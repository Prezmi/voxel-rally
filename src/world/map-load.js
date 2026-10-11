// SHIPPED MAP FORMAT + runtime loader (JOB: preset maps, not procedural stages).
//
// A stage used to be *generated* at boot (src/world/pregen.js) and only then cached to
// assets/world (src/world/stage-cache.js). This file makes the shipped game read an
// authored map instead: assets/maps/<id>.rmap holds everything the world needs, baked
// offline by tools/bake-map.mjs, so at play time nothing is generated at all - the
// loader only fills the existing chunk / prop / tile structures that physics and
// collision already read.
//
// Layout (little-endian):
//   'RMAP' | u16 version | u32 headerLen | header JSON (utf8)
//   sections, each: u8 tag | u32 payloadLen | payload
//     1 ROAD     the derived road table: n, length, then the 12 Float32 columns and the
//                2 Uint8 columns (surfaceId, feature) the spline builds
//     2 CHUNKS   terrain: the stage-cache RLE block (height, fine, rut, surface id per
//                cell, wear, run-length voxel stack) - the format physics already reads
//     3 PROPS    per chunk: species, x, y, z, yaw, scale, variant
//     4 TILES    per chunk + LOD ring: sparse (column, surfaceId|flags) pairs
//     5 CONTROL  the road spline control points (authored shape, for re-baking/editing)
//   u32 FNV-1a checksum of every preceding byte
//
// The header carries name / length / version / counts / biome band list / gates.
// A file that fails magic, version or checksum returns null: the caller then falls back
// to the procedural generator and says so loudly (src/main.js).
import { CHUNK, COLS, chunkKey, keyToCx, keyToCz } from './chunk.js';
import { decodeStageCache, encodeStageCache } from './stage-cache.js';
import { buildIndex } from './road-spline.js';

export const MAP_MAGIC = [0x52, 0x4d, 0x41, 0x50];      // 'RMAP'
export const MAP_VERSION = 1;
export const MAP_SIZE_BUDGET = 8 * 1024 * 1024;         // per shipped map
export const SEC = { ROAD: 1, CHUNKS: 2, PROPS: 3, TILES: 4, CONTROL: 5 };

/** The four shipped stages. `bands` is the biome sequence along the route: one stage
 *  changes character over its length, and the bake writes the matching surface ids and
 *  prop species per chunk. */
export const MAP_CATALOG = [
  {
    id: 'forest-loop', name: 'FOREST LOOP', seed: 41207713, lengthTarget: 2600,
    difficulty: 'EASY', surface: 'gravel', biome: 'FOREST', radius: 240,
    bands: [{ from: 0, to: 900, biome: 'FOREST' }, { from: 900, to: 1800, biome: 'SWAMP' },
      { from: 1800, to: 2600, biome: 'FOREST' }],
  },
  {
    id: 'hedgerow-farmlands', name: 'HEDGEROW FARMLANDS', seed: 88420519, lengthTarget: 3400,
    difficulty: 'MEDIUM', surface: 'dirt', biome: 'PLATEAU', radius: 260,
    // Almost no open canopy: hedgerow bands (PLATEAU = grass/sand, sparse oak) alternate
    // with a gravel segment, so the fields read as fields with walls of bush.
    bands: [{ from: 0, to: 1100, biome: 'PLATEAU' }, { from: 1100, to: 2200, biome: 'CANYON' },
      { from: 2200, to: 3400, biome: 'PLATEAU' }],
  },
  {
    id: 'rock-canyon', name: 'ROCK CANYON', seed: 129073341, lengthTarget: 4200,
    difficulty: 'HARD', surface: 'stone', biome: 'CANYON', radius: 280,
    bands: [{ from: 0, to: 1400, biome: 'CANYON' }, { from: 1400, to: 2500, biome: 'MOUNTAIN' },
      { from: 2500, to: 3300, biome: 'CANYON' }, { from: 3300, to: 4200, biome: 'PLATEAU' }],
  },
  {
    id: 'lakeside-flats', name: 'LAKESIDE FLATS', seed: 67120333, lengthTarget: 3000,
    difficulty: 'MEDIUM', surface: 'gravel/mud', biome: 'SWAMP', radius: 250,
    // Water + reeds: the SWAMP band puts mud/peat under the low ground and fern/bush in
    // the corridor, FOREST closes the stage under a canopy.
    bands: [{ from: 0, to: 1200, biome: 'SWAMP' }, { from: 1200, to: 2100, biome: 'PLATEAU' },
      { from: 2100, to: 3000, biome: 'FOREST' }],
  },
];

export function mapUrl(id) { return `assets/maps/${id}.rmap`; }
export function mapById(id) { return MAP_CATALOG.find((m) => m.id === id) || null; }

const enc = new TextEncoder();
const dec = new TextDecoder();

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// ---- road table -------------------------------------------------------------
const ROAD_F32 = ['x', 'z', 's', 'tx', 'tz', 'nx', 'nz', 'heading', 'kappa', 'grade', 'h', 'camber', 'width'];
const ROAD_U8 = ['surfaceId', 'feature'];

function encodeRoad(road) {
  const n = road.n;
  const buf = new Uint8Array(8 + n * (ROAD_F32.length * 4 + ROAD_U8.length));
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, n, true);
  dv.setFloat64(4, road.length, true);
  let o = 12;
  for (const k of ROAD_F32) {
    const a = road[k];
    for (let i = 0; i < n; i++) dv.setFloat32(o + i * 4, a[i], true);
    o += n * 4;
  }
  for (const k of ROAD_U8) {
    const a = road[k];
    for (let i = 0; i < n; i++) buf[o + i] = a[i];
    o += n;
  }
  return buf;
}

function decodeRoad(bytes) {
  const u = new Uint8Array(bytes);
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const n = dv.getUint32(0, true);
  const length = dv.getFloat64(4, true);
  if (!(n > 8) || u.length < 12 + n * (ROAD_F32.length * 4 + ROAD_U8.length)) return null;
  const road = { n, length };
  let o = 12;
  for (const k of ROAD_F32) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = dv.getFloat32(o + i * 4, true);
    road[k] = a; o += n * 4;
  }
  for (const k of ROAD_U8) {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = u[o + i];
    road[k] = a; o += n;
  }
  road.control = null;                  // filled from the CONTROL section when present
  buildIndex(road);
  return road;
}

// ---- props / tiles ----------------------------------------------------------
/** entries = [{cx, cz, list}] (chunk keys are >32 bit, so they are never re-split). */
function encodeProps(entries) {
  const parts = [];
  for (const { cx, cz, list } of entries) {
    const head = new Uint8Array(6);
    const hdv = new DataView(head.buffer);
    hdv.setInt16(0, cx, true); hdv.setInt16(2, cz, true); hdv.setUint16(4, list.length, true);
    parts.push(head);
    const rec = new Uint8Array(list.length * 22);
    const dv = new DataView(rec.buffer);
    for (let i = 0; i < list.length; i++) {
      const p = list[i], o = i * 22;
      rec[o] = p.prop;
      dv.setFloat32(o + 1, p.x, true); dv.setFloat32(o + 5, p.y, true);
      dv.setFloat32(o + 9, p.z, true); dv.setFloat32(o + 13, p.yaw, true);
      dv.setFloat32(o + 17, p.scale, true);
      rec[o + 21] = p.variant | 0;
    }
    parts.push(rec);
  }
  let total = 0; for (const p of parts) total += p.length;
  const out = new Uint8Array(total); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function decodeProps(bytes, propTables) {
  const u = new Uint8Array(bytes);
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let at = 0, lists = 0, props = 0;
  while (at + 6 <= u.length) {
    const cx = dv.getInt16(at, true), cz = dv.getInt16(at + 2, true);
    const n = dv.getUint16(at + 4, true);
    at += 6;
    if (at + n * 22 > u.length) return false;
    const list = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = at + i * 22;
      list[i] = {
        prop: u[o], x: dv.getFloat32(o + 1, true), y: dv.getFloat32(o + 5, true),
        z: dv.getFloat32(o + 9, true), yaw: dv.getFloat32(o + 13, true),
        scale: dv.getFloat32(o + 17, true), variant: u[o + 21],
      };
    }
    at += n * 22;
    propTables.set(chunkKey(cx, cz), list);
    lists++; props += n;
  }
  return at === u.length ? { lists, props } : null;
}

/** entries = [{cx, cz, ring, table}] */
function encodeTiles(entries) {
  const parts = [];
  for (const { cx, cz, ring, table: t } of entries) {
    if (!t) continue;
    const pairs = [];
    for (let c = 0, seen = 0; c < COLS && seen < t.tiles; c++) {
      if (!t[c]) continue;
      pairs.push(c, t[c]); seen++;
    }
    const head = new Uint8Array(9 + pairs.length);
    const hdv = new DataView(head.buffer);
    hdv.setInt16(0, cx, true); hdv.setInt16(2, cz, true);
    hdv.setUint8(4, ring); hdv.setUint16(5, t.tiles, true);
    hdv.setUint16(7, pairs.length / 2, true);
    for (let i = 0; i < pairs.length; i++) head[9 + i] = pairs[i];
    parts.push(head);
  }
  let total = 0; for (const p of parts) total += p.length;
  const out = new Uint8Array(total); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function decodeTiles(bytes, tileTables) {
  const u = new Uint8Array(bytes);
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let at = 0, lists = 0, tiles = 0;
  while (at + 9 <= u.length) {
    const cx = dv.getInt16(at, true), cz = dv.getInt16(at + 2, true);
    const ring = u[at + 4], count = dv.getUint16(at + 5, true), np = dv.getUint16(at + 7, true);
    at += 9;
    if (at + np * 2 > u.length) return false;
    const t = new Uint8Array(COLS);
    for (let i = 0; i < np; i++) t[u[at + i * 2]] = u[at + i * 2 + 1];
    t.tiles = count;
    at += np * 2;
    tileTables.set(chunkKey(cx, cz) * 4 + ring, t);
    lists++; tiles += count;
  }
  return at === u.length ? { lists, tiles } : null;
}

// ---- whole file -------------------------------------------------------------
function section(tag, bytes) {
  const head = new Uint8Array(5);
  const dv = new DataView(head.buffer);
  head[0] = tag; dv.setUint32(1, bytes.length, true);
  return [head, bytes];
}

/** Build the file. `def` = {meta, road, world, propTables, tileTables}. */
export function encodeMap({ meta, road, world, propMap, tileMap, propEntries, tileEntries }) {
  const propTables = propEntries || [...(propMap || new Map())].map(([k, list]) => ({ cx: keyToCx(k), cz: keyToCz(k), list }));
  const tileTables = tileEntries || [...(tileMap || new Map())].map(([k, table]) => ({ cx: keyToCx(Math.floor(k / 4)), cz: keyToCz(Math.floor(k / 4)), ring: k % 4, table }));
  const parts = [];
  const head = new Uint8Array(10);
  head.set(MAP_MAGIC, 0);
  new DataView(head.buffer).setUint16(4, MAP_VERSION, true);
  const hj = enc.encode(JSON.stringify(meta));
  new DataView(head.buffer).setUint32(6, hj.length, true);
  parts.push(head, hj);
  parts.push(...section(SEC.ROAD, encodeRoad(road)));
  parts.push(...section(SEC.CHUNKS, encodeStageCache(world, meta.seed, meta.biome)));
  parts.push(...section(SEC.PROPS, encodeProps(propTables)));
  parts.push(...section(SEC.TILES, encodeTiles(tileTables)));
  parts.push(...section(SEC.CONTROL, enc.encode(JSON.stringify(
    (road.control || []).map((p) => ({ x: p.x, z: p.z }))))));
  let total = 0; for (const p of parts) total += p.length;
  const out = new Uint8Array(total + 4);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  new DataView(out.buffer).setUint32(at, fnv1a(out.subarray(0, at)), true);
  return out;
}

/** Parse + checksum. null on any inconsistency, so the caller can fall back. */
export function decodeMap(bytes) {
  const u = new Uint8Array(bytes);
  if (u.length < 18) return null;
  for (let i = 0; i < 4; i++) if (u[i] !== MAP_MAGIC[i]) return null;
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const body = u.subarray(0, u.length - 4);
  if (dv.getUint32(u.length - 4, true) !== fnv1a(body)) return null;
  const version = dv.getUint16(4, true);
  if (version !== MAP_VERSION) return null;
  const hl = dv.getUint32(6, true);
  let at = 10;
  if (at + hl > u.length) return null;
  let meta;
  try { meta = JSON.parse(dec.decode(u.subarray(at, at + hl))); } catch { return null; }
  at += hl;
  const sections = new Map();
  while (at + 5 <= u.length - 4) {
    const tag = u[at];
    const len = dv.getUint32(at + 1, true);
    at += 5;
    if (at + len > u.length - 4) return null;
    sections.set(tag, u.subarray(at, at + len));
    at += len;
  }
  if (at !== u.length - 4) return null;
  if (!sections.has(SEC.ROAD) || !sections.has(SEC.CHUNKS)) return null;
  return { meta, sections, bytes: u.length };
}

/**
 * Fill the world + the stage's prop / tile structures from a map blob. Everything here
 * is a *load*: the chunk objects, the prop list and the tile tables are exactly the
 * structures Streaming and the Vehicle already read, so physics and collision are
 * untouched and no generator runs.
 * Returns null (world untouched semantics as decodeMap) when the file is unusable.
 */
export function applyMap(world, bytes, { onProgress = null } = {}) {
  const m = decodeMap(bytes);
  if (!m) return null;
  const road = decodeRoad(m.sections.get(SEC.ROAD));
  if (!road) return null;
  const cs = decodeStageCache(world, m.sections.get(SEC.CHUNKS), m.meta.seed, m.meta.biome);
  if (!cs) return null;
  const propTables = new Map();
  const pd = decodeProps(m.sections.get(SEC.PROPS) || new Uint8Array(0), propTables);
  if (!pd) return null;
  const tileTables = new Map();
  const td = decodeTiles(m.sections.get(SEC.TILES) || new Uint8Array(0), tileTables);
  if (!td) return null;
  const ctl = m.sections.get(SEC.CONTROL);
  if (ctl) { try { road.control = JSON.parse(dec.decode(ctl)); } catch { road.control = []; } }
  road.seed = m.meta.seed; road.biome = m.meta.biome;
  if (m.meta.climate) road.climate = m.meta.climate;
  const gates = (m.meta.gates || []).map((g) => ({ arc: g.arc, kind: g.kind, index: road.indexAt(g.arc) }));
  let n = 0;
  for (const g of gates) g.number = n++;
  if (onProgress) onProgress(1, cs.chunks, cs.chunks);
  return {
    meta: m.meta, road, gates, propTables, tileTables, bytes: m.bytes,
    stats: { chunks: cs.chunks, props: pd.props, propLists: pd.lists, tiles: td.tiles, tileLists: td.lists },
  };
}

/** Fetch one shipped map. null = not shipped / not reachable (caller falls back). */
export async function fetchMap(id, fetchFn = null) {
  const f = fetchFn || (typeof fetch === 'function' ? fetch : null);
  if (!f) return null;
  const url = mapUrl(id);
  let res;
  try { res = await f(url, { cache: 'no-store' }); } catch { return null; }
  if (!res || !res.ok) return null;
  try { return { url, bytes: new Uint8Array(await res.arrayBuffer()) }; } catch { return null; }
}

export const MAP_CHUNK_SIZE = CHUNK;
export { encodeStageCache };
