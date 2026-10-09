import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class FlatWorld { constructor(s){this.s=s;} groundHeight(){return 0;} surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;} columnTopAt(){return 0;} }
const R=60, speed=20;
const w = new FlatWorld(SURF.GRAVEL);
const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
car.placeAt(0,0,0); car.body.vel.x = speed; car.wheels.forEach(x=>{x.omega=speed/x.rGeo;});
const cx=0, cz=-R, L=car.params.wheelbase, ms=car.params.steerMax;
for (let i=0;i<Math.round(8/DT);i++){
  const t=i*DT;
  const px=car.body.pos.x, pz=car.body.pos.z, look=Math.max(9, speed*0.55);
  const th=Math.atan2(pz-cz, px-cx)-look/R;
  const tx=cx+R*Math.cos(th), tz=cz+R*Math.sin(th);
  const f=car.body.forward, head=Math.atan2(f.z,f.x), want=Math.atan2(tz-pz,tx-px);
  let dA=want-head; while(dA>Math.PI)dA-=2*Math.PI; while(dA<-Math.PI)dA+=2*Math.PI;
  const s=Math.max(-1,Math.min(1,-Math.atan((2*L*Math.sin(dA))/look)/ms));
  const hb = 0;
  car.setInput({throttle:0, brake:0, steer:s, handbrake:hb, shiftUp:0, shiftDown:0});
  car.step(DT);
  if (t>2.0 && i%20===0){
    const v=car.body.vel, sp=Math.hypot(v.x,v.z);
    const dot=(f.x*v.x+f.z*v.z)/(sp*Math.hypot(f.x,f.z)||1);
    console.log(`t=${t.toFixed(2)} s=${s.toFixed(2)} hb=${hb} slip=${(Math.acos(Math.max(-1,Math.min(1,dot)))*57.3).toFixed(1)} pitch=${(Math.asin(Math.max(-1,Math.min(1,car.body.m[1])))*57.3).toFixed(1)} roll=${(Math.asin(Math.max(-1,Math.min(1,-car.body.m[7])))*57.3).toFixed(1)} sus=[${car.wheels.map(x=>x.suspRaw.toFixed(3)).join(' ')}] yaw=${car.body.angVel.y.toFixed(3)} ka=[${car.wheels.map(x=>x.kappa.toFixed(2)).join(' ')}] al=[${car.wheels.map(x=>(x.alpha*57.3).toFixed(1)).join(' ')}] N=[${car.wheels.map(x=>x.N.toFixed(0)).join(' ')}] Fy=[${car.wheels.map(x=>x.Flat.toFixed(0)).join(' ')}] bt=[${car.wheels.map(x=>x.brakeTorque.toFixed(0)).join(' ')}] dtq=[${car.wheels.map(x=>x.driveTorque.toFixed(0)).join(' ')}]`);
  }
}
