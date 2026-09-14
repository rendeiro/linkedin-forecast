// Generates simple solid PNG icons (no image deps). Green square with a lighter rising bar.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      // Monochrome: near-black rounded square, three light bars rising left to right.
      const rad = size * 0.22;
      const dx = Math.max(rad - x, x - (size - 1 - rad), 0), dy = Math.max(rad - y, y - (size - 1 - rad), 0);
      const inside = dx * dx + dy * dy <= rad * rad;
      const pad = size * 0.22, gap = Math.max(1, size * 0.06);
      const w = (size - 2 * pad - 2 * gap) / 3;
      const col = Math.floor((x - pad) / (w + gap));
      const inCol = x >= pad && x < size - pad && col >= 0 && col <= 2 && (x - pad) - col * (w + gap) < w;
      const barTop = size * (0.72 - col * 0.17);
      const inBar = inCol && y >= barTop && y < size - pad;
      const v = inBar ? 0xf5 : 0x1a;
      raw[i] = v; raw[i + 1] = v; raw[i + 2] = v; raw[i + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
mkdirSync('static/icons', { recursive: true });
for (const s of [16, 48, 128]) writeFileSync(`static/icons/icon${s}.png`, png(s));
console.log('icons written');
