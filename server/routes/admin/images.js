const express = require('express');
const multer = require('multer');
const router = express.Router();
const auth = require('../../middleware/auth');
const imageService = require('../../services/imageService');
const { validateImageFile } = require('../../utils/imageInfo');
const config = require('../../config');
const { sendCaught } = require('../../utils/respond');

router.use(auth);

/**
 * 动态创建 multer 实例：每次请求按当前配置生成限制，
 * 使「上传大小限制 / 单次上传文件数上限」在线修改后立即生效
 */
function uploadMiddleware(req, res, next) {
  const maxFiles = config.uploadMaxFiles || 20;
  const maxBytes = (config.uploadMaxSize || 50) * 1024 * 1024;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: maxFiles },
  }).array('files', maxFiles);

  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ code: 413, message: `单个文件超过大小限制（${config.uploadMaxSize}MB），可在系统设置中调整` });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ code: 400, message: `单次最多上传 ${maxFiles} 个文件` });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ code: 400, message: '上传字段名不正确（应为 files）' });
    }
    return res.status(400).json({ code: 400, message: `上传失败: ${err.message}` });
  });
}

function parseIntOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * GET /admin/api/images
 * 获取图片列表（分页）
 */
router.get('/', (req, res) => {
  try {
    const { category_id } = req.query;
    const page = parseIntOr(req.query.page, 1);
    const size = parseIntOr(req.query.size, 20);
    let result;
    if (category_id) {
      result = imageService.getImages(parseIntOr(category_id, 0), page, size);
    } else {
      result = imageService.getAllImages(page, size);
    }
    res.json({ code: 0, data: result });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * POST /admin/api/images
 * 上传图片
 */
router.post('/', uploadMiddleware, async (req, res) => {
  try {
    const { category_id } = req.body;
    if (!category_id) return res.status(400).json({ code: 400, message: '缺少category_id' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ code: 400, message: '没有上传文件' });

    const results = [];
    for (const file of req.files) {
      // 扩展名 + 魔数双重校验（防止伪造扩展名；同时规避 image-size 解析恶意文件的死循环风险）
      const check = validateImageFile(file.originalname, file.buffer);
      if (!check.ok) {
        results.push({ success: false, filename: file.originalname, error: check.reason });
        continue;
      }
      try {
        const image = await imageService.uploadImage(parseIntOr(category_id, 0), file.buffer, file.originalname);
        results.push({ success: true, image });
      } catch (err) {
        results.push({ success: false, filename: file.originalname, error: err.message });
      }
    }

    res.json({ code: 0, data: results, message: `上传完成，成功${results.filter(r => r.success).length}张，失败${results.filter(r => !r.success).length}张` });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * DELETE /admin/api/images/:id
 * 删除单张图片
 */
router.delete('/:id', async (req, res) => {
  try {
    await imageService.deleteImage(parseIntOr(req.params.id, 0));
    res.json({ code: 0, message: '删除成功' });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * POST /admin/api/images/batch-delete
 * 批量删除图片
 */
router.post('/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ code: 400, message: '缺少ids' });
    const result = await imageService.deleteImages(ids);
    res.json({ code: 0, data: result, message: `成功${result.success}张，失败${result.failed}张` });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * POST /admin/api/images/sync
 * 从存储源同步图片（带进行中锁，防止并发重复同步）
 */
router.post('/sync', async (req, res) => {
  try {
    const { category_id } = req.body;
    if (!category_id) return res.status(400).json({ code: 400, message: '缺少category_id' });
    const result = await imageService.syncFromStorage(parseIntOr(category_id, 0));
    const updatedMsg = result.updated > 0 ? `，更新${result.updated}张` : '';
    res.json({
      code: 0,
      data: result,
      message: `同步完成，新增${result.added}张${updatedMsg}，共${result.total}张。同步只读取文件列表，如需宽高信息请点击「修复尺寸」`,
    });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * POST /admin/api/images/fix-dimensions
 * 修复 0×0 图片的宽高（可传 category_id 仅修复指定分类）
 */
router.post('/fix-dimensions', async (req, res) => {
  try {
    const categoryId = req.body.category_id ? parseIntOr(req.body.category_id, 0) : null;
    const result = await imageService.fixDimensions(categoryId);
    res.json({ code: 0, data: result, message: `修复完成，共${result.total}张，成功${result.fixed}张，失败${result.failed}张` });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * POST /admin/api/images/set-dimensions
 * 浏览器预览加载后回填真实宽高（用于服务器无法直接访问存储域名的情况）
 */
router.post('/set-dimensions', (req, res) => {
  try {
    const items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ code: 400, message: '缺少items' });
    }
    let updated = 0;
    for (const item of items.slice(0, 500)) {
      const id = parseInt(item.id, 10);
      const w = parseInt(item.width, 10);
      const h = parseInt(item.height, 10);
      if (!id || !(w > 0) || !(h > 0) || w > 100000 || h > 100000) continue;
      if (imageService.setImageDimensions(id, w, h)) updated++;
    }
    res.json({ code: 0, data: { updated }, message: `已更新${updated}张` });
  } catch (err) {
    sendCaught(res, err);
  }
});

module.exports = router;
