#!/usr/bin/env node
// Draws the app icon (a donut chart on a dark tile) as PNGs for the web app manifest.
// No image libraries: a tiny PNG encoder over node:zlib. Run with `npm run icons`; the
// output is committed under src/web/public/icons/.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public", "icons");
mkdirSync(out, { recursive: true });

const BG = [0x14, 0x1b, 0x2d];
// Slices: categorical slots 1-4 of the chart palette, as shares of the ring.
const SLICES = [
  [0.42, [0x39, 0x87, 0xe5]],
  [0.26, [0xeb, 0x68, 0x34]],
  [0.18, [0x1b, 0xaf, 0x7a]],
  [0.14, [0xed, 0xa1, 0x00]],
];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Color of the point (x, y) in a unit square, or null for transparent. */
function sample(x, y, { maskable }) {
  // Tile: full bleed for maskable icons, rounded square otherwise.
  if (!maskable) {
    const r = 0.22;
    const dx = Math.max(r - x, 0, x - (1 - r));
    const dy = Math.max(r - y, 0, y - (1 - r));
    if (dx * dx + dy * dy > r * r) return null;
  }
  const cx = x - 0.5;
  const cy = y - 0.5;
  const d = Math.hypot(cx, cy);
  const scale = maskable ? 0.72 : 1; // keep the donut inside the maskable safe zone
  const outer = 0.36 * scale;
  const inner = 0.2 * scale;
  if (d > outer || d < inner) return BG;
  // Angle clockwise from 12 o'clock.
  let a = Math.atan2(cx, -cy) / (2 * Math.PI);
  if (a < 0) a += 1;
  // A thin gap between slices, in the tile color.
  let start = 0;
  for (const [share, color] of SLICES) {
    if (a < start + share) {
      const edge = Math.min(a - start, start + share - a) * 2 * Math.PI * d;
      return edge < 0.012 ? BG : color;
    }
    start += share;
  }
  return BG;
}

function draw(size, opts) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const c = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, opts);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 1;
          }
        }
      }
      const i = (y * size + x) * 4;
      const n = ss * ss;
      buf[i] = a ? Math.round(r / a) : 0;
      buf[i + 1] = a ? Math.round(g / a) : 0;
      buf[i + 2] = a ? Math.round(b / a) : 0;
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, buf);
}

const icons = [
  ["icon-192.png", 192, { maskable: false }],
  ["icon-512.png", 512, { maskable: false }],
  ["maskable-512.png", 512, { maskable: true }],
  ["apple-touch-icon.png", 180, { maskable: true }],
];
for (const [name, size, opts] of icons) {
  writeFileSync(join(out, name), draw(size, opts));
  console.log(`wrote ${name}`);
}
