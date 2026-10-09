import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class BumpWorld {
  constructor(s, amp, wl){ this.s=s; this.amp=amp; this.wl=wl; }
  groundHeight(x,z){ const k=2*Math.PI/this.wl; return this.amp*Math.sin(x*k)*(0.6+0.4*Math.cos(z*0.35)); }
  surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;}
  columnTopAt(x,z){return Math.floor(this.groundHeight(x,z));}
}
const w = new BumpWorld(SURF.GRAVEL, 0.09, 5.0);
const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
car.placeAt(0,0,0);
car.body.vel.x = 25;
car.wheels.forEach(wh=>{wh.omega = 25/wh.rGeo;});
const chk = (v)=>!Number.isFinite(v);
for (let i=0;i<40;i++){
  car.setInput({throttle:0.5, brake:0, steer:0, handbrake:0, shiftUp:0, shiftDown:0});
  car.step(DT);
  const bad = [];
  if (chk(car.body.pos.y)) bad.push('posy');
  if (chk(car.body.vel.y)) bad.push('vely');
  car.wheels.forEach((x,k)=>{
    if (chk(x.y)) bad.push(`w${k}.y`);
    if (chk(x.vy)) bad.push(`w${k}.vy`);
    if (chk(x.N)) bad.push(`w${k}.N`);
    if (chk(x.Fvert)) bad.push(`w${k}.Fvert`);
    if (chk(x.compression)) bad.push(`w${k}.comp`);
    if (chk(x.omega)) bad.push(`w${k}.omega`);
    if (chk(x.suspRaw)) bad.push(`w${k}.susp`);
  });
  if (bad.length){ console.log(`i=${i} NaN in ${bad.join(', ')}`); break; }
  if (i>=14 && i<=22) console.log(`i=${i} posy=${car.body.pos.y.toFixed(4)} w0y=${car.wheels[0].y.toFixed(4)} w0vy=${car.wheels[0].vy.toFixed(3)} w0N=${car.wheels[0].N.toFixed(0)} w0Fg=${car.wheels[0].Fvert.toFixed(0)} w0comp=${car.wheels[0].compression.toFixed(4)} w0susp=${car.wheels[0].suspRaw.toFixed(4)} hubY=${car.wheels[0].hub.y.toFixed(4)}`);
}
