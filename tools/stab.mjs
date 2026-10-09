import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
class FlatWorld { constructor(s){this.s=s;} groundHeight(){return 0;} surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;} columnTopAt(){return 0;} }
for (const dt of [1/120, 1/240, 1/480, 1/960]) {
  const w = new FlatWorld(SURF.ASPHALT);
  const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
  car.placeAt(0,0,0);
  car.body.vel.x = 30;
  car.wheels.forEach(wh=>{wh.omega = 30/wh.rGeo;});
  const Ns = [], wys = [];
  const steps = Math.round(1.0/dt);
  for (let i=0;i<steps;i++){
    car.setInput({throttle:0.4, brake:0, steer:0, handbrake:0, shiftUp:0, shiftDown:0});
    car.step(dt);
    if (i > steps*0.6) { Ns.push(car.wheels[0].N); wys.push(car.wheels[0].y); }
  }
  const mean = Ns.reduce((a,b)=>a+b,0)/Ns.length;
  const sd = Math.sqrt(Ns.reduce((a,b)=>a+(b-mean)**2,0)/Ns.length);
  const wyMean = wys.reduce((a,b)=>a+b,0)/wys.length;
  const wySd = Math.sqrt(wys.reduce((a,b)=>a+(b-wyMean)**2,0)/wys.length);
  console.log(`dt=1/${(1/dt).toFixed(0)}  N mean=${mean.toFixed(0)} sd=${sd.toFixed(0)} (${(sd/mean*100).toFixed(1)}%)  wheelY sd=${wySd.toFixed(6)} m  bodyY=${car.body.pos.y.toFixed(5)}`);
}
