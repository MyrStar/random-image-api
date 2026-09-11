const QiniuAdapter = require('./qiniu');
const AliyunOSSAdapter = require('./aliyun-oss');
const TencentCOSAdapter = require('./tencent-cos');
const CloudflareR2Adapter = require('./cloudflare-r2');
const MinIOAdapter = require('./minio');
const ExternalAdapter = require('./external');

// 存储类型注册表（只包含已实现的适配器）
// hidden: true 的类型不在"新建存储源"下拉中展示（仅用于内置演示数据）
const adapters = {
  qiniu: { name: '七牛云', Adapter: QiniuAdapter },
  aliyun_oss: { name: '阿里云OSS', Adapter: AliyunOSSAdapter },
  tencent_cos: { name: '腾讯云COS', Adapter: TencentCOSAdapter },
  cloudflare_r2: { name: 'Cloudflare R2', Adapter: CloudflareR2Adapter },
  minio: { name: 'MinIO', Adapter: MinIOAdapter },
  external: { name: '外链图片', Adapter: ExternalAdapter, hidden: true },
};

function createAdapter(type, config, endpoint) {
  const entry = adapters[type];
  if (!entry) {
    throw new Error(`不支持的存储类型: ${type}，当前支持: ${Object.keys(adapters).join(', ')}`);
  }
  return new entry.Adapter(config, endpoint);
}

function getSupportedTypes() {
  return Object.entries(adapters)
    .filter(([, entry]) => !entry.hidden)
    .map(([type, entry]) => ({ type, name: entry.name }));
}

module.exports = { createAdapter, getSupportedTypes };
