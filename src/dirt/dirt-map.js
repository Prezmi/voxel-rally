// DIRT MAP — the world dirt/spray field of docs/04 §4.2 (B).
// ONE 512x512 RGBA8 grid (PLAN §7 "mapa brudu: 1 render target 512^2, RGBA8,
// splat <= 24/ms"). It is anchored to the world in 256 m steps, so splats stay
// where they were thrown instead of sliding over the car's UV atlas.
//
// The byte grid IS the CPU mirror: no second copy, so the whole map is queryable
// headless (tools/dirtmask.mjs reads it without a GPU) and the GPU texture is just
// a view onto the same buffer.
//
// Channels follow docs/04 §4.2:
//   r = thickness 0..1, g = wetness 0..1, b = colour index (surface id),
//   a = dry dust layer.

export const MAP_TEXELS = 512;
export const MAP_METRES = 512;     // 1 texel = 1 m of ground
export const MAP_TILE = 256;       // anchor snap distance (m)
export const SPLATS_PER_MS = 24;   // hard budget (PLAN §7)

const TEX = MAP_TEXELS * MAP_TEXELS * 4;

export class DirtMap {
  constructor() {
    this.data = new Uint8Array(TEX);          // the CPU mirror, single source
    this.originX = -MAP_TILE;                  // world coord of texel (0,0)
    this.originZ = -MAP_TILE;
    this.minX = MAP_TEXELS; this.minZ = MAP_TEXELS;
    this.maxX = -1; this.maxZ = -1;            // dirty rect, for the decay pass
    this.tokens = 0;                 // splat budget tokens (PLAN §7: <= 24/ms)
    this.splatsThisFrame = 0;
    this.dirtySeq = 0;                         // bumps on every write
    this.decayAcc = 0;
    this.written = 0;                          // texels touched (diagnostics)
  }

  /** Keep the car inside the middle half of the field (snap, never smooth: a
   *  sliding anchor would make the shader UVs swim across the terrain). */
  follow(x, z) {
    const nx = Math.floor((x - 0.5 * MAP_METRES) / MAP_TILE) * MAP_TILE;
    const nz = Math.floor((z - 0.5 * MAP_METRES) / MAP_TILE) * MAP_TILE;
    if (nx !== this.originX || nz !== this.originZ) {
      this.originX = nx; this.originZ = nz;
      this.dirtySeq++;
    }
  }

  texelOf(x, z) {
    const u = Math.round((x - this.originX) * (MAP_TEXELS / MAP_METRES));
    const v = Math.round((z - this.originZ) * (MAP_TEXELS / MAP_METRES));
    if (u < 0 || v < 0 || u >= MAP_TEXELS || v >= MAP_TEXELS) return -1;
    return v * MAP_TEXELS + u;
  }

  /**
   * One splat. Radius in metres, thickness 0..1. Allocation-free: a fixed 3x3
   * kernel plus the centre texel, weighted by distance.
   * Returns false when the per-ms splat budget is exhausted (PLAN §7).
   */
  splat(x, z, thickness, wet, dust, colorId) {
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    this.splatsThisFrame++;
    const t = this.texelOf(x, z);
    if (t < 0) return false;
    this.splatsUsed++;
    const cx = t % MAP_TEXELS, cz = (t / MAP_TEXELS) | 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const u = cx + dx, v = cz + dz;
        if (u < 0 || v < 0 || u >= MAP_TEXELS || v >= MAP_TEXELS) continue;
        const w = (dx === 0 && dz === 0) ? 1 : (Math.abs(dx) + Math.abs(dz) === 1 ? 0.55 : 0.3);
        const k = (v * MAP_TEXELS + u) * 4;
        const d = this.data;
        // Saturating add: the field accumulates material, it never subtracts it.
        d[k] = Math.min(255, d[k] + Math.round(thickness * w * 255));
        d[k + 1] = Math.max(d[k + 1], Math.round(wet * w * 255));
        d[k + 2] = colorId;
        d[k + 3] = Math.min(255, d[k + 3] + Math.round(dust * w * 220));
        this.written++;
      }
    }
    if (cx < this.minX) this.minX = cx;
    if (cz < this.minZ) this.minZ = cz;
    if (cx > this.maxX) this.maxX = cx;
    if (cz > this.maxZ) this.maxZ = cz;
    this.dirtySeq++;
    return true;
  }

  /**
   * Splat budget as a token bucket (PLAN §7 "splat <= 24/ms"). It is fed by sim
   * time, so the cap holds no matter how many substeps a frame runs, and a burst
   * cannot spend next frame's budget: the bucket is capped at one frame's worth.
   */
  addBudget(dtMs) {
    this.tokens = Math.min(SPLATS_PER_MS * 16, this.tokens + SPLATS_PER_MS * dtMs);
  }

  /** Called once per rendered frame: snapshot + reset the per-frame counter. */
  beginFrame() {
    const n = this.splatsThisFrame;
    this.splatsThisFrame = 0;
    return n;
  }

  /** Read the field at a world position (bilinear-free nearest sample). */
  sample(x, z, out) {
    const t = this.texelOf(x, z);
    if (t < 0) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; return false; }
    const k = t * 4;
    const d = this.data;
    out[0] = d[k] / 255; out[1] = d[k + 1] / 255; out[2] = d[k + 2]; out[3] = d[k + 3] / 255;
    return true;
  }

  /** Total material inside a world-space radius (used by tests and the lens). */
  massAround(x, z, radius = 4) {
    const t = this.texelOf(x, z);
    if (t < 0) return 0;
    const cx = t % MAP_TEXELS, cz = (t / MAP_TEXELS) | 0;
    const r = Math.max(1, Math.round(radius));
    let s = 0;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const u = cx + dx, v = cz + dz;
        if (u < 0 || v < 0 || u >= MAP_TEXELS || v >= MAP_TEXELS) continue;
        const k = (v * MAP_TEXELS + u) * 4;
        s += this.data[k] + this.data[k + 3] * 0.5;
      }
    }
    return s / 255;
  }

  /**
   * Field evolution, run on a 0.25 s tick (docs/04 §4.2): spray settles, dries
   * and is blown away downwind. Only the dirty rect is touched, so this stays
   * O(touched texels) instead of O(512^2).
   */
  tick(dt, speed) {
    this.decayAcc += dt;
    if (this.decayAcc < 0.25) return;
    const step = this.decayAcc;
    this.decayAcc = 0;
    if (this.maxX < 0) return;
    const d = this.data;
    const dry = Math.exp(-step * (1.4 + speed * 0.02));
    const settle = Math.exp(-step * (0.30 + speed * 0.010));
    for (let z = this.minZ; z <= this.maxZ; z++) {
      const row = z * MAP_TEXELS;
      for (let x = this.minX; x <= this.maxX; x++) {
        const k = (row + x) * 4;
        if (d[k] === 0 && d[k + 3] === 0) continue;
        d[k] = Math.round(d[k] * settle);
        d[k + 1] = Math.round(d[k + 1] * dry);
        d[k + 3] = Math.round(d[k + 3] * dry * 0.98);
        if (d[k] < 2 && d[k + 3] < 2) { d[k] = 0; d[k + 1] = 0; d[k + 3] = 0; }
      }
    }
    this.dirtySeq++;
  }

  clear() {
    this.data.fill(0);
    this.minX = MAP_TEXELS; this.minZ = MAP_TEXELS; this.maxX = -1; this.maxZ = -1;
    this.dirtySeq++;
  }

  /** Bounding box of everything dirtied so far, in metres (for the tests). */
  extent() {
    if (this.maxX < 0) return 0;
    const s = MAP_METRES / MAP_TEXELS;
    return (this.maxX - this.minX + 1) * (this.maxZ - this.minZ + 1) * s * s;
  }

  texelsDirty() {
    if (this.maxX < 0) return 0;
    return (this.maxX - this.minX + 1) * (this.maxZ - this.minZ + 1);
  }
}
