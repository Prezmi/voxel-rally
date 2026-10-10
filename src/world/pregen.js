// Whole-stage pre-generation.
//
// The streaming layer used to generate terrain, carve the road, scatter props and
// build the block-tile tables *while driving*: a 70 s perf run counted 945 chunk
// generations and 33 remeshes in the middle of the drive. Here the same
// deterministic work runs once, ahead of time, in bounded slices so the loading
// screen paints real progress. After this, Streaming only ever builds and destroys
// *render geometry* — heightfield, surface ids, carve silhouette, prop list and tile
// list are already resident for every chunk the draw distance can ask for, so
// `stream.stats.generated` stays 0 for the whole stage.
//
// Nothing about the chunk data structure, the carve or the scatter changes: this file
// only changes *when* the work happens. The offline equivalent is
// tools/gen-stage-cache.mjs, which writes the same result to assets/world/ for a
// fixed seed (src/world/stage-cache.js loads it back; when it is missing or the seed
// does not match, this generator is the fallback).
import { CHUNK, chunkKey, keyToCx, keyToCz } from './chunk.js';
import { carveChunk } from './road-carve.js';
import { generateChunkProps } from './props.js';

const SLICE_MS = 14;        // work per loading-screen slice, then yield + report
export const PROP_REACH = 150;   // m from the centreline a prop can possibly stand in

/**
 * Every chunk the streaming layer can ask for over the whole stage: the `radius`
 * metre disc swept along the road. `dist` is the chunk centre's distance to the
 * centreline, which decides whether the chunk needs the corridor work (carve, props,
 * tiles) or only the natural heightfield. Deterministic in (road, radius).
 */
export function stageChunkList(road, radius = 260) {
  const span = Math.ceil(radius / CHUNK);
  const step = Math.max(1, Math.round(8 / Math.max(0.2, road.s[1] - road.s[0])));
  const best = new Map();                       // chunk key -> closest centreline distance
  for (let i = 0; i < road.n; i += step) {
    const cx = Math.floor(road.x[i] / CHUNK), cz = Math.floor(road.z[i] / CHUNK);
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const X = (cx + dx) * CHUNK + CHUNK / 2, Z = (cz + dz) * CHUNK + CHUNK / 2;
        const d = Math.hypot(X - road.x[i], Z - road.z[i]);
        if (d > radius + CHUNK) continue;
        const k = chunkKey(cx + dx, cz + dz);
        const prev = best.get(k);
        if (prev === undefined || d < prev) best.set(k, d);
      }
    }
  }
  const out = [];
  for (const [k, d] of best) out.push({ cx: keyToCx(k), cz: keyToCz(k), dist: d });
  return out;
}

/**
 * Generate the whole stage in `sliceMs` slices, yielding (and calling `onProgress`)
 * between them so the loading screen is a real, reporting load instead of one long
 * stall. Fills `stage.propTables` / `stage.tileTables`, which Streaming reads instead
 * of generating anything itself.
 */
export async function pregenerateStage(stream, radius = 260, {
  onProgress = null, yieldFn = null, sliceMs = SLICE_MS,
} = {}) {
  const stage = stream.stage, world = stream.world, terrain = stream.terrain;
  if (stage.pregen) return stage.pregen;
  const list = stageChunkList(stream.road, radius);
  const propTables = stage.propTables || (stage.propTables = new Map());
  const tileTables = stage.tileTables || (stage.tileTables = new Map());
  const t0 = performance.now();
  let i = 0, filled = 0, carved = 0, props = 0, tiles = 0;
  while (i < list.length) {
    const stop = performance.now() + sliceMs;
    for (; i < list.length && performance.now() < stop; i++) {
      const { cx, cz, dist } = list[i];
      const key = chunkKey(cx, cz);
      if (!world.chunkAt(cx, cz)) { terrain.generateChunk(world, cx, cz); filled++; }
      const c = world.chunkAt(cx, cz);
      if (!c.carved) {
        carveChunk(world, cx, cz, stream.road, stream.carveIndex, terrain);
        c.carved = true;
        carved++;
      }
      // Props stand on the carved verge, so they are placed only after the carve of
      // their own chunk, exactly as the streaming path did. Past PROP_REACH from the
      // centreline the scatter cannot produce anything at all.
      if (dist <= PROP_REACH && !propTables.has(key)) {
        propTables.set(key, generateChunkProps(cx, cz, stage));
        props++;
      }
      // Block tiles only ever exist on the corridor the carve touched.
      if (stream.carveIndex.has(key)) {
        for (const ring of [0, 1]) if (!tileTables.has(key * 4 + ring)) stream.tileTable(cx, cz, ring);
        tiles++;
      }
    }
    if (onProgress) onProgress(i / list.length, i, list.length);
    if (yieldFn && i < list.length) await yieldFn();
  }
  stage.preGen = true;
  stage.pregen = {
    chunks: list.length, filled, carved, props, tiles,
    ms: performance.now() - t0, radius,
  };
  return stage.pregen;
}
