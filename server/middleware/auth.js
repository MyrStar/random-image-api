const jwt = require('jsonwebtoken');
const config = require('../config');

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ code: 401, message: '未登录' });
  }
  try {
    // 固定 HS256，防止算法混淆
    const decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
    // 修改密码后，不晚于修改时间签发的 token 一律失效
    // （iat 精度为秒，用 <= 才能覆盖"签发与改密在同一秒"的情况）
    if (decoded.iat && config.passwordChangedAt && decoded.iat <= config.passwordChangedAt) {
      return res.status(401).json({ code: 401, message: '密码已修改，请重新登录' });
    }
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ code: 401, message: 'Token无效或已过期' });
  }
}

module.exports = authMiddleware;
