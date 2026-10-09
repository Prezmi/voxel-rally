// Pixel font generated in code — no font file, no system font, no fetch (PLAN.md §10.1).
// Every glyph lives on an 8x8 cell, ascent 7 (one row below the baseline is left free),
// letters/digits on a 5x7 grid, advance 6. Glyph grids are arrays of 7 bitmasks
// (bit 4 = leftmost column) written straight into the source.
// The sheet is built ONCE into an offscreen canvas per colour and drawn with
// nearest-neighbour scaling at integer coordinates only.
const GW = 5, GH = 7, CELL = 8, ADVANCE = 6;

// 7 rows x 5 columns, bit 4 = leftmost. Accented letters carry their mark inside the
// 7-row box (a bitmap font has no room above the cap height), like classic 5x7 sets.
const RAW = {
  'A': '01110,10001,10001,11111,10001,10001,10001',
  'B': '11110,10001,10001,11110,10001,10001,11110',
  'C': '01111,10000,10000,10000,10000,10000,01111',
  'D': '11110,10001,10001,10001,10001,10001,11110',
  'E': '11111,10000,10000,11110,10000,10000,11111',
  'F': '11111,10000,10000,11110,10000,10000,10000',
  'G': '01110,10001,10000,10111,10001,10001,01111',
  'H': '10001,10001,10001,11111,10001,10001,10001',
  'I': '11111,00100,00100,00100,00100,00100,11111',
  'J': '00111,00010,00010,00010,00010,10010,01100',
  'K': '10001,10010,10100,11000,10100,10010,10001',
  'L': '10000,10000,10000,10000,10000,10000,11111',
  'M': '10001,11011,10101,10101,10001,10001,10001',
  'N': '10001,11001,10101,10011,10001,10001,10001',
  'O': '01110,10001,10001,10001,10001,10001,01110',
  'P': '11110,10001,10001,11110,10000,10000,10000',
  'Q': '01110,10001,10001,10001,10101,10010,01101',
  'R': '11110,10001,10001,11110,10100,10010,10001',
  'S': '01111,10000,10000,01110,00001,00001,11110',
  'T': '11111,00100,00100,00100,00100,00100,00100',
  'U': '10001,10001,10001,10001,10001,10001,01110',
  'V': '10001,10001,10001,10001,10001,01010,00100',
  'W': '10001,10001,10001,10101,10101,11011,10001',
  'X': '10001,01010,00100,01010,10001,10001,10001',   // corrected below
  'Y': '10001,10001,01010,00100,00100,00100,00100',
  'Z': '11111,00001,00010,00100,01000,10000,11111',
  // Polish diacritics (uppercase; lowercase is folded to uppercase in normalize()).
  'Ą': '01110,10001,10001,11111,10001,10001,00011',   // A + ogonek tail
  'Ć': '00110,01111,10000,10000,10000,10001,01111',   // C + acute
  'Ę': '11111,10000,11110,10000,10001,10001,00011',   // E + ogonek
  'Ł': '00010,10010,10010,10110,11100,10000,11111',   // L cut by a slash
  'Ń': '00110,10001,11001,10101,10011,10001,10001',   // N + acute
  'Ó': '00110,01110,10001,10001,10001,10001,01110',   // O + acute
  'Ś': '00110,01111,10000,01110,00001,00001,11110',   // S + acute
  'Ź': '00110,11111,00001,00010,00100,01000,11111',   // Z + acute
  'Ż': '00100,11111,00001,00010,00100,01000,11111',   // Z + dot
  '0': '01110,10001,10011,10101,11001,10001,01110',
  '1': '00100,01100,00100,00100,00100,00100,01110',
  '2': '01110,10001,00001,00010,00100,01000,11111',
  '3': '11111,00010,00100,00010,00001,10001,01110',
  '4': '00010,00110,01010,10010,11111,00010,00010',
  '5': '11111,10000,11110,00001,00001,10001,01110',
  '6': '00110,01000,10000,11110,10001,10001,01110',
  '7': '11111,00001,00010,00100,01000,01000,01000',
  '8': '01110,10001,10001,01110,10001,10001,01110',
  '9': '01110,10001,10001,01111,00001,00010,01100',
  ' ': '00000,00000,00000,00000,00000,00000,00000',
  '.': '00000,00000,00000,00000,00000,00110,00110',
  ',': '00000,00000,00000,00000,00110,00110,00100',
  ':': '00000,00110,00110,00000,00110,00110,00000',
  '-': '00000,00000,00000,11111,00000,00000,00000',
  '+': '00000,00100,00100,11111,00100,00100,00000',
  '=': '00000,00000,11111,00000,11111,00000,00000',
  '/': '00001,00001,00010,00100,01000,10000,10000',
  '°': '00100,01010,00100,00000,00000,00000,00000',
  "'": '00100,00100,00000,00000,00000,00000,00000',
  '!': '00100,00100,00100,00100,00100,00000,00100',
  '?': '01110,10001,00001,00110,00100,00000,00100',
  '%': '10001,00010,00100,00100,01000,10001,10001',   // % is too dense for 5 columns
  '(': '00010,00100,00100,00100,00100,00100,00010',
  ')': '01000,00100,00100,00100,00100,00100,01000',
  '>': '10000,01000,00100,00010,00100,01000,10000',
  '<': '00010,00100,01000,10000,01000,00100,00010',
  '·': '00000,00000,00000,01110,00000,00000,00000',
  '_': '00000,00000,00000,00000,00000,00000,11111',
  '#': '01010,01010,11111,01010,11111,01010,01010',
  '*': '00000,01010,00100,11111,00100,01010,00000',
};
// 'X' must read as an X: the diagonal has to cross in the middle row.
RAW['X'] = '10001,10001,01010,00100,01010,10001,10001';

const INDEX = new Map();
const ORDER = [];
for (const c of Object.keys(RAW)) { INDEX.set(c, ORDER.length); ORDER.push(c); }

const GLYPH_W = GW, GLYPH_H = GH, ADV = ADVANCE;

function normalize(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    let c = s[i];
    if (c === '’' || c === '‘' || c === '´') c = "'";
    if (c === '–' || c === '—') c = '-';
    if (c === '\n') { out += c; continue; }
    c = c.toUpperCase();
    out += INDEX.has(c) ? c : ' ';
  }
  return out;
}

// One sprite sheet per colour, built on first use and cached: the draw path is a
// single drawImage per glyph, so a colour never re-renders its pixels.
const SHEETS = new Map();
function sheetFor(color) {
  let s = SHEETS.get(color);
  if (s) return s;
  if (typeof document === 'undefined' || !document.createElement) return null;
  const cv = document.createElement('canvas');
  cv.width = ORDER.length * CELL; cv.height = GH;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.fillStyle = color;
  for (let i = 0; i < ORDER.length; i++) {
    const rows = RAW[ORDER[i]].split(',');
    for (let r = 0; r < GH; r++) {
      const mask = parseInt(rows[r], 2);
      if (!mask) continue;
      for (let c = 0; c < GW; c++) {
        if (mask & (1 << (GW - 1 - c))) g.fillRect(i * CELL + c, r, 1, 1);
      }
    }
  }
  SHEETS.set(color, cv);
  return cv;
}

/** Integer-only text draw. `x,y` and `scale` must be integers (true pixel art). */
function drawText(ctx, text, x, y, scale = 1, color = '#1E1E1E') {
  const sh = sheetFor(color);
  if (!sh) return;
  const s = normalize(text);
  let cx = Math.round(x);
  const cy = Math.round(y);
  const k = Math.max(1, Math.round(scale));
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') { cx = Math.round(x); cy += 9 * k; continue; }
    if (c !== ' ') {
      const idx = INDEX.get(c) * CELL;
      ctx.drawImage(sh, idx, 0, GW, GH, cx, cy, GW * k, GH * k);
    }
    cx += ADV * k;
  }
}

function textWidth(text, scale = 1) {
  return normalize(text).length * ADV * Math.max(1, Math.round(scale));
}

export { drawText, textWidth, normalize, GLYPH_W, GLYPH_H, ADV, GW, GH, CELL };
