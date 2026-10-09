import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class FlatWorld { constructor(s){this.s=s;} groundHeight(){return 0;} surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;} columnTopAt(){return 0;} }
const w = new FlatWorld(SURF.ASPHALT);
const car = new Vehicle('A', w, {setup:{bias:0.55}, assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
car.placeAt(0,0,0);
car.body.vel.x = 160/3.6;
car.wheels.forEach(wh=>{wh.omega = (160/3.6)/wh.rGeo;});
let t=0, x0=car.body.pos.x;
for (let i=0;i<120*12;i++){
  car.setInput({throttle:0, brake:1, steer:0, handbrake:0, shiftUp:0, shiftDown:0});
  car.step(DT); t+=DT;
  if (i%30===0){
    console.log(`t=${t.toFixed(2)} v=${car.body.groundSpeed.toFixed(1)} ka=[${car.wheels.map(x=>x.kappa.toFixed(2)).join(' ')}] N=[${car.wheels.map(x=>x.N.toFixed(0)).join(' ')}] Fl=[${car.wheels.map(x=>x.Flon.toFixed(0)).join(' ')}] bt=[${car.wheels.map(x=>x.brakeTorque.toFixed(0)).join(' ')}] om=[${car.wheels.map(x=>x.omega.toFixed(1)).join(' ')}] dist=${(car.body.pos.x-x0).toFixed(0)}`);
  }
  if (car.body.groundSpeed < 0.6) break;
}
console.log('final dist', (car.body.pos.x-x0).toFixed(1), 'time', t.toFixed(2));
