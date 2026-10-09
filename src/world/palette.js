// BLOCK PALETTE (docs/06 §2 world/palette.js). Block id -> render + physics link.
// Every block resolves to a surface_id; physics reads surface_id, never the block
// (docs/03 §1). Colour/roughness feed the procedural terrain shader.
import { SURF, SURFACE_KEYS, surface } from './surfaces.js';

export const BLOCK = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  GRAVEL: 3,
  ASPHALT: 4,
  MUD: 5,
  SNOW: 6,
  STONE: 7,
  SAND: 8,
  PEAT: 9,
  ICE: 10,
  // shoulder / loose roadside material
  SHOULDER: 11,
};

// Colour/roughness feed the procedural terrain shader. `tone` is the pair of hue
// anchors the shader mixes between across a multi-octave noise field (PLAN §10
// criterion 2: panels of the same surface must differ in hue *and* value, >= 12%).
export const PALETTE = [
  { id: BLOCK.AIR, name: 'air', surface: SURF.UNKNOWN, color: 0x000000, roughness: 1, loose: false, solid: false, pattern: 0, tone: [0x7a6a52, 0x6d5f4c] },
  { id: BLOCK.GRASS, name: 'grass', surface: SURF.GRASS, color: 0x53713a, roughness: 0.92, loose: true, solid: true, pattern: 1, tone: [0x63803d, 0x41602f] },
  { id: BLOCK.DIRT, name: 'dirt', surface: SURF.DIRT, color: 0x6b4f32, roughness: 0.96, loose: true, solid: true, pattern: 2, tone: [0x7a5c3c, 0x55402a] },
  { id: BLOCK.GRAVEL, name: 'gravel', surface: SURF.GRAVEL, color: 0x9c8a6d, roughness: 0.95, loose: true, solid: true, pattern: 3, tone: [0xa99878, 0x857460] },
  { id: BLOCK.ASPHALT, name: 'asphalt', surface: SURF.ASPHALT, color: 0x3d3d3c, roughness: 0.55, loose: false, solid: true, pattern: 4, tone: [0x474643, 0x303033] },
  { id: BLOCK.MUD, name: 'mud', surface: SURF.MUD, color: 0x4f3a28, roughness: 1.0, loose: true, solid: true, pattern: 2, tone: [0x5c4530, 0x3d2c1e] },
  { id: BLOCK.SNOW, name: 'snow', surface: SURF.SNOW, color: 0xe7edf1, roughness: 0.75, loose: true, solid: true, pattern: 5, tone: [0xf1f5f8, 0xd6dfef] },
  { id: BLOCK.STONE, name: 'stone', surface: SURF.STONE, color: 0x6b6b66, roughness: 0.65, loose: false, solid: true, pattern: 6, tone: [0x77766e, 0x5a5a58] },
  { id: BLOCK.SAND, name: 'sand', surface: SURF.SAND, color: 0xc9b184, roughness: 0.98, loose: true, solid: true, pattern: 7, tone: [0xd6c093, 0xb49b72] },
  { id: BLOCK.PEAT, name: 'peat', surface: SURF.PEAT, color: 0x3b2f22, roughness: 1.0, loose: true, solid: true, pattern: 2, tone: [0x463725, 0x2d241a] },
  { id: BLOCK.ICE, name: 'ice', surface: SURF.ICE, color: 0xa8c6d4, roughness: 0.35, loose: false, solid: true, pattern: 8, tone: [0xbcd6e2, 0x8fb2c6] },
  { id: BLOCK.SHOULDER, name: 'shoulder', surface: SURF.GRAVEL, color: 0x87775d, roughness: 1.0, loose: true, solid: true, pattern: 3, tone: [0x948465, 0x726349] },
];

export function block(id) { return PALETTE[id] || PALETTE[0]; }
export function isSolid(id) { return PALETTE[id] && PALETTE[id].solid; }
export function blockSurface(id) { return PALETTE[id] ? PALETTE[id].surface : SURF.UNKNOWN; }

/** Block id for a surface key (used by road carving). */
export function blockForSurface(key) {
  const id = SURFACE_KEYS[key];
  if (id === undefined) return BLOCK.DIRT;
  for (const p of PALETTE) if (p.surface === id) return p.id;
  return BLOCK.DIRT;
}

/** Colour as 0..1 rgb triple (for vertex colours). */
export function blockColor(id, out = [0, 0, 0]) {
  const c = block(id).color;
  out[0] = ((c >> 16) & 255) / 255;
  out[1] = ((c >> 8) & 255) / 255;
  out[2] = (c & 255) / 255;
  return out;
}

export { surface };

/**
 * Per-surface hue anchors (index = SURF id, matching the aSurface attribute the
 * mesher writes). The shader mixes A->B over a world-space noise field, which is
 * what removes the flat "slab" look without a single texture.
 */
export function surfaceTones() {
  let maxId = 0;
  for (const k in SURF) if (SURF[k] > maxId) maxId = SURF[k];
  const n = maxId + 1;
  const a = new Array(n).fill(0x808080), b = new Array(n).fill(0x808080);
  for (const p of PALETTE) {
    const s = p.surface;
    if (s < 0 || s >= n) continue;
    if (a[s] === 0x808080) { a[s] = p.tone[0]; b[s] = p.tone[1]; }   // first block wins
  }
  return { a, b };
}
