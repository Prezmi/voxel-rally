import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex } from '../src/world/road-carve.js';
import { generateChunkProps, PROP, PROP_NAMES } from '../src/world/props.js';
import { CHUNK } from '../src/world/chunk.js';
import { settings, qualityPreset, QUALITY } from '../src/core/settings.js';
import { vegBandPlan, vegDensity, vegCostFromDensity, VEG_BANDS, PROP_CAPACITY } from '../src/world/veg-bands.js';

const SEED = 12345;
const terrain = makeTerrain(SEED, 'FOREST');
const road = buildRoad({ seed: SEED, lengthTarget: 4200, terrainHeightAt: terrain.heightAt, biome: 'FOREST' });
const carveIndex = buildCarveIndex(road);
const stage = { road, carveIndex, terrain, biome: 'FOREST', density: 1, seed: SEED, world: null };
const seen = new Set(), keys = [];
for (let i = 0; i < road.n; i += 16) {
  const k = `${Math.floor(road.x[i] / CHUNK)},${Math.floor(road.z[i] / CHUNK)}`;
  if (!seen.has(k)) { seen.add(k); keys.push(k); }
}
const sample = keys.slice(0, 48);
const counts = {}; let props = 0;
for (const k of sample) {
  const [cx, cz] = k.split(',').map(Number);
  for (const p of generateChunkProps(cx, cz, stage)) { props++; counts[p.prop] = (counts[p.prop] || 0) + 1; }
}
const density = vegDensity(counts, sample.length, CHUNK * CHUNK);
console.log('chunks', sample.length, 'props', props, 'per chunk', (props / sample.length).toFixed(1));
console.log(Object.entries(counts).map(([t, n]) => `${PROP_NAMES[t] || t}=${n}`).join(' '));
for (const [n, q] of [['LOW', QUALITY.LOW], ['MED', QUALITY.MED], ['HIGH', QUALITY.HIGH]]) {
  qualityPreset(q);
  const p = vegBandPlan(q, settings);
  const c = vegCostFromDensity(p, density);
  console.log(n, JSON.stringify(p), '=> near', c.near.toFixed(0), 'mid', c.mid.toFixed(0), 'far', c.far.toFixed(0), 'total', c.total.toFixed(0), 'inst', c.instances.toFixed(0));
}
// hostile override: does the clamp bind?
qualityPreset(QUALITY.MED);
const saved = JSON.parse(JSON.stringify(VEG_BANDS[QUALITY.LOW]));
VEG_BANDS[QUALITY.LOW].farAdd = 900; VEG_BANDS[QUALITY.LOW].midCapMul = 0.95; VEG_BANDS[QUALITY.LOW].nearR = 90;
console.log('hostile LOW', JSON.stringify(vegBandPlan(QUALITY.LOW, settings)));
Object.assign(VEG_BANDS[QUALITY.LOW], saved);
console.log('restored LOW', JSON.stringify(vegBandPlan(QUALITY.LOW, settings)));
console.log('cap', JSON.stringify(PROP_CAPACITY));
