import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
class BumpWorld {
  constructor(s, amp, wl){ this.s=s; this.amp=amp; this.wl=wl; }
  groundHeight(x,z){ const k=2*Math.PI/this.wl; return this.amp*Math.sin(x*k)*(0.6+0.4*Math.cos(z*0.35)); }
  surfaceAt(){return this.s;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;}
  columnTopAt(x,z){return Math.floor(this.groundHeight(x,z));}
}
const w = new BumpWorld(SURF.GRAVEL, 0.09, 5.0);
const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}, substeps:1});
car.placeAt(0,0,0);
car.body.vel.x = 25;
car.wheels.forEach(wh=>{wh.omega = 25/wh.rGeo;});
const W = car.wheels[0];
console.log('after placeAt: posy', car.body.pos.y, 'hub', W.hub, 'wy', W.y, 'groundY', W.groundY, 'rest', car.restLength, 'suspRaw', W.suspRaw);
car.setInput({throttle:0.5, brake:0, steer:0, handbrake:0, shiftUp:0, shiftDown:0});
car.step(1/120);
console.log('after step: posy', car.body.pos.y, 'vely', car.body.vel.y, 'angVel', car.body.angVel);
for (const x of car.wheels) console.log(x.id, 'hubY', x.hub.y, 'y', x.y, 'vy', x.vy, 'N', x.N, 'Fg', x.Fvert, 'comp', x.compression, 'suspRaw', x.suspRaw, 'omega', x.omega, 'Flon', x.Flon, 'Flat', x.Flat, 'kappa', x.kappa, 'alpha', x.alpha, 'mu', x.muEff, 'rEff', x.rEff);
