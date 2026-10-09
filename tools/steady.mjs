import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class FlatWorld { constructor(s){this.s=s;} groundHeight(){return 0;} surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;} columnTopAt(){return 0;} }
const v0=Number(process.argv[2]||20), steerDeg=Number(process.argv[3]||1.2);
const w=new FlatWorld(SURF.GRAVEL);
const car=new Vehicle('A',w,{assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
car.placeAt(0,0,0); car.body.vel.x=v0; car.wheels.forEach(x=>{x.omega=v0/x.rGeo;});
const s=steerDeg*57.3?  (steerDeg*Math.PI/180)/car.params.steerMax : 0;
for(let i=0;i<Math.round(25/DT);i++){
  car.setInput({throttle:0,brake:0,steer:s,handbrake:0,shiftUp:0,shiftDown:0});
  car.step(DT);
  if(i%120===0){
    const sp=car.body.groundSpeed;
    console.log(`t=${(i*DT).toFixed(1)} v=${sp.toFixed(2)} yaw=${car.body.angVel.y.toFixed(4)} R=${(Math.abs(car.body.angVel.y)>1e-4?sp/Math.abs(car.body.angVel.y):0).toFixed(0)} pitch=${(Math.asin(Math.max(-1,Math.min(1,car.body.m[1])))*57.3).toFixed(2)} roll=${(Math.asin(Math.max(-1,Math.min(1,-car.body.m[7])))*57.3).toFixed(2)} sus=[${car.wheels.map(x=>x.suspRaw.toFixed(4)).join(' ')}] N=[${car.wheels.map(x=>x.N.toFixed(0)).join(' ')}]`);
  }
}
