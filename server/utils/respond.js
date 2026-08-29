/**
 * 统一的响应辅助：正常返回 / 业务错误 / 未知错误（不向客户端泄漏内部细节）
 */
function sendCaught(res, err) {
  const status = err && err.status ? err.status : 500;
  if (status >= 500) {
    console.error('[API Error]', err && err.stack ? err.stack : err);
    return res.status(status).json({ code: status, message: '服务器内部错误' });
  }
  // 业务类错误（4xx）：信息可安全展示
  console.warn('[API Rejected]', err && err.message);
  return res.status(status).json({ code: status, message: err.message || '请求被拒绝' });
}

module.exports = { sendCaught };
