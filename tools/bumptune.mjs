import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';
class FlatWorld {
  constructor(s, opts){ this.surfaceId=s; this.bumps=opts.bumps||null; }
  groundHeight(x,z){ if(!this.bumps) return 0; const b=this.bumps,k=2*Math.PI/b.wavelength; return b.amp*Math.sin(x*k)*(0.6+0.4*Math.cos(z*0.35)); }
  surfaceAt(){return this.surfaceId;} rutAt(){return 0;} addRut(){return false;} breakLooseBlock(){return false;} columnTopAt(x,z){return Math.floor(this.groundHeight(x,z));}
}
for (const thr of [0.5, 0.7, 0.9]) for (const amp of [0.07, 0.09]) for (const v0 of [22, 25]) {
  const w = new FlatWorld(SURF.GRAVEL, { bumps: { amp, wavelength: 5.0 } });
  const car = new Vehicle('A', w, {assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
  car.placeAt(0,0,0, w.groundHeight(0,0));
  car.body.vel.x = v0; car.wheels.forEach(x=>{x.omega=v0/x.rGeo;});
  let anyAir=0; const steps=Math.round(8/DT);
  for(let i=0;i<steps;i++){ car.setInput({throttle:thr,brake:0,steer:0,handbrake:0,shiftUp:0,shiftDown:0}); car.step(DT); if(car.wheels.some(x=>x.airborneFrames>0)) anyAir++; }
  console.log(`thr=${thr} amp=${amp} v0=${v0} air=${(anyAir/steps*100).toFixed(0)}% end=${car.body.groundSpeed.toFixed(1)}`);
}
