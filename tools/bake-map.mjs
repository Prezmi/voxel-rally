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
import { generateChunkProps, TREE_MIN_SPACING, TREE_CORRIDOR_HARD, TREE_FREE } from '../src/world/props.js';
import { PROP, propFootprint, treeSpacingFor } from '../src/world/props.js';
import { SHOULDER } from '../src/world/road-carve.js';
const TREE_PROPS = new Set([PROP.OAK, PROP.PINE, PROP.BIRCH, PROP.DEAD]);
import { chunkTiles, TILE_SURFACE_IDS } from '../src/world/block-tiles.js';
import { planGates } from '../src/game/stage.js';
import { encodeMap, applyMap, mapById, mapUrl, decodeMap, MAP_CATALOG, MAP_VERSION, MAP_NEAR_DEFAULT, MAP_FAR_DEFAULT } from '../src/world/map-load.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A phantom centreline `off` metres to `side` of the real road. props.js places its
 * grove scatter relative to whatever road it is handed (`nearest`, `x/z`, `nx/nz`,
 * `width`, `tx/tz`), so an offset copy of the real spline plants a stand of far
 * vegetation along a line that does not exist - which is exactly the distant treeline
 * the far band needs, authored offline and identical every load. The real `nearest`
 * index is reused: a chain point sits on the road normal, so the arc-nearest sample of
 * the road is the arc-nearest sample of the chain too.
 */
function offsetChain(road, off, side) {
  const n = road.n;
  const x = new Float32Array(n), z = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = road.x[i] + road.nx[i] * off * side;
    z[i] = road.z[i] + road.nz[i] * off * side;
  }
  return { n, x, z, length: road.length, s: road.s, tx: road.tx, tz: road.tz,
    nx: road.nx, nz: road.nz, kappa: road.kappa, width: road.width,
    nearest: (X, Z) => road.nearest(X, Z) };
}

// Phantom lines per side: their scatter reach (props.js: 64-124 m) tiles the far band
// outward from the near band, so nothing between the corridor and 400 m is empty.
const FAR_CHAINS = [215, 345];

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

  const nearR = def.nearRadius ?? MAP_NEAR_DEFAULT;
  const farR = def.farRadius ?? MAP_FAR_DEFAULT;
  // The whole authored area is a CORRIDOR along the route, not a disc around the start:
  // every chunk whose centre lies within `farR` of the spline, split into the fully
  // authored near band and the far band (heightfield + billboard vegetation only).
  const list = stageChunkList(road, farR);
  const propMap = new Map(), tileMap = new Map();
  const bandCount = new Map();
  let props = 0, tiles = 0, nearChunks = 0, farChunks = 0;
  for (const { cx, cz, dist } of list) {
    const arc = road.s[road.nearest(cx * 16 + 8, cz * 16 + 8)];
    const biome = biomeAt(arc);
    const terrain = terrainFor(biome);
    terrain.generateChunk(world, cx, cz);
    const c = world.chunkAt(cx, cz);
    carveChunk(world, cx, cz, road, carveIndex, terrain);
    c.carved = true;
    c.farBand = dist > nearR;                  // encoder: far band = the compact mode
    if (c.farBand) farChunks++; else nearChunks++;
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

  // Far band vegetation: the real scatter cannot reach past ~124 m of the centreline
  // (props.js `reach`), so the treeline ahead used to stop dead there. Each phantom
  // chain scatters its own groves over the far band; chunks the real scatter already
  // authored are left alone, so the corridor is untouched.
  let farProps = 0;
  for (const side of [1, -1]) {
    for (const off of FAR_CHAINS) {
      const chain = offsetChain(road, off, side);
      for (const { cx, cz, dist } of stageChunkList(chain, 132)) {
        if (dist > farR) continue;
        const key = chunkKey(cx, cz);
        if (propMap.has(key)) continue;
        const arc = road.s[road.nearest(cx * 16 + 8, cz * 16 + 8)];
        const terrain = terrainFor(biomeAt(arc));
        const stage = { road: chain, terrain, seed, world, carveIndex, biome: biomeAt(arc), density: def.farDensity ?? 0.45 };
        const p = generateChunkProps(cx, cz, stage);
        if (p.length) { propMap.set(key, p); props += p.length; farProps += p.length; }
        else propMap.set(key, p);
      }
    }
  }

  // ---- global placement rules over the assembled map ----
  // The chunk-local scatter cannot see its own far chains (they scatter against an offset
  // phantom road, so a candidate on a chunk border is computed from two different
  // centrelines and can come out twice), and a corridor rule is only worth what the
  // shipped file obeys. So the assembled placement is filtered ONCE, in a fixed order:
  //  * never a trunk inside carriageway + shoulder + TREE_CORRIDOR_HARD,
  //  * the 8 m tree-free verge band keeps only ISOLATED single specimens (no other trunk
  //    within SPECIMEN_ISOLATED m), which is what makes them verifiable from the file,
  //  * minimum trunk-to-trunk spacing (TREE_MIN_SPACING, per species) across the map.
  const SPECIMEN_ISOLATED = 12;
  const kept = [];
  const cells = new Map();
  const cellKey = (x, z) => `${Math.floor(x / 6)},${Math.floor(z / 6)}`;
  const nearAccepted = (x, z) => {
    const cx = Math.floor(x / 6), cz = Math.floor(z / 6), out = [];
    for (let a = cx - 2; a <= cx + 2; a++) for (let b2 = cz - 2; b2 <= cz + 2; b2++) {
      const l = cells.get(`${a},${b2}`);
      if (l) for (const q of l) out.push(q);
    }
    return out;
  };
  let dropped = 0, specimens = 0;
  const treeKeys = [...propMap.keys()].sort((a, b) => a - b);
  for (const key of treeKeys) {
    const list = propMap.get(key);
    const keep = [];
    for (const p of list) {
      if (!TREE_PROPS.has(p.prop)) { keep.push(p); continue; }
      const i = road.nearest(p.x, p.z);
      const toEdge = Math.abs((p.x - road.x[i]) * road.nx[i] + (p.z - road.z[i]) * road.nz[i])
        - road.width[i] / 2 - SHOULDER;
      if (toEdge < TREE_CORRIDOR_HARD) { dropped++; continue; }
      const nb = nearAccepted(p.x, p.z);
      if (toEdge < TREE_FREE) {
        let lonely = true;
        for (const q of nb) if (TREE_PROPS.has(q.prop) && Math.hypot(p.x - q.x, p.z - q.z) < SPECIMEN_ISOLATED) { lonely = false; break; }
        if (!lonely) { dropped++; continue; }
        p.specimen = 1; specimens++;
      }
      let clear = true;
      for (const q of nb) {
        if (!TREE_PROPS.has(q.prop)) continue;
        if (Math.hypot(p.x - q.x, p.z - q.z) < treeSpacingFor(p.prop, p.scale, q.prop, q.scale)) { clear = false; break; }
      }
      if (!clear) { dropped++; continue; }
      const k = cellKey(p.x, p.z);
      const l = cells.get(k) || (cells.set(k, []), cells.get(k));
      l.push(p);
      kept.push(p);
      keep.push(p);
    }
    propMap.set(key, keep);
  }
  let tMin = Infinity, tSum = 0, overlap = 0;
  for (let a = 0; a < kept.length; a++) {
    let best = Infinity;
    for (const q of nearAccepted(kept[a].x, kept[a].z)) {
      if (q === kept[a] || !TREE_PROPS.has(q.prop)) continue;
      const d = Math.hypot(kept[a].x - q.x, kept[a].z - q.z);
      if (d < best) best = d;
    }
    if (best < Infinity) { tSum += best; if (best < tMin) tMin = best; }
  }
  // crown overlaps, via the same spatial hash (a pair is seen from both ends, so /2)
  for (const p of kept) {
    if (!TREE_PROPS.has(p.prop)) continue;
    for (const q of nearAccepted(p.x, p.z)) {
      if (q === p || !TREE_PROPS.has(q.prop)) continue;
      if (Math.hypot(p.x - q.x, p.z - q.z)
        < propFootprint(p.prop, p.scale) + propFootprint(q.prop, q.scale)) overlap++;
    }
  }
  overlap >>= 1;
  props = kept.length;
  const stats = { trees: kept.length, dropped, specimens, minTrunkSpacing: tMin === Infinity ? 0 : +tMin.toFixed(2),
    meanTrunkSpacing: +(tSum / Math.max(1, kept.length)).toFixed(2), crownOverlaps: overlap };

  // Dominant surface of the shipped road, for the menu line.
  const tally = new Map();
  for (let i = 0; i < road.n; i++) tally.set(road.surfaceId[i], (tally.get(road.surfaceId[i]) || 0) + 1);
  const top = [...tally].sort((a, b) => b[1] - a[1])[0][0];

  const meta = {
    id: def.id, name: def.name, version: MAP_VERSION, seed, biome: def.biome,
    length: road.length, difficulty: def.difficulty, surface: def.surface,
    roadSurfaceTop: top, radius: def.radius, bands: def.bands,
    coverage: { near: nearR, far: farR, chains: FAR_CHAINS, farDensity: def.farDensity ?? 0.45,
      nearChunks, farChunks },
    climate: road.climate,
    gates: gates.map((g) => ({ arc: g.arc, kind: g.kind })),
    counts: { chunks: list.length, propLists: propMap.size, props, farProps, tileLists: tileMap.size, tiles },
    veg: stats,
    bandChunks: Object.fromEntries(bandCount),
    baked: new Date().toISOString(),
  };
  let covered = 0;
  for (const c of world.chunks.values()) {
    if (!c.roadCover) continue;
    for (let i = 0; i < c.roadCover.length; i++) covered += c.roadCover[i];
  }
  const bytes = encodeMap({ meta, road, world, propMap, tileMap });
  const out = path.join(root, mapUrl(def.id));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);

  // Round trip: a shipped file the loader cannot read is worse than no file at all.
  const back = new VoxelWorld(seed);
  const a = decodeMap(bytes);
  const ok = a && applyCheck(world, back, bytes, propMap);
  const applied = ok === true;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[bake] ${def.id.padEnd(19)} ${(road.length / 1000).toFixed(2)} km  `
    + `${list.length} chunks  ${props} props  ${tiles} tiles  `
    + `${(bytes.length / 1e6).toFixed(2)} MB  ${secs} s  bands=[${def.bands.map((b) => b.biome).join('>')}]`
    + `  roadCover=${covered} columns (1 bit/col in the file)`
    + `  veg trees=${stats.trees} minNN=${stats.minTrunkSpacing} meanNN=${stats.meanTrunkSpacing} overlap=${stats.crownOverlaps} specimens=${stats.specimens} dropped=${stats.dropped}`
    + `  coverage=${nearR}/${farR} m (${nearChunks}+${farChunks} chunks)  far props=${farProps}`
    + `  verify=${applied ? 'OK' : String(ok)}`);
  if (!applied) console.error(`[bake] ${def.id}: ${ok}`);
  return applied ? 0 : 1;
}

/** Decode back with the runtime loader and compare EVERY voxel / column / prop / tile of
 *  the baked world. A map the game cannot reproduce exactly is not shipped. */
function applyCheck(src, back, bytes, propTables) {
  const r = applyMap(back, bytes);
  if (!r) return 'decode rejected';
  if (!r.road || typeof r.road.nearest !== 'function' || !r.gates.length) return 'road/gates missing';
  if (!r.propTables.size || !r.tileTables.size) return 'prop/tile tables missing';
  let bad = 0;
  for (const c of src.chunks.values()) {
    const d = back.chunkAt(c.cx, c.cz);
    if (!d) { bad++; continue; }
    for (let i = 0; i < c.blocks.length; i++) if (c.blocks[i] !== d.blocks[i]) { bad++; break; }
    for (let i = 0; i < c.height.length; i++) {
      if (c.height[i] !== d.height[i] || c.surface[i] !== d.surface[i]
        || c.fine[i] !== d.fine[i] || c.rut[i] !== d.rut[i] || c.wear[i] !== d.wear[i]
        || c.roadCover[i] !== d.roadCover[i]) { bad++; break; }
    }
  }
  let pbad = 0;
  for (const [k, list] of propTables) {
    const q = r.propTables.get(k);
    if (!q || q.length !== list.length) { pbad++; continue; }
    for (let i = 0; i < list.length; i++) {
      const a = list[i], b = q[i];
      if (a.prop !== b.prop || Math.abs(a.x - b.x) > 1e-4 || Math.abs(a.y - b.y) > 1e-4
        || Math.abs(a.z - b.z) > 1e-4 || Math.abs(a.scale - b.scale) > 1e-4) { pbad++; break; }
    }
  }
  if (bad) return `VOXEL MISMATCH in ${bad}/${src.chunks.size} chunks`;
  if (pbad) return `PROP MISMATCH in ${pbad} lists`;
  return r.stats.chunks > 0 ? true : 'no chunks';
}

const want = process.argv[2];
const defs = want ? [mapById(want)] : MAP_CATALOG;
if (!defs[0]) { console.error(`unknown map id ${want} (have: ${MAP_CATALOG.map((d) => d.id).join(', ')})`); process.exit(2); }
let bad = 0;
for (const d of defs) bad += bake(d);
console.log(`[bake] ${MAP_CATALOG.length ? '' : ''}wrote ${defs.length} map file(s) to assets/maps/`);
process.exit(bad ? 3 : 0);
