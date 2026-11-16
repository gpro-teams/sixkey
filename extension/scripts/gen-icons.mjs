// Generates the toolbar/store icons from the brand mark (src/ui/art.tsx `Mark`): an ink tile, five sixths of a brass
// dial, the current second, and a keyhole. No dependencies: shapes are rasterised here with 8x8 supersampling.
// Run: node scripts/gen-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const INK = [20, 23, 29],
  BRASS = [215, 168, 76],
  KEY = [255, 255, 255];

// Geometry in the mark's 32-unit space; small sizes get heavier strokes so they survive the pixel grid.
const PARAMS = {
  16: { stroke: 4.6, r: 9.4, key: 3.1, dot: false, radius: 7 },
  32: { stroke: 3.9, r: 9.8, key: 2.85, dot: true, radius: 8 },
  48: { stroke: 3.5, r: 10, key: 2.65, dot: true, radius: 8.5 },
  128: { stroke: 3.4, r: 10, key: 2.6, dot: true, radius: 8.5 },
};

const deg = (x, y) => ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360; // 0 at twelve o'clock, clockwise
const polar = (r, a) => [16 + r * Math.sin((a * Math.PI) / 180), 16 - r * Math.cos((a * Math.PI) / 180)];

function inTile(x, y, rad) {
  const qx = Math.max(Math.abs(x - 16) - (16 - rad), 0),
    qy = Math.max(Math.abs(y - 16) - (16 - rad), 0);
  return Math.hypot(qx, qy) <= rad;
}
function inArc(x, y, p) {
  const dx = x - 16,
    dy = y - 16,
    a = deg(dx, dy),
    half = p.stroke / 2;
  if (a <= 300) return Math.abs(Math.hypot(dx, dy) - p.r) <= half;
  for (const end of [0, 300]) {
    const [ex, ey] = polar(p.r, end);
    if (Math.hypot(x - ex, y - ey) <= half) return true;
  }
  return false;
}
function inDot(x, y, p) {
  if (!p.dot) return false;
  const [cx, cy] = polar(p.r, 330);
  return Math.hypot(x - cx, y - cy) <= 1.75;
}
function inKey(x, y, p) {
  const s = p.key,
    cx = 16,
    cy = 16.4,
    top = cy - s * 1.55,
    hy = top + s;
  if (Math.hypot(x - cx, y - hy) <= s) return true;
  const y0 = top + s * 1.79,
    y1 = cy + s * 1.55;
  if (y < y0 || y > y1) return false;
  const hw = s * (0.62 + ((y - y0) / (y1 - y0)) * 0.04);
  return Math.abs(x - cx) <= hw;
}

function crc32(buf) {
  let c,
    crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const p = PARAMS[size],
    S = 8,
    rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let a = 0,
        r = 0,
        g = 0,
        b = 0;
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const x = ((px + (sx + 0.5) / S) / size) * 32,
            y = ((py + (sy + 0.5) / S) / size) * 32;
          if (!inTile(x, y, p.radius)) continue;
          const c = inKey(x, y, p) ? KEY : inArc(x, y, p) || inDot(x, y, p) ? BRASS : INK;
          a++;
          r += c[0];
          g += c[1];
          b += c[2];
        }
      if (a)
        row.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a / (S * S)) * 255)], 1 + px * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
mkdirSync("public/icons", { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`public/icons/${s}.png`, png(s));
