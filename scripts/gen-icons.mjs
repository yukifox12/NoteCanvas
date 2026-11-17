// 生成应用图标（纯 Node，无第三方依赖）：琥珀色便签 + 折角 + 文字线条
// 输出: src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.png,icon.ico}
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src-tauri', 'icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;

function drawIcon(S) {
  const px = Buffer.alloc(S * S * 4);
  const m = S * 0.06;                 // 外边距
  const r = S * 0.16;                 // 圆角
  const fold = S * 0.26;              // 折角尺寸
  const x0 = m, y0 = m, x1 = S - m, y1 = S - m;
  // 文字线条（相对坐标）
  const lines = [
    { y: 0.34, x0: 0.22, x1: 0.78 },
    { y: 0.50, x0: 0.22, x1: 0.70 },
    { y: 0.66, x0: 0.22, x1: 0.56 },
  ];
  const lineH = Math.max(1, S * 0.055);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      // 圆角矩形 SDF
      const qx = Math.max(x0 + r - cx, cx - (x1 - r), 0);
      const qy = Math.max(y0 + r - cy, cy - (y1 - r), 0);
      const insideRect = Math.hypot(qx, qy) <= r && cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
      // 折角：右下角切掉一个三角形
      const fx = cx - (x1 - fold), fy = cy - (y1 - fold);
      const inFoldCut = fx > 0 && fy > 0 && fx + fy > fold;
      let a = 0, R = 0, G = 0, B = 0;
      if (insideRect && !inFoldCut) {
        const t = clamp((cy - y0) / (y1 - y0), 0, 1);
        R = mix(0xf9, 0xe0, t); G = mix(0xcd, 0x8e, t); B = mix(0x4b, 0x0e, t);
        a = 255;
        // 顶部高光
        if (cy < y0 + S * 0.05) { R = mix(R, 255, 0.25); G = mix(G, 255, 0.25); B = mix(B, 255, 0.2); }
        // 文字线条
        for (const L of lines) {
          const ly = y0 + (y1 - y0) * L.y, lx0 = x0 + (x1 - x0) * L.x0, lx1 = x0 + (x1 - x0) * L.x1;
          if (Math.abs(cy - ly) <= lineH / 2 && cx >= lx0 && cx <= lx1) {
            const edge = clamp((lineH / 2 - Math.abs(cy - ly)) / (lineH / 2), 0, 1);
            R = mix(R, 0x6b, 0.62 * edge); G = mix(G, 0x45, 0.62 * edge); B = mix(B, 0x08, 0.62 * edge);
          }
        }
      } else if (fx > 0 && fy > 0 && fx + fy <= fold && cx <= x1 && cy <= y1) {
        // 折角小三角（深琥珀）
        const t = clamp((fx + fy) / fold, 0, 1);
        R = mix(0xc9, 0xa8, t); G = mix(0x7c, 0x62, t); B = mix(0x10, 0x08, t);
        a = 255;
      }
      const i = (y * S + x) * 4;
      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = a;
    }
  }
  return px;
}

const pngs = {};
for (const [name, size] of [['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256], ['icon.png', 512]]) {
  pngs[name] = encodePNG(size, size, drawIcon(size));
  writeFileSync(join(outDir, name), pngs[name]);
}
// ICO（内嵌 PNG，Vista+ 支持）：用 256px
const icoPng = pngs['128x128@2x.png'];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0; // 256
entry[2] = 0; entry[3] = 0;
entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(icoPng.length, 8); entry.writeUInt32LE(22, 12);
writeFileSync(join(outDir, 'icon.ico'), Buffer.concat([header, entry, icoPng]));
console.log('icons generated:', Object.keys(pngs).join(', '), '+ icon.ico');