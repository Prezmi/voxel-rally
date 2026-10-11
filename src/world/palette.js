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
  // One base tone per surface with a *small* controlled variation around it. The wide
  // anchors (GRAVEL 0x9d8d72 -> 0x6f6149, GRASS 0x63803d -> 0x41602f) let the shader's
  // world-space fbm swing a 1 m panel from sun-lit pale to near-black, which is what
  // the road read as (shots/pregen-check.png, FAULT 1: a brown/near-black checkerboard).
  // Verge grass was a uniform mint carpet: the anchors sat a whole step too pale and
  // too green. Pushed down into a dark, dusty field-side green so it sits under the
  // road tone instead of next to it.
  { id: BLOCK.GRASS, name: 'grass', surface: SURF.GRASS, color: 0x44602e, roughness: 0.94, loose: true, solid: true, pattern: 1, tone: [0x4e6b34, 0x38501f] },
  // STAGE ROAD PALETTE (one dominant mid-brown earth). The corridor is mostly SURF.GRAVEL
  // with a SHOULDER band, so GRAVEL used to sit a whole value step above DIRT: the road
  // read as a patchwork of tan/sand/grey plates (shots/stage-2.png). GRAVEL is now a
  // mid-brown earth sitting within ~6% value of DIRT, SHOULDER only a shade paler, MUD a
  // shade darker and glossier (the wheel ruts). Anchors are kept tight (tone spread <=
  // ~8%) so neighbouring blocks never separate by more than ~12% lightness.
  { id: BLOCK.DIRT, name: 'dirt', surface: SURF.DIRT, color: 0x585040, roughness: 0.96, loose: true, solid: true, pattern: 2, tone: [0x615a49, 0x4b4637] },
    // GRAVEL/SHOULDER are the corridor's own material and they cover most of the frame:
  // with the old 0xa8977a / 0xc0af8d anchors the sun pushed the worn wheel lines to a
  // near-white albedo (measured: 1002+ mesh panels with min channel >= 0.45 within the
  // start corridor). Anchored down to a dusty ochre so no lit panel can clip.
  // STAGE ROAD PALETTE: dusty brown-grey earth, not orange. The old anchors were ochre
  // (G running ~25 % above B), which under the warm key read as flat orange
  // (shots/veg-pass.png, FAULT: road = orange slab). Every road anchor is now pulled
  // towards neutral: R still leads, but B is within ~12 % of G, so the carriageway
  // reads as dusty brown-grey and the warm key stays in the *light*, not in the albedo.
  { id: BLOCK.GRAVEL, name: 'gravel', surface: SURF.GRAVEL, color: 0x635c4c, roughness: 0.88, loose: true, solid: true, pattern: 3, tone: [0x6d6755, 0x565142] },
  { id: BLOCK.ASPHALT, name: 'asphalt', surface: SURF.ASPHALT, color: 0x3d3d3c, roughness: 0.55, loose: false, solid: true, pattern: 4, tone: [0x474643, 0x303033] },
  // The wheel-line ruts: damp packed earth, so darker and noticeably glossier than
  // the dry crown it sits beside.
  { id: BLOCK.MUD, name: 'mud', surface: SURF.MUD, color: 0x35332c, roughness: 0.54, loose: true, solid: true, pattern: 2, tone: [0x3b3931, 0x2c2b24] },
  { id: BLOCK.SNOW, name: 'snow', surface: SURF.SNOW, color: 0xe7edf1, roughness: 0.75, loose: true, solid: true, pattern: 5, tone: [0xf1f5f8, 0xd6dfef] },
  { id: BLOCK.STONE, name: 'stone', surface: SURF.STONE, color: 0x5f5f5a, roughness: 0.65, loose: false, solid: true, pattern: 6, tone: [0x66655f, 0x565550] },
  { id: BLOCK.SAND, name: 'sand', surface: SURF.SAND, color: 0xc9b184, roughness: 0.98, loose: true, solid: true, pattern: 7, tone: [0xd6c093, 0xb49b72] },
  { id: BLOCK.PEAT, name: 'peat', surface: SURF.PEAT, color: 0x3b2f22, roughness: 1.0, loose: true, solid: true, pattern: 2, tone: [0x463725, 0x2d241a] },
  { id: BLOCK.ICE, name: 'ice', surface: SURF.ICE, color: 0xa8c6d4, roughness: 0.35, loose: false, solid: true, pattern: 8, tone: [0xbcd6e2, 0x8fb2c6] },
    // SHOULDER was the sandy-wash band: a full value step above the carriageway. Held
  // just a shade above GRAVEL now, so the road edge reads as packed earth, not sand.
  { id: BLOCK.SHOULDER, name: 'shoulder', surface: SURF.GRAVEL, color: 0x6d6858, roughness: 0.98, loose: true, solid: true, pattern: 3, tone: [0x777261, 0x615c4c] },
];

export function block(id) { return PALETTE[id] || PALETTE[0]; }
export function isSolid(id) { return PALETTE[id] && PALETTE[id].solid; }
export function blockSurface(id) { return PALETTE[id] ? PALETTE[id].surface : SURF.UNKNOWN; }

/** Block id for a surface key (used by road carving). */
export function blockForSurface(key) {
  const id = SURFACE_KEYS[key];
  if (id === undefined) return BLOCK.DIRT;
  // Explicit lookup order: the corridor never wants SNOW/ICE just because a surface
  // happens to share a palette entry with them (the roadside white-dash defect).
  for (const p of PALETTE) if (p.surface === id && p.id !== BLOCK.SNOW && p.id !== BLOCK.ICE) return p.id;
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
