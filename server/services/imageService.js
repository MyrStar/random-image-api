const path = require('path');
const { getDb } = require('../database');
const db = new Proxy({}, { get(_, prop) { return getDb()[prop]; } });
const cache = require('./cacheService');
const { createAdapter } = require('../adapters');
const { decrypt } = require('../utils/crypto');
const { encrypt } = require('../utils/crypto');
const { getMimeType, isImage, getImageDimensions } = require('../utils/imageInfo');
const { safeFetch } = require('../utils/safeFetch');
const { nanoid } = require('../utils/nanoid');

const CACHE_PREFIX = 'images:';

// 大分类阈值：超过此数量使用索引随机定位，而非全量加载
const LARGE_CATEGORY_THRESHOLD = 10000;

// 修复尺寸时的下载并发数与单图大小上限
const FIX_DIMENSIONS_CONCURRENCY = 4;
const FIX_DIMENSIONS_MAX_BYTES = 100 * 1024 * 1024;

/** 把 node-fetch 的底层报错翻译成可操作的提示 */
function friendlyFetchError(err) {
  const msg = err.message || String(err);
  if (err.name === 'AbortError' || /aborted/i.test(msg)) {
    return '请求超时：服务器无法访问该图片URL（常见原因：七牛防盗链拦截了服务器请求、服务器到CDN线路不通、防火墙拦截出站请求）';
  }
  if (/certificate|SSL|TLS|self-signed/i.test(msg)) {
    return 'HTTPS 证书验证失败：' + msg;
  }
  return msg;
}

// 适配器实例缓存，避免每次请求都创建
const adapterCache = new Map();

// 正在同步的分类（防并发重复同步）
const syncingCategories = new Set();

// 修复尺寸失败过的图片 ID（本轮运行内不再重试）
const dimensionFixFailed = new Set();

/**
 * 获取适配器实例（带缓存）
 */
function getAdapter(storageId) {
  if (adapterCache.has(storageId)) {
    return adapterCache.get(storageId);
  }
  const storage = db.prepare('SELECT * FROM storage_configs WHERE id = ?').get(storageId);
  if (!storage) throw createBizError('存储源不存在', 404);

  let configObj;
  try {
    configObj = JSON.parse(decrypt(storage.config));
  } catch (err) {
    throw createBizError(`存储源「${storage.name}」密钥解密失败：${err.message}`, err.status || 400);
  }
  const adapter = createAdapter(storage.type, configObj, storage.endpoint);
  adapterCache.set(storageId, adapter);
  return adapter;
}

function createBizError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * 清除适配器缓存（存储源更新时调用）
 */
function clearAdapterCache(storageId) {
  if (storageId) {
    adapterCache.delete(storageId);
  } else {
    adapterCache.clear();
  }
}

/**
 * 归一化存储路径：去除首部 /，补齐尾部 /
 * 避免拼接出的 key 缺少目录分隔符（images/wallpaper + abc.jpg -> wallpaperabc.jpg）
 */
function normalizeStoragePath(p) {
  let s = String(p ?? '').trim();
  if (!s) return '';
  s = s.replace(/^\/+/, '');
  if (!s.endsWith('/')) s += '/';
  return s;
}

/**
 * 归一化访问域名：补全协议头（填 cdn.example.com 视为 https://cdn.example.com）、去尾部斜杠
 * 否则生成的图片 URL 缺少协议头，浏览器会当作相对路径拼接出错
 */
function normalizeEndpoint(ep) {
  let s = String(ep ?? '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) {
    s = 'https://' + s;
  }
  return s || null;
}

/**
 * 查询分类对应存储的源站域名信息（服务端取图用）
 * 配了外部 CDN 回源时：公开 URL 用「访问域名」，服务端取图改走「源站域名」
 */
function getProxyFetchInfo(slug) {
  const row = db.prepare(`
    SELECT s.endpoint, s.origin_domain
    FROM categories c JOIN storage_configs s ON c.storage_id = s.id
    WHERE c.slug = ? AND c.status = 1
  `).get(slug);
  if (!row || !row.origin_domain) return null;
  return { endpoint: row.endpoint, origin_domain: row.origin_domain };
}

/** 若 URL 属于该存储的访问域名且配了源站域名，改写为源站 URL；否则原样返回 */
function rewriteUrlToOrigin(url, storage) {
  if (!storage || !url) return url;
  const endpoint = normalizeEndpoint(storage.endpoint);
  const origin = normalizeEndpoint(storage.origin_domain);
  if (origin && endpoint && url.startsWith(endpoint)) {
    return origin + url.slice(endpoint.length);
  }
  return url;
}

/**
 * 大分类随机取图：利用 (category_id, id) 索引按随机 id 定位，O(log n)
 * 避免每次请求 ORDER BY RANDOM() 全表扫描
 */
function randomFromLargeCategory(categoryId, imageCount) {
  const range = db.prepare(
    'SELECT MIN(id) as minId, MAX(id) as maxId FROM images WHERE category_id = ?'
  ).get(categoryId);
  if (!range || range.minId == null) return null;

  const { minId, maxId } = range;
  const span = maxId - minId + 1;
  for (let i = 0; i < 6; i++) {
    const target = minId + Math.floor(Math.random() * span);
    const row = db.prepare(
      'SELECT url, width, height, size, mime_type FROM images WHERE category_id = ? AND id >= ? ORDER BY id LIMIT 1'
    ).get(categoryId, target);
    if (row) return row;
  }
  // id 稀疏等极端情况兜底：随机 OFFSET（仅一次，不再全表排序）
  const offset = Math.floor(Math.random() * imageCount);
  return db.prepare(
    'SELECT url, width, height, size, mime_type FROM images WHERE category_id = ? LIMIT 1 OFFSET ?'
  ).get(categoryId, offset) || null;
}

/**
 * 获取随机图片
 * @param {string} slug - 分类slug
 * @returns {{ url: string, width: number, height: number, size: number, mime_type: string }|null}
 */
function getRandomImage(slug) {
  const cacheKey = CACHE_PREFIX + slug;

  // 先从缓存中获取该分类下的所有图片
  let images = cache.get(cacheKey);

  if (!images) {
    // 查数据库
    const category = db.prepare('SELECT id, cache_ttl FROM categories WHERE slug = ? AND status = 1').get(slug);
    if (!category) return null;

    // 检查图片数量，大分类使用索引随机定位优化
    const countResult = db.prepare('SELECT COUNT(*) as count FROM images WHERE category_id = ?').get(category.id);
    const imageCount = countResult.count;

    if (imageCount === 0) return null;

    if (imageCount > LARGE_CATEGORY_THRESHOLD) {
      return randomFromLargeCategory(category.id, imageCount);
    }

    // 小分类：全量加载到缓存
    images = db.prepare(
      'SELECT url, width, height, size, mime_type FROM images WHERE category_id = ?'
    ).all(category.id);

    if (!images.length) return null;

    cache.set(cacheKey, images, category.cache_ttl || 300);
  }

  if (!images.length) return null;

  // 随机选取一张
  const index = Math.floor(Math.random() * images.length);
  return images[index];
}

/**
 * 上传图片
 */
async function uploadImage(categoryId, fileBuffer, filename) {
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId);
  if (!category) throw createBizError('分类不存在', 404);

  const adapter = getAdapter(category.storage_id);
  const ext = path.extname(filename);
  const key = `${category.storage_path}${nanoid()}${ext}`;
  const mimeType = getMimeType(filename);

  // 先上传到存储，成功后再写数据库
  const result = await adapter.upload(key, fileBuffer, mimeType);

  // 解析图片宽高
  const { width, height } = getImageDimensions(fileBuffer);

  try {
    const stmt = db.prepare(`
      INSERT INTO images (category_id, filename, storage_key, url, size, width, height, mime_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(categoryId, filename, key, result.url, fileBuffer.length, width, height, mimeType);

    // 清除缓存
    cache.del(CACHE_PREFIX + category.slug);

    return {
      id: info.lastInsertRowid,
      filename,
      storage_key: key,
      url: result.url,
      size: fileBuffer.length,
      width,
      height,
      mime_type: mimeType,
    };
  } catch (err) {
    // 数据库写入失败：补偿性删除已上传的远端文件，避免孤儿文件
    try { await adapter.delete(key); } catch { /* 补偿失败仅记录，远端文件为孤儿不影响数据一致性 */ }
    console.warn(`[uploadImage] 数据库写入失败，已回滚远端文件 ${key}`);
    throw err;
  }
}

/**
 * 删除图片：先删数据库记录，再尽力删除远端文件
 * 远端删除失败只留下孤儿文件（无害），不会出现"记录还在但文件已删"的死链
 */
async function deleteImage(imageId) {
  const image = db.prepare(`
    SELECT i.*, c.slug, c.storage_id
    FROM images i
    JOIN categories c ON i.category_id = c.id
    WHERE i.id = ?
  `).get(imageId);

  if (!image) throw createBizError('图片不存在', 404);

  db.prepare('DELETE FROM images WHERE id = ?').run(imageId);
  cache.del(CACHE_PREFIX + image.slug);

  try {
    const adapter = getAdapter(image.storage_id);
    await adapter.delete(image.storage_key);
  } catch (err) {
    console.warn(`[deleteImage] 远端文件删除失败（记录已删除）: ${image.storage_key}, ${err.message}`);
  }

  return true;
}

/**
 * 批量删除图片
 */
async function deleteImages(imageIds) {
  const results = { success: 0, failed: 0, errors: [] };

  for (const id of imageIds) {
    try {
      await deleteImage(id);
      results.success++;
    } catch (err) {
      results.failed++;
      results.errors.push({ id, error: err.message });
    }
  }

  return results;
}

/**
 * 从存储源同步图片列表到数据库
 */
async function syncFromStorage(categoryId) {
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId);
  if (!category) throw createBizError('分类不存在', 404);

  if (syncingCategories.has(categoryId)) {
    throw createBizError('该分类正在同步中，请等待当前同步完成', 409);
  }
  syncingCategories.add(categoryId);

  try {
    const adapter = getAdapter(category.storage_id);

    // 已存在的记录（key -> 行），同步时既用于去重，也用于刷新已有记录的 URL/大小
    const existingRows = db.prepare('SELECT id, storage_key, url, size, mime_type FROM images WHERE category_id = ?')
      .all(categoryId);
    const existing = new Map(existingRows.map(r => [r.storage_key, r]));

    let added = 0;
    let updated = 0;
    let marker = null;
    let hasMore = true;
    let guard = 0;
    const MAX_PAGES = 10000; // 防御性上限，避免适配器分页异常导致死循环

    while (hasMore && guard++ < MAX_PAGES) {
      const result = await adapter.list(category.storage_path, marker, 1000);

      for (const item of result.items) {
        if (!isImage(item.key)) continue;

        const filename = path.basename(item.key);
        const url = adapter.getUrl(item.key);
        const mimeType = getMimeType(filename);
        const old = existing.get(item.key);

        if (!old) {
          const info = db.prepare(`
            INSERT INTO images (category_id, filename, storage_key, url, size, mime_type)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(categoryId, filename, item.key, url, item.size, mimeType);
          existing.set(item.key, { id: info.lastInsertRowid, storage_key: item.key, url, size: item.size, mime_type: mimeType });
          added++;
        } else if (old.url !== url || old.size !== item.size || old.mime_type !== mimeType) {
          // 域名配置变更/文件被替换后，刷新已有记录（重新同步即自愈）
          db.prepare('UPDATE images SET url = ?, size = ?, mime_type = ? WHERE id = ?')
            .run(url, item.size, mimeType, old.id);
          updated++;
        }
      }

      marker = result.nextMarker;
      hasMore = !!marker;
    }

    // 清除缓存
    cache.del(CACHE_PREFIX + category.slug);

    // 清除该分类图片的"修复尺寸失败"记录，URL 修正后允许重新尝试
    for (const row of existingRows) dimensionFixFailed.delete(row.id);

    return { added, updated, total: existing.size };
  } finally {
    syncingCategories.delete(categoryId);
  }
}

/**
 * 修复图片尺寸：下载 0×0 的图片并解析宽高
 * @param {number|null} categoryId - 仅处理指定分类（null 为全库）
 */
async function fixDimensions(categoryId = null) {
  let sql = `
    SELECT i.*, s.endpoint AS storage_endpoint, s.origin_domain AS storage_origin
    FROM images i
    JOIN categories c ON i.category_id = c.id
    LEFT JOIN storage_configs s ON c.storage_id = s.id
    WHERE i.width = 0 AND i.height = 0`;
  const params = [];
  if (categoryId) {
    sql += ' AND i.category_id = ?';
    params.push(categoryId);
  }
  const images = db.prepare(sql).all(...params).filter(img => !dimensionFixFailed.has(img.id));
  let fixed = 0, failed = 0;
  const errors = [];
  let cursor = 0;

  // 简易并发池
  async function worker() {
    while (cursor < images.length) {
      const img = images[cursor++];
      try {
        const resp = await safeFetch(rewriteUrlToOrigin(img.url, img), { timeoutMs: 30000, maxBytes: FIX_DIMENSIONS_MAX_BYTES });
        const { width, height } = getImageDimensions(resp.buffer);
        if (width > 0 || height > 0) {
          db.prepare('UPDATE images SET width = ?, height = ? WHERE id = ?').run(width, height, img.id);
          dimensionFixFailed.delete(img.id);
          fixed++;
        } else {
          dimensionFixFailed.add(img.id);
          failed++;
          if (errors.length < 10) errors.push({ filename: img.filename, url: img.url, reason: '无法解析图片尺寸（格式可能不受支持）' });
        }
      } catch (err) {
        dimensionFixFailed.add(img.id);
        failed++;
        const reason = friendlyFetchError(err);
        console.warn(`[fixDimensions] ${img.filename}: ${reason}`);
        if (errors.length < 10) errors.push({ filename: img.filename, url: img.url, reason });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(FIX_DIMENSIONS_CONCURRENCY, images.length || 1) }, worker)
  );

  // 清除受影响分类的缓存
  const categories = categoryId
    ? db.prepare('SELECT slug FROM categories WHERE id = ?').all(categoryId)
    : db.prepare('SELECT slug FROM categories').all();
  for (const c of categories) cache.del(CACHE_PREFIX + c.slug);

  return { total: images.length, fixed, failed, errors };
}

/**
 * 分页参数校验
 */
function clampPage(page, size) {
  const p = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const s = Number.isFinite(size) && size >= 1 ? Math.min(Math.floor(size), 200) : 20;
  return [p, s];
}

/**
 * 设置图片尺寸（浏览器预览加载后回填真实宽高，绕开服务器无法访问存储域名的情况）
 * 仅更新当前为 0×0 的记录，避免覆盖正确数据；返回受影响分类的 slug 列表
 */
function setImageDimensions(id, width, height) {
  const affected = db.prepare(`
    UPDATE images SET width = ?, height = ?
    WHERE id = ? AND width = 0 AND height = 0
  `).run(width, height, id);

  if (affected.changes === 0) return null;
  const row = db.prepare(`
    SELECT c.slug FROM images i JOIN categories c ON i.category_id = c.id WHERE i.id = ?
  `).get(id);
  if (row) cache.del(CACHE_PREFIX + row.slug);
  dimensionFixFailed.delete(id);
  return row ? row.slug : null;
}

/**
 * 获取图片列表（分页）
 */
function getImages(categoryId, page = 1, size = 20) {
  const [p, s] = clampPage(page, size);
  const offset = (p - 1) * s;
  const total = db.prepare('SELECT COUNT(*) as count FROM images WHERE category_id = ?').get(categoryId).count;
  const items = db.prepare(
    'SELECT * FROM images WHERE category_id = ? ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(categoryId, s, offset);

  return { items, total, page: p, size: s, pages: Math.ceil(total / s) };
}

/**
 * 存储源 CRUD
 */
function getStorages() {
  return db.prepare('SELECT id, name, type, endpoint, status, created_at, updated_at FROM storage_configs').all();
}

function getStorageById(id) {
  return db.prepare('SELECT * FROM storage_configs WHERE id = ?').get(id);
}

function createStorage(data) {
  const stmt = db.prepare(`
    INSERT INTO storage_configs (name, type, config, endpoint, origin_domain, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(data.name, data.type, encrypt(JSON.stringify(data.config)), normalizeEndpoint(data.endpoint), normalizeEndpoint(data.origin_domain), data.status ?? 1);
  return { id: info.lastInsertRowid, ...data };
}

function updateStorage(id, data) {
  const fields = [];
  const values = [];

  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.type !== undefined) { fields.push('type = ?'); values.push(data.type); }
  if (data.config !== undefined && Object.keys(data.config).length > 0) {
    // 先读取现有配置，解密后与新值合并，避免脱敏字段被过滤后丢失其他字段
    const existing = db.prepare('SELECT config FROM storage_configs WHERE id = ?').get(id);
    let mergedConfig = {};
    if (existing) {
      mergedConfig = JSON.parse(decrypt(existing.config));
    }
    mergedConfig = { ...mergedConfig, ...data.config };
    fields.push('config = ?');
    values.push(encrypt(JSON.stringify(mergedConfig)));
  }
  if (data.endpoint !== undefined) { fields.push('endpoint = ?'); values.push(normalizeEndpoint(data.endpoint)); }
  if (data.origin_domain !== undefined) { fields.push('origin_domain = ?'); values.push(normalizeEndpoint(data.origin_domain)); }
  if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
  fields.push("updated_at = datetime('now','localtime')");
  values.push(id);

  db.prepare(`UPDATE storage_configs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  // 清除适配器缓存，下次请求时重新创建
  clearAdapterCache(id);
}

function deleteStorage(id) {
  // 检查是否有关联的分类
  const count = db.prepare('SELECT COUNT(*) as count FROM categories WHERE storage_id = ?').get(id).count;
  if (count > 0) throw createBizError('该存储源下还有分类，请先删除关联分类');
  db.prepare('DELETE FROM storage_configs WHERE id = ?').run(id);
  clearAdapterCache(id);
}

/**
 * 分类 CRUD
 */
function getCategories() {
  return db.prepare(`
    SELECT c.*, s.name as storage_name, s.type as storage_type,
      (SELECT COUNT(*) FROM images WHERE category_id = c.id) as image_count
    FROM categories c
    LEFT JOIN storage_configs s ON c.storage_id = s.id
    ORDER BY c.id ASC
  `).all();
}

function getCategoryById(id) {
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
}

function createCategory(data) {
  const stmt = db.prepare(`
    INSERT INTO categories (name, slug, description, storage_id, storage_path, status, cache_ttl)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    data.name,
    data.slug,
    data.description || '',
    data.storage_id,
    normalizeStoragePath(data.storage_path),
    data.status ?? 1,
    data.cache_ttl ?? 300
  );
  return { id: info.lastInsertRowid, ...data };
}

function updateCategory(id, data) {
  // 更新前取旧信息：改 slug 时需要清理旧 slug 的缓存
  const old = db.prepare('SELECT slug FROM categories WHERE id = ?').get(id);
  if (!old) throw createBizError('分类不存在', 404);

  const fields = [];
  const values = [];

  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.slug !== undefined) { fields.push('slug = ?'); values.push(data.slug); }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
  if (data.storage_id !== undefined) { fields.push('storage_id = ?'); values.push(data.storage_id); }
  if (data.storage_path !== undefined) { fields.push('storage_path = ?'); values.push(normalizeStoragePath(data.storage_path)); }
  if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
  if (data.cache_ttl !== undefined) { fields.push('cache_ttl = ?'); values.push(data.cache_ttl); }
  // categories 表没有 updated_at 列，不需要更新
  values.push(id);

  db.prepare(`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  // 清除新旧 slug 的缓存
  cache.del(CACHE_PREFIX + old.slug);
  const cat = db.prepare('SELECT slug FROM categories WHERE id = ?').get(id);
  if (cat && cat.slug !== old.slug) cache.del(CACHE_PREFIX + cat.slug);
}

function deleteCategory(id) {
  // 先获取分类信息和关联图片
  const cat = db.prepare('SELECT slug, storage_id, storage_path FROM categories WHERE id = ?').get(id);
  if (!cat) return;

  const images = db.prepare('SELECT storage_key FROM images WHERE category_id = ?').all(id);
  const adapter = getAdapter(cat.storage_id);

  // 使用事务保护数据库操作
  const database = getDb();
  database.transaction(() => {
    db.prepare('DELETE FROM images WHERE category_id = ?').run(id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  });

  // 异步删除远端存储文件（不阻塞响应，失败只记日志）
  Promise.allSettled(images.map(img => adapter.delete(img.storage_key)))
    .then(results => {
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length > 0) {
        console.warn(`[deleteCategory] ${failed.length}/${images.length} 个远端文件删除失败`);
      }
    });

  // 清除该分类的缓存
  cache.del(CACHE_PREFIX + cat.slug);
}

/**
 * 七牛 imageView2 缩放 URL：让 CDN 直接返回缩放结果，服务器无需取图
 * mode 映射：fit -> /2（限定宽高缩放），fill -> /3（限定宽高居中裁剪）；
 * stretch 七牛无对应模式，降级为 fit
 */
function buildQiniuImageView2(url, w, h, mode) {
  const modeCode = mode === 'fill' ? 3 : 2;
  let param = `imageView2/${modeCode}`;
  if (w) param += `/w/${w}`;
  if (h) param += `/h/${h}`;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${param}`;
}

/**
 * 若当前分类的存储支持「CDN 端缩放」，返回缩放后的 URL；不支持返回 null（走服务端 sharp）
 * 目前七牛支持（imageView2）；其他存储走服务端处理
 */
function getProcessedResizeUrl(slug, w, h, mode) {
  const cat = db.prepare(`
    SELECT s.type AS storage_type
    FROM categories c JOIN storage_configs s ON c.storage_id = s.id
    WHERE c.slug = ? AND c.status = 1 AND s.status = 1
  `).get(slug);
  if (!cat || cat.storage_type !== 'qiniu') return null;

  const image = getRandomImage(slug);
  if (!image || !image.url) return null;
  return buildQiniuImageView2(image.url, w, h, mode);
}

/**
 * 获取仪表盘统计数据
 */
function getStats() {
  const storageCount = db.prepare('SELECT COUNT(*) as count FROM storage_configs').get().count;
  const categoryCount = db.prepare('SELECT COUNT(*) as count FROM categories').get().count;
  const imageCount = db.prepare('SELECT COUNT(*) as count FROM images').get().count;
  const totalSize = db.prepare('SELECT COALESCE(SUM(size), 0) as total FROM images').get().total;

  return { storageCount, categoryCount, imageCount, totalSize };
}

/**
 * 获取所有图片（用于数据浏览）
 */
function getAllImages(page = 1, size = 50) {
  const [p, s] = clampPage(page, Math.min(size, 200));
  const offset = (p - 1) * s;
  const total = db.prepare('SELECT COUNT(*) as count FROM images').get().count;
  const items = db.prepare(`
    SELECT i.*, c.name as category_name, c.slug as category_slug
    FROM images i
    LEFT JOIN categories c ON i.category_id = c.id
    ORDER BY i.id DESC LIMIT ? OFFSET ?
  `).all(s, offset);

  return { items, total, page: p, size: s, pages: Math.ceil(total / s) };
}

module.exports = {
  getRandomImage,
  uploadImage,
  deleteImage,
  deleteImages,
  syncFromStorage,
  setImageDimensions,
  getProcessedResizeUrl,
  getProxyFetchInfo,
  rewriteUrlToOrigin,
  getImages,
  getStorages,
  getStorageById,
  createStorage,
  updateStorage,
  deleteStorage,
  getCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  getStats,
  getAllImages,
  fixDimensions,
};
