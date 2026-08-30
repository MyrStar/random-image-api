/**
 * 存储适配器基类
 * 所有存储适配器必须继承此类并实现抽象方法
 */
const { normalizeEndpoint } = require('../utils/endpoint');

class StorageAdapter {
  constructor(config, endpoint) {
    this.endpoint = normalizeEndpoint(endpoint);
    this.config = config;
  }

  /**
   * 上传文件
   * @param {string} key - 存储路径/key
   * @param {Buffer} buffer - 文件内容
   * @param {string} mimeType - MIME类型
   * @returns {Promise<{ url: string }>}
   */
  async upload(key, buffer, mimeType) {
    throw new Error('Not implemented');
  }

  /**
   * 删除文件
   * @param {string} key - 存储路径/key
   * @returns {Promise<void>}
   */
  async delete(key) {
    throw new Error('Not implemented');
  }

  /**
   * 获取文件公开访问URL
   * @param {string} key - 存储路径/key
   * @returns {string}
   */
  getUrl(key) {
    throw new Error('Not implemented');
  }

  /**
   * 列出目录下的文件
   * @param {string} prefix - 目录前缀
   * @param {string|null} marker - 分页标记
   * @param {number} limit - 每页数量
   * @returns {Promise<{ items: Array<{key: string, size: number}>, nextMarker: string|null }>}
   */
  async list(prefix, marker = null, limit = 1000) {
    throw new Error('Not implemented');
  }

  /**
   * 测试存储连接
   * @returns {Promise<{ success: boolean, message: string }>}
   */
  async test() {
    throw new Error('Not implemented');
  }
}

module.exports = StorageAdapter;
