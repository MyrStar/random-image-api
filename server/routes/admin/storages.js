const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const imageService = require('../../services/imageService');
const { decrypt } = require('../../utils/crypto');
const { createAdapter, getSupportedTypes } = require('../../adapters');
const { sendCaught } = require('../../utils/respond');

// 所有路由需要认证
router.use(auth);

// 需要脱敏的敏感字段（编辑回显时打码，保存时空值/打码值不参与覆盖）
const SENSITIVE_KEYS = ['secretKey', 'secretAccessKey', 'accessKeySecret', 'accessKeyId', 'accessKey', 'secretId', 'secret'];

/**
 * 对存储配置中的敏感字段进行脱敏
 * 保留字段的前2位和后2位，中间用 **** 替代
 */
function maskConfig(config) {
  const masked = { ...config };
  for (const key of SENSITIVE_KEYS) {
    if (masked[key] && typeof masked[key] === 'string' && masked[key].length > 6) {
      const val = masked[key];
      masked[key] = val.slice(0, 2) + '****' + val.slice(-2);
    } else if (masked[key]) {
      masked[key] = '****';
    }
  }
  return masked;
}

/**
 * GET /admin/api/storages
 * 获取存储源列表
 */
router.get('/', (req, res) => {
  try {
    const storages = imageService.getStorages();
    res.json({ code: 0, data: storages });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * GET /admin/api/storages/types
 * 获取支持的存储类型
 */
router.get('/types', (req, res) => {
  res.json({ code: 0, data: getSupportedTypes() });
});

/**
 * GET /admin/api/storages/:id
 * 获取单个存储源（密钥脱敏）
 * 前端编辑弹窗必须使用本接口回填配置，避免用空值覆盖真实密钥
 */
router.get('/:id', (req, res) => {
  try {
    const storage = imageService.getStorageById(req.params.id);
    if (!storage) return res.status(404).json({ code: 404, message: '存储源不存在' });
    // 解密config后脱敏返回
    const configObj = JSON.parse(decrypt(storage.config));
    storage.config = maskConfig(configObj);
    res.json({ code: 0, data: storage });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * 清理配置中的字符串字段（去除首尾空格）
 */
function trimConfig(config) {
  const cleaned = {};
  for (const [key, value] of Object.entries(config)) {
    cleaned[key] = typeof value === 'string' ? value.trim() : value;
  }
  return cleaned;
}

/**
 * POST /admin/api/storages
 * 添加存储源
 */
router.post('/', (req, res) => {
  try {
    const { name, type, config, endpoint, status } = req.body;
    if (!name || !type || !config) {
      return res.status(400).json({ code: 400, message: '缺少必填字段' });
    }
    const storage = imageService.createStorage({ name: name.trim(), type, config: trimConfig(config), endpoint: endpoint?.trim(), status });
    res.json({ code: 0, data: storage, message: '添加成功' });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * PUT /admin/api/storages/:id
 * 更新存储源
 */
router.put('/:id', (req, res) => {
  try {
    const data = { ...req.body };
    if (data.config) {
      // 双重保护，防止已保存的密钥被意外覆盖：
      // 1) 包含 **** 的值是编辑页回显的打码结果，说明用户没改，移除
      // 2) 敏感字段的空字符串视为"未修改"，不参与合并覆盖
      const cleanedConfig = {};
      for (const [key, value] of Object.entries(data.config)) {
        if (typeof value === 'string' && value.includes('****')) continue;
        if (SENSITIVE_KEYS.includes(key) && typeof value === 'string' && value.trim() === '') continue;
        cleanedConfig[key] = value;
      }
      data.config = trimConfig(cleanedConfig);
    }
    if (data.name) data.name = data.name.trim();
    if (data.endpoint) data.endpoint = data.endpoint.trim();
    imageService.updateStorage(req.params.id, data);
    res.json({ code: 0, message: '更新成功' });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * DELETE /admin/api/storages/:id
 * 删除存储源
 */
router.delete('/:id', (req, res) => {
  try {
    imageService.deleteStorage(req.params.id);
    res.json({ code: 0, message: '删除成功' });
  } catch (err) {
    sendCaught(res, err);
  }
});

/**
 * POST /admin/api/storages/:id/test
 * 测试存储连接
 */
router.post('/:id/test', async (req, res) => {
  try {
    const storage = imageService.getStorageById(req.params.id);
    if (!storage) return res.status(404).json({ code: 404, message: '存储源不存在' });

    const config = JSON.parse(decrypt(storage.config));
    const adapter = createAdapter(storage.type, config, storage.endpoint);
    const result = await adapter.test();
    res.json({ code: 0, data: result });
  } catch (err) {
    res.json({ code: 0, data: { success: false, message: err.message } });
  }
});

module.exports = router;
