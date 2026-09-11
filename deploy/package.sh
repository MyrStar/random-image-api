#!/usr/bin/env bash
# 构建部署包（源码包 + 可选的离线 Linux 依赖包）
# 用法（在仓库根目录或任意位置执行）:
#   bash deploy/package.sh                # 默认版本号取自 package.json
#   bash deploy/package.sh v1.0.2         # 指定版本号
#   bash deploy/package.sh v1.0.2 --with-nm   # 同时构建离线 node_modules 包
#
# 产出: 与仓库同目录下 random-image-api-<版本>-src.tar.gz 等

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_VERSION_DEFAULT="$(node -e "console.log('v' + require('$ROOT/package.json').version)" 2>/dev/null || echo v1.0.2)"
VERSION="${1:-$PKG_VERSION_DEFAULT}"
WITH_NM="${2:-}"
OUT="$(dirname "$ROOT")"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo "==> 打包 $VERSION"

# ---------- 1. 源码包 ----------
mkdir -p "$STAGING/random-image-api"
cp -r "$ROOT/server" "$STAGING/random-image-api/"
cp -r "$ROOT/client" "$STAGING/random-image-api/"
rm -rf "$STAGING/random-image-api/client/node_modules"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/.env.example" \
   "$ROOT/Dockerfile" "$ROOT/docker-compose.yml" "$ROOT/.dockerignore" \
   "$ROOT/README.md" "$ROOT/开发文档.md" "$STAGING/random-image-api/"
cp -r "$ROOT/deploy" "$STAGING/random-image-api/"

# 关键文件自检（防止漏打包）
for f in \
  server/index.js \
  client/package.json \
  client/package-lock.json \
  client/vite.config.js \
  client/src/main.js \
  client/dist/index.html \
  package-lock.json \
  deploy/setup-env.sh \
  deploy/Dockerfile.offline ; do
  if [ ! -e "$STAGING/random-image-api/$f" ]; then
    echo "❌ 缺少关键文件: $f" && exit 1
  fi
done

( cd "$STAGING" && tar -czf "$OUT/random-image-api-$VERSION-src.tar.gz" random-image-api )
echo "✅ $OUT/random-image-api-$VERSION-src.tar.gz"

# ---------- 2. 离线依赖包（可选） ----------
if [ "$WITH_NM" = "--with-nm" ]; then
  NM_STAGING="$STAGING/nm-staging"
  mkdir -p "$NM_STAGING"
  cp "$ROOT/package.json" "$ROOT/package-lock.json" "$NM_STAGING/"
  ( cd "$NM_STAGING" && npm ci --omit=dev --os=linux --cpu=x64 --libc=glibc \
      --ignore-scripts --registry=https://registry.npmmirror.com )
  if [ ! -d "$NM_STAGING/node_modules/@img/sharp-linux-x64" ]; then
    echo "❌ 离线依赖包缺少 sharp linux 二进制" && exit 1
  fi
  ( cd "$STAGING" && tar -czf "$OUT/random-image-api-$VERSION-node_modules-linux-x64.tar.gz" nm-staging )
  echo "✅ $OUT/random-image-api-$VERSION-node_modules-linux-x64.tar.gz"
fi

( cd "$OUT" && sha256sum random-image-api-$VERSION-*.tar.gz > "sha256sums-$VERSION.txt" )
echo "✅ 校验和: $OUT/sha256sums-$VERSION.txt"
