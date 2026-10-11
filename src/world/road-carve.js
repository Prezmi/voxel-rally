
// Road carving: the spline sculpts the voxel terrain (docs/03 §3).
// For every 1 m of arc the corridor is resolved as a cross-section — carriageway
// with crown + camber, a rising shoulder lip, then a bank that blends onto the
// natural ground — so the road is a *formed* corridor instead of a plank laid in a
// trench (PLAN §10 criterion 3: "skarpy i pobocza", no vertical wall at the road edge).
//
// Cost control: each chunk resolves its columns once (a scratch buffer keeps the
// sample that covers a column best), so a column is written once, not once per
// passing metre of road.
import { BLOCK, blockForSurface } from './palette.js';
import { surface } from './surfaces.js';
import { CHUNK, WORLD_HEIGHT, chunkKey, keyToCx, keyToCz } from './chunk.js';
import { smoothstep, hash01 } from './noise.js';
const EDGE_SALT = 0x39d7a1c5;
const GRIT_SALT = 0x6b2f8e51;

// Cross-section of the corridor, metres out from the centreline (PLAN §10 "korytarz
// z poboczem i skarpą", docs/03 §3):
//   0 .. hw                  carriageway (crown + camber)
//   hw .. hw + SHOULDER      loose shoulder, rising lip so the road edge reads
//   hw+S .. hw+S+BANK        bank/slope blended onto the *column's own* ground
const SHOULDER = 1.5;
export { SHOULDER };
export const BANK = 9.5;
export const RAMP = SHOULDER + BANK;      // legacy name: full blend width
export const CROWN = 0.035;              // cross-fall of a graded road (m per half-width)
export const SHOULDER_RISE = 0.11;       // lip above the carriageway edge
// ---- carriageway relief (JOB: the road is one continuous strip, not paving slabs) ----
// The block tile layer used to pave the corridor column by column, so the carriageway was
// a grid of 1 m plates with slots between them. The plates are now off the carriageway
// entirely (src/world/block-tiles.js TILE_ON_CARRIAGEWAY) and the relief the corridor needs
// is carved into the terrain sheet itself, which is one continuous surface already: two
// compacted wheel-line ruts, the graded crown above, a broken edge line and a gravel
// ripple so the carriageway has small stones in it. All of it is heightfield geometry in
// the 1/16-block grid (6.25 cm resolution), so it self-shadows and catches the sun.
export const RUT_DEPTH = 0.115;          // m a wheel line sits below the crown line
export const RUT_AT = 0.55;             // wheel line at 55 % of half-width (matches wear band)
export const RUT_WIDTH = 0.30;          // gaussian sigma, as a fraction of half-width
export const EDGE_BREAK = 0.10;         // m of jitter on the carriageway edge (broken lip)
export const GRAVEL_RIPPLE = 0.055;     // m of small-stone ripple across the strip

/**
 * Surface key -> block id for a corridor column, with the biome guard: SNOW/ICE are
 * MOUNTAIN-only. A shoulder or bank that resolved to a palette entry whose tone anchors
 * are the cool snow/ice pair is what put the pale dashes along the corridor edge
 * (PLAN §10 criterion 2/3: the verge must read as gravel and earth, never as ice).
 */
const FROZEN = new Set([BLOCK.SNOW, BLOCK.ICE]);
function corridorBlock(key, biome) {
  const id = blockForSurface(key);
  if (id === 0) return BLOCK.GRAVEL;
  if (FROZEN.has(id) && biome !== 'MOUNTAIN') return BLOCK.GRAVEL;
  return id;
}

const COLS = CHUNK * CHUNK;
const scratchBest = new Float32Array(COLS);
const scratchD = new Float32Array(COLS);      // signed lateral distance of the best sample
const scratchH = new Float32Array(COLS);      // road bed height at that sample (camber applied)
const scratchHW = new Float32Array(COLS);     // carriageway half-width at that sample
const scratchBlock = new Uint8Array(COLS);
const scratchUsed = new Uint8Array(COLS);

/**
 * Local average of the natural ground around a column (3 samples at stride 2, so a
 * 5x5 footprint, 9 reads). Natural terrain is quantised to whole blocks, so blending a
 * bank straight onto one column's top inherits those 1 m terraces as steps in the
 * verge; the average gives the bank a smooth reference while still landing on the real
 * ground at the outer edge of the corridor.
 */
function naturalSmooth(chunk, c) {
  const lx = c & (CHUNK - 1), lz = c >> 4;
  let sum = 0, n = 0;
  for (let dz = -2; dz <= 2; dz += 2) {
    const az = lz + dz;
    if (az < 0 || az >= CHUNK) continue;
    for (let dx = -2; dx <= 2; dx += 2) {
      const ax = lx + dx;
      if (ax < 0 || ax >= CHUNK) continue;
      const t = chunk.columnTop(az * CHUNK + ax);
      if (t < 0) continue;
      sum += t; n++;
    }
  }
  return n ? sum / n : chunk.columnTop(c);
}

/** Pre-index road samples per chunk so carving is O(corridor) per chunk. */
export function buildCarveIndex(road) {
  const index = new Map();
  for (let i = 0; i < road.n; i++) {
    const cx = Math.floor(road.x[i] / CHUNK), cz = Math.floor(road.z[i] / CHUNK);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const k = chunkKey(cx + dx, cz + dz);
        let a = index.get(k);
        if (!a) { a = []; index.set(k, a); }
        a.push(i);
      }
    }
  }
  return index;
}

export function carveChunk(world, cx, cz, road, carveIndex, terrain) {
  const samples = carveIndex.get(chunkKey(cx, cz));
  if (!samples || !samples.length) return 0;
  const chunk = world.ensureChunk(cx, cz);
  const x0 = cx * CHUNK, z0 = cz * CHUNK;

  scratchBest.fill(1e9);
  scratchUsed.fill(0);

  for (let k = 0; k < samples.length; k++) {
    const i = samples[k];
    const rx = road.x[i], rz = road.z[i];
    const hw = road.width[i] / 2;
    const reach = hw + SHOULDER + BANK;
    // Skip samples that cannot reach this chunk.
    const ddx = rx - (x0 + CHUNK / 2), ddz = rz - (z0 + CHUNK / 2);
    if (Math.abs(ddx) > CHUNK / 2 + reach || Math.abs(ddz) > CHUNK / 2 + reach) continue;

    const nx = road.nx[i], nz = road.nz[i];
    const camberTan = Math.tan(road.camber[i]);
    const roadBlock = corridorBlock(surface(road.surfaceId[i]).key, terrain.biome);

    for (let d = -reach; d <= reach; d += 0.5) {
      const px = rx + nx * d, pz = rz + nz * d;
      const colX = Math.floor(px), colZ = Math.floor(pz);
      if (Math.floor(colX / CHUNK) !== cx || Math.floor(colZ / CHUNK) !== cz) continue;
      const c = (colZ - z0) * CHUNK + (colX - x0);
      const absD = Math.abs(d);
      if (absD >= scratchBest[c]) continue;      // a nearer sample already claimed it

      // Only the *station* is remembered here. The height a column ends up at is
      // resolved in the write pass, against that column's own ground (below) — the
      // old code blended towards terrain.heightAt() measured at the road sample,
      // which for a column on a cross-slope is metres away from its own top and
      // left a stepped trench wall along the corridor (the staircase in the shot).
      const roadH = road.h[i] + d * camberTan;
      scratchBest[c] = absD;
      scratchD[c] = d;
      scratchH[c] = roadH;
      scratchHW[c] = hw;
      scratchBlock[c] = absD <= hw ? roadBlock : (absD <= hw + SHOULDER ? BLOCK.SHOULDER : 0);
      scratchUsed[c] = 1;
    }
  }

  let writes = 0;
  for (let c = 0; c < COLS; c++) {
    if (!scratchUsed[c]) continue;
    const colX = x0 + (c % CHUNK), colZ = z0 + Math.floor(c / CHUNK);
    const cur = chunk.columnTop(c);
    const hw = scratchHW[c], d = scratchD[c], absD = Math.abs(d);
    let blockId = scratchBlock[c], target;
    if (absD <= hw) {
      // Graded carriageway: crown (centre high, edges low) + camber into the corner, plus
      // the wheel-line ruts, a broken edge and a gravel ripple (see RUT_DEPTH above). The
      // ruts are continuous along the whole route because the carve samples the spline at
      // 0.5 m; nothing here is per-column independent, so the strip has no seam.
      const u = absD / hw;
      const wl = Math.exp(-Math.pow((absD - hw * RUT_AT) / (hw * RUT_WIDTH), 2));
      const edge = (hash01(colX, colZ, EDGE_SALT) - 0.5) * EDGE_BREAK
        * Math.max(0, (u - 0.55) / 0.45);
      const grit = (hash01(colX, colZ, GRIT_SALT) - 0.5) * GRAVEL_RIPPLE;
      target = scratchH[c] - CROWN * hw * u * u - RUT_DEPTH * wl + edge + grit;
    } else if (absD <= hw + SHOULDER) {
      target = scratchH[c] + (absD - hw) * SHOULDER_RISE;
    } else {
      if (cur < 0) continue;                       // bank must stand on existing ground
      // Blend onto THIS column's own surface: t=1 at the outer edge means the target
      // equals the untouched neighbour column exactly, so the corridor has no end wall
      // and every step inside the bank is sub-block (PLAN §10 criterion 3).
      const t = smoothstep(hw + SHOULDER, hw + SHOULDER + BANK, absD);
      const nat = naturalSmooth(chunk, c);
      // A stage is cut into the hill, not banked up on it: the blend may fill a verge a
      // little, but never a metre of imported embankment next to the carriageway (that
      // is what the old carve avoided by blending to a flat analytic profile, and what
      // the drive tests punish). Clamping the fill keeps the corridor a cutting with a
      // real bank while staying close to the carved baseline the stage was tuned on.
      target = Math.min((1 - t) * (scratchH[c] + SHOULDER * SHOULDER_RISE) + t * nat, nat + 0.45);
      if (Math.abs(cur - target) < 0.12) continue; // already natural ground: leave it
      const under = chunk.blocks[c * WORLD_HEIGHT + chunk.height[c]];
      blockId = (under && !FROZEN.has(under)) ? under : BLOCK.DIRT;
    }
    if (!isFinite(target)) continue;
    if (blockId === 0) blockId = BLOCK.DIRT;
    // Render-only wear field for the mesher (no effect on height/physics).
    // Semantics are *tone*, not damage: 0 = the darkest, most compacted strip,
    // 255 = the palest. PLAN §10.2 "Brud na drodze to koleiny, nie jasne łaty":
    // the wheel-line ruts are the DARK bands of the carriageway, the shoulder is a
    // slightly paler band, the road/grass edge is one narrow bright line, and the
    // bank decays to zero so natural ground (and grass) never gets a pale plate.
    // The old ramp put the wheel lines at the TOP of the range (70..220 with the
    // centre brighter than the verge), which is exactly the flat pale band the
    // screenshots read as "plates".
    let wear = 0;
    if (absD <= hw) {
      // Two compacted wheel lines at ~55 % half-width, drawn continuous along the
      // whole carriageway, plus a dark centre seam (crown of the road stays paler).
      const wl = Math.exp(-Math.pow((absD - hw * 0.55) / (hw * 0.20), 2))
        + Math.exp(-Math.pow((absD + hw * 0.55) / (hw * 0.20), 2));
      const mid = Math.exp(-Math.pow(absD / (hw * 0.45), 2));
      // Controlled spread, not a ramp across the whole range: base ~140, wheel ruts
      // down to ~96 (the darkest worked band), crown up to ~168. The old 30..172
      // swing put a near-black panel next to a lit one across 1 m of road.
      // Now 108 (rut) .. 146 (crown): a ~15 % of range spread, i.e. well under the
      // 12 % lightness step between neighbouring blocks once the shader band is applied.
      wear = 134 - 26 * wl + 12 * mid;
    } else if (absD <= hw + SHOULDER) {
      // Shoulder: loose material a shade paler than the carriageway + a crisp edge
      // line right at hw (kept inside the same tone band, no step to near-white).
      const e = (absD - hw) / SHOULDER;
      wear = 152 - 12 * e;
    } else {
      // Verge/bank: only a trace, gone within a third of the blend so grass keeps
      // its own tone (this tail used to brighten grass for several metres).
      wear = Math.max(0, 10 * (1 - (absD - hw - SHOULDER) / (BANK * 0.34)));
    }
    wear = wear < 0 ? 0 : wear > 255 ? 255 : wear | 0;
    if (chunk.wear[c] < wear) chunk.wear[c] = wear;
    if (world.carveColumn(colX, colZ, target, blockId)) writes++;
  }
  return writes;
}

/** Whole-stage carve (used by tests / offline generation). */
export function carveRoad(world, road, terrain) {
  const index = buildCarveIndex(road);
  let total = 0;
  for (const key of index.keys()) {
    total += carveChunk(world, keyToCx(key), keyToCz(key), road, index, terrain);
  }
  return { index, total };
}

/**
 * Fill and carve the chunks around a point. Terrain must exist in a chunk before
 * it can be carved (carveColumn lowers columns, it never builds them), so anything
 * that needs ground before Streaming gets a chance — the start line especially —
 * has to go through here rather than straight to carveChunk.
 */
export function prewarmArea(world, terrain, road, carveIndex, x, z, radius = 120) {
  const cx0 = Math.floor(x / CHUNK), cz0 = Math.floor(z / CHUNK);
  const span = Math.ceil(radius / CHUNK);
  let filled = 0;
  for (let dz = -span; dz <= span; dz++) {
    for (let dx = -span; dx <= span; dx++) {
      if (Math.hypot(dx * CHUNK, dz * CHUNK) > radius + CHUNK) continue;
      const cx = cx0 + dx, cz = cz0 + dz;
      terrain.generateChunk(world, cx, cz);
      const c = world.chunkAt(cx, cz);
      if (c && !c.carved) { carveChunk(world, cx, cz, road, carveIndex, terrain); c.carved = true; }
      filled++;
    }
  }
  return filled;
}
