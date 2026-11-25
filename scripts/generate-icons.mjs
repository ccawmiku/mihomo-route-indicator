import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUTPUT_DIR = path.resolve('public/icons');
const SIZES = [16, 48, 128];

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function blendPixel(buf, size, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= size || y >= size || a <= 0) return;
  const idx = (y * size + x) * 4;
  const srcA = a / 255;
  const dstA = buf[idx + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  buf[idx] = Math.round((r * srcA + buf[idx] * dstA * (1 - srcA)) / outA);
  buf[idx + 1] = Math.round((g * srcA + buf[idx + 1] * dstA * (1 - srcA)) / outA);
  buf[idx + 2] = Math.round((b * srcA + buf[idx + 2] * dstA * (1 - srcA)) / outA);
  buf[idx + 3] = Math.round(outA * 255);
}

function sdRoundedBox(px, py, cx, cy, hw, hh, radius) {
  const dx = Math.abs(px - cx) - hw + radius;
  const dy = Math.abs(py - cy) - hh + radius;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - radius;
}

function renderIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size;
  const cx = s / 2;
  const cy = s / 2;
  const pad = s * 0.06;
  const half = s / 2 - pad;
  const radius = s * 0.22;

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const dist = sdRoundedBox(px, py, cx, cy, half, half, radius);
      const cov = Math.max(0, Math.min(1, 0.5 - dist));
      if (cov > 0) {
        const t = (x + y) / (2 * s);
        const r = Math.round(24 + t * 22);
        const g = Math.round(39 + t * 38);
        const b = Math.round(78 + t * 82);
        blendPixel(buf, s, x, y, r, g, b, Math.round(cov * 255));
      }

      // 中心 M 字路由折线造型
      const nx = (px - cx) / (s * 0.28);
      const ny = (py - cy) / (s * 0.28);
      const inM = Math.abs(nx) <= 0.92 && Math.abs(ny) <= 0.78;
      if (inM) {
        const stroke = 0.24;
        const leftBar = Math.abs(nx + 0.65);
        const rightBar = Math.abs(nx - 0.65);
        const leftDiag = Math.abs(ny - (-0.6 + ((nx + 0.65) / 0.65) * 0.85)) / 1.65;
        const rightDiag = Math.abs(ny - (-0.6 + ((0.65 - nx) / 0.65) * 0.85)) / 1.65;
        let dLine = Math.min(leftBar, rightBar);
        if (nx >= -0.65 && nx <= 0.02) dLine = Math.min(dLine, leftDiag);
        if (nx >= -0.02 && nx <= 0.65) dLine = Math.min(dLine, rightDiag);
        const lCov = Math.max(0, Math.min(1, (stroke - dLine) * 3.5));
        if (lCov > 0) {
          blendPixel(buf, s, x, y, 241, 245, 249, Math.round(lCov * 255));
        }
      }

      // 四角迷你分流标识点（右下蓝圆、左下绿方、左上紫、右上橙）
      const badges = [
        { bx: s * 0.77, by: s * 0.77, color: [59, 130, 246] },
        { bx: s * 0.23, by: s * 0.77, color: [34, 197, 94] },
        { bx: s * 0.23, by: s * 0.23, color: [168, 85, 247] },
        { bx: s * 0.77, by: s * 0.23, color: [249, 115, 22] },
      ];
      const br = Math.max(1.5, s * 0.115);
      const border = Math.max(0.7, s * 0.035);
      for (const badge of badges) {
        const d = Math.hypot(px - badge.bx, py - badge.by);
        const borderCov = Math.max(0, Math.min(1, br + border + 0.5 - d));
        if (borderCov > 0) {
          blendPixel(buf, s, x, y, 255, 255, 255, Math.round(borderCov * 255));
        }
        const fillCov = Math.max(0, Math.min(1, br + 0.5 - d));
        if (fillCov > 0) {
          blendPixel(buf, s, x, y, badge.color[0], badge.color[1], badge.color[2], Math.round(fillCov * 255));
        }
      }
    }
  }

  return encodePng(s, s, buf);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = renderIcon(size);
  const outPath = path.join(OUTPUT_DIR, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Generated ${outPath} (${png.length} bytes)`);
}
