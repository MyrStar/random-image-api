const express = require('express');
const path = require('path');
const config = require('./config');
const { initDatabase, startAutoSave, stopAutoSave, getDb } = require('./database');

async function main() {
  // 初始化数据库
  await initDatabase();

  // 从数据库加载运行时配置（覆盖 .env 默认值）
  config.loadFromDatabase();

  // 启动安全校验：默认弱密钥在生产环境直接拒绝启动
  config.checkStartupSecurity();

  startAutoSave();

  const routes = require('./routes');
  const errorHandler = require('./middleware/errorHandler');

  const app = express();

  // 反向代理支持：默认只信任本机回环上的代理（Nginx 同机部署）。
  // 可通过 TRUST_PROXY 环境变量调整：true / 跳数 / CIDR 列表（逗号分隔）
  const trustProxy = process.env.TRUST_PROXY || 'loopback';
  if (trustProxy === 'true') {
    app.set('trust proxy', true);
  } else if (/^\d+$/.test(trustProxy)) {
    app.set('trust proxy', parseInt(trustProxy, 10));
  } else if (trustProxy !== 'false' && trustProxy !== '0') {
    app.set('trust proxy', trustProxy.split(',').map(s => s.trim()).filter(Boolean));
  }

  // 基础安全响应头
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // 管理后台页面的 CSP（API 响应无需）
  const CSP_ADMIN = "default-src 'self'; img-src * data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:";
  app.use('/admin', (req, res, next) => {
    if (!req.path.startsWith('/api')) {
      res.setHeader('Content-Security-Policy', CSP_ADMIN);
    }
    next();
  });

  // CORS（手写实现，替代 cors 包）：
  // - 允许来源为 * 时不发送 Allow-Credentials（避免"通配 + 凭证"的危险组合）
  // - 白名单模式按原始大小写无关、忽略尾斜杠匹配，命中后回显 origin 并允许凭证
  function normalizeOrigin(origin) {
    if (!origin) return '';
    try {
      const u = new URL(origin);
      return `${u.protocol}//${u.host}`.toLowerCase();
    } catch {
      return origin.toLowerCase().replace(/\/+$/, '');
    }
  }
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next(); // 无 Origin（同源、curl、服务端调用）无需 CORS 头

    const allowed = String(config.corsOrigins ?? '*').trim();
    if (allowed === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      const list = allowed.split(',').map(s => normalizeOrigin(s.trim())).filter(Boolean);
      if (!list.includes(normalizeOrigin(origin))) {
        return next(); // 不在白名单：不下发 CORS 头，浏览器会拦截
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
      return res.status(204).end();
    }
    next();
  });

  // 健康检查（供 Docker HEALTHCHECK / 负载均衡探测使用，不参与限流）
  app.get('/health', (req, res) => {
    res.json({ code: 0, data: { status: 'ok', uptime: Math.floor(process.uptime()) } });
  });

  // 简易请求频率限制（登录和公开API使用独立计数器）
  const loginLimitMap = new Map();
  const publicLimitMap = new Map();
  const RATE_WINDOW = 60 * 1000; // 1分钟

  function makeRateLimiter(map, getLimit, name) {
    return (req, res, next) => {
      const key = req.ip;
      const now = Date.now();
      const entry = map.get(key) || { count: 0, start: now };
      if (now - entry.start > RATE_WINDOW) {
        entry.count = 1;
        entry.start = now;
      } else {
        entry.count++;
      }
      map.set(key, entry);
      if (entry.count > getLimit()) {
        return res.status(429).json({ code: 429, message: '请求过于频繁，请稍后再试' });
      }
      next();
    };
  }
  app.use('/admin/api/login', makeRateLimiter(loginLimitMap, () => config.rateLimitLogin, 'login'));
  app.use('/api/', makeRateLimiter(publicLimitMap, () => config.rateLimitPublic, 'public'));

  // 定期清理过期的频率限制记录
  const rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of loginLimitMap) {
      if (now - entry.start > RATE_WINDOW * 2) loginLimitMap.delete(key);
    }
    for (const [key, entry] of publicLimitMap) {
      if (now - entry.start > RATE_WINDOW * 2) publicLimitMap.delete(key);
    }
  }, 5 * 60 * 1000);

  // 中间件：管理接口均为小体积 JSON，收紧体积上限防止内存放大攻击
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // 静态文件 - 前端构建产物
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use('/admin', express.static(clientDist, {
    maxAge: '7d',
    setHeaders(res, filePath) {
      // HTML 不缓存，保证发版后立即生效
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  // API路由
  app.use(routes);

  // 前端SPA fallback - /admin下的非API请求都返回index.html
  app.get('/admin/*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  // 根路径重定向到管理后台
  app.get('/', (req, res) => {
    res.redirect('/admin');
  });

  // 错误处理
  app.use(errorHandler);

  const server = app.listen(config.port, () => {
    console.log(`随机图片API服务已启动: http://localhost:${config.port}`);
    console.log(`管理后台: http://localhost:${config.port}/admin`);
    console.log(`随机图片API示例: http://localhost:${config.port}/api/{slug}`);
  });

  // 注册热更新回调：配置变更时无需重启即可生效
  config.onHotReload((key, value, oldValue) => {
    if (key === 'port' && value !== oldValue) {
      // 端口变更：关闭旧监听（主动断开 keep-alive 连接），切换到新端口
      const oldPort = oldValue;
      const newPort = value;
      console.log(`[HotReload] 端口变更: ${oldPort} → ${newPort}，正在切换...`);
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      server.close(() => {
        // 新端口被占用时回退到旧端口，避免进程因未处理的 error 事件退出
        server.once('error', (err) => {
          console.error(`[HotReload] 新端口 ${newPort} 监听失败(${err.message})，回退到 ${oldPort}`);
          server.listen(oldPort);
        });
        server.listen(newPort, () => {
          console.log(`[HotReload] 服务已切换到新端口: http://localhost:${newPort}`);
        });
      });
    }

    if (key === 'autoSaveInterval' && value !== oldValue) {
      // 保存间隔变更：重启自动保存定时器
      console.log(`[HotReload] 自动保存间隔变更: ${oldValue}s → ${value}s，重启定时器...`);
      stopAutoSave();
      startAutoSave();
    }
  });

  // 优雅关闭：保存数据库后退出
  function gracefulShutdown(signal) {
    console.log(`\n收到 ${signal} 信号，正在保存数据库并关闭...`);
    clearInterval(rateLimitCleanupTimer);
    stopAutoSave();
    try {
      getDb().save();
      console.log('数据库已保存');
    } catch (e) {
      console.error('数据库保存失败:', e.message);
    }
    server.close(() => {
      console.log('服务已关闭');
      process.exit(0);
    });
    // 超时强制退出：先断开所有 keep-alive 连接再退出
    setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      process.exit(1);
    }, 5000);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // 未捕获异常处理：保存数据库后退出，避免数据丢失
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] uncaughtException:', err);
    gracefulShutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] unhandledRejection:', reason);
    gracefulShutdown('unhandledRejection');
  });
}

main().catch(err => {
  console.error('启动失败:', err.message || err);
  process.exit(1);
});
