import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class FlatWorld { constructor(s){this.s=s;} groundHeight(){return 0;} surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;} columnTopAt(){return 0;} }
function run(surf, speed, steerFrac, secs=5){
  const w = new FlatWorld(surf);
  const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
  car.placeAt(0,0,0);
  car.body.vel.x = speed;
  car.wheels.forEach(wh=>{wh.omega = speed/wh.rEff;});
  for (let i=0;i<Math.round(secs/DT);i++){
    car.setInput({throttle:0, brake:0, steer:steerFrac, handbrake:0, shiftUp:0, shiftDown:0});
    car.step(DT);
    if (i%120===0){
      const N=car.wheels.map(x=>x.N.toFixed(0)).join(' ');
      const al=car.wheels.map(x=>(x.alpha*57.3).toFixed(1)).join(' ');
      const ka=car.wheels.map(x=>x.kappa.toFixed(3)).join(' ');
      const ut=car.wheels.map(x=>(Math.hypot(x.Flon,x.Flat)/Math.max(1,x.muEff*x.N)).toFixed(2)).join(' ');
      const R = Math.abs(car.body.angVel.y)>1e-4 ? Math.hypot(car.body.vel.x,car.body.vel.z)/Math.abs(car.body.angVel.y) : 0;
      console.log(`t=${(i*DT).toFixed(2)} v=${car.body.groundSpeed.toFixed(1)} R=${R.toFixed(1)} steer=${(car.steerAngle*57.3).toFixed(2)}deg N=[${N}] alpha=[${al}] kappa=[${ka}] util=[${ut}] angVelY=${car.body.angVel.y.toFixed(3)}`);
    }
  }
}
console.log('--- asphalt 30 m/s, steer for R=60 ---');
run(SURF.ASPHALT, 30, Math.atan(2.62/60)/ (32*Math.PI/180));
console.log('--- asphalt 10 m/s ---');
run(SURF.ASPHALT, 10, Math.atan(2.62/60)/(32*Math.PI/180));
