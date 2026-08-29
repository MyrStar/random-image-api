const Minio = require('minio');
const StorageAdapter = require('./base');

class MinIOAdapter extends StorageAdapter {
  constructor(config, endpoint) {
    super(config, endpoint);
    this.bucket = config.bucket;

    // 解析 endPoint：可以是完整 URL 或纯域名
    let endPoint = config.endPoint || '';
    let useSSL = config.useSSL !== false; // 默认 true
    let port = parseInt(config.port, 10) || 0;

    if (endPoint.startsWith('http://')) {
      useSSL = false;
      endPoint = endPoint.replace('http://', '');
    } else if (endPoint.startsWith('https://')) {
      useSSL = true;
      endPoint = endPoint.replace('https://', '');
    }

    // 去除端口号（如果有）
    if (endPoint.includes(':')) {
      const parts = endPoint.split(':');
      endPoint = parts[0];
      if (!port) port = parseInt(parts[1], 10);
    }

    if (!port) port = useSSL ? 443 : 80;

    this.client = new Minio.Client({
      endPoint,
      port,
      useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      // 可选：region
      ...(config.region ? { region: config.region } : {}),
    });
  }

  async upload(key, buffer, mimeType) {
    const metaData = {};
    if (mimeType) metaData['Content-Type'] = mimeType;
    await this.client.putObject(this.bucket, key, buffer, buffer.length, metaData);
    return { url: this.getUrl(key) };
  }

  async delete(key) {
    try {
      await this.client.removeObject(this.bucket, key);
    } catch (err) {
      // 文件不存在也视为成功
      if (err.code === 'NoSuchKey' || err.message?.includes('not found') || err.message?.includes('NoSuchKey')) return;
      throw err;
    }
  }

  getUrl(key) {
    if (this.endpoint) {
      return `${this.endpoint}/${key}`;
    }
    // 构造默认 URL
    const cfg = this.client;
    const protocol = cfg.useSSL ? 'https' : 'http';
    const port = cfg.port === 80 || cfg.port === 443 ? '' : `:${cfg.port}`;
    return `${protocol}://${cfg.endPoint}${port}/${this.bucket}/${key}`;
  }

  async list(prefix, marker = null, limit = 1000) {
    // 使用 ListObjectsV2 + startAfter 服务端分页，避免每页都从头全量扫描（O(n²)）
    return new Promise((resolve, reject) => {
      const items = [];
      let count = 0;
      let resolved = false;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolve({
          items,
          nextMarker: count >= limit ? (items[items.length - 1]?.key ?? null) : null,
        });
      };

      const stream = this.client.listObjectsV2(this.bucket, prefix || '', true, marker || undefined);

      stream.on('data', obj => {
        if (count >= limit) {
          stream.destroy();
          return;
        }
        items.push({
          key: obj.name,
          size: obj.size,
          lastModified: obj.lastModified,
        });
        count++;
      });

      stream.on('error', err => {
        if (resolved) return;
        resolved = true;
        reject(err);
      });
      stream.on('end', finish);
      stream.on('close', finish);
    });
  }

  async test() {
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        return { success: false, message: `连接失败: 存储桶 "${this.bucket}" 不存在` };
      }
      return { success: true, message: '连接成功，存储桶存在' };
    } catch (err) {
      let msg = err.message;
      if (err.code === 'AccessDenied' || err.statusCode === 403) {
        msg = '认证失败或权限不足，请检查 AccessKey、SecretKey 和服务地址';
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        msg = '无法连接到 MinIO 服务，请检查服务地址和端口';
      }
      return { success: false, message: `连接失败: ${msg}` };
    }
  }
}

module.exports = MinIOAdapter;
