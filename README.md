# 随机图片 API - 使用说明

## 简介

随机图片 API 是一个基于对象存储的随机图片服务，支持多云存储后端，提供分类随机图片 API 和可视化管理后台。部署后通过网页即可完成所有配置，无需手动编辑文件。

---

## 快速开始

### 方式一：Docker 部署（推荐）

```bash
# 1. 克隆项目
git clone <repo-url>
cd random-image-api

# 2. 复制配置文件并修改
cp .env.example .env

# 3. 构建并启动
docker-compose up -d --build

# 后续如仅修改了 .env，重启即可（无需重新构建）
docker-compose up -d

# 4. 访问管理后台
# 浏览器打开 http://your-server:3100/admin
```

### 方式二：直接部署

```bash
# 1. 安装依赖
npm install
cd client && npm install && npm run build && cd ..

# 2. 复制配置文件
cp .env.example .env

# 3. 启动
node server/index.js

# 或使用 PM2 守护进程
pm2 start server/index.js --name random-image-api
```

### 首次登录

默认账号密码在 `.env` 文件中配置，首次登录后建议在 **系统设置** 页面修改密码。

---

## 功能导航

### 1. 仪表盘

查看系统概览：存储源数量、分类数量、图片数量、总存储大小、最近图片。

### 2. 存储源管理

配置云端存储服务，系统通过存储源获取图片文件。

**支持的存储类型：**

| 类型 | 说明 | 必要配置 |
|------|------|---------|
| 七牛云 | 国内常用对象存储 | AccessKey、SecretKey、Bucket、Domain |
| 阿里云 OSS | 阿里云对象存储 | Endpoint、AccessKeyId、AccessKeySecret、Bucket |
| 腾讯云 COS | 腾讯云对象存储 | Region、SecretId、SecretKey、Bucket |
| Cloudflare R2 | Cloudflare 对象存储 | Endpoint、AccessKeyId、SecretAccessKey、Bucket、PublicDomain |
| MinIO | 自建对象存储 | Endpoint、AccessKey、SecretKey、Bucket |

**操作步骤：**
1. 点击「添加存储源」
2. 选择存储类型，填写名称和配置信息
3. 点击「测试连接」验证配置是否正确
4. 保存后即可在分类中引用

### 3. 分类管理

创建图片分类，每个分类对应一个存储源和一个存储路径。

- **Slug**：分类的唯一标识，用于 API 调用，如 `/api/wallpaper`
- **存储路径**：存储源中图片所在的目录前缀，如 `images/wallpaper/`
- **缓存 TTL**：分类图片列表的缓存时间（秒），默认 300 秒

**同步图片**：点击「同步」按钮从存储源拉取最新的图片列表到数据库。

### 4. 图片管理

浏览、上传、删除图片。

- **上传**：选择分类后上传图片，支持批量上传（最多 20 张）
- **删除**：删除图片记录，同时删除存储源中的文件
- **预览**：点击图片可查看大图

### 5. 数据浏览

直接查看和编辑 SQLite 数据库中的表数据。**注意**：加密字段（如存储源 config）不可编辑。

### 6. 系统设置

在线配置系统参数，无需手动编辑文件。配置保存在数据库中，重启后自动加载。**绝大部分配置修改后立即生效，无需重启服务。**

#### 基本配置

| 配置项 | 说明 | 默认值 | 生效方式 |
|--------|------|--------|---------|
| 服务端口 | HTTP 监听端口 | 3100 | ✅ 立即生效，自动切换监听 |
| 公开访问地址 | 用于生成 API 地址 | http://localhost:3100 | ✅ 立即生效 |
| CORS 允许来源 | 跨域访问白名单，逗号分隔 | * | ✅ 立即生效 |

#### 安全配置

| 配置项 | 说明 | 注意事项 | 生效方式 |
|--------|------|---------|---------|
| 管理员用户名 | 登录账号 | — | ✅ 立即生效 |
| 管理员密码 | 登录密码 | 修改后需重新登录 | ✅ 立即生效 |
| JWT 密钥 | Token 签名密钥 | 修改后所有用户需重新登录 | ✅ 立即生效 |
| 加密密钥 | 存储源密钥的加密密钥 | ⚠️ 修改后已有存储源密钥无法解密！ | ✅ 立即生效 |

> 💡 密码和密钥字段旁边有「随机生成」按钮，建议使用随机生成的值。

#### 上传配置

| 配置项 | 说明 | 默认值 | 生效方式 |
|--------|------|--------|---------|
| 上传大小限制 | 单文件最大 MB 数 | 50 MB | ✅ 立即生效 |
| 单次上传文件数上限 | 一次最多上传几张 | 20 | ✅ 立即生效 |
| 图片缩放最大尺寸 | API 缩放请求的最大宽/高 | 4096 px | ✅ 立即生效 |

#### 高级配置

| 配置项 | 说明 | 默认值 | 生效方式 |
|--------|------|--------|---------|
| 数据库路径 | SQLite 文件位置 | ./data/images.db | ❌ 不可在线修改 |
| 缓存最大条目数 | 内存缓存上限 | 500 | ✅ 立即生效 |
| 自动保存间隔 | 数据库自动保存频率 | 30 秒 | ✅ 立即生效，自动重启定时器 |
| 公开 API 频率限制 | 每分钟请求上限 | 120 次 | ✅ 立即生效 |
| 登录频率限制 | 每分钟登录上限 | 10 次 | ✅ 立即生效 |

#### 系统检测

运行系统自检，验证加密解密、数据库连接、存储源密钥是否正常。

---

## API 接口

### 随机获取图片

```
GET /api/{slug}
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| slug | 路径 | 分类标识 |
| format | query | `json` 返回 JSON，默认 302 重定向 |
| type | query | `raw` 代理返回图片二进制 |
| w | query | 指定宽度（px） |
| h | query | 指定高度（px） |
| mode | query | 缩放模式：`fit`(适应)、`fill`(填充裁剪)、`stretch`(拉伸) |

**示例：**

```bash
# 302 重定向到原图
curl http://your-server:3100/api/wallpaper

# 返回 JSON
curl http://your-server:3100/api/wallpaper?format=json

# 返回 500x300 的缩放图
curl http://your-server:3100/api/wallpaper?w=500&h=300

# 填充模式
curl http://your-server:3100/api/wallpaper?w=500&h=300&mode=fill

# 仅指定宽度，高度按比例
curl http://your-server:3100/api/wallpaper?w=500
```

**JSON 响应格式：**

```json
{
  "code": 0,
  "data": {
    "url": "https://cdn.example.com/img.jpg",
    "width": 1920,
    "height": 1080,
    "size": 524288,
    "mime_type": "image/jpeg"
  }
}
```

---

## 部署说明

### 环境变量

首次启动前需要配置 `.env` 文件（从 `.env.example` 复制）。**.env 仅作为首次启动的初始值，后续所有配置均可在系统设置页面在线修改，修改后立即生效，无需重启。**

```env
PORT=3100                        # 后续可在系统设置中修改
ADMIN_USER=admin
ADMIN_PASS=your_secure_password  # 必须修改！默认弱密钥在生产环境会拒绝启动
JWT_SECRET=your_jwt_secret       # 必须修改！默认弱密钥在生产环境会拒绝启动
ENCRYPT_KEY=0123456789abcdef0123456789abcdef  # 必须修改！随机字符串即可，建议32位hex
DB_PATH=./data/images.db
PUBLIC_URL=http://localhost:3100
CORS_ORIGINS=*
TRUST_PROXY=loopback             # 反代信任配置：loopback/跳数/CIDR列表
```

> 生成随机密钥：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

> ⚠️ **启动安全校验**：生产环境（`NODE_ENV=production`）下，`ADMIN_PASS`/`JWT_SECRET`/`ENCRYPT_KEY` 仍为默认值时将拒绝启动；开发环境仅打印警告。如确需以默认值启动，可设置 `ALLOW_INSECURE_DEFAULTS=1`（强烈不推荐）。

> ⚠️ `ENCRYPT_KEY` 修改后会导致已有存储源密钥无法解密。如需更换，请先删除所有存储源。

### Docker Compose

```yaml
services:
  random-image-api:
    build: .
    container_name: random-image-api
    restart: unless-stopped
    ports:
      - "3100:3100"
    volumes:
      - ./data:/app/data        # 持久化数据库
      - ./.env:/app/.env:ro     # 挂载配置文件
    environment:
      - NODE_ENV=production
```

### 反向代理（Nginx）

```nginx
server {
    listen 80;
    server_name img.example.com;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 安全注意事项

1. **修改默认密码**：首次部署必须修改 `.env` 中的 `ADMIN_PASS`。密码在线修改后以 bcrypt 哈希保存，且所有已登录会话立即失效
2. **修改 JWT 密钥**：使用随机生成的 64 位 hex 字符串
3. **修改加密密钥**：使用随机生成的 32 位 hex 字符串
4. **限制 CORS**：生产环境不要使用 `*`，应指定具体域名
5. **使用 HTTPS**：生产环境务必配置 SSL 证书
6. **反向代理**：默认 `TRUST_PROXY=loopback` 适合同机 Nginx 部署，限流按真实客户端 IP 生效；CDN 等多级代理请调整为对应跳数或网段
7. **定期备份**：数据库保存采用"临时文件 + 原子重命名"，并自动维护 `images.db.bak` 备份副本；手动备份请在服务停止时复制，或同时备份 `.bak`

## Docker 部署说明

容器以 `node` 用户（非 root）运行。若使用 bind mount 挂载 `./data`，请确保宿主机目录对 UID 1000 可写：

```bash
mkdir -p data && sudo chown -R 1000:1000 data
```

容器内置健康检查（`GET /health`），可通过 `docker ps` 的 STATUS 列查看健康状态。

---

## 常见问题

### Q: 修改密码后登录不了？
A: 确保使用新密码登录。如果忘记了密码，可以编辑 `.env` 文件中的 `ADMIN_PASS` 重置。

### Q: 修改端口后无法访问？
A: 修改端口后会自动切换监听，前端会弹窗提示新地址。如果使用 Docker，还需同步修改 `docker-compose.yml` 的端口映射和 Nginx 反向代理配置。

### Q: 修改配置后需要重启吗？
A: 除数据库路径外，所有配置修改后均立即生效，无需重启。端口变更会自动切换监听，保存间隔变更会自动重启定时器。

### Q: 存储源密钥解密失败？
A: 这通常是因为修改了 `ENCRYPT_KEY`。需要删除所有存储源，然后重新配置。

### Q: 上传图片报 413 错误？
A: 在系统设置中调大「上传大小限制」，保存后立即生效（无需重启）。

### Q: 图片访问很慢？
A: 检查 CORS 配置，确保 `PUBLIC_URL` 设置正确。使用 CDN 加速存储源域名。

### Q: Docker 容器重启后数据丢失？
A: 确保挂载了数据卷：`volumes: - ./data:/app/data`。若容器以非 root 用户运行且无法写入，请执行 `sudo chown -R 1000:1000 data` 修正目录归属。

### Q: 如何更换加密密钥？
A:
1. 在管理后台删除所有存储源
2. 在系统设置中点击「随机生成」更换加密密钥
3. 重新添加存储源

---

## 项目结构

```
random-image-api/
├── server/                  # 后端
│   ├── index.js             # 入口
│   ├── config.js            # 配置管理（支持运行时更新）
│   ├── database.js          # 数据库
│   ├── adapters/            # 存储适配器
│   │   ├── index.js         # 适配器工厂
│   │   ├── base.js          # 基类
│   │   ├── qiniu.js         # 七牛云
│   │   ├── aliyun-oss.js    # 阿里云 OSS
│   │   ├── tencent-cos.js   # 腾讯云 COS
│   │   ├── cloudflare-r2.js # Cloudflare R2
│   │   └── minio.js         # MinIO
│   ├── middleware/          # 中间件
│   │   ├── auth.js          # JWT 认证
│   │   └── errorHandler.js  # 错误处理
│   ├── routes/              # 路由
│   │   ├── api.js           # 公开 API
│   │   ├── index.js         # 路由汇总
│   │   └── admin/           # 管理后台 API
│   │       ├── auth.js      # 登录
│   │       ├── storages.js  # 存储源
│   │       ├── categories.js# 分类
│   │       ├── images.js    # 图片
│   │       ├── dashboard.js # 仪表盘
│   │       ├── dbbrowser.js # 数据浏览
│   │       └── settings.js  # 系统设置
│   ├── services/            # 业务逻辑
│   │   ├── imageService.js  # 图片服务
│   │   └── cacheService.js  # 缓存服务
│   └── utils/               # 工具
│       ├── crypto.js        # 加密解密
│       ├── imageInfo.js     # 图片信息
│       └── nanoid.js        # ID 生成
├── client/                  # 前端
│   └── src/
│       ├── App.vue          # 主布局
│       ├── main.js          # 入口
│       ├── router/          # 路由
│       └── views/           # 页面
│           ├── Login.vue    # 登录
│           ├── Dashboard.vue# 仪表盘
│           ├── Storages.vue # 存储源
│           ├── Categories.vue# 分类
│           ├── Images.vue   # 图片
│           ├── Database.vue # 数据浏览
│           └── Settings.vue # 系统设置
├── data/                    # 数据目录
│   └── images.db            # SQLite 数据库
├── .env                     # 环境配置（不进仓库）
├── .env.example             # 配置模板
├── Dockerfile               # Docker 构建
├── docker-compose.yml       # Docker Compose
└── package.json             # 依赖
```
