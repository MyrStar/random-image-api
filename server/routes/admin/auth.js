const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const router = express.Router();

/**
 * 时序安全的字符串比较，防止时序攻击
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // 长度不同时仍然比较内容，避免通过长度泄露信息
  if (bufA.length !== bufB.length) {
    // 用一个假比较保持时间一致
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * POST /admin/api/login
 * 登录接口（密码以 bcrypt 哈希校验，见 config.verifyAdminPassword）
 */
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (timingSafeEqual(username, config.admin.user) && config.verifyAdminPassword(password)) {
    const token = jwt.sign({ user: username }, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    });
    return res.json({ code: 0, data: { token, user: username } });
  }

  res.status(401).json({ code: 401, message: '用户名或密码错误' });
});

/**
 * GET /admin/api/me
 * 获取当前用户信息
 */
router.get('/me', require('../../middleware/auth'), (req, res) => {
  res.json({ code: 0, data: { user: req.user.user } });
});

module.exports = router;
