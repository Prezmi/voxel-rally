// Offline stage cache generator (JOB: pre-generated maps).
//
//   node tools/gen-stage-cache.mjs [seed] [BIOME] [len] [radius]
//
// Builds the stage deterministically in node and writes the carved chunk data to
// assets/world/stage-<seed>-<biome>.bin, which the boot loader (src/main.js ->
// src/world/stage-cache.js) reads back instead of generating. Same code path as the
// in-boot generator (src/world/pregen.js), so a cached stage and a generated one are
// byte-identical; the loader refuses a file whose seed/biome header does not match.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VoxelWorld, chunkKey } from '../src/world/chunk.js';
import { makeTerrain, BIOME_INFO } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex, carveChunk } from '../src/world/road-carve.js';
import { stageChunkList } from '../src/world/pregen.js';
import { encodeStageCache, cacheUrl, decodeStageCache } from '../src/world/stage-cache.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seed = Number(process.argv[2] ?? 38571816) >>> 0;
const biome = String(process.argv[3] ?? 'FOREST').toUpperCase();
const len = Number(process.argv[4] ?? 3400);
const radius = Number(process.argv[5] ?? 260);
if (!BIOME_INFO[biome]) { console.error(`unknown biome ${biome}`); process.exit(2); }

const t0 = Date.now();
const world = new VoxelWorld(seed);
const terrain = makeTerrain(seed, biome);
const road = buildRoad({ seed, lengthTarget: len, terrainHeightAt: terrain.heightAt, biome });
const carveIndex = buildCarveIndex(road);
const list = stageChunkList(road, radius);
console.log(`[cache] seed ${seed} ${biome} road ${road.length.toFixed(0)} m, ${list.length} chunks within ${radius} m`);

let i = 0;
for (const { cx, cz } of list) {
  terrain.generateChunk(world, cx, cz);
  const c = world.chunkAt(cx, cz);
  carveChunk(world, cx, cz, road, carveIndex, terrain);
  c.carved = true;
  i++;
  if (i % 1000 === 0) console.log(`[cache]  ${i}/${list.length} chunks  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
const bytes = encodeStageCache(world, seed, biome);
const out = path.join(root, cacheUrl(seed, biome));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, bytes);
console.log(`[cache] wrote ${out} ${(bytes.length / 1e6).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// Round-trip check: a cache the game cannot reproduce column for column is worse than
// no cache at all, so decode it back and compare every column of every chunk.
const back = new VoxelWorld(seed);
const ok = decodeStageCache(back, fs.readFileSync(out), seed, biome);
if (!ok) { console.error('[cache] VERIFY FAILED: decode rejected'); process.exit(3); }
let bad = 0, cols = 0;
for (const c of world.chunks.values()) {
  const d = back.chunkAt(c.cx, c.cz);
  if (!d) { bad++; continue; }
  for (let i = 0; i < c.blocks.length; i++) if (c.blocks[i] !== d.blocks[i]) { bad++; break; }
  for (let i = 0; i < c.height.length; i++) {
    cols++;
    if (c.height[i] !== d.height[i] || c.fine[i] !== d.fine[i] || c.rut[i] !== d.rut[i]
      || c.surface[i] !== d.surface[i] || c.wear[i] !== d.wear[i]) { bad++; break; }
  }
  void chunkKey(c.cx, c.cz);
}
console.log(`[cache] verify ${bad ? `FAILED (${bad} chunks differ)` : 'OK'}: ${ok.chunks} chunks, ${cols} columns identical`);
process.exit(bad ? 3 : 0);
