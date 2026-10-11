// Headless audit of what the two vegetation fixes are actually worth (no browser, no GPU):
// the painted sprite cells (opaque coverage / canopy share) and the shipped maps (prop
// counts, trunk-to-trunk nearest neighbour, crown overlaps, the road corridor band).
//   node tools/veg-audit.mjs
import fs from 'node:fs';
import { VoxelWorld } from '../src/world/chunk.js';
import { applyMap, MAP_CATALOG, mapUrl } from '../src/world/map-load.js';
import { PROP, PROP_NAMES, SPRITE_PROPS, SPRITE_ATLAS, FAR_SPRITE_CELLS, FAR_SPRITE_PX,
  paintFoliageCell, foliageCellStats, propFootprint, TREE_MIN_SPACING, TREE_CORRIDOR_HARD,
  TREE_FREE } from '../src/world/props.js';

const PAINT = { [PROP.OAK]: 0, [PROP.PINE]: 1, [PROP.BIRCH]: 2, [PROP.BUSH]: 3, [PROP.FERN]: 4, [PROP.DEAD]: 5 };
for (const p of SPRITE_PROPS) {
  const near = foliageCellStats(paintFoliageCell(PAINT[p], SPRITE_ATLAS.cellPx), SPRITE_ATLAS.cellPx);
  const far = foliageCellStats(paintFoliageCell(PAINT[p], FAR_SPRITE_PX), FAR_SPRITE_PX);
  console.log(`cell ${PROP_NAMES[p].padEnd(7)} ${SPRITE_ATLAS.cellPx}px cov=${near.coverage.toFixed(3)} canopy=${near.canopyShare.toFixed(2)}`
    + ` | far ${FAR_SPRITE_PX}px cov=${far.coverage.toFixed(3)} canopy=${far.canopyShare.toFixed(2)} bark=${far.barkShare.toFixed(2)}`);
}
const TREES = new Set([PROP.OAK, PROP.PINE, PROP.BIRCH, PROP.DEAD]);
for (const def of MAP_CATALOG) {
  const w = new VoxelWorld(def.seed >>> 0);
  const r = applyMap(w, fs.readFileSync(mapUrl(def.id)));
  let total = 0; const T = [];
  for (const list of r.propTables.values()) for (const p of list) { total++; if (TREES.has(p.prop)) T.push(p); }
  let sum = 0, over = 0, minNN = Infinity, band = 0, hard = 0;
  for (let i = 0; i < T.length; i++) {
    let best = Infinity;
    for (let j = 0; j < T.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(T[i].x - T[j].x, T[i].z - T[j].z);
      if (d < best) best = d;
      if (i < j && d < propFootprint(T[i].prop, T[i].scale) + propFootprint(T[j].prop, T[j].scale)) over++;
    }
    sum += best; if (best < minNN) minNN = best;
    const road = r.road, k = road.nearest(T[i].x, T[i].z);
    const toEdge = Math.abs((T[i].x - road.x[k]) * road.nx[k] + (T[i].z - road.z[k]) * road.nz[k])
      - (road.width[k] / 2 + 1.5);
    if (toEdge < TREE_CORRIDOR_HARD) hard++;
    if (toEdge < TREE_FREE) band++;
  }
  console.log(`${def.id.padEnd(19)} props=${total} trees=${T.length} meanNN=${(sum / T.length).toFixed(2)}`
    + ` minNN=${minNN.toFixed(2)} crownOverlap=${over} corridorBand=${band} corridorHardViol=${hard}`);
}
