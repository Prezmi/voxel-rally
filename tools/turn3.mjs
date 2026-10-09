import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class FlatWorld { constructor(s){this.s=s;} groundHeight(){return 0;} surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;} columnTopAt(){return 0;} }
const w = new FlatWorld(SURF.ASPHALT);
const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
car.placeAt(0,0,0);
car.body.vel.x = 30;
car.wheels.forEach(wh=>{wh.omega = 30/wh.rEff;});
const s = Math.atan(2.62/60)/(32*Math.PI/180);
for (let i=0;i<Math.round(4/DT);i++){
  car.setInput({throttle:0, brake:0, steer:s, handbrake:0, shiftUp:0, shiftDown:0});
  const ev = car.step(DT);
  const t = i*DT;
  if (t>1.0 && t<3.3){
    const m = car.body.m;
    const roll = Math.asin(Math.max(-1,Math.min(1,-m[7])))*57.3;
    const pitch = Math.asin(Math.max(-1,Math.min(1,m[1])))*57.3;
    const sus = car.wheels.map(x=>x.suspRaw.toFixed(3)).join(' ');
    const N=car.wheels.map(x=>x.N.toFixed(0)).join(' ');
    const lat=car.wheels.map(x=>x.Flat.toFixed(0)).join(' ');
    const fv=car.wheels.map(x=>x.Fvert.toFixed(0)).join(' ');
    console.log(`i=${i} t=${t.toFixed(3)} posy=${car.body.pos.y.toFixed(3)} vely=${car.body.vel.y.toFixed(2)} roll=${roll.toFixed(1)} pitch=${pitch.toFixed(1)} aX=${car.body.angVel.x.toFixed(2)} sus=[${sus}] N=[${N}] Flat=[${lat}] Fg=[${fv}] T=[${car.body.torque.x.toFixed(0)} ${car.body.torque.y.toFixed(0)} ${car.body.torque.z.toFixed(0)}] ev=${ev.length}`);
  }
}
