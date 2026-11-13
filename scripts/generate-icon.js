'use strict';

/**
 * Генерация иконки приложения без внешних зависимостей.
 *
 * Скрипт рисует простой знак (тёмная плитка, кольцо и три полосы эквалайзера)
 * и сохраняет:
 * - assets/icon.png — 512×512 RGBA;
 * - assets/icon.ico — 256×256 в формате ICO с PNG-содержимым (поддерживается
 *   Windows Vista и новее, electron-builder принимает такой файл).
 *
 * Запуск: npm run icon
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUTPUT_DIR = path.join(__dirname, '..', 'assets');

const COLOR_BACKGROUND_TOP = [21, 35, 48];
const COLOR_BACKGROUND_BOTTOM = [10, 16, 23];
const COLOR_ACCENT = [76, 194, 255];
const COLOR_RING = [76, 194, 255];
const RING_ALPHA = 0.32;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let c = n;

    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    table[n] = c >>> 0;
  }

  return table;
})();

/**
 * @param {Buffer} buffer
 * @returns {number}
 */
function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Собирает PNG-чанк.
 *
 * @param {string} type
 * @param {Buffer} data
 * @returns {Buffer}
 */
function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);

  length.writeUInt32BE(data.length, 0);

  const crc = crc32(Buffer.concat([typeBuffer, data]));
  const crcBuffer = Buffer.alloc(4);

  crcBuffer.writeUInt32BE(crc, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

/**
 * Кодирует RGBA-пиксели в PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);

  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // глубина цвета
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // фильтр None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * Проверяет попадание точки в прямоугольник со скруглением.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} left
 * @param {number} top
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @returns {boolean}
 */
function insideRoundedRect(x, y, left, top, width, height, radius) {
  if (x < left || y < top || x > left + width || y > top + height) {
    return false;
  }

  const r = Math.min(radius, width / 2, height / 2);
  const innerLeft = left + r;
  const innerRight = left + width - r;
  const innerTop = top + r;
  const innerBottom = top + height - r;

  const nearestX = Math.min(Math.max(x, innerLeft), innerRight);
  const nearestY = Math.min(Math.max(y, innerTop), innerBottom);

  const dx = x - nearestX;
  const dy = y - nearestY;

  return dx * dx + dy * dy <= r * r;
}

/**
 * Рисует иконку заданного размера.
 *
 * @param {number} size
 * @returns {Buffer} RGBA.
 */
function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = 4;
  const radius = size * 0.22;

  const barWidth = size * 0.085;
  const barGap = size * 0.05;
  const barRadius = barWidth / 2;
  const centerX = size / 2;
  const heights = [0.22, 0.34, 0.26].map((ratio) => size * ratio);
  const totalWidth = barWidth * 3 + barGap * 2;
  const firstLeft = centerX - totalWidth / 2;

  const ringOuter = size * 0.31;
  const ringInner = ringOuter - size * 0.032;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;

          if (!insideRoundedRect(px, py, 0, 0, size, size, radius)) {
            continue;
          }

          const ratio = py / size;

          let r = COLOR_BACKGROUND_TOP[0] + (COLOR_BACKGROUND_BOTTOM[0] - COLOR_BACKGROUND_TOP[0]) * ratio;
          let g = COLOR_BACKGROUND_TOP[1] + (COLOR_BACKGROUND_BOTTOM[1] - COLOR_BACKGROUND_TOP[1]) * ratio;
          let b = COLOR_BACKGROUND_TOP[2] + (COLOR_BACKGROUND_BOTTOM[2] - COLOR_BACKGROUND_TOP[2]) * ratio;

          const distance = Math.hypot(px - centerX, py - centerX);

          if (distance <= ringOuter && distance >= ringInner) {
            r = r * (1 - RING_ALPHA) + COLOR_RING[0] * RING_ALPHA;
            g = g * (1 - RING_ALPHA) + COLOR_RING[1] * RING_ALPHA;
            b = b * (1 - RING_ALPHA) + COLOR_RING[2] * RING_ALPHA;
          }

          for (let index = 0; index < 3; index += 1) {
            const left = firstLeft + index * (barWidth + barGap);
            const top = centerX - heights[index] / 2;

            if (insideRoundedRect(px, py, left, top, barWidth, heights[index], barRadius)) {
              r = COLOR_ACCENT[0];
              g = COLOR_ACCENT[1];
              b = COLOR_ACCENT[2];
            }
          }

          red += r;
          green += g;
          blue += b;
          alpha += 1;
        }
      }

      const total = samples * samples;
      const offset = (y * size + x) * 4;

      if (alpha === 0) {
        pixels[offset] = 0;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = 0;
        pixels[offset + 3] = 0;
        continue;
      }

      pixels[offset] = Math.round(red / alpha);
      pixels[offset + 1] = Math.round(green / alpha);
      pixels[offset + 2] = Math.round(blue / alpha);
      pixels[offset + 3] = Math.round((alpha / total) * 255);
    }
  }

  return pixels;
}

/**
 * Оборачивает PNG в ICO-контейнер (один размер).
 *
 * @param {Buffer} png
 * @param {number} size
 * @returns {Buffer}
 */
function createIco(png, size) {
  const header = Buffer.alloc(6);

  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);

  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, png]);
}

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const png512 = encodePng(512, 512, renderIcon(512));
  const png256 = encodePng(256, 256, renderIcon(256));

  fs.writeFileSync(path.join(OUTPUT_DIR, 'icon.png'), png512);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'icon.ico'), createIco(png256, 256));

  console.log('Иконка создана: assets/icon.png (512×512) и assets/icon.ico (256×256).');
}

main();
