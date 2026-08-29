# 部署指南（v1.0.1，Docker 方式）

面向 Linux 服务器（Ubuntu / Debian / CentOS 等）的首次部署与日常维护。

> 约定：部署目录 `/opt/random-image-api`，域名 `img.example.com`，请按实际替换。

---

## 一、前置准备

1. **安装 Docker**（已装跳过）：

```bash
# 一键脚本（含 docker compose 插件）
curl -fsSL https://get.docker.com | bash
systemctl enable --now docker
docker compose version   # 确认 compose 可用
```

2. **（国内服务器建议）配置 Docker 镜像加速**，避免拉取基础镜像缓慢/失败：

```bash
sudo tee /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run"
  ]
}
EOF
sudo systemctl restart docker
```

3. **开放端口**：防火墙 / 云安全组只放行 `80`、`443`（SSH 22 保持）。应用监听 `3100`，不对公网放行，由 Nginx 反代对外。
4. **域名解析**：域名 A 记录指向服务器 IP。

---

## 二、上传与解压

在本机（Git Bash / PowerShell 均可）：

```bash
scp random-image-api-v1.0.1-src.tar.gz root@服务器IP:/tmp/
# 若服务器无法访问 npm，再额外上传离线依赖包（见第六节）
scp random-image-api-v1.0.1-node_modules-linux-x64.tar.gz root@服务器IP:/tmp/
```

服务器上：

```bash
mkdir -p /opt/random-image-api
tar -xzf /tmp/random-image-api-v1.0.1-src.tar.gz -C /opt/random-image-api --strip-components=1
cd /opt/random-image-api
ls   # 应看到 server/ client/dist/ docker-compose.yml deploy/ 等
```

---

## 三、生成配置

```bash
bash deploy/setup-env.sh https://img.example.com
```

脚本会生成 `.env`（随机强密钥）并**打印管理员登录密码，务必保存**。
Docker 部署请保持 `.env` 中 `PORT=3100` 不变（与 compose 端口映射一致）。

---

## 四、构建并启动

```bash
docker compose up -d --build
```

首次构建约 3~8 分钟（拉取 node:20-alpine 基础镜像 + 两次 npm ci）。
默认使用 npmmirror 源，如需更换：

```bash
docker compose build --build-arg NPM_REGISTRY=https://registry.npmjs.org
```

验证：

```bash
docker compose ps                          # STATUS 应含 (healthy)
curl http://127.0.0.1:3100/health          # {"code":0,"data":{"status":"ok",...}}
docker compose logs -f random-image-api    # 看启动日志（Ctrl+C 退出）
```

看到 `随机图片API服务已启动` 即成功。数据（SQLite）落在宿主机 `./data/`，配置在 `./.env`，容器重建不丢失。

> 权限提示：容器以 UID 1000（node 用户）运行。若日志出现数据目录写入失败：
> `sudo chown -R 1000:1000 data`

---

## 五、Nginx 反向代理 + HTTPS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/conf.d/random-image-api.conf
sudo vim /etc/nginx/conf.d/random-image-api.conf   # 改 server_name 为你的域名
sudo nginx -t && sudo systemctl reload nginx

# HTTPS 证书（强烈推荐）
sudo apt-get install -y certbot python3-certbot-nginx    # CentOS: yum install certbot python3-certbot-nginx
sudo certbot --nginx -d img.example.com
```

完成后访问 `https://img.example.com/admin`，用 setup-env.sh 打印的密码登录。

---

## 六、服务器无法访问 npm 时（离线构建变体）

源码包内已包含构建好的前端（`client/dist/`），配合离线依赖包可完全跳过容器内 npm：

```bash
cd /opt/random-image-api
mkdir -p node_modules-offline
tar -xzf /tmp/random-image-api-v1.0.1-node_modules-linux-x64.tar.gz \
    -C node_modules-offline --strip-components=2

docker build -f deploy/Dockerfile.offline -t random-image-api:v1.0.1 .
docker compose -f deploy/docker-compose.offline.yml up -d
```

此时唯一需要外网的是基础镜像 `node:20-alpine`（用第一节的镜像加速获取；极端情况下可在有 Docker 的机器上 `docker pull node:20-alpine && docker save` 后传到服务器 `docker load`）。

---

## 七、首次部署检查清单

1. 打开 `https://img.example.com/admin`，用随机密码登录
2. **立即在「系统设置 → 安全配置」修改密码**（改完旧会话失效，属预期）
3. 「存储源管理」添加云存储 → 「测试连接」确认成功
4. 「分类管理」建分类（slug 即 API 路径）
5. 「图片管理」上传或「从存储源同步」，同步后点「修复尺寸」解析宽高
6. 验证公开 API：
   - `https://img.example.com/api/{slug}` → 302 跳转原图
   - `?format=json` → JSON；`?w=500` → 缩放图

---

## 八、日常运维

```bash
docker compose logs --tail 100 random-image-api   # 查看日志
docker compose restart                             # 重启
docker compose down                                # 停止（数据保留在 ./data）
docker compose up -d                               # 启动
```

**升级到新版本：**

```bash
cd /opt/random-image-api
docker compose down
tar -xzf /tmp/random-image-api-v新版本-src.tar.gz -C /opt/random-image-api --strip-components=1
# data/ 与 .env 不在源码包内，不会被覆盖
docker compose up -d --build
```

**回滚：** 用旧版本源码包执行同样的覆盖 + 重建流程；数据库文件保留不动。
**备份：** 停服后复制 `data/images.db`（服务运行期间同时备份自动生成的 `images.db.bak`）。
**忘记密码：** 编辑 `.env` 的 `ADMIN_PASS` 为新值 → `docker compose restart`，登录后再改回随机强密码。

## 常见问题

- **构建时报 `failed to solve: node:20-alpine` 拉取失败**：配置第一节的镜像加速后重试。
- **构建时 npm 超时**：确认用了默认 npmmirror 源；仍失败则改用第六节离线构建。
- **启动即退出，日志报"检测到不安全的默认配置"**：`.env` 有默认密钥，生产环境禁止启动，重新运行 setup-env.sh。
- **修改配置**：后台「系统设置」在线改即可，无需重启；`.env` 仅首次初始化生效。
- **改了端口无法访问**：Docker 部署请保持 `PORT=3100`；如确需修改，同步改 `docker-compose.yml` 的端口映射后 `docker compose up -d` 重建。
