const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const { getDb } = require('../../database');
const db = new Proxy({}, { get(_, prop) { return getDb()[prop]; } });
const cache = require('../../services/cacheService');
const imageService = require('../../services/imageService');
const { sendCaught } = require('../../utils/respond');

router.use(auth);

// 允许操作的表（白名单，防止SQL注入）
const ALLOWED_TABLES = ['storage_configs', 'categories', 'images'];

// 允许查询的列白名单（防止列名注入）
const ALLOWED_COLUMNS = {
  storage_configs: ['id', 'name', 'type', 'config', 'endpoint', 'status', 'created_at', 'updated_at'],
  categories: ['id', 'name', 'slug', 'description', 'storage_id', 'storage_path', 'status', 'cache_ttl', 'created_at'],
  images: ['id', 'category_id', 'filename', 'storage_key', 'url', 'size', 'width', 'height', 'mime_type', 'created_at'],
};

// 禁止通过DB浏览器编辑的敏感字段
const READONLY_COLUMNS = ['config', 'created_at', 'updated_at'];

/**
 * GET /admin/api/db/tables
 * 获取所有表信息（仅返回白名单中的表）
 */
router.get('/tables', (req, res) => {
  try {
    const result = ALLOWED_TABLES.map(t => {
      const count = db.prepare(`SELECT COUNT(*) as count FROM "${t}"`).get().count;
      const columns = db.prepare(`PRAGMA table_info("${t}")`).all();
      return {
        name: t,
        count,
        columns: columns.map(c => ({
          name: c.name,
          type: c.type,
          notnull: !!c.notnull,
          pk: !!c.pk,
          default: c.dflt_value,
        })),
      };
    });

    res.json({ code: 0, data: result });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * GET /admin/api/db/:table
 * 查询表数据（分页）
 */
router.get('/:table', (req, res) => {
  try {
    const { table } = req.params;
    if (!ALLOWED_TABLES.includes(table)) {
      return res.status(400).json({ code: 400, message: '不允许访问该表' });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const size = Math.min(Math.max(parseInt(req.query.size, 10) || 50, 1), 200);
    const { sort, order = 'DESC', search } = req.query;
    const offset = (page - 1) * size;

    // 获取列信息
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
    const columnNames = columns.map(c => c.name);
    const allowedCols = ALLOWED_COLUMNS[table] || columnNames;

    // 构建查询
    let whereClause = '';
    let countParams = [];
    let queryParams = [];

    if (search && columnNames.length > 0) {
      // 在所有TEXT列中搜索
      const textColumns = columns.filter(c => c.type === 'TEXT').map(c => c.name);
      if (textColumns.length > 0) {
        const conditions = textColumns.map(c => `"${c}" LIKE ?`);
        whereClause = ` WHERE ${conditions.join(' OR ')}`;
        const searchParam = `%${search}%`;
        countParams = textColumns.map(() => searchParam);
        queryParams = [...countParams];
      }
    }

    // 排序 - 验证排序列名在白名单中
    let orderClause = ' ORDER BY id DESC';
    if (sort && allowedCols.includes(sort)) {
      const orderDir = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      orderClause = ` ORDER BY "${sort}" ${orderDir}`;
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM "${table}"${whereClause}`).get(...countParams).count;

    queryParams.push(size, offset);
    const items = db.prepare(
      `SELECT * FROM "${table}"${whereClause}${orderClause} LIMIT ? OFFSET ?`
    ).all(...queryParams);

    res.json({
      code: 0,
      data: {
        items,
        total,
        page,
        size,
        pages: Math.ceil(total / size),
        columns: columnNames,
      },
    });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * PUT /admin/api/db/:table/:id
 * 更新记录（绕过业务层的原始编辑，写后清除图片缓存以保证公开API数据一致）
 */
router.put('/:table/:id', (req, res) => {
  try {
    const { table, id } = req.params;
    if (!ALLOWED_TABLES.includes(table)) {
      return res.status(400).json({ code: 400, message: '不允许操作该表' });
    }

    const data = req.body;
    // 移除不允许更新的字段
    delete data.id;
    delete data.created_at;
    delete data.updated_at;

    const allowedCols = ALLOWED_COLUMNS[table] || [];

    const fields = Object.keys(data).filter(key => {
      // 过滤：必须在白名单中，且不能是只读字段
      return allowedCols.includes(key) && !READONLY_COLUMNS.includes(key);
    });

    if (fields.length === 0) {
      return res.status(400).json({ code: 400, message: '没有要更新的字段' });
    }

    // 仅支持标量值，对象/数组一律拒绝
    for (const f of fields) {
      const v = data[f];
      if (!(v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
        return res.status(400).json({ code: 400, message: `字段 ${f} 的值类型不支持` });
      }
    }

    const values = fields.map(f => data[f]);
    let setClause = fields.map(f => `"${f}" = ?`).join(', ');

    // 仅当表有 updated_at 列时才追加自动更新
    const tableColumns = db.prepare(`PRAGMA table_info("${table}")`).all();
    if (tableColumns.some(c => c.name === 'updated_at')) {
      setClause += ", updated_at = datetime('now','localtime')";
    }

    db.prepare(`UPDATE "${table}" SET ${setClause} WHERE id = ?`).run(...values, id);

    // 直接改库绕过了业务层，清空缓存保证公开 API 不供出旧数据
    cache.clear();

    res.json({ code: 0, message: '更新成功' });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * DELETE /admin/api/db/:table/:id
 * 删除记录（images/categories 走业务层，保证远端文件与缓存一致）
 */
router.delete('/:table/:id', async (req, res) => {
  try {
    const { table, id } = req.params;
    if (!ALLOWED_TABLES.includes(table)) {
      return res.status(400).json({ code: 400, message: '不允许操作该表' });
    }

    // 禁止删除 storage_configs 的记录（应通过专用API删除，保证数据一致性）
    if (table === 'storage_configs') {
      return res.status(400).json({ code: 400, message: '请通过存储源管理页面删除存储源' });
    }

    if (table === 'images') {
      await imageService.deleteImage(id);
    } else if (table === 'categories') {
      imageService.deleteCategory(id);
    }
    res.json({ code: 0, message: '删除成功' });
  } catch (err) {
    sendCaught(res, err);
  }
});

// 注意：已移除 POST /admin/api/db/query 自定义SQL查询端点
// 原因：仅用 startsWith('SELECT') 检查无法防止SQL注入，风险极高

module.exports = router;
