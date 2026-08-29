#!/usr/bin/env bash
# 生成生产环境 .env 配置文件（随机强密钥）
# 用法: bash setup-env.sh [公开访问地址]
# 示例: bash setup-env.sh https://img.example.com

set -euo pipefail

PUBLIC_URL="${1:-http://localhost:3100}"
ENV_FILE=".env"

if [ -f "$ENV_FILE" ]; then
  echo "⚠️  $ENV_FILE 已存在，不覆盖。如需重新生成请先备份删除。"
  exit 1
fi

rand() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }

ADMIN_USER_VALUE="admin"
ADMIN_PASS_VALUE="$(rand 12)"
JWT_SECRET_VALUE="$(rand 32)"
ENCRYPT_KEY_VALUE="$(rand 16)"

cat > "$ENV_FILE" <<EOF
# 服务端口（建议保持 3100，由 Nginx 反代对外）
PORT=3100

# 管理员账号（密码为随机生成值，请查看下方输出并妥善保存！）
ADMIN_USER=$ADMIN_USER_VALUE
ADMIN_PASS=$ADMIN_PASS_VALUE

# JWT密钥
JWT_SECRET=$JWT_SECRET_VALUE

# 存储密钥加密密钥（生成后请勿更换，否则已保存的存储源密钥无法解密）
ENCRYPT_KEY=$ENCRYPT_KEY_VALUE

# 数据库文件路径
DB_PATH=./data/images.db

# 公开访问地址（用于生成API地址）
PUBLIC_URL=$PUBLIC_URL

# CORS允许的来源（管理后台与API同源部署时保持默认即可；跨域调用请填具体域名）
CORS_ORIGINS=*

# 反向代理信任配置（Nginx 同机部署保持默认）
TRUST_PROXY=loopback
EOF

echo "======================================================"
echo "✅ .env 已生成（密钥均为随机值）"
echo ""
echo "   管理后台登录密码: $ADMIN_PASS_VALUE"
echo "   （用户名: $ADMIN_USER_VALUE，首次登录后建议在后台修改）"
echo ""
echo "   ⚠️  PUBLIC_URL 当前为: $PUBLIC_URL"
echo "      如与实际域名不符，请编辑 $ENV_FILE 修改"
echo "======================================================"
