import { VoxelWorld } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad, planCheckpoints } from '../src/world/road-spline.js';
import { buildCarveIndex, prewarmArea } from '../src/world/road-carve.js';
import { Vehicle } from '../src/car/vehicle.js';
import { DT } from '../src/core/time.js';

const seed = 12345, biome = 'FOREST';
const world = new VoxelWorld(seed);
let t0 = performance.now();
const terrain = makeTerrain(seed, biome);
const road = buildRoad({ seed, lengthTarget: 3400, terrainHeightAt: terrain.heightAt, biome });
const gates = planCheckpoints(road, seed);
const carveIndex = buildCarveIndex(road);
console.log('road', (performance.now()-t0).toFixed(0), 'ms  length', road.length.toFixed(0), 'gates', gates.length, 'carveChunks', carveIndex.size);

t0 = performance.now();
const n = prewarmArea(world, terrain, road, carveIndex, road.x[0], road.z[0], 140);
console.log('prewarm 140 m:', (performance.now()-t0).toFixed(0), 'ms  chunks', n, 'ground under start', world.groundHeight(road.x[0], road.z[0]).toFixed(2));

const car = new Vehicle('A', world, { assists: { abs:false, tc:false, counterSteer:false, autoShift:true } });
car.placeAt(road.x[12], road.z[12], -road.heading[12], road.h[12]);
console.log('placed y', car.body.pos.y.toFixed(2), 'wheelGround', car.wheels.map(w=>w.groundY.toFixed(2)).join(' '));

t0 = performance.now();
let nan=false, maxAir=0;
for (let i=0;i<Math.round(8/DT);i++){
  // follow the road with a crude pure-pursuit so the test exercises the car on real terrain
  const idx = road.nearest(car.body.pos.x, car.body.pos.z);
  const j = Math.min(road.n-1, idx + 18);
  const want = Math.atan2(road.z[j]-car.body.pos.z, road.x[j]-car.body.pos.x);
  let dA = want - Math.atan2(car.body.forward.z, car.body.forward.x);
  while (dA>Math.PI) dA-=2*Math.PI; while (dA<-Math.PI) dA+=2*Math.PI;
  const st = Math.max(-1, Math.min(1, -Math.atan(2*car.params.wheelbase*Math.sin(dA)/18)/car.params.steerMax));
  car.setInput({throttle:0.8, brake:0, steer:st, handbrake:0, shiftUp:0, shiftDown:0});
  car.step(DT);
  if (!Number.isFinite(car.body.pos.y)) { nan=true; break; }
  maxAir = Math.max(maxAir, car.airborneWheels);
  if (i % 240 === 0) {
    // keep ground under the car
    prewarmArea(world, terrain, road, carveIndex, car.body.pos.x, car.body.pos.z, 90);
    console.log(`t=${(i*DT).toFixed(1)} v=${car.body.groundSpeed.toFixed(1)} arc=${road.s[idx]?.toFixed(0)} y=${car.body.pos.y.toFixed(2)} air=${car.airborneWheels}`);
  }
}
console.log('drive', (performance.now()-t0).toFixed(0), 'ms  nan', nan, 'maxAir', maxAir, 'end v', car.body.groundSpeed.toFixed(1), 'chunks', world.chunkCount);
