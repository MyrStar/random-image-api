const crypto = require('crypto');
const config = require('../config');

/**
 * 加密方案 v2：AES-256-GCM（带认证，防篡改）
 * 密文格式：enc:v2:<iv>:<tag>:<ciphertext>（均为 hex）
 * 密钥：对配置的 encryptKey 做 SHA-256 派生为 32 字节，因此任意长度的密钥字符串均可
 *
 * 兼容性：
 * - 旧版 AES-128-CBC 格式（<iv hex 32字符>:<ciphertext hex>）：解密时自动识别
 * - 旧版未加密的明文（不含冒号或不匹配密文格式）：原样返回
 * - 解密失败（如 ENCRYPT_KEY 被修改）会抛出明确错误，不再静默返回原文
 */

const V2_PREFIX = 'enc:v2:';
// 旧版 AES-128-CBC 的密文特征：32位hex的IV + ':' + hex密文
const LEGACY_CBC_RE = /^[0-9a-f]{32}:[0-9a-f]+$/i;

function getKeyV2() {
  return crypto.createHash('sha256').update(String(config.encryptKey), 'utf8').digest();
}

function getKeyLegacy() {
  return Buffer.from(config.encryptKey, 'hex');
}

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKeyV2(), iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return V2_PREFIX + iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(encryptedText) {
  if (!encryptedText) return '';

  // v2 GCM 格式：解密失败说明密钥不匹配，直接抛错（不再伪装成功）
  if (encryptedText.startsWith(V2_PREFIX)) {
    try {
      const [ivHex, tagHex, dataHex] = encryptedText.slice(V2_PREFIX.length).split(':');
      const decipher = crypto.createDecipheriv('aes-256-gcm', getKeyV2(), Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
    } catch {
      const err = new Error('解密失败：加密密钥不匹配（ENCRYPT_KEY 可能已被修改）');
      err.status = 400;
      throw err;
    }
  }

  // 旧版 AES-128-CBC 格式
  if (LEGACY_CBC_RE.test(encryptedText)) {
    try {
      const [ivHex, dataHex] = encryptedText.split(':');
      const decipher = crypto.createDecipheriv('aes-128-cbc', getKeyLegacy(), Buffer.from(ivHex, 'hex'));
      return decipher.update(dataHex, 'hex', 'utf8') + decipher.final('utf8');
    } catch {
      const err = new Error('解密失败：旧版密文解密出错，ENCRYPT_KEY 可能已被修改');
      err.status = 400;
      throw err;
    }
  }

  // 都不匹配：视为历史上未加密的明文数据，原样返回
  return encryptedText;
}

module.exports = { encrypt, decrypt };
