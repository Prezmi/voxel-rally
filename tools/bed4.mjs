import { VoxelWorld } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex, prewarmArea } from '../src/world/road-carve.js';
import { Vehicle } from '../src/car/vehicle.js';
import { DT } from '../src/core/time.js';

const seed = 12345, biome = 'FOREST';
const world = new VoxelWorld(seed);
const terrain = makeTerrain(seed, biome);
const road = buildRoad({ seed, lengthTarget: 3400, terrainHeightAt: terrain.heightAt, biome });
const ci = buildCarveIndex(road);
prewarmArea(world, terrain, road, ci, road.x[12], road.z[12], 140);

const car = new Vehicle('A', world, { assists: { autoShift: true } });
car.placeAt(road.x[12], road.z[12], -road.heading[12], road.h[12]);

const p = car.params;
console.log('params: r', car.wheels[0].r ?? '', 'restLength', car.restLength, 'mountY', p.mountY, 'comY', p.comY,
  'bumpStop', p.bumpStop, 'droopStop', p.droopStop, 'hull.y', p.hull.y, 'hull.cy', p.hull.cy, 'mass', car.mass);
console.log('road.h[12]', road.h[12].toFixed(2), 'body y', car.body.pos.y.toFixed(2));

function dump(tag) {
  const rows = car.wheels.map((w) => {
    const len = w.hub.y - w.y;
    return `${w.id}: len=${len.toFixed(3)} ground=${w.groundY.toFixed(2)} wheelBottom=${(w.y - (w.r ?? 0.33)).toFixed(2)} N=${(w.N / 1000).toFixed(1)}kN air=${w.airborne ? 1 : 0}`;
  });
  console.log(tag, 'v=' + car.body.groundSpeed.toFixed(2), 'gear', car.powertrain.gear, 'rpm', car.powertrain.rpm.toFixed(0), 'cut', car.powertrain.cut.toFixed(2), 'air', car.airborneWheels);
  for (const r of rows) console.log('   ', r);
}
dump('t=0');

for (let i = 0; i < 240; i++) {
  const idx = road.nearest(car.body.pos.x, car.body.pos.z);
  const j = Math.min(road.n - 1, idx + 18);
  const want = Math.atan2(road.z[j] - car.body.pos.z, road.x[j] - car.body.pos.x);
  let dA = want - Math.atan2(car.body.forward.z, car.body.forward.x);
  while (dA > Math.PI) dA -= 2 * Math.PI; while (dA < -Math.PI) dA += 2 * Math.PI;
  const st = Math.max(-1, Math.min(1, -Math.atan(2 * car.params.wheelbase * Math.sin(dA) / 18) / car.params.steerMax));
  car.setInput({ throttle: 0.8, brake: 0, steer: st, handbrake: 0, shiftUp: 0, shiftDown: 0 });
  const ev = car.step(DT);
  if (i === 0 || i === 30 || i === 119) {
    dump(`t=${((i + 1) * DT).toFixed(2)}`);
    if (ev.length) console.log('    events', ev.slice(0, 4).map((e) => `${e.type}:${(e.impulse || 0).toFixed(0)}`).join(' '));
  }
}
dump('end');
console.log('pos', car.body.pos.x.toFixed(2), car.body.pos.z.toFixed(2), 'arc', road.nearest(car.body.pos.x, car.body.pos.z));
