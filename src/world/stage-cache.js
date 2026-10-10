// Offline stage world cache (tools/gen-stage-cache.mjs writes it, the boot loader
// reads it): one compact binary per seed + biome holding the *carved* chunk data —
// heightfield columns, sub-block bed, surface ids, wear and the run-length encoded
// voxel blocks. Nothing render-side is cached: geometry is still built by Streaming.
//
// The loader is deliberately forgiving: a missing file, a truncated file, or a file
// whose seed/biome header does not match the stage being booted returns null and the
// caller generates the stage deterministically instead (src/world/pregen.js). That
// is why the header carries the seed and biome and the decode verifies both.
import { CHUNK, COLS, WORLD_HEIGHT } from './chunk.js';

const MAGIC = [0x56, 0x52, 0x57, 0x31];   // 'VRW1'
const COL_BYTES = 1 + 2 + 2 + 1 + 1;      // height i8, fine i16, rut i16, surface u8, wear u8

export function cacheUrl(seed, biome) {
  return `assets/world/stage-${seed >>> 0}-${String(biome).toUpperCase()}.bin`;
}

/** Serialise every chunk currently resident in `world` (the tool's offline step). */
export function encodeStageCache(world, seed, biome) {
  const parts = [];
  const head = new Uint8Array(9);        // magic 4 + seed 4 + biome length 1
  head.set(MAGIC, 0);
  new DataView(head.buffer).setUint32(4, seed >>> 0, true);
  head[8] = 0;                                  // biome length patched below
  parts.push(head);
  const bi = new TextEncoder().encode(String(biome).toUpperCase());
  head[8] = bi.length;
  parts.push(bi);
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, world.chunks.size, true);
  parts.push(count);

  const blocks = new Uint8Array(COLS * WORLD_HEIGHT);
  // Worst case is one run per voxel (3 bytes each); the scratch is sized for that so
  // the encoder can never overflow on a hand-edited world.
  const runs = new Uint8Array(COLS * WORLD_HEIGHT * 3 + 64);
  for (const c of world.chunks.values()) {
    const rec = new DataView(new ArrayBuffer(4 + COLS * COL_BYTES));
    rec.setInt16(0, c.cx, true);
    rec.setInt16(2, c.cz, true);
    let o = 4;
    for (let i = 0; i < COLS; i++) rec.setInt8(o + i, c.height[i]);
    o += COLS;
    for (let i = 0; i < COLS; i++) rec.setInt16(o + i * 2, c.fine[i], true);
    o += COLS * 2;
    for (let i = 0; i < COLS; i++) rec.setInt16(o + i * 2, c.rut[i], true);
    o += COLS * 2;
    for (let i = 0; i < COLS; i++) rec.setUint8(o + i, c.surface[i]);
    o += COLS;
    for (let i = 0; i < COLS; i++) rec.setUint8(o + i, c.wear[i]);
    // Run-length encode the voxel column stack: natural terrain is a handful of runs
    // per column (stone core, dirt, the surface block, air above), which keeps a whole
    // stage in a few megabytes instead of ~175 MB of raw Uint8Arrays.
    blocks.set(c.blocks);
    let n = 0;
    for (let i = 0; i < blocks.length;) {
      const v = blocks[i];
      let j = i + 1;
      while (j < blocks.length && blocks[j] === v) j++;
      let cnt = j - i;
      while (cnt > 0) {
        const step = Math.min(cnt, 65535);
        runs[n++] = v;
        runs[n++] = step & 255;
        runs[n++] = (step >> 8) & 255;
        cnt -= step;
      }
      i = j;
    }
    // Copy, do not view: a view of the shared `runs` scratch would let every later
    // chunk overwrite the earlier ones before the concat below happens (that is what
    // made a whole stage decode as the last chunk's terrain).
    const rl = runs.slice(0, n);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, rl.length, true);
    parts.push(new Uint8Array(rec.buffer), len, rl);
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Fill `world` from a cache blob. Returns null (and touches nothing) when the header
 * does not match the requested seed + biome or the blob is inconsistent, so the
 * caller can fall back to generating the stage.
 */
export function decodeStageCache(world, bytes, seed, biome) {
  const u = new Uint8Array(bytes);
  if (u.length < 13) return null;
  for (let i = 0; i < 4; i++) if (u[i] !== MAGIC[i]) return null;
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const cSeed = dv.getUint32(4, true);
  const bl = u[8];
  if (cSeed !== (seed >>> 0)) return null;
  const name = new TextDecoder().decode(u.subarray(9, 9 + bl));
  if (name !== String(biome).toUpperCase()) return null;
  let at = 9 + bl;
  const n = dv.getUint32(at, true); at += 4;
  const blocks = new Uint8Array(COLS * WORLD_HEIGHT);
  let made = 0;
  for (let k = 0; k < n; k++) {
    if (at + 4 + COLS * COL_BYTES + 4 > u.length) return null;
    const cx = dv.getInt16(at, true), cz = dv.getInt16(at + 2, true);
    let o = at + 4;
    const chunk = world.ensureChunk(cx, cz);
    for (let i = 0; i < COLS; i++) chunk.height[i] = dv.getInt8(o + i);
    o += COLS;
    for (let i = 0; i < COLS; i++) chunk.fine[i] = dv.getInt16(o + i * 2, true);
    o += COLS * 2;
    for (let i = 0; i < COLS; i++) chunk.rut[i] = dv.getInt16(o + i * 2, true);
    o += COLS * 2;
    for (let i = 0; i < COLS; i++) chunk.surface[i] = dv.getUint8(o + i);
    o += COLS;
    for (let i = 0; i < COLS; i++) chunk.wear[i] = dv.getUint8(o + i);
    o += COLS;
    const rl = dv.getUint32(o, true);            // o is still the length field itself
    const rleStart = o + 4, rleEnd = rleStart + rl;
    if (rleEnd > u.length) return null;
    blocks.fill(0);
    let c = 0;
    for (let p = rleStart; p < rleEnd; p += 3) {
      const v = u[p], cnt = u[p + 1] | (u[p + 2] << 8);
      for (let q = 0; q < cnt && c < blocks.length; q++) blocks[c++] = v;
    }
    chunk.blocks.set(blocks);
    chunk.generated = true;
    chunk.carved = true;                  // the cache holds the *carved* corridor
    chunk.dirty = true;
    chunk.lod = -1;
    at = rleEnd;
    made++;
  }
  if (at !== u.length) return null;      // trailing garbage: not ours
  return { chunks: made, seed: cSeed, biome: name };
}

/** Fetch the cache for this seed + biome and load it. null = generate instead. */
export async function loadStageCache(world, seed, biome) {
  const url = cacheUrl(seed, biome);
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch { return null; }
  if (!res || !res.ok) return null;
  try {
    const buf = await res.arrayBuffer();
    const ok = decodeStageCache(world, buf, seed, biome);
    if (!ok) return null;
    return { ...ok, bytes: buf.byteLength, url };
  } catch { return null; }
}

/** Chunk count of CHUNK*CHUNK columns of the cache format (diagnostics only). */
export const CACHE_COL_BYTES = COL_BYTES;
export const CACHE_CHUNK_SIZE = CHUNK;
