// Рисует иконки приложения в icons/ без сторонних библиотек (PNG собирается вручную).
// Запуск: node tools/make-icons.js
// Рисунок: зелёный фон, белая «тетрадь» с линиями и красной линией полей.

import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';

const OUT = new URL('../icons/', import.meta.url);

const TEAL = [15, 118, 110, 255];
const WHITE = [255, 255, 255, 255];
const LINE = [15, 118, 110, 255];
const MARGIN = [198, 40, 40, 255];
const NONE = [0, 0, 0, 0];

// ---------- PNG ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // фильтр «нет»
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Рисунок (координаты от 0 до 1) ----------

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function colorAt(x, y, rounded) {
  if (rounded && !inRoundRect(x, y, 0, 0, 1, 1, 0.22)) return NONE;
  // Листок
  const px0 = 0.27, px1 = 0.73, py0 = 0.2, py1 = 0.8;
  if (inRoundRect(x, y, px0, py0, px1, py1, 0.05)) {
    if (x >= 0.375 && x <= 0.395 && y > py0 + 0.02 && y < py1 - 0.02) return MARGIN; // поля
    for (const ly of [0.36, 0.47, 0.58, 0.69]) {
      if (y >= ly - 0.014 && y <= ly + 0.014 && x > 0.42 && x < px1 - 0.06) return LINE;
    }
    return WHITE;
  }
  return TEAL;
}

function draw(size, rounded) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4; // 4×4 подвыборки на пиксель — сглаживание краёв
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const c = colorAt((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size, rounded);
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round(a / (S * S));
    }
  }
  return encodePNG(size, px);
}

const icons = [
  ['icon-192.png', 192, true],
  ['icon-512.png', 512, true],
  ['icon-maskable-512.png', 512, false], // Android сам обрежет по своей форме
  ['apple-touch-icon.png', 180, false], // iPhone сам скругляет углы
];

await mkdir(OUT, { recursive: true });
for (const [name, size, rounded] of icons) {
  await writeFile(new URL(name, OUT), draw(size, rounded));
  console.log(`icons/${name} — ${size}×${size}`);
}
