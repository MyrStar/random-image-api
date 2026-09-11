const StorageAdapter = require('./base');

/**
 * 外链图片适配器（内置演示类型，不在新建存储源列表中展示）
 * 图片 URL 直接入库（如 picsum.photos），文件不经对象存储托管，
 * 因此上传/同步/远端删除不可用；取图、缩放等读取功能不受影响。
 */
class ExternalAdapter extends StorageAdapter {
  async upload() {
    throw Object.assign(new Error('外链图片存储不支持上传，请使用对象存储类型的存储源'), { status: 400 });
  }

  async delete() {
    // 远端文件不归本系统托管，无需删除；数据库记录由业务层删除
  }

  getUrl(key) {
    // key 即完整 URL
    return key;
  }

  async list() {
    throw Object.assign(new Error('外链图片存储不支持同步，图片 URL 已直接入库'), { status: 400 });
  }

  async test() {
    return { success: true, message: '外链图片存储无需连接测试' };
  }
}

module.exports = ExternalAdapter;
