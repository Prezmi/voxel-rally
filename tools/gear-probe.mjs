import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';
import { bus } from '../src/core/events.js';
class W{constructor(i){this.surfaceId=i;this.rutDepth=0}groundHeight(){return 0}surfaceAt(){return this.surfaceId}rutAt(){return 0}addRut(){return false}breakLooseBlock(){return false}columnTopAt(){return 0}}
const DT=1/120; const car=new Vehicle('A',new W(SURF.ASPHALT),{setup:{},assists:{abs:false,tc:false,counterSteer:false,autoShift:true}});
car.placeAt(0,0,0);
let t=0; const ev=[];
bus.on('shift',(e)=>{ev.push(`${t.toFixed(2)}:${e.up?'U':'D'}${e.gear}`);});
for(let i=0;i<Math.round(8/DT);i++){car.setInput({throttle:1,brake:0,steer:0,handbrake:0,shiftUp:0,shiftDown:0});car.step(DT);t+=DT;}
console.log(ev.join(' '));
