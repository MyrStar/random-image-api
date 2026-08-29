const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * 系统配置模块
 * 支持从数据库运行时读取配置，.env 作为初始默认值
 *
 * 配置优先级：
 * 1. 数据库 system_settings 表（运行时可修改）
 * 2. .env 环境变量（首次启动的初始值）
 * 3. 代码中的默认值
 *
 * 安全设计：
 * - 管理员密码以 bcrypt 哈希形式存库（键 adminPassHash），数据库中不落明文
 * - 在线修改密码后会记录 passwordChangedAt，早于该时间签发的 JWT 全部失效
 * - 启动时校验默认弱密钥：生产环境（NODE_ENV=production）直接拒绝启动，
 *   除非显式设置 ALLOW_INSECURE_DEFAULTS=1
 */

// 从 .env 读取的初始默认值
const envDefaults = {
  port: parseInt(process.env.PORT) || 3100,
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'admin123',
  jwtSecret: process.env.JWT_SECRET || 'change-me-in-production',
  encryptKey: process.env.ENCRYPT_KEY || '0123456789abcdef0123456789abcdef',
  dbPath: path.resolve(process.env.DB_PATH || './data/images.db'),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3100').replace(/\/$/, ''),
  corsOrigins: process.env.CORS_ORIGINS || '*',
  uploadMaxSize: parseInt(process.env.UPLOAD_MAX_SIZE) || 50,
  uploadMaxFiles: parseInt(process.env.UPLOAD_MAX_FILES) || 20,
  cacheMaxSize: parseInt(process.env.CACHE_MAX_SIZE) || 500,
  resizeMaxDimension: parseInt(process.env.RESIZE_MAX_DIMENSION) || 4096,
  autoSaveInterval: parseInt(process.env.AUTO_SAVE_INTERVAL) || 30,
  rateLimitPublic: parseInt(process.env.RATE_LIMIT_PUBLIC) || 120,
  rateLimitLogin: parseInt(process.env.RATE_LIMIT_LOGIN) || 10,
};

// 当前运行时配置（初始从 envDefaults 加载）
const _config = { ...envDefaults };

// 管理员密码的 bcrypt 哈希（运行时校验用；明文仅存在于内存）
let _adminPassHash = null;
// 密码最后修改时间（unix 秒），早于该时间签发的 JWT 失效
let _passwordChangedAt = 0;

// 数据库是否已初始化
let _dbReady = false;

// 热更新回调：当需要重启相关服务的配置变更时调用
const _hotReloadCallbacks = [];

/**
 * 注册热更新回调
 * 回调接收 (key, value) 参数
 */
function onHotReload(fn) {
  _hotReloadCallbacks.push(fn);
}

/** 数据库中保存/更新一个设置行 */
function upsertRow(db, key, value) {
  db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')
  `).run(key, String(value));
}

/**
 * 持久化设置：普通键直接存；密码键只存 bcrypt 哈希，并清除历史明文
 */
function persistSetting(db, key, value) {
  if (key === 'adminPass') {
    _adminPassHash = bcrypt.hashSync(String(value), 10);
    upsertRow(db, 'adminPassHash', _adminPassHash);
    // 清理旧版本可能遗留的明文密码
    db.prepare('DELETE FROM system_settings WHERE key = ?').run('adminPass');
    return;
  }
  upsertRow(db, key, value);
}

/**
 * 从数据库加载配置，覆盖默认值
 * 在数据库初始化完成后调用
 */
function loadFromDatabase() {
  try {
    const { getDb } = require('./database');
    const db = getDb();

    // 确保 system_settings 表存在
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT (datetime('now','localtime'))
      )
    `);

    const numericKeys = [
      'port', 'uploadMaxSize', 'uploadMaxFiles', 'cacheMaxSize',
      'resizeMaxDimension', 'autoSaveInterval', 'rateLimitPublic', 'rateLimitLogin'
    ];
    const rows = db.prepare('SELECT key, value FROM system_settings').all();
    for (const row of rows) {
      if (row.key === 'adminPassHash') {
        _adminPassHash = row.value;
        continue;
      }
      if (row.key === 'passwordChangedAt') {
        _passwordChangedAt = parseInt(row.value) || 0;
        continue;
      }
      if (row.key === 'adminPass') {
        // 迁移：旧版本把明文密码写进了数据库，转为哈希并删除明文
        _adminPassHash = bcrypt.hashSync(row.value, 10);
        db.transaction(() => {
          upsertRow(db, 'adminPassHash', _adminPassHash);
          db.prepare('DELETE FROM system_settings WHERE key = ?').run('adminPass');
        });
        console.log('[Config] 已将数据库中的明文管理员密码迁移为 bcrypt 哈希');
        continue;
      }
      if (row.key in _config) {
        _config[row.key] = numericKeys.includes(row.key)
          ? parseInt(row.value)
          : row.value;
      }
    }

    // 若从未设置过密码（无哈希），用 .env 值生成内存哈希，校验统一走 bcrypt
    if (!_adminPassHash) {
      _adminPassHash = bcrypt.hashSync(String(_config.adminPass), 10);
    }

    _dbReady = true;
  } catch (e) {
    // 数据库还没初始化，使用默认值
    console.log('[Config] 数据库未就绪，使用环境变量/默认配置');
    if (!_adminPassHash) {
      _adminPassHash = bcrypt.hashSync(String(_config.adminPass), 10);
    }
  }
}

/**
 * 启动安全校验：检测默认弱密钥
 * 生产环境检测到弱密钥时抛错（由入口拒绝启动），
 * 设置 ALLOW_INSECURE_DEFAULTS=1 可显式跳过（不推荐）。
 */
function checkStartupSecurity() {
  const insecureDefaults = {
    adminPass: ['admin123', 'your_secure_password_here'],
    jwtSecret: ['change-me-in-production', 'your_jwt_secret_here'],
    encryptKey: ['0123456789abcdef0123456789abcdef'],
  };

  const problems = [];
  // 密码已经在线设置过（有哈希）时，.env 里的默认值不再作为校验依据
  if (!_adminPassHash && (!_config.adminPass || insecureDefaults.adminPass.includes(_config.adminPass))) {
    problems.push('管理员密码 (ADMIN_PASS) 仍为默认/示例值');
  }
  if (!_config.jwtSecret || insecureDefaults.jwtSecret.includes(_config.jwtSecret)) {
    problems.push('JWT 密钥 (JWT_SECRET) 仍为默认/示例值，任何人可伪造登录凭证');
  } else if (String(_config.jwtSecret).length < 16) {
    problems.push('JWT 密钥 (JWT_SECRET) 过短（建议 ≥ 32 位随机字符串）');
  }
  if (!_config.encryptKey || insecureDefaults.encryptKey.includes(_config.encryptKey)) {
    problems.push('加密密钥 (ENCRYPT_KEY) 仍为公开的默认值，存储凭证形同明文');
  }

  if (problems.length === 0) return;

  const text = '检测到不安全的默认配置:\n  - ' + problems.join('\n  - ')
    + '\n请在 .env 中修改这些值后再部署（随机生成命令见 README）';

  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_INSECURE_DEFAULTS !== '1') {
    throw new Error(text);
  }
  console.warn('┌──────────────────────────────────────────────');
  console.warn('│ [安全警告] ' + text.replace(/\n/g, '\n│ '));
  console.warn('└──────────────────────────────────────────────');
}

/**
 * 更新配置项并持久化到数据库
 * 部分配置支持热更新（无需重启）
 */
function setSetting(key, value) {
  if (!(key in _config)) {
    throw new Error(`未知的配置项: ${key}`);
  }
  const oldValue = _config[key];
  _config[key] = value;

  if (_dbReady) {
    const { getDb } = require('./database');
    persistSetting(getDb(), key, value);
  }

  if (key === 'adminPass' && oldValue !== value) {
    touchPasswordChangedAt();
  }

  // 值实际发生变化时，触发热更新回调
  if (oldValue !== value) {
    fireHotReload(key, value, oldValue);
  }
}

function fireHotReload(key, value, oldValue) {
  for (const fn of _hotReloadCallbacks) {
    try { fn(key, value, oldValue); } catch (e) { console.error('[Config HotReload Error]', e.message); }
  }
}

function touchPasswordChangedAt() {
  _passwordChangedAt = Math.floor(Date.now() / 1000);
  if (_dbReady) {
    const { getDb } = require('./database');
    upsertRow(getDb(), 'passwordChangedAt', _passwordChangedAt);
  }
}

/**
 * 批量更新配置（单事务持久化，保证原子性）
 */
function updateSettings(settings) {
  const changes = [];
  const oldValues = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!(key in _config)) continue;
    if (_config[key] !== value) {
      oldValues[key] = _config[key];
      _config[key] = value;
      changes.push(key);
    }
  }

  if (_dbReady && changes.length > 0) {
    const { getDb } = require('./database');
    const db = getDb();
    db.transaction(() => {
      for (const key of changes) {
        persistSetting(db, key, _config[key]);
      }
      if (changes.includes('adminPass')) {
        upsertRow(db, 'passwordChangedAt', Math.floor(Date.now() / 1000));
      }
    });
  }

  if (changes.includes('adminPass')) {
    _passwordChangedAt = Math.floor(Date.now() / 1000);
  }

  // 触发热更新回调（传入真实的 oldValue）
  for (const key of changes) {
    fireHotReload(key, _config[key], oldValues[key]);
  }

  return changes;
}

/**
 * 校验管理员密码（bcrypt）
 */
function verifyAdminPassword(input) {
  if (_adminPassHash) {
    try {
      return bcrypt.compareSync(String(input ?? ''), _adminPassHash);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 获取所有可配置项（脱敏后的）
 */
function getAllSettings() {
  return {
    port: _config.port,
    adminUser: _config.adminUser,
    adminPass: _adminPassHash ? '********' : maskSecret(_config.adminPass),
    jwtSecret: maskSecret(_config.jwtSecret),
    encryptKey: maskSecret(_config.encryptKey),
    dbPath: _config.dbPath,
    publicUrl: _config.publicUrl,
    corsOrigins: _config.corsOrigins,
    uploadMaxSize: _config.uploadMaxSize,
    uploadMaxFiles: _config.uploadMaxFiles,
    cacheMaxSize: _config.cacheMaxSize,
    resizeMaxDimension: _config.resizeMaxDimension,
    autoSaveInterval: _config.autoSaveInterval,
    rateLimitPublic: _config.rateLimitPublic,
    rateLimitLogin: _config.rateLimitLogin,
  };
}

/**
 * 获取原始配置值（内部使用，不脱敏）
 */
function getRaw(key) {
  return _config[key];
}

/**
 * 脱敏显示：仅显示前2后2位
 */
function maskSecret(val) {
  if (!val || val.length <= 4) return '****';
  return val.slice(0, 2) + '****' + val.slice(-2);
}

// 兼容旧代码的导出格式
module.exports = {
  // 兼容属性访问
  get port() { return _config.port; },
  get admin() { return { user: _config.adminUser, pass: _config.adminPass }; },
  get jwt() { return { secret: _config.jwtSecret, expiresIn: '7d' }; },
  get encryptKey() { return _config.encryptKey; },
  get dbPath() { return _config.dbPath; },
  get publicUrl() { return _config.publicUrl; },
  get corsOrigins() { return _config.corsOrigins; },
  get uploadMaxSize() { return _config.uploadMaxSize; },
  get uploadMaxFiles() { return _config.uploadMaxFiles; },
  get cacheMaxSize() { return _config.cacheMaxSize; },
  get resizeMaxDimension() { return _config.resizeMaxDimension; },
  get autoSaveInterval() { return _config.autoSaveInterval; },
  get rateLimitPublic() { return _config.rateLimitPublic; },
  get rateLimitLogin() { return _config.rateLimitLogin; },
  get passwordChangedAt() { return _passwordChangedAt; },

  // 方法
  loadFromDatabase,
  checkStartupSecurity,
  setSetting,
  updateSettings,
  getAllSettings,
  getRaw,
  maskSecret,
  onHotReload,
  verifyAdminPassword,

  // 所有配置项的 key 列表和元信息
  SETTINGS_META: {
    port: { label: '服务端口', type: 'number', group: 'basic', min: 1, max: 65535, restart: false, hotReload: true },
    adminUser: { label: '管理员用户名', type: 'text', group: 'security', restart: false },
    adminPass: { label: '管理员密码', type: 'password', group: 'security', restart: false, secret: true, warning: '修改后所有已登录会话将立即失效，需重新登录' },
    jwtSecret: { label: 'JWT 密钥', type: 'password', group: 'security', restart: false, secret: true, warning: '修改后所有已登录用户需重新登录' },
    encryptKey: { label: '加密密钥', type: 'password', group: 'security', restart: false, secret: true, warning: '修改后已有存储源密钥将无法解密！请先删除所有存储源再修改' },
    publicUrl: { label: '公开访问地址', type: 'text', group: 'basic', restart: false },
    corsOrigins: { label: 'CORS 允许来源', type: 'text', group: 'basic', restart: false, placeholder: '逗号分隔，* 表示全部允许' },
    dbPath: { label: '数据库路径', type: 'text', group: 'advanced', restart: true, readonly: true },
    uploadMaxSize: { label: '上传大小限制 (MB)', type: 'number', group: 'upload', min: 1, max: 200, restart: false },
    uploadMaxFiles: { label: '单次上传文件数上限', type: 'number', group: 'upload', min: 1, max: 100, restart: false },
    resizeMaxDimension: { label: '图片缩放最大尺寸 (px)', type: 'number', group: 'upload', min: 100, max: 16384, restart: false },
    cacheMaxSize: { label: '缓存最大条目数', type: 'number', group: 'advanced', min: 10, max: 10000, restart: false },
    autoSaveInterval: { label: '自动保存间隔 (秒)', type: 'number', group: 'advanced', min: 5, max: 300, restart: false, hotReload: true },
    rateLimitPublic: { label: '公开API频率限制 (次/分)', type: 'number', group: 'advanced', min: 10, max: 1000, restart: false },
    rateLimitLogin: { label: '登录频率限制 (次/分)', type: 'number', group: 'advanced', min: 3, max: 60, restart: false },
  },
};
