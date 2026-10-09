import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class FlatWorld { constructor(s){this.s=s;} groundHeight(){return 0;} surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;} columnTopAt(){return 0;} }
const w = new FlatWorld(SURF.ASPHALT);
const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
car.placeAt(0,0,0);
car.body.vel.x = 30;
car.wheels.forEach(wh=>{wh.omega = 30/wh.rGeo;});
for (let i=0;i<Math.round(3/DT);i++){
  car.setInput({throttle:0.4, brake:0, steer:0, handbrake:0, shiftUp:0, shiftDown:0});
  car.step(DT);
  if (i<12 || i%10===0)
    console.log(`t=${(i*DT).toFixed(3)} posy=${car.body.pos.y.toFixed(4)} vely=${car.body.vel.y.toFixed(3)} N=[${car.wheels.map(x=>x.N.toFixed(0)).join(' ')}] Fg=[${car.wheels.map(x=>x.Fvert.toFixed(0)).join(' ')}] sus=[${car.wheels.map(x=>x.suspRaw.toFixed(4)).join(' ')}] T=[${car.body.torque.x.toFixed(0)} ${car.body.torque.y.toFixed(0)} ${car.body.torque.z.toFixed(0)}] v=${car.body.groundSpeed.toFixed(1)}`);
}
