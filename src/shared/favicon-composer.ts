import { MAX_FAVICON_BADGES } from './defaults';
import type { BadgeDescriptor, BadgeShape, FaviconOverlayConfig } from './types';

export const FAVICON_CANVAS_SIZE = 64;

interface Point {
  x: number;
  y: number;
}

/**
 * 计算四角位置（严格顺时针：右下 -> 左下 -> 左上 -> 右上）。
 */
export function getCornerPositions(
  canvasSize: number,
  markerSize: number,
  strokeWidth: number,
): Point[] {
  const half = markerSize / 2;
  const pad = Math.max(1.5, strokeWidth * 0.75 + 1);
  const left = pad + half;
  const right = canvasSize - pad - half;
  const top = pad + half;
  const bottom = canvasSize - pad - half;

  return [
    { x: right, y: bottom }, // 0: 右下角
    { x: left, y: bottom }, // 1: 左下角
    { x: left, y: top }, // 2: 左上角
    { x: right, y: top }, // 3: 右上角
  ];
}

function traceShapePath(
  ctx: CanvasRenderingContext2D,
  shape: BadgeShape,
  cx: number,
  cy: number,
  markerSize: number,
): void {
  const half = markerSize / 2;
  ctx.beginPath();

  switch (shape) {
    case 'circle': {
      ctx.arc(cx, cy, half, 0, Math.PI * 2);
      break;
    }
    case 'square': {
      const r = Math.max(1.5, markerSize * 0.14);
      const x = cx - half;
      const y = cy - half;
      const w = markerSize;
      const h = markerSize;
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      break;
    }
    case 'triangle': {
      const topY = cy - half * 1.05;
      const bottomY = cy + half * 0.88;
      const halfWidth = half * 1.04;
      ctx.moveTo(cx, topY);
      ctx.lineTo(cx + halfWidth, bottomY);
      ctx.lineTo(cx - halfWidth, bottomY);
      ctx.closePath();
      break;
    }
  }
}

function drawBadge(
  ctx: CanvasRenderingContext2D,
  badge: BadgeDescriptor,
  center: Point,
  markerSize: number,
  strokeWidth: number,
  strokeColor: string,
): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  traceShapePath(ctx, badge.shape, center.x, center.y, markerSize);

  // 先用较宽的外描边绘制边界，再用主色填充内部，确保小图标缩放下边缘清晰且色彩面积饱满
  if (strokeWidth > 0) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth * 1.8;
    ctx.stroke();
  }

  ctx.fillStyle = badge.color;
  ctx.fill();
  ctx.restore();
}

export function drawFallbackBaseIcon(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.save();
  const pad = size * 0.08;
  const r = size * 0.18;
  const w = size - pad * 2;
  const h = size - pad * 2;

  ctx.beginPath();
  ctx.moveTo(pad + r, pad);
  ctx.lineTo(pad + w - r, pad);
  ctx.quadraticCurveTo(pad + w, pad, pad + w, pad + r);
  ctx.lineTo(pad + w, pad + h - r);
  ctx.quadraticCurveTo(pad + w, pad + h, pad + w - r, pad + h);
  ctx.lineTo(pad + r, pad + h);
  ctx.quadraticCurveTo(pad, pad + h, pad, pad + h - r);
  ctx.lineTo(pad, pad + r);
  ctx.quadraticCurveTo(pad, pad, pad + r, pad);
  ctx.closePath();

  ctx.fillStyle = '#e2e8f0';
  ctx.fill();
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 简笔地球经纬线
  const cx = size / 2;
  const cy = size / 2;
  const gr = size * 0.24;
  ctx.beginPath();
  ctx.arc(cx, cy, gr, 0, Math.PI * 2);
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx - gr, cy);
  ctx.lineTo(cx + gr, cy);
  ctx.moveTo(cx, cy - gr);
  ctx.lineTo(cx, cy + gr);
  ctx.stroke();
  ctx.restore();
}

export function renderFaviconWithBadges(
  ctx: CanvasRenderingContext2D,
  size: number,
  baseImage: CanvasImageSource | null,
  badges: readonly BadgeDescriptor[],
  config: FaviconOverlayConfig,
  useFallbackBaseWhenNull = false,
): void {
  ctx.clearRect(0, 0, size, size);

  if (baseImage) {
    ctx.drawImage(baseImage, 0, 0, size, size);
  } else if (useFallbackBaseWhenNull) {
    drawFallbackBaseIcon(ctx, size);
  }

  if (!config.enabled || badges.length === 0) {
    return;
  }

  const visibleBadges = badges.slice(0, MAX_FAVICON_BADGES);
  const scale = size / FAVICON_CANVAS_SIZE;
  const markerSize = config.markerSize * scale;
  const strokeWidth = config.strokeWidth * scale;
  const corners = getCornerPositions(size, markerSize, strokeWidth);

  visibleBadges.forEach((badge, index) => {
    const corner = corners[index];
    if (!corner) return;
    drawBadge(ctx, badge, corner, markerSize, strokeWidth, config.strokeColor);
  });
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load favicon image'));
    img.src = src;
  });
}

export async function composeFaviconDataUrl(
  baseImageDataUrl: string | null,
  badges: readonly BadgeDescriptor[],
  config: FaviconOverlayConfig,
  useFallbackBaseWhenNull = false,
): Promise<string | null> {
  let baseImg: HTMLImageElement | null = null;
  if (baseImageDataUrl) {
    try {
      baseImg = await loadImageElement(baseImageDataUrl);
    } catch {
      baseImg = null;
    }
  }

  if (!baseImg && !useFallbackBaseWhenNull) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = FAVICON_CANVAS_SIZE;
  canvas.height = FAVICON_CANVAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  renderFaviconWithBadges(
    ctx,
    FAVICON_CANVAS_SIZE,
    baseImg,
    badges,
    config,
    useFallbackBaseWhenNull,
  );

  return canvas.toDataURL('image/png');
}
