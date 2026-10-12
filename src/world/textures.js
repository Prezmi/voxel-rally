// Procedural texture atlas: every tile is painted on a canvas at boot.
// No external image files exist in this game. Layout matches tiles.js
// (8x8 grid, 128 px tiles on a 1024 px canvas).

import { TILE, ATLAS_COLS } from './tiles.js';
import { mulberry32 } from '../core/rng.js';

const TS = 128;

function painters() {
  const P = {};
  const base = (ctx, color, rng, speckles, n = 420, alpha = 0.16) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, TS, TS);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = speckles[Math.floor(rng() * speckles.length)];
      ctx.globalAlpha = alpha + rng() * alpha;
      const s = 1 + rng() * 3;
      ctx.fillRect(rng() * TS, rng() * TS, s, s);
    }
    ctx.globalAlpha = 1;
  };

  P[TILE.GRASS] = (c, r) => {
    base(c, '#67a047', r, ['#578a3a', '#77b355', '#4c7d33', '#86c064'], 620, 0.18);
    c.strokeStyle = 'rgba(60,110,40,0.5)';
    for (let i = 0; i < 90; i++) {
      const x = r() * TS, y = r() * TS;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + (r() - 0.5) * 2, y - 3 - r() * 3); c.stroke();
    }
    // Sparse wild flowers.
    for (let i = 0; i < 7; i++) {
      c.fillStyle = ['#f5e97a', '#ffffff', '#e88bb0'][Math.floor(r() * 3)];
      const x = r() * TS, y = r() * TS;
      c.fillRect(x, y, 2.4, 2.4); c.fillRect(x - 1.6, y + 0.6, 1.4, 1.4); c.fillRect(x + 2.2, y + 0.6, 1.4, 1.4);
    }
    // Bare earth flecks.
    c.fillStyle = 'rgba(122,90,56,0.35)';
    for (let i = 0; i < 5; i++) { c.beginPath(); c.ellipse(r() * TS, r() * TS, 3 + r() * 5, 2 + r() * 3, r() * 3, 0, 7); c.fill(); }
  };
  P[TILE.GRASS_SIDE] = (c, r) => {
    base(c, '#7a5a38', r, ['#6b4e2f', '#8a683f', '#5d4429']);
    c.fillStyle = '#67a047';
    c.fillRect(0, 0, TS, 26);
    for (let x = 0; x < TS; x += 6) c.fillRect(x, 26, 4, 4 + r() * 10);
    c.fillStyle = '#578a3a'; c.fillRect(0, 0, TS, 7);
  };
  P[TILE.DIRT] = (c, r) => {
    base(c, '#8a6a42', r, ['#77572f', '#9c7c4e', '#6b4e2f'], 520, 0.18);
    c.fillStyle = 'rgba(90,70,45,0.6)';
    for (let i = 0; i < 12; i++) { c.beginPath(); c.arc(r() * TS, r() * TS, 2 + r() * 3, 0, 7); c.fill(); }
    // Embedded stones and a pale worn band.
    c.fillStyle = 'rgba(200,185,160,0.5)';
    for (let i = 0; i < 26; i++) c.fillRect(r() * TS, r() * TS, 2.5, 2);
    c.fillStyle = 'rgba(255,240,210,0.07)';
    c.fillRect(0, 44, TS, 40);
  };
  P[TILE.GRAVEL] = (c, r) => {
    c.fillStyle = '#8f8b82'; c.fillRect(0, 0, TS, TS);
    const shades = ['#7c786f', '#a3a099', '#6e6a62', '#b0aca2', '#948f85'];
    for (let i = 0; i < 420; i++) {
      c.fillStyle = shades[Math.floor(r() * shades.length)];
      c.globalAlpha = 0.85;
      c.beginPath(); c.ellipse(r() * TS, r() * TS, 2 + r() * 4, 1.5 + r() * 3, r() * 3, 0, 7); c.fill();
    }
    c.globalAlpha = 1;
    // Darker swept line and loose edges: reads as a used rally road.
    c.fillStyle = 'rgba(60,56,50,0.13)';
    c.fillRect(0, 50, TS, 28);
    c.fillStyle = 'rgba(255,250,240,0.10)';
    for (let i = 0; i < 30; i++) c.fillRect(r() * TS, r() * 12, 3, 2);
  };
  P[TILE.MUD] = (c, r) => {
    base(c, '#5f4630', r, ['#513b28', '#6e543a', '#48351f'], 300, 0.2);
    c.fillStyle = 'rgba(40,28,18,0.55)';
    for (let i = 0; i < 8; i++) { c.beginPath(); c.ellipse(r() * TS, r() * TS, 8 + r() * 16, 5 + r() * 8, r() * 3, 0, 7); c.fill(); }
    // Wet tyre ruts and standing water sheen.
    c.fillStyle = 'rgba(30,20,12,0.5)';
    c.fillRect(24, 0, 15, TS); c.fillRect(88, 0, 15, TS);
    c.fillStyle = 'rgba(168,188,205,0.30)';
    c.fillRect(27, 0, 4, TS); c.fillRect(91, 0, 4, TS);
    for (let i = 0; i < 4; i++) { c.beginPath(); c.ellipse(r() * TS, r() * TS, 7 + r() * 10, 4 + r() * 5, 0, 0, 7); c.fill(); }
  };
  P[TILE.ROCK] = (c, r) => {
    base(c, '#8d8d90', r, ['#7a7a7e', '#9d9da0', '#6e6e72'], 260, 0.2);
    c.strokeStyle = 'rgba(60,60,64,0.6)'; c.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      c.beginPath();
      let x = r() * TS, y = r() * TS;
      c.moveTo(x, y);
      for (let k = 0; k < 4; k++) { x += (r() - 0.5) * 40; y += (r() - 0.5) * 40; c.lineTo(x, y); }
      c.stroke();
    }
  };
  P[TILE.SAND] = (c, r) => {
    base(c, '#e2c07e', r, ['#d4af68', '#eed096', '#c9a55c'], 500, 0.12);
    c.strokeStyle = 'rgba(190,155,90,0.35)';
    for (let i = 0; i < 5; i++) {
      c.beginPath();
      const y = 14 + i * 26 + r() * 8;
      c.moveTo(0, y);
      for (let x = 0; x <= TS; x += 16) c.lineTo(x, y + Math.sin(x * 0.2 + i) * 3);
      c.stroke();
    }
  };
  P[TILE.SAND_SIDE] = (c, r) => {
    base(c, '#b08c54', r, ['#9c7a44', '#c09c60']);
    c.fillStyle = '#e2c07e'; c.fillRect(0, 0, TS, 20);
    c.fillStyle = '#d4af68'; for (let x = 0; x < TS; x += 7) c.fillRect(x, 20, 4, 3 + r() * 7);
  };
  P[TILE.SNOW] = (c, r) => {
    base(c, '#f2f6fa', r, ['#e4edf5', '#ffffff', '#d8e4ef'], 320, 0.25);
    c.fillStyle = '#ffffff';
    for (let i = 0; i < 26; i++) c.fillRect(r() * TS, r() * TS, 2, 2);
  };
  P[TILE.SNOW_SIDE] = (c, r) => {
    base(c, '#c9d6e4', r, ['#b8c9da', '#dbe6f0']);
    c.fillStyle = '#f6fafc'; c.fillRect(0, 0, TS, 22);
  };
  P[TILE.TARMAC] = (c, r) => {
    base(c, '#43464a', r, ['#3a3d40', '#4e5154', '#33363a'], 620, 0.15);
    // Cracks, tar patches and oil stains: an old mountain road.
    c.strokeStyle = 'rgba(20,21,24,0.55)'; c.lineWidth = 1.6;
    for (let i = 0; i < 5; i++) {
      c.beginPath();
      let x = r() * TS, y = r() * TS;
      c.moveTo(x, y);
      for (let k = 0; k < 4; k++) { x += (r() - 0.5) * 34; y += (r() - 0.5) * 34; c.lineTo(x, y); }
      c.stroke();
    }
    c.fillStyle = 'rgba(28,29,32,0.5)';
    for (let i = 0; i < 3; i++) c.fillRect(r() * TS * 0.8, r() * TS * 0.8, 18 + r() * 22, 12 + r() * 14);
    c.fillStyle = 'rgba(15,15,18,0.35)';
    for (let i = 0; i < 4; i++) { c.beginPath(); c.ellipse(r() * TS, r() * TS, 5 + r() * 9, 3 + r() * 5, r() * 3, 0, 7); c.fill(); }
    // Faded edge paint.
    c.fillStyle = 'rgba(232,230,223,0.5)';
    c.fillRect(3, 0, 4, TS); c.fillRect(TS - 7, 0, 4, TS);
  };
  P[TILE.TARMAC_LINE] = (c, r) => {
    P[TILE.TARMAC](c, r);
    c.fillStyle = '#e8e6df';
    c.fillRect(TS / 2 - 5, 0, 10, TS);
    c.fillStyle = 'rgba(0,0,0,0.18)';
    for (let i = 0; i < 20; i++) c.fillRect(TS / 2 - 5 + r() * 10, r() * TS, 2, 3);
  };
  P[TILE.SNOW_ROAD] = (c, r) => {
    base(c, '#e8eff6', r, ['#dbe6f0', '#f4f9fc'], 300, 0.2);
    c.fillStyle = 'rgba(150,168,190,0.5)';
    c.fillRect(26, 0, 16, TS); c.fillRect(86, 0, 16, TS);
    c.fillStyle = 'rgba(120,140,168,0.35)';
    c.fillRect(31, 0, 6, TS); c.fillRect(91, 0, 6, TS);
  };
  P[TILE.WOOD] = (c, r) => {
    c.fillStyle = '#8a6844'; c.fillRect(0, 0, TS, TS);
    for (let y = 0; y < TS; y += 32) {
      c.fillStyle = `rgba(0,0,0,${0.10 + r() * 0.08})`; c.fillRect(0, y, TS, 3);
      c.strokeStyle = 'rgba(90,64,36,0.5)';
      for (let i = 0; i < 4; i++) {
        c.beginPath(); const yy = y + 6 + r() * 22;
        c.moveTo(0, yy); c.bezierCurveTo(40, yy + 3, 90, yy - 3, TS, yy); c.stroke();
      }
    }
  };
  P[TILE.LEAF_PINE] = (c, r) => {
    base(c, '#2e5d33', r, ['#26502b', '#38693c', '#1f4624'], 500, 0.2);
    c.strokeStyle = 'rgba(20,50,24,0.6)';
    for (let i = 0; i < 90; i++) {
      const x = r() * TS, y = r() * TS;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + (r() - 0.5) * 7, y + 3 + r() * 4); c.stroke();
    }
  };
  P[TILE.LEAF_ROUND] = (c, r) => {
    c.fillStyle = '#3d7038'; c.fillRect(0, 0, TS, TS);
    const shades = ['#4c8a44', '#356b31', '#5a9a4e', '#2e5f2b'];
    for (let i = 0; i < 60; i++) {
      c.fillStyle = shades[Math.floor(r() * shades.length)];
      c.beginPath(); c.arc(r() * TS, r() * TS, 6 + r() * 11, 0, 7); c.fill();
    }
  };
  P[TILE.LEAF_AUTUMN] = (c, r) => {
    c.fillStyle = '#a35a24'; c.fillRect(0, 0, TS, TS);
    const shades = ['#c47a2e', '#8f4c1e', '#d99a3a', '#7d5a20'];
    for (let i = 0; i < 60; i++) {
      c.fillStyle = shades[Math.floor(r() * shades.length)];
      c.beginPath(); c.arc(r() * TS, r() * TS, 6 + r() * 11, 0, 7); c.fill();
    }
  };
  P[TILE.SNOW_TREE] = (c, r) => {
    P[TILE.LEAF_PINE](c, r);
    c.fillStyle = 'rgba(245,250,252,0.85)';
    for (let i = 0; i < 46; i++) c.fillRect(r() * TS, r() * TS * 0.6, 3 + r() * 5, 2);
  };
  P[TILE.BARK] = (c, r) => {
    c.fillStyle = '#6b4c30'; c.fillRect(0, 0, TS, TS);
    for (let x = 0; x < TS; x += 9) {
      c.fillStyle = `rgba(40,26,14,${0.25 + r() * 0.3})`;
      c.fillRect(x, 0, 3 + r() * 3, TS);
      c.fillStyle = 'rgba(140,110,76,0.35)';
      c.fillRect(x + 4, 0, 2, TS);
    }
  };
  P[TILE.STONE] = (c, r) => {
    c.fillStyle = '#9a968c'; c.fillRect(0, 0, TS, TS);
    c.fillStyle = '#7e7a72';
    for (let y = 0; y < TS; y += 26) c.fillRect(0, y, TS, 4);
    for (let y = 0, row = 0; y < TS; y += 26, row++)
      for (let x = (row % 2) * 22; x < TS; x += 44) c.fillRect(x, y, 4, 26);
    base(c, 'rgba(0,0,0,0)', r, ['#8a867e', '#aaa69c'], 160, 0.15);
  };
  P[TILE.HAY] = (c, r) => {
    c.fillStyle = '#dcb84a'; c.fillRect(0, 0, TS, TS);
    c.strokeStyle = 'rgba(160,124,32,0.7)';
    for (let i = 0; i < 110; i++) {
      const x = r() * TS, y = r() * TS;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + 8 + r() * 14, y + (r() - 0.5) * 4); c.stroke();
    }
  };
  const roof = (color, dark) => (c, r) => {
    c.fillStyle = color; c.fillRect(0, 0, TS, TS);
    for (let y = 0; y < TS; y += 21) {
      c.fillStyle = dark; c.fillRect(0, y, TS, 5);
      c.fillStyle = 'rgba(255,255,255,0.10)'; c.fillRect(0, y + 5, TS, 3);
    }
  };
  P[TILE.ROOF_RED] = roof('#a03c30', 'rgba(90,26,20,0.8)');
  P[TILE.ROOF_GREY] = roof('#6e7278', 'rgba(52,55,60,0.8)');
  P[TILE.WALL_CREAM] = (c, r) => {
    base(c, '#e6dbc2', r, ['#d9cbae', '#f2e8d2'], 200, 0.12);
    c.fillStyle = 'rgba(120,100,70,0.35)'; c.fillRect(0, TS - 14, TS, 14);
  };
  P[TILE.GLASS] = (c, r) => {
    const g = c.createLinearGradient(0, 0, TS, TS);
    g.addColorStop(0, '#9fc8dd'); g.addColorStop(0.5, '#5d8aa8'); g.addColorStop(1, '#7fb0c9');
    c.fillStyle = g; c.fillRect(0, 0, TS, TS);
    c.fillStyle = 'rgba(255,255,255,0.5)';
    c.beginPath(); c.moveTo(18, TS); c.lineTo(58, 0); c.lineTo(84, 0); c.lineTo(44, TS); c.fill();
    void r;
  };
  const paint = (color, shade) => (c, r) => {
    base(c, color, r, [shade], 130, 0.10);
    const g = c.createLinearGradient(0, 0, 0, TS);
    g.addColorStop(0, 'rgba(255,255,255,0.13)'); g.addColorStop(1, 'rgba(0,0,0,0.13)');
    c.fillStyle = g; c.fillRect(0, 0, TS, TS);
  };
  P[TILE.WHITE] = paint('#eef0f2', '#d5d9dd');
  P[TILE.RED] = paint('#c23327', '#a02820');
  P[TILE.BLUE] = paint('#2456c4', '#1d46a5');
  P[TILE.YELLOW] = paint('#f2b61c', '#d9a114');
  P[TILE.ORANGE] = paint('#e8710c', '#cc6208');
  P[TILE.BLACK] = paint('#23252a', '#17181c');
  P[TILE.METAL] = (c, r) => {
    base(c, '#9aa0a6', r, ['#878d93', '#aeb4ba'], 200, 0.12);
    c.fillStyle = 'rgba(60,64,68,0.8)';
    for (const [x, y] of [[10, 10], [TS - 10, 10], [10, TS - 10], [TS - 10, TS - 10]]) {
      c.beginPath(); c.arc(x, y, 4, 0, 7); c.fill();
    }
    c.fillStyle = 'rgba(70,74,78,0.5)'; c.fillRect(0, TS / 2 - 2, TS, 4);
  };
  P[TILE.TYRE] = (c, r) => {
    base(c, '#1c1d20', r, ['#26272b', '#121316'], 200, 0.2);
    c.fillStyle = 'rgba(70,72,78,0.7)';
    for (let y = 6; y < TS; y += 16) for (let x = 0; x < TS; x += 16) c.fillRect(x + ((y / 16) % 2) * 8, y, 8, 5);
  };
  P[TILE.CACTUS] = (c, r) => {
    base(c, '#3f7d3a', r, ['#356b31', '#4c8f45'], 200, 0.14);
    c.fillStyle = 'rgba(30,70,28,0.55)';
    for (let x = 14; x < TS; x += 26) c.fillRect(x, 0, 5, TS);
    c.fillStyle = 'rgba(230,240,200,0.8)';
    for (let i = 0; i < 22; i++) c.fillRect(r() * TS, r() * TS, 2, 2);
  };
  const chevron = (dir) => (c, r) => {
    c.fillStyle = '#2b2d30'; c.fillRect(0, 0, TS, TS);
    c.strokeStyle = '#ffb400'; c.lineWidth = 17; c.lineCap = 'square';
    for (const off of [-38, 8]) {
      c.beginPath();
      if (dir > 0) { c.moveTo(38 + off, 30); c.lineTo(84 + off, 64); c.lineTo(38 + off, 98); }
      else { c.moveTo(90 + off, 30); c.lineTo(44 + off, 64); c.lineTo(90 + off, 98); }
      c.stroke();
    }
    void r;
  };
  P[TILE.CHEVRON_R] = chevron(1);
  P[TILE.CHEVRON_L] = chevron(-1);
  P[TILE.BANNER] = (c, r) => {
    c.fillStyle = '#f0f0ee'; c.fillRect(0, 0, TS, TS);
    c.fillStyle = '#c23327';
    for (let x = 0; x < TS; x += 32) c.fillRect(x, 0, 16, TS);
    c.fillStyle = 'rgba(0,0,0,0.85)';
    c.font = 'bold 44px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle';
    void r;
  };
  P[TILE.ICE] = (c, r) => {
    base(c, '#cfe2ee', r, ['#bdd5e6', '#e2eef6', '#aecadb'], 260, 0.22);
    const g = c.createLinearGradient(0, 0, TS, TS);
    g.addColorStop(0, 'rgba(255,255,255,0.35)'); g.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(140,170,200,0.25)');
    c.fillStyle = g; c.fillRect(0, 0, TS, TS);
    c.strokeStyle = 'rgba(240,250,255,0.8)'; c.lineWidth = 1.4;
    for (let i = 0; i < 6; i++) {
      c.beginPath();
      let x = r() * TS, y = r() * TS;
      c.moveTo(x, y);
      for (let k = 0; k < 3; k++) { x += (r() - 0.5) * 44; y += (r() - 0.5) * 44; c.lineTo(x, y); }
      c.stroke();
    }
    // Dark tarmac ghosts through the ice.
    c.fillStyle = 'rgba(60,70,80,0.18)';
    c.fillRect(0, 52, TS, 24);
  };
  P[TILE.DRY_GRASS] = (c, r) => {
    base(c, '#b3a05e', r, ['#a08c4c', '#c2b06c', '#8f7c40'], 520, 0.16);
    c.strokeStyle = 'rgba(140,120,60,0.6)';
    for (let i = 0; i < 110; i++) {
      const x = r() * TS, y = r() * TS;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + (r() - 0.5) * 3, y - 2 - r() * 4); c.stroke();
    }
    c.fillStyle = 'rgba(150,110,70,0.3)';
    for (let i = 0; i < 6; i++) { c.beginPath(); c.ellipse(r() * TS, r() * TS, 4 + r() * 6, 2 + r() * 3, r() * 3, 0, 7); c.fill(); }
  };
  P[TILE.RED_DIRT] = (c, r) => {
    base(c, '#a4502f', r, ['#93452a', '#b55d38', '#8a3e24'], 560, 0.18);
    c.fillStyle = 'rgba(230,190,150,0.4)';
    for (let i = 0; i < 30; i++) c.fillRect(r() * TS, r() * TS, 2.5, 2);
    // Corrugations, the outback classic.
    c.fillStyle = 'rgba(70,30,16,0.16)';
    for (let y = 4; y < TS; y += 11) c.fillRect(0, y, TS, 3);
    c.fillStyle = 'rgba(255,220,190,0.10)';
    c.fillRect(0, 46, TS, 34);
  };
  P[TILE.POST] = (c, r) => {
    c.fillStyle = '#e8e6df'; c.fillRect(0, 0, TS, TS);
    c.fillStyle = '#d23a2a';
    for (let y = -TS; y < TS * 2; y += 44) {
      c.beginPath();
      c.moveTo(0, y); c.lineTo(TS, y + TS * 0.55); c.lineTo(TS, y + TS * 0.55 + 22); c.lineTo(0, y + 22);
      c.fill();
    }
    base(c, 'rgba(0,0,0,0)', r, ['#c9c5ba', '#f4f2ec'], 120, 0.12);
  };
  P[TILE.TAPE] = (c, r) => {
    c.fillStyle = '#ff5a1f'; c.fillRect(0, 0, TS, TS);
    c.fillStyle = '#ffffff';
    c.font = 'bold 30px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let x = 16; x < TS; x += 42) c.fillRect(x, TS / 2 - 9, 22, 18);
    void r;
  };
  P[TILE.PUDDLE] = (c, r) => {
    const g = c.createLinearGradient(0, 0, TS, TS);
    g.addColorStop(0, '#7d99ad'); g.addColorStop(0.45, '#4d6a80'); g.addColorStop(1, '#6d8aa0');
    c.fillStyle = g; c.fillRect(0, 0, TS, TS);
    c.fillStyle = 'rgba(255,255,255,0.4)';
    c.beginPath(); c.moveTo(14, TS); c.lineTo(56, 0); c.lineTo(76, 0); c.lineTo(34, TS); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.2)';
    for (let i = 0; i < 5; i++) { c.beginPath(); c.ellipse(r() * TS, r() * TS, 6 + r() * 10, 2 + r() * 3, 0, 0, 7); c.fill(); }
  };
  P[TILE.HIVIS] = (c, r) => {
    base(c, '#d8e021', r, ['#c3cb1a', '#e8ec40'], 140, 0.12);
    c.fillStyle = '#c0c6cc'; c.fillRect(0, 52, TS, 12); c.fillRect(0, 84, TS, 10);
    c.fillStyle = 'rgba(0,0,0,0.12)'; c.fillRect(0, 0, TS, 8);
  };
  P[TILE.SCRUB] = (c, r) => {
    base(c, '#9a8f66', r, ['#8a7f58', '#aa9f74', '#7d724e'], 420, 0.16);
    c.fillStyle = 'rgba(110,105,80,0.55)';
    for (let i = 0; i < 26; i++) { c.beginPath(); c.arc(r() * TS, r() * TS, 2 + r() * 4, 0, 7); c.fill(); }
    c.fillStyle = 'rgba(90,95,60,0.6)';
    for (let i = 0; i < 34; i++) c.fillRect(r() * TS, r() * TS, 3, 4);
    c.fillStyle = 'rgba(200,190,160,0.35)';
    for (let i = 0; i < 20; i++) c.fillRect(r() * TS, r() * TS, 2.5, 2);
  };
  P[TILE.FLOWER] = (c, r) => {
    base(c, '#5d9440', r, ['#4f8434', '#6ca34e'], 200, 0.14);
    for (let i = 0; i < 26; i++) {
      c.fillStyle = ['#e84f7a', '#f5e97a', '#ffffff', '#b678e8'][Math.floor(r() * 4)];
      c.fillRect(r() * TS, r() * TS, 3, 3);
    }
  };
  return P;
}

export function createAtlasCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff00ff';
  ctx.fillRect(0, 0, 1024, 1024);
  const P = painters();
  for (let tile = 0; tile < ATLAS_COLS * ATLAS_COLS; tile++) {
    const painter = P[tile];
    if (!painter) continue;
    const col = tile % ATLAS_COLS;
    const row = Math.floor(tile / ATLAS_COLS);
    ctx.save();
    ctx.translate(col * TS, row * TS);
    ctx.beginPath();
    ctx.rect(0, 0, TS, TS);
    ctx.clip();
    painter(ctx, mulberry32(9000 + tile * 131));
    ctx.restore();
  }
  return canvas;
}

export function createAtlasTexture(THREE) {
  const tex = new THREE.CanvasTexture(createAtlasCanvas());
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
