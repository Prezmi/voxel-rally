// Chunk data + world registry (docs/03 §1).
// Chunk = 16x16 columns, 96 blocks tall, 1.0 m blocks.
// blocks are column-major: idx = (lz*16 + lx) * WORLD_HEIGHT + y
import { BLOCK, isSolid, blockSurface } from './palette.js';
import { noise3 } from './noise.js';

export const CHUNK = 16;
export const WORLD_HEIGHT = 96;
export const BLOCK_SIZE = 1.0;
export const COLS = CHUNK * CHUNK;

export class Chunk {
  constructor(cx, cz) {
    this.cx = cx; this.cz = cz;
    this.blocks = new Uint8Array(COLS * WORLD_HEIGHT);
    this.height = new Int8Array(COLS).fill(-1);   // y of topmost solid block
    this.surface = new Uint8Array(COLS);          // surface_id at the surface (physics reads this)
    // Sub-block vertical resolution, 1/16 block units (docs/03 §1). The surface of a
    // column sits at height + 1 + (fine + rut)/16 metres. `fine` is the carved bed
    // (road-carve writes a float road profile into a block grid without quantising it
    // to 1 m, which is what makes the road drivable); `rut` is wear (negative).
    this.fine = new Int16Array(COLS);             // carved sub-block offset, 0..15
    this.rut = new Int16Array(COLS);              // sub-block offset in 1/16 block (negative)
    // Render-only corridor wear, 0..255 (0 = untouched natural ground, high = a worn
    // wheel line / shoulder lip). Written by road-carve.js, read by the mesher for
    // tone only: it is NOT part of the column height and physics never reads it.
    this.wear = new Uint8Array(COLS);
    this.dirty = true;
    this.lod = -1;                                // 0 full, 1 simplified, 2 silhouette
    this.generated = false;
    this.meshes = null;
    this.triangles = 0;
  }

  colIndex(lx, lz) { return lz * CHUNK + lx; }

  /** Local block get. Out-of-chunk reads return AIR. */
  get(lx, lz, y) {
    if (lx < 0 || lz < 0 || lx >= CHUNK || lz >= CHUNK || y < 0 || y >= WORLD_HEIGHT) return BLOCK.AIR;
    return this.blocks[(lz * CHUNK + lx) * WORLD_HEIGHT + y];
  }

  /** Raw local set (does not refresh height; caller uses setSolid). */
  setRaw(lx, lz, y, id) {
    if (lx < 0 || lz < 0 || lx >= CHUNK || lz >= CHUNK || y < 0 || y >= WORLD_HEIGHT) return false;
    const i = (lz * CHUNK + lx) * WORLD_HEIGHT + y;
    if (this.blocks[i] === id) return false;
    this.blocks[i] = id;
    return true;
  }

  /** Recompute cached column height + surface id for one column. */
  refreshColumn(lx, lz) {
    const c = lz * CHUNK + lx;
    const base = c * WORLD_HEIGHT;
    let h = -1;
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      const id = this.blocks[base + y];
      if (id !== BLOCK.AIR) { h = y; break; }
    }
    // A block-level change invalidates the sub-block bed carved into this column.
    if (h !== this.height[c] || h < 0) this.fine[c] = 0;
    this.height[c] = h;
    this.surface[c] = h >= 0 ? blockSurface(this.blocks[base + h]) : 0;
  }

  refreshAll() {
    for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) this.refreshColumn(lx, lz);
  }

  /** Surface height in metres (top face of the topmost solid block) + sub-block offsets. */
  columnTop(c) {
    const h = this.height[c];
    return h < 0 ? -1 : h + 1 + (this.fine[c] + this.rut[c]) / 16;
  }

  /** Same height in 1/16-block integer units (what the mesher merges on), -1 = empty. */
  columnTopQ(c) {
    const h = this.height[c];
    return h < 0 ? -1 : (h + 1) * 16 + this.fine[c] + this.rut[c];
  }
}

// Keys must survive negative chunk coordinates: offset into the positive range.
const CKEY_OFF = 32768;
export function chunkKey(cx, cz) { return (cx + CKEY_OFF) * 65536 + (cz + CKEY_OFF); }
export function keyToCx(key) { return Math.floor(key / 65536) - CKEY_OFF; }
export function keyToCz(key) { return (key - Math.floor(key / 65536) * 65536) - CKEY_OFF; }

export class VoxelWorld {
  constructor(seed = 1) {
    this.seed = seed >>> 0;
    this.chunks = new Map();
    // Scratch list, capped (see ensureChunk): it used to be append-only and held a
    // reference to every chunk ever touched, i.e. it grew with distance travelled.
    this.dirtyQueue = [];
    this.blocksBroken = 0;
    this.maxBlocksBroken = 400;      // docs/02 §7
  }

  get chunkCount() { return this.chunks.size; }

  chunkAt(cx, cz) { return this.chunks.get(chunkKey(cx, cz)) || null; }

  ensureChunk(cx, cz) {
    const k = chunkKey(cx, cz);
    let c = this.chunks.get(k);
    if (!c) { c = new Chunk(cx, cz); this.chunks.set(k, c); }
    // Never accumulate: the queue is scratch space, not a history.
    if (this.dirtyQueue.length > 64) this.dirtyQueue.length = 0;
    return c;
  }

  /**
   * Release a chunk the player cannot see any more. Terrain generation and the road
   * carve are pure functions of (cx,cz,seed), so a chunk that comes back into range
   * regenerates to exactly the same columns. Without this the chunk Map - ~16 KB of
   * column arrays per chunk - grew for the whole stage (293 chunks in 30 s of
   * driving) and the GC pressure of that pile is part of the frame-rate sag.
   */
  dropChunk(cx, cz) {
    return this.chunks.delete(chunkKey(cx, cz));
  }

  // ---- world-space block access (integer block coords) ----
  blockAt(x, y, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return BLOCK.AIR;
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    if (y < 0 || y >= WORLD_HEIGHT) return BLOCK.AIR;
    return c.blocks[(lz * CHUNK + lx) * WORLD_HEIGHT + y];
  }

  isSolidAt(x, y, z) { return isSolid(this.blockAt(x, y, z)); }

  /** Set a block and refresh the affected column(s); marks chunks dirty. */
  setBlock(x, y, z, id) {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.ensureChunk(cx, cz);
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    if (!c.setRaw(lx, lz, y, id)) return false;
    c.refreshColumn(lx, lz);
    c.dirty = true;
    // Border columns affect neighbour chunk geometry (walls + AO).
    if (lx === 0) this.markDirty(cx - 1, cz);
    if (lx === CHUNK - 1) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    if (lz === CHUNK - 1) this.markDirty(cx, cz + 1);
    return true;
  }

  markDirty(cx, cz) {
    const c = this.chunks.get(chunkKey(cx, cz));
    if (c) c.dirty = true;
  }

  // ---- heightfield queries (docs/03 §1) ----
  /** Cached integer column top for a world column. */
  columnTopAt(x, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return -1;
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    return c.columnTop(lz * CHUNK + lx);
  }

  /** Column surface in 1/16-block units, exact (no float round-trip). */
  columnTopQAt(x, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return -1;
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    return c.columnTopQ(lz * CHUNK + lx);
  }

  /**
   * Ground height in metres at (x,z): bilinear between column centres, with a
   * wall-aware blend when the four columns differ by >=1 block (a cliff must not
   * become a ramp). Plus `micro` procedural relief (docs/03 §1, amplitude 0.06 m).
   */
  groundHeight(x, z) {
    const c00 = this.columnTopAt(Math.floor(x) - 1, Math.floor(z) - 1);
    const c10 = this.columnTopAt(Math.floor(x), Math.floor(z) - 1);
    const c01 = this.columnTopAt(Math.floor(x) - 1, Math.floor(z));
    const c11 = this.columnTopAt(Math.floor(x), Math.floor(z));
    if (c00 < 0 && c10 < 0 && c01 < 0 && c11 < 0) return 0;

    // Column centres are at (i + 0.5).
    const tx = x - Math.floor(x), tz = z - Math.floor(z);
    const g = (v) => (v < 0 ? 0 : v);
    const a = g(c00) * (1 - tx) + g(c10) * tx;
    const b = g(c01) * (1 - tx) + g(c11) * tx;
    const bil = a * (1 - tz) + b * tz;

    let lo = Infinity, hi = -Infinity;
    for (const v of [c00, c10, c01, c11]) { if (v < 0) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    let h = bil;
    if (hi - lo >= 1) {
      // Nearest column wins as the step gets taller -> a wall, not a slide.
      let near = c00, best = Infinity;
      const px = Math.floor(x) - 1 + 0.5, pz = Math.floor(z) - 1 + 0.5;
      const cand = [[px, pz, c00], [px + 1, pz, c10], [px, pz + 1, c01], [px + 1, pz + 1, c11]];
      for (const [qx, qz, qh] of cand) {
        if (qh < 0) continue;
        const d = (qx - x) * (qx - x) + (qz - z) * (qz - z);
        if (d < best) { best = d; near = qh; }
      }
      const blend = Math.min(1, (hi - lo - 1) / 1.5);
      h = bil + (g(near) - bil) * blend;
    }
    return h + micro(x, z, this.seed);
  }

  /** surface_id of the block at the surface of the column under (x,z). */
  surfaceAt(x, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return 0;
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    return c.surface[lz * CHUNK + lx];
  }

  /** Rut depth in metres at the column under (x,z) (0 = none). */
  rutAt(x, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return 0;
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    return Math.max(0, -c.rut[lz * CHUNK + lx] / 16);
  }

  /**
   * Carve a smooth road bed: force a column's top to `targetY` (metres) and set
   * its surface block. Used by road-carve.js. Keeps the column solid below.
   */
  carveColumn(x, z, targetY, blockId) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.ensureChunk(cx, cz);
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    const col = lz * CHUNK + lx;
    const base = col * WORLD_HEIGHT;
    // Work in 1/16-block units so the bed keeps sub-block precision: the block grid
    // holds the integer part, `fine` holds the remainder.
    const Q = Math.max(16, Math.min(WORLD_HEIGHT * 16, Math.round(targetY * 16)));
    const top = Math.min(WORLD_HEIGHT - 1, Math.floor(Q / 16) - 1);
    const sub = Q - (top + 1) * 16;
    const cur = c.height[col];
    if (cur === top && c.fine[col] === sub && c.blocks[base + top] === blockId) return false;
    if (cur > top) {
      for (let y = top + 1; y <= Math.min(cur, WORLD_HEIGHT - 1); y++) c.blocks[base + y] = BLOCK.AIR;
    } else if (cur >= 0) {
      for (let y = cur + 1; y <= top; y++) c.blocks[base + y] = c.blocks[base + cur];
    } else {
      for (let y = 0; y <= top; y++) c.blocks[base + y] = BLOCK.DIRT;
    }
    c.blocks[base + top] = blockId;
    c.rut[col] = 0;
    c.fine[col] = sub;
    c.height[col] = top;
    c.surface[col] = blockSurface(blockId);
    c.dirty = true;
    if (lx === 0) this.markDirty(cx - 1, cz);
    if (lx === CHUNK - 1) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    if (lz === CHUNK - 1) this.markDirty(cx, cz + 1);
    return true;
  }

  /** Set only the surface block of a column (no height change). */
  setSurfaceBlock(x, z, blockId) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.ensureChunk(cx, cz);
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    const col = lz * CHUNK + lx;
    const h = c.height[col];
    if (h < 0) return false;
    const base = col * WORLD_HEIGHT;
    if (c.blocks[base + h] === blockId) return false;
    c.blocks[base + h] = blockId;
    c.refreshColumn(lx, lz);
    c.dirty = true;
    return true;
  }

  /**
   * Rut carving is OFF as a height change (docs/02 §7 stays as a look only).
   * A loaded wheel used to push the column top down by up to 4 m of accumulated
   * `rut` (measured: -1.13 m worst, 62 m of total displacement in 30 s), which both
   * sank the car into the road and flagged every touched chunk dirty, so the mesher
   * rebuilt the terrain under the car several times a second. `rut` remains a field
   * the mesher and the wear shader read, pinned at 0, so the surface can never fall
   * below the height the carve left it at: the ground is graded, never pressed down
   * by the car. The wheel-line tone the rut used to buy is painted by the carve's
   * `wear` band already.
   */
  addRut() {
    return false;
  }

  /** Break a loose block (docs/02 §7). Returns true if a block was removed. */
  breakLooseBlock(x, y, z) {
    if (this.blocksBroken >= this.maxBlocksBroken) return false;
    const id = this.blockAt(x, y, z);
    if (!isSolid(id)) return false;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return false;
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    const col = lz * CHUNK + lx;
    if (c.height[col] !== y) return false;      // only surface blocks pop
    c.blocks[col * WORLD_HEIGHT + y] = BLOCK.AIR;
    c.refreshColumn(lx, lz);
    // No extra `rut` push here either: the ground under the car never sinks.
    c.dirty = true;
    this.blocksBroken++;
    this.markDirty(cx, cz);
    if (lx === 0) this.markDirty(cx - 1, cz);
    if (lx === CHUNK - 1) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    if (lz === CHUNK - 1) this.markDirty(cx, cz + 1);
    return true;
  }

  forEachChunk(fn) { for (const c of this.chunks.values()) fn(c); }
}

/** Procedural micro-relief, amplitude 0.06 m (docs/03 §1). */
export function micro(x, z, seed) {
  return 0.06 * noise3(x * 0.55, 7.31, z * 0.55, seed ^ 0x2545f491);
}
