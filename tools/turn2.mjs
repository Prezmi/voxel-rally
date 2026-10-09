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
  car.step(DT);
  if (i%30===0){
    const m = car.body.m;
    const roll = Math.asin(Math.max(-1,Math.min(1,-m[7])))*57.3;
    const sus = car.wheels.map(x=>x.suspRaw.toFixed(4)).join(' ');
    const N=car.wheels.map(x=>x.N.toFixed(0)).join(' ');
    const wy = car.wheels.map(x=>x.y.toFixed(3)).join(' ');
    const vy = car.wheels.map(x=>x.vy.toFixed(2)).join(' ');
    console.log(`t=${(i*DT).toFixed(2)} posy=${car.body.pos.y.toFixed(3)} vely=${car.body.vel.y.toFixed(2)} roll=${roll.toFixed(1)} angVelX=${car.body.angVel.x.toFixed(3)} sus=[${sus}] N=[${N}] wy=[${wy}] wvy=[${vy}] sumN=${car.wheels.reduce((a,b)=>a+b.N,0).toFixed(0)}`);
  }
}
