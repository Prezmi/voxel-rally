// Livery legibility sheet (queue P9): paint the door roundel exactly as
// src/render/car-livery.js does, then show it at the sizes it actually reaches the
// screen, minified TWO ways - a mip box filter (what the game samples now) and plain
// nearest (what it sampled before). Node-only: no canvas, no browser, no libraries, so
// the same numbers src/debug/tests.js T42 pins can be looked at as pixels.
//
//   node tools/livery-read.mjs [out.png]
//
// Roundel sizes across: 1:1 is the atlas itself (40 texels = 0.35 m). On a 1080p screen
// the 0.35 m roundel measures ~24 px at 12 m, ~16 px at 18 m, ~12 px at 24 m, 9 px at
// 32 m. Anything under the roundel's own texel count needs the mip chain or it aliases.
import { LIVERY_ROUND, LIVERY_BAND, LIVERY_STRIP, LIVERY_TEXEL, liveryNumberRects, liveryFor } from '../src/render/car-livery.js';

const OUT = process.argv[2] || 'shots/livery-read.png';
const CROP = 110;                    // texels of door around the roundel centre
const TARGETS = [1, 24, 16, 12, 9];  // roundel diameters to judge
const VIEW = 150;                    // display size of every cell, px

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const S = LIVERY_TEXEL;
const cx = LIVERY_ROUND.u * S, cy = (1 - LIVERY_ROUND.v) * S;
const r = LIVERY_ROUND.r * S;

/** The door as painted, in a CROP window of the atlas, RGBA 8-bit. */
function paintDoor(carId) {
  const t = liveryFor(carId);
  const img = new Uint8Array(CROP * CROP * 4);
  const put = (x, y, c, a = 255) => {
    if (x < 0 || y < 0 || x >= CROP || y >= CROP) return;
    const i = (y * CROP + x) * 4;
    img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; img[i + 3] = a;
  };
  const rect = (x0, y0, w, h, c) => {
    for (let y = Math.round(y0); y < Math.round(y0 + h); y++)
      for (let x = Math.round(x0); x < Math.round(x0 + w); x++) put(Math.round(x - x0o), Math.round(y - y0o), c);
  };
  const x0o = cx - CROP / 2, y0o = cy - CROP / 2;
  const body = hex(t.primary), ink = hex('#1a1b1f'), num = hex('#141414');
  // base + band + strip + disc + ring + number, same order as drawLivery
  for (let y = 0; y < CROP; y++) for (let x = 0; x < CROP; x++) put(x, y, body);
  rect(LIVERY_BAND.u0 * S, (1 - LIVERY_BAND.v1) * S, (LIVERY_BAND.u1 - LIVERY_BAND.u0) * S, (LIVERY_BAND.v1 - LIVERY_BAND.v0) * S, hex(t.secondary));
  rect(LIVERY_STRIP.u0 * S, (1 - LIVERY_STRIP.v1) * S, (LIVERY_STRIP.u1 - LIVERY_STRIP.u0) * S, (LIVERY_STRIP.v1 - LIVERY_STRIP.v0) * S, hex(t.secondary));
  for (let y = 0; y < CROP; y++) {
    for (let x = 0; x < CROP; x++) {
      const d = Math.hypot(x + x0o + 0.5 - cx, y + y0o + 0.5 - cy);
      if (d <= r) put(x, y, [255, 255, 255]);
      else if (d <= r + 3) put(x, y, ink);          // the 3 texel ring
    }
  }
  const n = liveryNumberRects(carId);
  for (const [x, y, w, h] of n.rects) rect(x, y, w, h, num);
  return img;
}

/** Two ways to throw texels away: a box filter (a mip level) and nearest (the old minFilter). */
function shrink(src, factor, mode) {
  const n = Math.round(CROP / factor);
  const out = new Uint8Array(n * n * 3);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let R = 0, G = 0, B = 0, c = 0;
      if (mode === 'nearest') {
        const sy = Math.min(CROP - 1, Math.floor((y + 0.5) * CROP / n)), sx = Math.min(CROP - 1, Math.floor((x + 0.5) * CROP / n));
        const i = (sy * CROP + sx) * 4;
        out[(y * n + x) * 3] = src[i]; out[(y * n + x) * 3 + 1] = src[i + 1]; out[(y * n + x) * 3 + 2] = src[i + 2];
        continue;
      }
      const y0 = Math.floor(y * CROP / n), y1 = Math.max(y0 + 1, Math.floor((y + 1) * CROP / n));
      const x0 = Math.floor(x * CROP / n), x1 = Math.max(x0 + 1, Math.floor((x + 1) * CROP / n));
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const i = (sy * CROP + sx) * 4;
        R += src[i]; G += src[i + 1]; B += src[i + 2]; c++;
      }
      out[(y * n + x) * 3] = R / c; out[(y * n + x) * 3 + 1] = G / c; out[(y * n + x) * 3 + 2] = B / c;
    }
  }
  return out;
}

/** Nearest-upscale an RGB buffer into the montage at (px,py), with a dark key line. */
function blit(dst, dw, dh, src, sw, sh, px, py, scale) {
  for (let y = 0; y < sh * scale; y++) {
    for (let x = 0; x < sw * scale; x++) {
      const i = ((py + y) * dw + px + x) * 3, j = (Math.floor(y / scale) * sw + Math.floor(x / scale)) * 3;
      dst[i] = src[j]; dst[i + 1] = src[j + 1]; dst[i + 2] = src[j + 2];
    }
  }
  // frame the cell so the columns are readable
  for (let k = 0; k < sw * scale; k++) {
    dst[((py) * dw + px + k) * 3] = 40; dst[((py) * dw + px + k) * 3 + 2] = 90;
    dst[((py + sh * scale - 1) * dw + px + k) * 3] = 40; dst[((py + sh * scale - 1) * dw + px + k) * 3 + 2] = 90;
  }
}

// ---- build the sheet: rows = cars, columns = 1:1, then mip / nearest per size ----
const cols = [{ k: 1, mode: 'mip' }];
for (const d of TARGETS.slice(1)) { cols.push({ k: (2 * r) / d, mode: 'mip', d }); cols.push({ k: (2 * r) / d, mode: 'nearest', d }); }
const cell = Math.ceil(VIEW / 1) ;
const dw = cols.length * (VIEW + 8) + 8, dh = 4 * (VIEW + 8) + 8;
const canvas = new Uint8Array(dw * dh * 3).fill(30);
const ids = ['A', 'B', 'C', 'D'];
ids.forEach((id, row) => {
  const door = paintDoor(id);
  cols.forEach((c, ci) => {
    const src = c.k === 1 ? toRgb(door, CROP) : shrink(door, c.k, c.mode);
    const sw = Math.round(CROP / c.k);
    const scale = Math.max(1, Math.floor(VIEW / sw));
    blit(canvas, dw, dh, src, sw, sw, 8 + ci * (VIEW + 8), 8 + row * (VIEW + 8), scale);
  });
});

function toRgb(src, n) { const o = new Uint8Array(n * n * 3); for (let i = 0; i < n * n; i++) { o[i * 3] = src[i * 4]; o[i * 3 + 1] = src[i * 4 + 1]; o[i * 3 + 2] = src[i * 4 + 2]; } return o; }

// ---- minimal PNG writer (node builtin zlib only) ----
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc = (b) => { let c = ~0; for (const x of b) c = CRC_T[(c ^ x) & 0xff] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type), body = Buffer.concat([t, data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(dw, 0); ihdr.writeUInt32BE(dh, 4); ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc((dw * 3 + 1) * dh);
for (let y = 0; y < dh; y++) { raw[y * (dw * 3 + 1)] = 0; Buffer.from(canvas.buffer, y * dw * 3, dw * 3).copy(raw, y * (dw * 3 + 1) + 1); }
const zlib = await import('node:zlib');
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
(await import('node:fs')).mkdirSync((await import('node:path')).dirname(OUT), { recursive: true });
(await import('node:fs')).writeFileSync(OUT, png);

const rows = ids.map((id) => {
  const n = liveryNumberRects(id);
  return `${id} '${n.label}' cell ${n.cell}+${n.bold} cap ${n.cap}/${(2 * r).toFixed(0)} stroke ${n.cell + n.bold} texels`;
});
console.log(`${OUT} ${dw}x${dh} · columns: atlas 1:1 | ${TARGETS.slice(1).map((d) => `${d}px mip, ${d}px nearest`).join(' | ')}`);
console.log(rows.join('\n'));
