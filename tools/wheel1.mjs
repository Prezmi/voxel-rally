import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class FlatWorld { constructor(s){this.s=s;} groundHeight(){return 0;} surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;} columnTopAt(){return 0;} }
const w = new FlatWorld(SURF.ASPHALT);
const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
car.placeAt(0,0,0);
car.body.vel.x = 30;
car.wheels.forEach(wh=>{wh.omega = 30/wh.rGeo;});
for (let i=0;i<Math.round(1.0/DT);i++){
  car.setInput({throttle:0.4, brake:0, steer:0, handbrake:0, shiftUp:0, shiftDown:0});
  car.step(DT);
  if (i>60 && i<90){
    const W = car.wheels[0];
    console.log(`i=${i} hubY=${W.hub.y.toFixed(5)} wy=${W.y.toFixed(5)} wvy=${W.vy.toFixed(4)} comp=${W.compression.toFixed(5)} Fg=${W.Fvert.toFixed(0)} N=${W.N.toFixed(0)} susp=${W.suspRaw.toFixed(5)} hubVy=${W.hubVy.toFixed(4)} bodyVy=${car.body.vel.y.toFixed(4)} bodyY=${car.body.pos.y.toFixed(5)}`);
  }
}
