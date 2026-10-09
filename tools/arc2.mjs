import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class FlatWorld { constructor(s){this.s=s;} groundHeight(){return 0;} surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;} columnTopAt(){return 0;} }
function run(surfId, speed, R, secs=4){
  const w = new FlatWorld(surfId);
  const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
  car.placeAt(0,0,0);
  car.body.vel.x = speed;
  car.wheels.forEach(wh=>{wh.omega = speed/wh.rGeo;});
  const wb = car.params.wheelbase;
  const s = Math.max(-1, Math.min(1, Math.atan(wb/R)/car.params.steerMax));
  let maxUtil=0, minR=Infinity, maxSlip=0;
  for (let i=0;i<Math.round(secs/DT);i++){
    car.setInput({throttle:0, brake:0, steer:s, handbrake:0, shiftUp:0, shiftDown:0});
    car.step(DT);
    for (const wh of car.wheels){ const cap = wh.muEff*wh.N; if (cap>1) maxUtil = Math.max(maxUtil, Math.hypot(wh.Flon,wh.Flat)/cap); }
    const v=car.body.vel, sp=Math.hypot(v.x,v.z);
    if (sp>1){ const f=car.body.forward; const d=(f.x*v.x+f.z*v.z)/(sp*Math.hypot(f.x,f.z)||1); maxSlip=Math.max(maxSlip, Math.acos(Math.max(-1,Math.min(1,d)))); const oy=car.body.angVel.y; if (Math.abs(oy)>1e-3) minR=Math.min(minR, sp/Math.abs(oy)); }
  }
  return {maxUtil, minR, maxSlip:maxSlip*57.3, endSpeed:car.body.groundSpeed, roll:Math.asin(Math.max(-1,Math.min(1,-car.body.m[7])))*57.3};
}
for (const surf of [SURF.ASPHALT, SURF.GRAVEL]) for (const v of [15,20,22,24,26,28,30,34,38]){
  const r = run(surf, v, 60);
  console.log(`${surf===SURF.ASPHALT?'asphalt':'gravel'} v=${v} util=${r.maxUtil.toFixed(2)} minR=${r.minR.toFixed(0)} slip=${r.maxSlip.toFixed(1)} end=${r.endSpeed.toFixed(1)} roll=${r.roll.toFixed(1)}`);
}
