import fs from 'node:fs';
import { VoxelWorld } from './chunk.js';
import { applyMap, MAP_CATALOG, mapUrl } from './map-load.js';
import { PROP, propFootprint } from './props.js';
const TREES = new Set([PROP.OAK, PROP.PINE, PROP.BIRCH, PROP.DEAD]);
for (const def of MAP_CATALOG) {
  const w = new VoxelWorld(def.seed >>> 0);
  const r = applyMap(w, fs.readFileSync(mapUrl(def.id)));
  let total = 0; const T = [];
  for (const list of r.propTables.values()) for (const p of list) { total++; if (TREES.has(p.prop)) T.push(p); }
  let sum = 0, over = 0, minNN = Infinity;
  for (let i = 0; i < T.length; i++) { let best = Infinity;
    for (let j = 0; j < T.length; j++) { if (i === j) continue; const d = Math.hypot(T[i].x-T[j].x, T[i].z-T[j].z);
      if (d < best) best = d;
      if (i < j && d < propFootprint(T[i].prop, T[i].scale) + propFootprint(T[j].prop, T[j].scale)) over++; }
    sum += best; if (best < minNN) minNN = best; }
  const road = r.road; let band = 0, hard = 0;
  for (const p of T) { const i = road.nearest(p.x, p.z);
    const lat = Math.abs((p.x-road.x[i])*road.nx[i] + (p.z-road.z[i])*road.nz[i]);
    const g = lat - (road.width[i]/2 + 1.5);
    if (g < 2.6) hard++; if (g < 8) band++; }
  console.log(`${def.id.padEnd(20)} props=${total} trees=${T.length} meanNN=${(sum/T.length).toFixed(2)} minNN=${minNN.toFixed(2)} crownOverlap=${over} band8m=${band} hardViol=${hard}`);
}
