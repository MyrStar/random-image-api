const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const imageService = require('../../services/imageService');
const config = require('../../config');
const { sendCaught } = require('../../utils/respond');

router.use(auth);

/**
 * GET /admin/api/categories
 */
router.get('/', (req, res) => {
  try {
    const categories = imageService.getCategories();
    // 附加API地址
    const data = categories.map(c => ({
      ...c,
      api_url: `${config.publicUrl}/api/${c.slug}`,
    }));
    res.json({ code: 0, data });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * GET /admin/api/categories/:id
 */
router.get('/:id', (req, res) => {
  try {
    const category = imageService.getCategoryById(req.params.id);
    if (!category) return res.status(404).json({ code: 404, message: '分类不存在' });
    res.json({ code: 0, data: category });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * POST /admin/api/categories
 */
router.post('/', (req, res) => {
  try {
    const { name, slug, description, storage_id, storage_path, status, cache_ttl } = req.body;
    if (!name || !slug || !storage_id || !storage_path) {
      return res.status(400).json({ code: 400, message: '缺少必填字段' });
    }
    // slug格式校验
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      return res.status(400).json({ code: 400, message: 'slug只能包含字母、数字、下划线、连字符' });
    }
    const category = imageService.createCategory({ name, slug, description, storage_id, storage_path, status, cache_ttl });
    res.json({ code: 0, data: category, message: '添加成功' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ code: 400, message: 'slug已存在，请换一个' });
    }
    sendCaught(res, err);
  }
});

/**
 * PUT /admin/api/categories/:id
 */
router.put('/:id', (req, res) => {
  try {
    if (req.body.slug && !/^[a-zA-Z0-9_-]+$/.test(req.body.slug)) {
      return res.status(400).json({ code: 400, message: 'slug只能包含字母、数字、下划线、连字符' });
    }
    imageService.updateCategory(req.params.id, req.body);
    res.json({ code: 0, message: '更新成功' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ code: 400, message: 'slug已存在，请换一个' });
    }
    sendCaught(res, err);
  }
});

/**
 * DELETE /admin/api/categories/:id
 */
router.delete('/:id', (req, res) => {
  try {
    imageService.deleteCategory(req.params.id);
    res.json({ code: 0, message: '删除成功' });
  } catch (err) {
    sendCaught(res, err);
  }
});

module.exports = router;
