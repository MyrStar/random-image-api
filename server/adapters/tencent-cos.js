const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const StorageAdapter = require('./base');

/**
 * 腾讯云 COS 适配器
 * 基于 AWS S3 兼容协议实现（cos-nodejs-sdk-v5 依赖链存在多个严重漏洞，已弃用）：
 * endpoint: https://cos.{region}.myqcloud.com，Bucket: {name}-{appid}，签名用 SecretId/SecretKey
 */
class TencentCOSAdapter extends StorageAdapter {
  constructor(config, endpoint) {
    super(config, endpoint);
    this.bucket = config.bucket;
    this.region = config.region || 'ap-guangzhou';

    this.client = new S3Client({
      region: this.region,
      // 虚拟主机风格：https://{bucket}.cos.{region}.myqcloud.com（COS 官方 S3 兼容格式）
      endpoint: `https://cos.${this.region}.myqcloud.com`,
      credentials: {
        accessKeyId: config.secretId,
        secretAccessKey: config.secretKey,
      },
    });
  }

  _getBucket() {
    // bucket 格式: bucketname-appid
    return this.bucket;
  }

  async upload(key, buffer, mimeType) {
    const params = {
      Bucket: this._getBucket(),
      Key: key,
      Body: buffer,
    };
    if (mimeType) params.ContentType = mimeType;

    await this.client.send(new PutObjectCommand(params));
    return { url: this.getUrl(key) };
  }

  async delete(key) {
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this._getBucket(),
        Key: key,
      }));
    } catch (err) {
      // 文件不存在也视为成功
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404 || err.$metadata?.httpStatusCode === 204) return;
      throw err;
    }
  }

  getUrl(key) {
    if (this.endpoint) {
      return `${this.endpoint}/${key}`;
    }
    // 使用默认域名: https://{bucket}.cos.{region}.myqcloud.com/{key}
    return `https://${this._getBucket()}.cos.${this.region}.myqcloud.com/${key}`;
  }

  async list(prefix, marker = null, limit = 1000) {
    const params = {
      Bucket: this._getBucket(),
      Prefix: prefix || undefined,
      MaxKeys: limit,
    };
    if (marker) params.ContinuationToken = marker;

    const result = await this.client.send(new ListObjectsV2Command(params));
    const items = (result.Contents || []).map(item => ({
      key: item.Key,
      size: Number(item.Size) || 0,
      lastModified: item.LastModified,
    }));
    return {
      items,
      nextMarker: result.IsTruncated ? (result.NextContinuationToken || null) : null,
    };
  }

  async test() {
    try {
      const result = await this.list('', null, 1);
      const hasFiles = result.items.length > 0;
      return { success: true, message: hasFiles ? '连接成功，存储桶中有文件' : '连接成功，存储桶为空' };
    } catch (err) {
      let msg = err.message;
      if (err.name === 'InvalidAccessKeyId' || err.name === 'SignatureDoesNotMatch') {
        msg = '认证失败，请检查 SecretId、SecretKey 是否正确';
      } else if (err.name === 'NoSuchBucket') {
        msg = '存储桶不存在，请检查 Bucket 名称和区域(Region)是否匹配';
      } else if (err.$metadata?.httpStatusCode === 403) {
        msg = '认证失败或权限不足，请检查 SecretId、SecretKey 和 Bucket 是否正确';
      }
      return { success: false, message: `连接失败: ${msg}` };
    }
  }
}

module.exports = TencentCOSAdapter;
