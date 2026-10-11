// Offline map baker (JOB: preset maps). This is what produces the shipped stages:
//
//   node tools/bake-map.mjs                 all four maps in MAP_CATALOG
//   node tools/bake-map.mjs <mapId>         one map
//
// It runs the existing generators EXACTLY ONCE per map in node - terrain heightfield +
// surface ids (src/world/terrain-gen.js), the road spline (src/world/road-spline.js),
// the corridor carve (src/world/road-carve.js), the prop scatter (src/world/props.js)
// and the block tile selection (src/world/block-tiles.js) - and writes the result as a
// shipped map file (src/world/map-load.js) under assets/maps/. At play time the game
// only loads that file; no generator ever runs (src/debug/perf-harness.js reports
// `gen=0` for the whole drive).
//
// Biome bands: a map's `bands` list assigns a biome per stretch of the route. The
// height field is biome-independent (terrain-gen.js), so bands change the surface ids
// and the prop species of each chunk without any height seam.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VoxelWorld, chunkKey, keyToCx, keyToCz } from '../src/world/chunk.js';
import { makeTerrain, BIOME_INFO } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex, carveChunk } from '../src/world/road-carve.js';
import { stageChunkList, PROP_REACH } from '../src/world/pregen.js';
import { generateChunkProps } from '../src/world/props.js';
import { chunkTiles, TILE_SURFACE_IDS } from '../src/world/block-tiles.js';
import { planGates } from '../src/game/stage.js';
import { encodeMap, applyMap, mapById, mapUrl, decodeMap, MAP_CATALOG, MAP_VERSION } from '../src/world/map-load.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bake(def) {
  const t0 = Date.now();
  const seed = def.seed >>> 0;
  const world = new VoxelWorld(seed);
  const base = makeTerrain(seed, def.biome);
  const road = buildRoad({ seed, lengthTarget: def.lengthTarget, terrainHeightAt: base.heightAt, biome: def.biome });
  const carveIndex = buildCarveIndex(road);
  const gates = planGates(road, seed);

  // One terrain per biome in the band list: blockAt()/species follow the band, heightAt
  // is identical, so the corridor and the ground stay continuous across a band change.
  const terrains = new Map();
  const terrainFor = (b) => {
    let t = terrains.get(b);
    if (!t) { t = makeTerrain(seed, b); terrains.set(b, t); }
    return t;
  };
  const biomeAt = (arc) => {
    for (const b of def.bands) if (arc >= b.from && arc <= b.to) return b.biome;
    return def.biome;
  };

  const list = stageChunkList(road, def.radius);
  const propMap = new Map(), tileMap = new Map();
  const bandCount = new Map();
  let props = 0, tiles = 0;
  for (const { cx, cz, dist } of list) {
    const arc = road.s[road.nearest(cx * 16 + 8, cz * 16 + 8)];
    const biome = biomeAt(arc);
    const terrain = terrainFor(biome);
    terrain.generateChunk(world, cx, cz);
    const c = world.chunkAt(cx, cz);
    carveChunk(world, cx, cz, road, carveIndex, terrain);
    c.carved = true;
    bandCount.set(biome, (bandCount.get(biome) || 0) + 1);
    const key = chunkKey(cx, cz);
    if (dist <= PROP_REACH) {
      // Same scatter as the runtime path, with the band's biome so the species follow
      // the band (props.js reads stage.biome).
      const stage = { road, terrain, seed, world, carveIndex, biome, density: def.density ?? 1 };
      const p = generateChunkProps(cx, cz, stage);
      if (p.length) { propMap.set(key, p); props += p.length; }
    }
    if (carveIndex.has(key)) {
      for (const ring of [0, 1]) {
        const t = ring === 0 ? chunkTiles(world, road, TILE_SURFACE_IDS, cx, cz, 1, 192)
          : chunkTiles(world, road, TILE_SURFACE_IDS, cx, cz, 2, 96);
        if (t) { tileMap.set(key * 4 + ring, t); tiles += t.tiles; }
      }
    }
  }

  // Dominant surface of the shipped road, for the menu line.
  const tally = new Map();
  for (let i = 0; i < road.n; i++) tally.set(road.surfaceId[i], (tally.get(road.surfaceId[i]) || 0) + 1);
  const top = [...tally].sort((a, b) => b[1] - a[1])[0][0];

  const meta = {
    id: def.id, name: def.name, version: MAP_VERSION, seed, biome: def.biome,
    length: road.length, difficulty: def.difficulty, surface: def.surface,
    roadSurfaceTop: top, radius: def.radius, bands: def.bands,
    climate: road.climate,
    gates: gates.map((g) => ({ arc: g.arc, kind: g.kind })),
    counts: { chunks: list.length, propLists: propMap.size, props, tileLists: tileMap.size, tiles },
    bandChunks: Object.fromEntries(bandCount),
    baked: new Date().toISOString(),
  };
  const bytes = encodeMap({ meta, road, world, propMap, tileMap });
  const out = path.join(root, mapUrl(def.id));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);

  // Round trip: a shipped file the loader cannot read is worse than no file at all.
  const back = new VoxelWorld(seed);
  const a = decodeMap(bytes);
  const applied = a && applyCheck(back, bytes);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[bake] ${def.id.padEnd(19)} ${(road.length / 1000).toFixed(2)} km  `
    + `${list.length} chunks  ${props} props  ${tiles} tiles  `
    + `${(bytes.length / 1e6).toFixed(2)} MB  ${secs} s  bands=[${def.bands.map((b) => b.biome).join('>')}]`
    + `  verify=${applied ? 'OK' : 'FAILED'}`);
  return applied ? 0 : 1;
}

/** Decode back with the runtime loader: a file the game cannot apply is no good. */
function applyCheck(back, bytes) {
  const r = applyMap(back, bytes);
  if (!r) return false;
  if (!r.road || typeof r.road.nearest !== 'function' || !r.gates.length) return false;
  if (!r.propTables.size || !r.tileTables.size) return false;
  return r.stats.chunks > 0;
}

const want = process.argv[2];
const defs = want ? [mapById(want)] : MAP_CATALOG;
if (!defs[0]) { console.error(`unknown map id ${want} (have: ${MAP_CATALOG.map((d) => d.id).join(', ')})`); process.exit(2); }
let bad = 0;
for (const d of defs) bad += bake(d);
console.log(`[bake] ${MAP_CATALOG.length ? '' : ''}wrote ${defs.length} map file(s) to assets/maps/`);
process.exit(bad ? 3 : 0);
