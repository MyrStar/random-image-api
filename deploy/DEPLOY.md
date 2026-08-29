# 部署指南（v1.0.1）

本文档面向 Linux 服务器（Ubuntu / Debian / CentOS 等）的首次部署与日常维护。

**两种部署方式任选其一：**

| 方式 | 适用条件 | 特点 |
|------|----------|------|
| 方案 A：Docker 部署 | 服务器已装 Docker | 推荐。环境隔离，升级回滚最简单 |
| 方案 B：Node 直部 | 服务器可装 Node.js 20+ | 无 Docker 时使用，支持完全离线安装 |

---

## 部署前置

1. **开放端口**：防火墙 / 云安全组放行 `80`、`443`（SSH 的 `22` 保持）。应用本身监听 `3100`，**不要**对公网放行 3100，由 Nginx 反代对外。
2. **域名解析**：把域名 A 记录指到服务器 IP（下文以 `img.example.com` 为例）。

---

## 方案 A：Docker 部署（推荐）

```bash
# 1. 上传源码包到服务器并解压（包名以实际为准）
mkdir -p /opt/random-image-api
tar -xzf random-image-api-v1.0.1-src.tar.gz -C /opt/random-image-api --strip-components=1
cd /opt/random-image-api

# 2. 生成 .env（随机强密钥，记住输出的登录密码）
bash deploy/setup-env.sh https://img.example.com

# 3. 构建并启动（首次构建需要几分钟，拉取依赖镜像与 npm 包）
docker compose up -d --build

# 4. 查看状态与健康检查
docker compose ps
curl http://127.0.0.1:3100/health
```

数据持久化：`./data`（数据库）与 `./.env` 通过卷挂载，容器重建不丢失。
容器以非 root（UID 1000）运行，如遇权限问题：`sudo chown -R 1000:1000 data`。

**升级：** 上传新源码包解压覆盖源码（保留 `data/` 和 `.env`）→ `docker compose up -d --build`。
**回滚：** `git checkout <旧tag>` 或用旧源码包覆盖后重新 `docker compose up -d --build`。

---

## 方案 B：Node.js 直接部署

### 1. 安装 Node.js 20+（已装可跳过）

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# CentOS / RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

node -v   # 应 >= 20
```

### 2. 解压源码包

```bash
mkdir -p /opt/random-image-api
tar -xzf random-image-api-v1.0.1-src.tar.gz -C /opt/random-image-api --strip-components=1
cd /opt/random-image-api
```

### 3. 安装依赖（二选一）

```bash
# 3a. 离线安装（推荐，使用随包附带的 Linux x64 依赖包，无需联网）
tar -xzf random-image-api-v1.0.1-node_modules-linux-x64.tar.gz -C . --strip-components=1
# 注：该依赖包基于 glibc（Ubuntu/Debian/CentOS 均适用）。Alpine 服务器请改用方案 A。

# 3b. 在线安装（服务器可访问 npm 源时）
npm ci --omit=dev
```

### 4. 生成 .env 配置

```bash
bash deploy/setup-env.sh https://img.example.com
```

### 5. 启动（systemd，推荐）

```bash
sudo cp deploy/random-image-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now random-image-api
systemctl status random-image-api
curl http://127.0.0.1:3100/health
```

或使用 PM2：

```bash
npm i -g pm2
NODE_ENV=production pm2 start server/index.js --name random-image-api
pm2 save && pm2 startup   # 开机自启
```

### 6. Nginx 反向代理 + HTTPS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/conf.d/random-image-api.conf
sudo vim /etc/nginx/conf.d/random-image-api.conf   # 改 server_name
sudo nginx -t && sudo systemctl reload nginx

# HTTPS 证书（强烈推荐）
sudo apt-get install -y certbot python3-certbot-nginx   # CentOS: yum install certbot python3-certbot-nginx
sudo certbot --nginx -d img.example.com
```

**升级：** 备份 `data/` → 覆盖新源码（保留 `data/` 和 `.env`）→ 依赖有变化时重新安装 → `systemctl restart random-image-api`。
**回滚：** 用旧版本源码包覆盖，重启服务。数据库文件保留不动即可。

---

## 首次部署检查清单

1. 浏览器打开 `https://img.example.com/admin`（或 `http://服务器IP:3100/admin`，仅限临时测试）
2. 用 setup-env.sh 输出的随机密码登录，**立即在「系统设置 → 安全配置」修改密码**（改完旧会话全部失效，属预期）
3. 「存储源管理」添加云存储 → 点「测试连接」确认成功
4. 「分类管理」建分类（slug 即对外 API 路径）
5. 「图片管理」上传或「从存储源同步」，同步后点「修复尺寸」解析宽高
6. 验证公开 API：`https://img.example.com/api/{slug}` 应 302 跳转；`?format=json` 返回 JSON；`?w=500` 返回缩放图

## 常见问题

- **启动日志报"检测到不安全的默认配置"并退出**：`.env` 里的密钥还是默认值，生产环境禁止启动。重新运行 setup-env.sh 或手动修改 `.env`。
- **502**：`systemctl status random-image-api` 看服务是否存活；`curl 127.0.0.1:3100/health` 本机验证。
- **修改配置**：后台「系统设置」在线改即可，无需重启；`.env` 只在首次初始化时生效。
- **备份**：停服后复制 `data/images.db`（服务运行中会自动生成 `images.db.bak` 副本，也可一并备份）。
- **忘记密码**：编辑 `.env` 中的 `ADMIN_PASS` 为新值并重启服务，再用后台改回随机强密码。
