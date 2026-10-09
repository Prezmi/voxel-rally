import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class FlatWorld { constructor(s){this.s=s;} groundHeight(){return 0;} surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;} columnTopAt(){return 0;} }
const R=60, speed=20, SEC=12;
const w=new FlatWorld(SURF.GRAVEL);
const car=new Vehicle('A',w,{assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
car.placeAt(0,0,0); car.body.vel.x=speed; car.wheels.forEach(x=>{x.omega=speed/x.rGeo;});
const cx=0,cz=-R,L=car.params.wheelbase,ms=car.params.steerMax;
let steerCmd=0;
for(let i=0;i<Math.round(SEC/DT);i++){
  const t=i*DT;
  const px=car.body.pos.x,pz=car.body.pos.z;
  const sp0=Math.hypot(car.body.vel.x,car.body.vel.z);
  const look=Math.max(14, sp0*1.15);
  const th=Math.atan2(pz-cz,px-cx)-look/R;
  const tx=cx+R*Math.cos(th),tz=cz+R*Math.sin(th);
  const f=car.body.forward, head=Math.atan2(f.z,f.x), want=Math.atan2(tz-pz,tx-px);
  let dA=want-head; while(dA>Math.PI)dA-=2*Math.PI; while(dA<-Math.PI)dA+=2*Math.PI;
  const cmd=-Math.atan((2*L*Math.sin(dA))/look)/ms;
  steerCmd += (cmd-steerCmd)*Math.min(1,12*DT);
  const s=Math.max(-1,Math.min(1,steerCmd));
  car.setInput({throttle:0,brake:0,steer:s,handbrake:0,shiftUp:0,shiftDown:0});
  car.step(DT);
  if(i%40===0){
    const dot=(f.x*car.body.vel.x+f.z*car.body.vel.z)/(sp0*(Math.hypot(f.x,f.z)||1));
    console.log(`t=${t.toFixed(2)} v=${sp0.toFixed(2)} y=${car.body.pos.y.toFixed(3)} s=${s.toFixed(3)} slip=${(Math.acos(Math.max(-1,Math.min(1,dot)))*57.3).toFixed(1)} yaw=${car.body.angVel.y.toFixed(3)} pitch=${(Math.asin(Math.max(-1,Math.min(1,car.body.m[1])))*57.3).toFixed(1)} sus=[${car.wheels.map(x=>x.suspRaw.toFixed(3)).join(' ')}] N=[${car.wheels.map(x=>x.N.toFixed(0)).join(' ')}] gear=${car.powertrain.gear} rpm=${car.powertrain.rpm.toFixed(0)}`);
  }
}
