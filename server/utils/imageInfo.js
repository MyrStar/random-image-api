const path = require('path');
const imageSize = require('image-size');

const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

// 各二进制格式的魔数特征
const MAGIC_SIGNATURES = [
  { ext: '.jpg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.jpeg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.png', test: b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: '.gif', test: b => b.length > 6 && b.slice(0, 6).toString('ascii') === 'GIF87a' },
  { ext: '.gif', test: b => b.length > 6 && b.slice(0, 6).toString('ascii') === 'GIF89a' },
  { ext: '.webp', test: b => b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
  { ext: '.bmp', test: b => b.length > 2 && b[0] === 0x42 && b[1] === 0x4d },
  { ext: '.ico', test: b => b.length > 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00 },
  { ext: '.avif', test: b => b.length > 12 && b.slice(4, 8).toString('ascii') === 'ftyp' && b.slice(8, 12).toString('ascii').startsWith('avi') },
];

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function isImage(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ext in MIME_MAP;
}

/**
 * 上传文件校验：扩展名必须在允许列表内，且二进制格式需匹配魔数；
 * SVG 为文本格式，需确保是 XML/SVG 文本且不含内联脚本。
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateImageFile(filename, buffer) {
  const ext = path.extname(filename).toLowerCase();
  if (!(ext in MIME_MAP)) {
    return { ok: false, reason: `不支持的文件类型: ${filename}` };
  }
  if (!buffer || buffer.length === 0) {
    return { ok: false, reason: `文件为空: ${filename}` };
  }

  if (ext === '.svg') {
    const head = buffer.slice(0, 4096).toString('utf8', 0, Math.min(buffer.length, 4096)).trimStart();
    const isXmlOrSvg = head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!--');
    if (!isXmlOrSvg) {
      return { ok: false, reason: `文件内容与扩展名不符: ${filename}` };
    }
    if (/<script[\s>]/i.test(buffer.slice(0, 1024 * 1024).toString('utf8'))) {
      return { ok: false, reason: `SVG 不允许包含 script 标签: ${filename}` };
    }
    return { ok: true };
  }

  const matched = MAGIC_SIGNATURES.some(sig => sig.ext === ext && sig.test(buffer));
  if (!matched) {
    return { ok: false, reason: `文件内容与扩展名不符: ${filename}` };
  }
  return { ok: true };
}

/**
 * 解析图片元数据（宽高）
 * 先做魔数预检：仅允许已知安全的二进制格式进入 image-size 解析器，
 * 规避 image-size 对 ICNS/JXL/HEIF 等格式解析死循环的已知漏洞（无上游修复）
 * @param {Buffer} buffer - 图片二进制数据
 * @returns {{ width: number, height: number }}
 */
function getImageDimensions(buffer) {
  try {
    if (!buffer || !buffer.length) return { width: 0, height: 0 };
    const isKnownBinary = MAGIC_SIGNATURES.some(sig => sig.test(buffer));
    if (!isKnownBinary) return { width: 0, height: 0 };
    const result = imageSize(buffer);
    if (result) {
      return { width: result.width || 0, height: result.height || 0 };
    }
    return { width: 0, height: 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

module.exports = { getMimeType, isImage, getImageDimensions, validateImageFile };
