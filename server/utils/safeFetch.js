/**
 * SSRF 安全的 fetch 封装（基于 node-fetch v2）
 *
 * 防护点：
 * 1. 仅允许 http/https 协议
 * 2. 请求前做 DNS 解析并校验所有解析结果均非内网地址（IPv4/IPv6 全覆盖）
 * 3. 使用自定义 Agent 的 lookup 钩子在「建连时」再次校验，防止 DNS Rebinding（校验与建连之间换 IP）
 * 4. 手动跟随重定向（最多 maxRedirects 次），每一跳重新做协议/内网校验
 * 5. 总超时（AbortController）+ 响应体大小上限（防止内存耗尽）
 */

const fetch = require('node-fetch');
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');

/* ---------------- 内网 IP 判定 ---------------- */

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  if (a === 0) return true;                       // 0.0.0.0/8（含 0.0.0.0）
  if (a === 10) return true;                      // 10.0.0.0/8
  if (a === 127) return true;                     // 127.0.0.0/8
  if (a === 169 && b === 254) return true;        // 169.254.0.0/16 云元数据/链路本地
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;        // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGN
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试
  if (a === 192 && b === 0 && c === 0) return true;     // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true;     // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true;  // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;   // TEST-NET-3
  if (a >= 224) return true;                      // 组播 224/4 + 保留 240/4 + 广播
  return false;
}

/** 将 IPv6（含压缩写法、内嵌 IPv4）展开为 8 组 16bit 数字 */
function expandIPv6(ip) {
  let head = ip;
  let tail = [];
  const v4 = ip.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4[1].split('.').map(Number);
    tail = [((n[0] << 8) | n[1]), ((n[2] << 8) | n[3])];
    head = ip.slice(0, ip.length - v4[1].length);
    if (head.endsWith(':')) head = head.slice(0, -1);
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const groups = left.map(g => parseInt(g, 16));
  const rightNums = right.map(g => parseInt(g, 16));
  if (groups.some(Number.isNaN) || rightNums.some(Number.isNaN)) return null;
  const fill = halves.length === 2 ? 8 - left.length - right.length - tail.length : 0;
  if (halves.length === 2 && fill < 0) return null;
  if (halves.length === 1 && left.length + tail.length !== 8) return null;
  const all = [...groups, ...Array(Math.max(fill, 0)).fill(0), ...rightNums, ...tail];
  if (all.length !== 8) return null;
  return all;
}

function isPrivateIPv6(ip) {
  const g = expandIPv6(ip);
  if (!g) return true; // 解析失败一律视为不安全
  // 未指定地址 ::
  if (g.every(x => x === 0)) return true;
  // 回环 ::1
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) return true;
  // IPv4 映射 ::ffff:a.b.c.d（以及 ::0000 前缀的翻译地址）
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0) {
    if (g[5] === 0xffff) {
      const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
      return isPrivateIPv4(v4);
    }
    if (g[5] === 0) return true; // ::0:0/96 翻译地址段
  }
  // NAT64 众所周知前缀 64:ff9b::/96（目标为公网 IPv4，保守拒绝）
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;
  // ULA fc00::/7
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  // 链路本地 fe80::/10
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  // 组播 ff00::/8
  if ((g[0] & 0xff00) === 0xff00) return true;
  // 文档专用 2001:db8::/32
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  return false;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

/** 校验 hostname：字面 IP 直接判定；域名则解析并校验所有记录 */
async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw createBlockError(`禁止访问内网地址: ${hostname}`);
  }
  if (net.isIPv4(host) || net.isIPv6(host)) {
    if (isPrivateIp(host)) throw createBlockError(`禁止访问内网地址: ${hostname}`);
    return host;
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw createBlockError(`域名解析失败: ${hostname} (${err.code || err.message})`);
  }
  if (!records || records.length === 0) {
    throw createBlockError(`域名解析失败: ${hostname}`);
  }
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      throw createBlockError(`禁止访问内网地址: ${hostname} -> ${r.address}`);
    }
  }
  return records[0].address;
}

function createBlockError(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'ESSRFBLOCKED';
  return err;
}

/* ---------------- 建连时二次校验的 Agent（防 DNS Rebinding） ---------------- */

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err);
    for (const a of addresses) {
      if (isPrivateIp(a.address)) {
        return callback(createBlockError(`禁止访问内网地址: ${hostname} -> ${a.address}`));
      }
    }
    callback(null, addresses[0].address, addresses[0].family);
  });
}

const httpAgent = new http.Agent({ lookup: safeLookup, keepAlive: false });
const httpsAgent = new https.Agent({ lookup: safeLookup, keepAlive: false });

/* ---------------- 主流程 ---------------- */

const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/**
 * SSRF 安全地获取一个 URL 的内容
 * @param {string} urlStr
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=15000]   总超时（含重定向跳转）
 * @param {number} [opts.maxBytes=104857600] 响应体上限，默认 100MB
 * @param {number} [opts.maxRedirects=5]
 * @returns {Promise<{buffer: Buffer, contentType: string|null, status: number, finalUrl: string}>}
 */
async function safeFetch(urlStr, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxBytes = opts.maxBytes ?? 100 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;

  let current = urlStr;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let url;
    try {
      url = new URL(current);
    } catch {
      throw createBlockError(`无效的URL: ${current}`);
    }
    if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
      throw createBlockError(`不允许的协议: ${url.protocol}`);
    }
    if (url.username || url.password) {
      throw createBlockError('不允许携带用户凭证的URL');
    }
    await assertPublicHost(url.hostname);

    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
      headers: { 'User-Agent': 'random-image-api/1.0' },
    });

    // 重定向：手动跟随，每一跳重新校验
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      response.body?.resume(); // 释放连接
      if (!location) throw new Error(`重定向缺少 Location (${response.status})`);
      if (hop === maxRedirects) throw new Error('重定向次数过多');
      current = new URL(location, url).href;
      continue;
    }

    if (!response.ok) {
      response.body?.resume();
      throw new Error(`获取失败 HTTP ${response.status}`);
    }

    // 大小上限：先看 Content-Length，再流式累计兜底
    const declared = parseInt(response.headers.get('content-length') || '0', 10);
    if (declared > maxBytes) {
      response.body?.resume();
      throw new Error(`响应体超过大小上限 (${Math.round(maxBytes / 1024 / 1024)}MB)`);
    }

    const buffer = await readWithCap(response.body, maxBytes);
    return {
      buffer,
      contentType: response.headers.get('content-type'),
      status: response.status,
      finalUrl: url.href,
    };
  }
  throw new Error('重定向次数过多');
}

function readWithCap(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        reject(new Error(`响应体超过大小上限 (${Math.round(maxBytes / 1024 / 1024)}MB)`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    // 停滞的流由 AbortSignal 超时兜底触发 error
  });
}

module.exports = { safeFetch, isPrivateIp, assertPublicHost };
