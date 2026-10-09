import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class BumpWorld {
  constructor(s, amp, wl){ this.s=s; this.amp=amp; this.wl=wl; }
  groundHeight(x,z){ const k=2*Math.PI/this.wl; return this.amp*Math.sin(x*k)*(0.6+0.4*Math.cos(z*0.35)); }
  surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;}
  columnTopAt(x,z){return Math.floor(this.groundHeight(x,z));}
}
const amp = Number(process.argv[2]||0.18), wl = Number(process.argv[3]||6.5), spd = Number(process.argv[4]||25);
const w = new BumpWorld(SURF.GRAVEL, amp, wl);
const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
car.placeAt(0,0,0, w.groundHeight(0,0));
car.body.vel.x = spd;
car.wheels.forEach(wh=>{wh.omega = spd/wh.rGeo;});
let air=0, hull=0;
for (let i=0;i<Math.round(6/DT);i++){
  car.setInput({throttle:0.5, brake:0, steer:0, handbrake:0, shiftUp:0, shiftDown:0});
  const ev = car.step(DT);
  for (const e of ev) if (e.type==='impact') hull++;
  if (car.wheels.some(x=>x.Fvert<=0)) air++;
  if (i%30===0){
    const g = w.groundHeight(car.body.pos.x, car.body.pos.z);
    console.log(`t=${(i*DT).toFixed(2)} x=${car.body.pos.x.toFixed(1)} v=${car.body.groundSpeed.toFixed(1)} posy=${car.body.pos.y.toFixed(3)} ground=${g.toFixed(3)} clearance=${(car.body.pos.y-0.22-g).toFixed(3)} N=[${car.wheels.map(x=>x.N.toFixed(0)).join(' ')}] Fg=[${car.wheels.map(x=>x.Fvert.toFixed(0)).join(' ')}] hullHits=${hull}`);
  }
}
console.log('airborne frames', air, '/', Math.round(6/DT), 'hullHits', hull);
