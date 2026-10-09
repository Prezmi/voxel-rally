import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class FlatWorld {
  constructor(s){this.s=s;}
  groundHeight(){return 0;}
  surfaceAt(){return this.s;}
  rutAt(){return 0;}
  addRut(){return false;}
  breakLooseBlock(){return false;}
  columnTopAt(){return 0;}
}
const w = new FlatWorld(SURF.ASPHALT);
const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
car.placeAt(0,0,0);
console.log('restLength', car.restLength.toFixed(4), 'comY', car.params.comY, 'mountY', car.params.mountY);
console.log('wheel0 mountLocal', car.wheels[0].mountLocal, 'hub after place', car.wheels[0].hub, 'wheel y', car.wheels[0].y.toFixed(4));
console.log('body pos', car.body.pos);
for (let i=0;i<600;i++){
  car.setInput({throttle:0, brake:0, steer:0, handbrake:0, shiftUp:0, shiftDown:0});
  car.step(DT);
  if (i%60===0 || i<10){
    const N = car.wheels.map(x=>x.N.toFixed(0)).join(' ');
    const ys = car.wheels.map(x=>x.y.toFixed(4)).join(' ');
    const sus = car.wheels.map(x=>x.susp.toFixed(4)).join(' ');
    console.log(`i=${i} posy=${car.body.pos.y.toFixed(4)} vely=${car.body.vel.y.toFixed(3)} N=[${N}] wheelY=[${ys}] susp=[${sus}] angVel=${car.body.angVel.z.toFixed(3)}`);
  }
}
