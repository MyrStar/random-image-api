const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const StorageAdapter = require('./base');

class CloudflareR2Adapter extends StorageAdapter {
  constructor(config, endpoint) {
    super(config, endpoint);
    this.bucket = config.bucket;
    // R2 使用 S3 兼容接口，endpoint 为 R2 的 API endpoint
    // 格式: https://{account_id}.r2.cloudflarestorage.com
    this.r2Endpoint = config.endpoint || '';
    // R2.dev 公共访问域名（可选，需在 R2 控制台开启公共访问后获取）
    this.publicDomain = config.publicDomain || '';

    this.client = new S3Client({
      region: 'auto',
      endpoint: this.r2Endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async upload(key, buffer, mimeType) {
    const params = {
      Bucket: this.bucket,
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
        Bucket: this.bucket,
        Key: key,
      }));
    } catch (err) {
      // NoSuchKey 也算成功
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return;
      throw err;
    }
  }

  getUrl(key) {
    // 优先使用自定义域名（endpoint参数）
    if (this.endpoint) {
      return `${this.endpoint}/${key}`;
    }
    // 使用 R2.dev 公共域名（需要用户在配置中提供）
    if (this.publicDomain) {
      const domain = this.publicDomain.replace(/\/$/, '');
      return `https://${domain}/${key}`;
    }
    // 无法生成有效URL：直接报错，避免把占位符当作图片URL写进数据库
    const err = new Error('R2 存储源未配置公开访问地址，请在配置中填写「公共域名(publicDomain)」或「访问域名(endpoint)」');
    err.status = 400;
    throw err;
  }

  async list(prefix, marker = null, limit = 1000) {
    const params = {
      Bucket: this.bucket,
      Prefix: prefix || undefined,
      MaxKeys: limit,
    };
    if (marker) params.ContinuationToken = marker;

    const result = await this.client.send(new ListObjectsV2Command(params));
    const items = (result.Contents || []).map(item => ({
      key: item.Key,
      size: item.Size,
    }));

    return {
      items,
      nextMarker: result.IsTruncated ? (result.NextContinuationToken || null) : null,
    };
  }

  async test() {
    try {
      // 没有公共访问地址时无法生成图片URL，直接在测试阶段给出明确提示
      if (!this.endpoint && !this.publicDomain) {
        return { success: false, message: '连接配置不完整：请填写「公共域名(publicDomain)」（R2控制台开启公共访问后获取）或「访问域名(endpoint)」，否则无法生成图片URL' };
      }
      const result = await this.list('', null, 1);
      const hasFiles = result.items.length > 0;
      return { success: true, message: hasFiles ? '连接成功，存储桶中有文件' : '连接成功，存储桶为空' };
    } catch (err) {
      let msg = err.message;
      if (err.name === 'InvalidAccessKeyId' || err.name === 'SignatureDoesNotMatch') {
        msg = '认证失败，请检查 AccessKeyId 和 SecretAccessKey 是否正确';
      } else if (err.name === 'NoSuchBucket') {
        msg = '存储桶不存在，请检查 Bucket 名称';
      } else if (err.$metadata?.httpStatusCode === 403) {
        msg = '权限不足，请检查 R2 API Token 权限';
      } else if (err.$metadata?.httpStatusCode === 401) {
        msg = '认证失败，请检查 R2 API Endpoint、AccessKeyId 和 SecretAccessKey';
      }
      return { success: false, message: `连接失败: ${msg}` };
    }
  }
}

module.exports = CloudflareR2Adapter;
