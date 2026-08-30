/**
 * 归一化访问域名：
 * - 去尾部斜杠
 * - 未带协议头时补 https://（填 cdn.example.com 视为 https://cdn.example.com）
 * - 显式 http:// 会被尊重保留（存储源「源站域名」支持填 http 绕过未配证书的源站）
 * @param {string} ep
 * @returns {string|null}
 */
function normalizeEndpoint(ep) {
  let s = String(ep ?? '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) {
    s = 'https://' + s;
  }
  return s || null;
}

module.exports = { normalizeEndpoint };
