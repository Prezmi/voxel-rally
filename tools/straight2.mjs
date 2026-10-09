import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class FlatWorld { constructor(s){this.s=s;} groundHeight(){return 0;} surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;} columnTopAt(){return 0;} }
const w = new FlatWorld(SURF.ASPHALT);
const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
car.placeAt(0,0,0);
car.body.vel.x = 30;
car.wheels.forEach(wh=>{wh.omega = 30/wh.rGeo;});
const f = (a)=>[a.x,a.y,a.z].map(v=>v.toFixed(3)).join(' ');
for (let i=0;i<Math.round(1.2/DT);i++){
  car.setInput({throttle:0.4, brake:0, steer:0, handbrake:0, shiftUp:0, shiftDown:0});
  car.step(DT);
  if (i>100 && i%4===0){
    const m = car.body.m;
    const roll = Math.asin(Math.max(-1,Math.min(1,-m[7])))*57.3;
    console.log(`t=${(i*DT).toFixed(3)} N=[${car.wheels.map(x=>x.N.toFixed(0)).join(' ')}] Flat=[${car.wheels.map(x=>x.Flat.toFixed(0)).join(' ')}] al=[${car.wheels.map(x=>(x.alpha*57.3).toFixed(2)).join(' ')}] vyL=[${car.wheels.map(x=>x.vyLat.toFixed(2)).join(' ')}] w=[${f(car.body.angVel)}] roll=${roll.toFixed(2)}`);
  }
}
