import { makeTerrain } from '../src/world/terrain-gen.js';
import { walkRoad } from '../src/world/road-spline.js';
const seed=12345;
const t = makeTerrain(seed,'FOREST');
const pts = walkRoad({ seed, lengthTarget: 3400, terrainHeightAt: t.heightAt });
for (let i=0;i<pts.length;i++){
  const p=pts[i];
  let l1=NaN,l2=NaN,turn=NaN;
  if(i>0) l1=Math.hypot(p.x-pts[i-1].x,p.z-pts[i-1].z);
  if(i<pts.length-1) l2=Math.hypot(pts[i+1].x-p.x,pts[i+1].z-p.z);
  if(i>0&&i<pts.length-1){
    const a=pts[i-1],b=p,c=pts[i+1];
    let d=(Math.atan2(c.z-b.z,c.x-b.x)-Math.atan2(b.z-a.z,b.x-a.x))*180/Math.PI;
    while(d>180)d-=360; while(d<-180)d+=360; turn=d;
  }
  const R = (isFinite(l1)&&isFinite(l2)) ? Math.min(l1,l2)/(2*Math.sin(Math.abs(turn*Math.PI/180)/2)||1e-9) : NaN;
  console.log(`cp${String(i).padStart(2)} (${p.x.toFixed(0)},${p.z.toFixed(0)}) l1=${isFinite(l1)?l1.toFixed(0):'-'} l2=${isFinite(l2)?l2.toFixed(0):'-'} turn=${isFinite(turn)?turn.toFixed(0):'-'} R=${isFinite(R)?R.toFixed(1):'-'}`);
}
