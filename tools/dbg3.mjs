import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad, walkRoad } from '../src/world/road-spline.js';
const seed = 12345;
const t = makeTerrain(seed,'FOREST');
const pts = walkRoad({ seed, lengthTarget: 3400, terrainHeightAt: t.heightAt });
for (let i=1;i<pts.length-1;i++){
  const a=pts[i-1],b=pts[i],c=pts[i+1];
  const l1=Math.hypot(b.x-a.x,b.z-a.z), l2=Math.hypot(c.x-b.x,c.z-b.z);
  const th1=Math.atan2(b.z-a.z,b.x-a.x), th2=Math.atan2(c.z-b.z,c.x-b.x);
  let d=(th2-th1)*180/Math.PI; while(d>180)d-=360; while(d<-180)d+=360;
  const R = Math.min(l1,l2)/(2*Math.sin(Math.abs(d*Math.PI/180)/2)||1e-9);
  if (R < 25) console.log(`cp${i} turn=${d.toFixed(0)}deg l1=${l1.toFixed(0)} l2=${l2.toFixed(0)} R=${R.toFixed(1)}`);
}
const road = buildRoad({ seed, lengthTarget:3400, terrainHeightAt: t.heightAt, biome:'FOREST' });
let runs=[]; let cur=null;
for(let i=0;i<road.n;i++){const k=Math.abs(road.kappa[i]); if(k>1/15){ if(!cur) cur={s0:road.s[i],n:0,Rmax:0}; cur.n++; cur.Rmax=Math.max(cur.Rmax,1/k);} else { if(cur){runs.push(cur);cur=null;} } }
if(cur) runs.push(cur);
console.log('tight runs:', runs.map(r=>`s=${r.s0.toFixed(0)} len=${r.n}m Rmax=${r.Rmax.toFixed(1)}`).join(' | '));
