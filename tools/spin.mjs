import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class FlatWorld { constructor(s){this.s=s;} groundHeight(){return 0;} surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;} columnTopAt(){return 0;} }
const v0 = Number(process.argv[2]||15), surf = process.argv[3]==='gravel'?SURF.GRAVEL:SURF.ASPHALT;
const w = new FlatWorld(surf);
const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
car.placeAt(0,0,0);
car.body.vel.x = v0;
car.wheels.forEach(wh=>{wh.omega = v0/wh.rGeo;});
const s = Math.max(-1, Math.min(1, Math.atan(car.params.wheelbase/60)/car.params.steerMax));
console.log('steer input', s.toFixed(3), 'steerMax', car.params.steerMax.toFixed(4));
for (let i=0;i<Math.round(3/DT);i++){
  car.setInput({throttle:0, brake:0, steer:s, handbrake:0, shiftUp:0, shiftDown:0});
  car.step(DT);
  if (i%15===0){
    const v=car.body.vel, sp=Math.hypot(v.x,v.z);
    console.log(`t=${(i*DT).toFixed(2)} v=${sp.toFixed(1)} yaw=${car.body.angVel.y.toFixed(3)} steer=[${car.wheels.map(x=>(x.steer*57.3).toFixed(2)).join(' ')}] al=[${car.wheels.map(x=>(x.alpha*57.3).toFixed(1)).join(' ')}] N=[${car.wheels.map(x=>x.N.toFixed(0)).join(' ')}] Fy=[${car.wheels.map(x=>x.Flat.toFixed(0)).join(' ')}] roll=${(Math.asin(Math.max(-1,Math.min(1,-car.body.m[7])))*57.3).toFixed(1)} sus=[${car.wheels.map(x=>x.suspRaw.toFixed(3)).join(' ')}] ka=[${car.wheels.map(x=>x.kappa.toFixed(2)).join(' ')}]`);
  }
}
