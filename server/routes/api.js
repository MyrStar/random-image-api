const express = require('express');
const router = express.Router();
const imageService = require('../services/imageService');
const { safeFetch } = require('../utils/safeFetch');
const config = require('../config');
const { sendCaught } = require('../utils/respond');

// sharp 支持的输出格式（mime -> sharp 格式名）
const SHARP_FORMATS = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};
// 动图格式：缩放时保留动画帧
const ANIMATED_MIMES = ['image/gif', 'image/webp', 'image/avif'];

const RESIZE_MODES = ['fit', 'fill', 'stretch'];
// 代理下载的单图大小上限
const PROXY_MAX_BYTES = 100 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 20000;

/**
 * 解析 w/h 查询参数：仅接受纯数字，返回 null 表示未提供/无效
 */
function parseDimension(val) {
  if (val === undefined || val === null || val === '') return null;
  const s = String(val);
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n > 0 ? n : null;
}

/**
 * GET /api/:slug
 * 随机图片API
 *
 * 查询参数:
 *   format=json  -> 返回JSON
 *   type=raw     -> 代理模式，返回图片二进制
 *   w=500        -> 指定宽度（自动切换代理模式）
 *   h=200        -> 指定高度（自动切换代理模式）
 *   mode=fit     -> 缩放模式: fit(适应) | fill(填充裁剪) | stretch(拉伸)
 *   默认         -> 302重定向
 *
 * 示例:
 *   /api/wallpaper              -> 302重定向原图
 *   /api/wallpaper?w=500&h=300  -> 返回500x300的图片（fit模式）
 *   /api/wallpaper?w=500        -> 宽度500，高度按比例
 *   /api/wallpaper?w=500&h=300&mode=fill   -> 填充模式，可能裁剪
 *   /api/wallpaper?w=500&h=300&mode=stretch -> 拉伸模式，可能变形
 */
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { format, type } = req.query;

    const image = imageService.getRandomImage(slug);
    if (!image) {
      return res.status(404).json({ code: 404, message: '分类不存在或没有图片' });
    }

    // JSON模式
    if (format === 'json') {
      return res.json({
        code: 0,
        data: {
          url: image.url,
          width: image.width,
          height: image.height,
          size: image.size,
          mime_type: image.mime_type,
        },
      });
    }

    // 需要调整尺寸 -> 自动使用代理模式
    const targetW = parseDimension(req.query.w);
    const targetH = parseDimension(req.query.h);
    const mode = RESIZE_MODES.includes(req.query.mode) ? req.query.mode : 'fit';
    const needResize = targetW !== null || targetH !== null;

    // 代理模式
    if (type === 'raw' || needResize) {
      try {
        // safeFetch 内部完成协议/内网地址/重定向/超时/大小校验
        const { buffer } = await safeFetch(image.url, {
          timeoutMs: PROXY_TIMEOUT_MS,
          maxBytes: PROXY_MAX_BYTES,
        });

        // SVG 等可执行文档强制下载，避免在站点域名下内联渲染（存储型 XSS）
        const mime = image.mime_type || 'image/jpeg';
        if (mime === 'image/svg+xml') {
          res.set('Content-Disposition', 'attachment; filename="image.svg"');
        }

        // 如果指定了尺寸，进行缩放（sharp）
        if (needResize) {
          const maxDim = config.resizeMaxDimension || 4096;
          const w = targetW !== null ? Math.min(targetW, maxDim) : null;
          const h = targetH !== null ? Math.min(targetH, maxDim) : null;

          if (w === null && h === null) {
            return res.redirect(302, image.url);
          }

          if (!SHARP_FORMATS[mime]) {
            // 无法用 sharp 处理的格式（svg/bmp/ico等）：降级为跳转原图
            return res.redirect(302, image.url);
          }

          const fit = mode === 'stretch' && w && h ? 'fill' : mode === 'fill' && w && h ? 'cover' : 'inside';
          try {
            const pipeline = sharpWithAnimation(buffer, mime);
            let resized = w && h
              ? pipeline.resize(w, h, { fit })
              : w
                ? pipeline.resize({ width: w, fit: 'inside' })
                : pipeline.resize({ height: h, fit: 'inside' });
            const outBuffer = await resized.toFormat(SHARP_FORMATS[mime]).toBuffer();
            res.set('Content-Type', mime);
            res.set('Cache-Control', 'public, max-age=86400');
            return res.send(outBuffer);
          } catch (err) {
            // 图片数据损坏等缩放失败：降级为跳转原图，而不是报错
            console.warn('[Resize Fallback]', err.message);
            return res.redirect(302, image.url);
          }
        }

        res.set('Content-Type', mime);
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(buffer);
      } catch (err) {
        if (err.code === 'ESSRFBLOCKED') {
          return res.status(400).json({ code: 400, message: err.message });
        }
        console.error('[Proxy Error]', err.message);
        return res.status(502).json({ code: 502, message: '代理获取图片失败' });
      }
    }

    // 默认: 302重定向
    res.redirect(302, image.url);
  } catch (err) {
    return sendCaught(res, err);
  }
});

function sharpWithAnimation(buffer, mime) {
  const sharp = require('sharp');
  return ANIMATED_MIMES.includes(mime) ? sharp(buffer, { animated: true }) : sharp(buffer);
}

module.exports = router;
