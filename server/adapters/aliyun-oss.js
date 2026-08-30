const OSS = require('ali-oss');
const StorageAdapter = require('./base');

class AliyunOSSAdapter extends StorageAdapter {
  constructor(config, endpoint) {
    super(config, endpoint);
    // API 操作（上传/列表/删除）始终走官方区域端点：
    // 访问域名通常是 CDN 域名，不转发 OSS 签名 API 请求，cname 模式会导致同步/上传全部失败
    this.client = new OSS({
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      bucket: config.bucket,
      region: config.region || 'oss-cn-hangzhou',
    });
  }

  async upload(key, buffer, mimeType) {
    const options = {};
    if (mimeType) options.headers = { 'Content-Type': mimeType };
    await this.client.put(key, buffer, options);
    return { url: this.getUrl(key) };
  }

  async delete(key) {
    try {
      await this.client.delete(key);
    } catch (err) {
      // 文件不存在也视为成功
      if (err.code === 'NoSuchKey' || err.status === 404) return;
      throw err;
    }
  }

  getUrl(key) {
    if (this.endpoint) {
      return `${this.endpoint}/${key}`;
    }
    // 使用默认域名: https://{bucket}.{region}.aliyuncs.com/{key}
    const region = this.config.region || 'oss-cn-hangzhou';
    return `https://${this.config.bucket}.${region}.aliyuncs.com/${key}`;
  }

  async list(prefix, marker = null, limit = 1000) {
    const options = { prefix, 'max-keys': limit };
    if (marker) options.marker = marker;

    const result = await this.client.list(options);
    const items = (result.objects || []).map(item => ({
      key: item.name,
      size: item.size,
    }));

    return {
      items,
      nextMarker: result.isTruncated ? result.nextMarker : null,
    };
  }

  async test() {
    try {
      const result = await this.list('', null, 1);
      const hasFiles = result.items.length > 0;
      return { success: true, message: hasFiles ? '连接成功，存储桶中有文件' : '连接成功，存储桶为空' };
    } catch (err) {
      let msg = err.message;
      if (err.code === 'InvalidAccessKeyId' || err.code === 'SignatureDoesNotMatch') {
        msg = '认证失败，请检查 AccessKeyId、AccessKeySecret 是否正确';
      } else if (err.code === 'NoSuchBucket') {
        msg = '存储桶不存在，请检查 Bucket 名称和区域(Region)是否匹配';
      } else if (err.status === 403) {
        msg = '权限不足，请检查 RAM 策略是否包含 OSS 读写权限';
      }
      return { success: false, message: `连接失败: ${msg}` };
    }
  }
}

module.exports = AliyunOSSAdapter;
