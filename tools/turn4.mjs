import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class FlatWorld { constructor(s){this.s=s;} groundHeight(){return 0;} surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;} columnTopAt(){return 0;} }
const w = new FlatWorld(SURF.ASPHALT);
const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
car.placeAt(0,0,0);
car.body.vel.x = 30;
car.wheels.forEach(wh=>{wh.omega = 30/wh.rGeo;});
const s = Math.atan(2.62/60)/(32*Math.PI/180);
for (let i=0;i<Math.round(3.4/DT);i++){
  car.setInput({throttle:0, brake:0, steer:s, handbrake:0, shiftUp:0, shiftDown:0});
  car.step(DT);
  const t=i*DT;
  if (t>2.7 && t<3.35 && i%6===0){
    const v=car.body.vel, sp=Math.hypot(v.x,v.z);
    const fwd=car.body.forward;
    const dot=(fwd.x*v.x+fwd.z*v.z)/(sp*(Math.hypot(fwd.x,fwd.z)||1));
    const slip=Math.acos(Math.max(-1,Math.min(1,dot)))*57.3;
    const R = Math.abs(car.body.angVel.y)>1e-4 ? sp/Math.abs(car.body.angVel.y) : 0;
    const ay = sp*sp/Math.max(1,R);
    console.log(`t=${t.toFixed(3)} v=${sp.toFixed(1)} R=${R.toFixed(0)} ay=${(ay/9.81).toFixed(2)}g bodySlip=${slip.toFixed(1)} yaw=${car.body.angVel.y.toFixed(3)} al=[${car.wheels.map(x=>(x.alpha*57.3).toFixed(1)).join(' ')}] ka=[${car.wheels.map(x=>x.kappa.toFixed(3)).join(' ')}] N=[${car.wheels.map(x=>x.N.toFixed(0)).join(' ')}] Fl=[${car.wheels.map(x=>x.Flon.toFixed(0)).join(' ')}] Fy=[${car.wheels.map(x=>x.Flat.toFixed(0)).join(' ')}] sus=[${car.wheels.map(x=>x.suspRaw.toFixed(3)).join(' ')}]`);
  }
}
