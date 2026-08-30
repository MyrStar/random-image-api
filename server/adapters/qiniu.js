const qiniu = require('qiniu');
const StorageAdapter = require('./base');

class QiniuAdapter extends StorageAdapter {
  constructor(config, endpoint) {
    super(config, endpoint);
    this.mac = new qiniu.auth.digest.Mac(config.accessKey, config.secretKey);
    this.bucket = config.bucket;
    this.bucketManager = new qiniu.rs.BucketManager(this.mac, this._getConfig());
  }

  _getConfig() {
    const cfg = new qiniu.conf.Config();
    // 可选区域: z0=华东, z1=华北, z2=华南, na0=北美, as0=东南亚
    if (this.config.region) {
      const regionMap = {
        'z0': qiniu.zone.Zone_z0,
        'z1': qiniu.zone.Zone_z1,
        'z2': qiniu.zone.Zone_z2,
        'na0': qiniu.zone.Zone_na0,
        'as0': qiniu.zone.Zone_as0,
      };
      const zone = regionMap[this.config.region];
      // 无效 region 静默回退会让海外空间打到错误区域的 API 上、报难以定位的鉴权/网络错误，必须显式报错
      if (!zone) {
        throw new Error(`不支持的区域(Region): ${this.config.region}，可选值：z0/z1/z2/na0/as0`);
      }
      cfg.zone = zone;
    }
    return cfg;
  }

  _getUploadToken(key) {
    const putPolicy = new qiniu.rs.PutPolicy({ scope: `${this.bucket}:${key}` });
    return putPolicy.uploadToken(this.mac);
  }

  async upload(key, buffer, mimeType) {
    const token = this._getUploadToken(key);
    const formUploader = new qiniu.form_up.FormUploader(this._getConfig());
    const putExtra = new qiniu.form_up.PutExtra();
    putExtra.mimeType = mimeType;

    return new Promise((resolve, reject) => {
      formUploader.put(token, key, buffer, putExtra, (err, body, info) => {
        if (err) return reject(err);
        if (info.statusCode !== 200) {
          return reject(new Error(`Upload failed: ${info.statusCode}`));
        }
        resolve({ url: this.getUrl(body.key) });
      });
    });
  }

  async delete(key) {
    return new Promise((resolve, reject) => {
      this.bucketManager.delete(this.bucket, key, (err, body, info) => {
        if (err) return reject(err);
        if (info.statusCode === 200 || info.statusCode === 612) {
          resolve(); // 612 = 文件不存在，也算成功
        } else {
          reject(new Error(`Delete failed: ${info.statusCode}`));
        }
      });
    });
  }

  getUrl(key) {
    if (this.endpoint) {
      return `${this.endpoint}/${key}`;
    }
    // 如果没有配置endpoint，使用七牛默认CDN域名（https）
    // 注意：qiniudn.com 是旧域名，建议在控制台绑定自定义域名并配置 endpoint
    return `https://${this.bucket}.qiniudn.com/${key}`;
  }

  async list(prefix, marker = null, limit = 1000) {
    const options = { prefix, limit, delimiter: '' };
    if (marker) options.marker = marker;

    return new Promise((resolve, reject) => {
      this.bucketManager.listPrefix(this.bucket, options, (err, body, info) => {
        if (err) return reject(err);
        if (info.statusCode !== 200) {
          const detail = body ? JSON.stringify(body) : '';
          return reject(new Error(`List failed: ${info.statusCode} ${detail}`));
        }
        const items = (body.items || []).map(item => ({
          key: item.key,
          size: item.fsize,
        }));
        resolve({
          items,
          nextMarker: body.marker || null,
        });
      });
    });
  }

  async test() {
    try {
      const result = await this.list('', null, 1);
      const hasFiles = result.items.length > 0;
      return { success: true, message: hasFiles ? '连接成功，存储桶中有文件' : '连接成功，存储桶为空' };
    } catch (err) {
      // 解析七牛云错误信息
      let msg = err.message;
      if (msg.includes('401')) {
        msg = '认证失败，请检查 AccessKey、SecretKey 和 Bucket 是否正确，以及区域(Region)是否匹配';
      }
      return { success: false, message: `连接失败: ${msg}` };
    }
  }
}

module.exports = QiniuAdapter;
