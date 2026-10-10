import { GeoBuilder } from '../src/render/primitives.js';
import { buildGateGeometry } from '../src/world/props.js';
class FakeGeo { setAttribute(n,a){this[n]=a.array;} setIndex(i){this.idx=i;} computeBoundingSphere(){} }
const T = { BufferGeometry: FakeGeo, Float32BufferAttribute: class { constructor(a){this.array=a;} } };
const geo = buildGateGeometry(GeoBuilder, T);
const pos=geo.position, nrm=geo.normal, col=geo.color, idx=geo.idx;
const F=[];
for(let t=0;t<idx.length;t+=3){const a=idx[t]*3,b=idx[t+1]*3,c=idx[t+2]*3;
 const n=[nrm[a],nrm[a+1],nrm[a+2]];const d=n[0]*pos[a]+n[1]*pos[a+1]+n[2]*pos[a+2];
 const rgb=[0,1,2].map(k=>(col[a+k]+col[b+k]+col[c+k])/3);
 let min=[pos[a],pos[a+1],pos[a+2]],max=[...min];
 for(const k of [b,c])for(let x=0;x<3;x++){min[x]=Math.min(min[x],pos[k+x]);max[x]=Math.max(max[x],pos[k+x]);}
 F.push({n,d,rgb,min,max});}
const P=[];
for(let i=0;i<F.length;i++)for(let j=i+1;j<F.length;j++){const A=F[i],B=F[j];
 if(Math.abs(A.n[0]*B.n[0]+A.n[1]*B.n[1]+A.n[2]*B.n[2])<0.999)continue;
 let ov=true;for(let x=0;x<3;x++)if(A.max[x]<B.min[x]||B.max[x]<A.min[x])ov=false;
 if(!ov)continue;
 const dc=Math.hypot(...A.rgb.map((v,k)=>v-B.rgb[k])); if(dc<0.06)continue;
 P.push({gap:Math.abs(A.d-B.d),A:[A.n.map(v=>v.toFixed(0)),A.d.toFixed(2),A.min.map(v=>v.toFixed(2)),A.max.map(v=>v.toFixed(2))].join(' '),B:[B.n.map(v=>v.toFixed(0)),B.d.toFixed(2),B.min.map(v=>v.toFixed(2)),B.max.map(v=>v.toFixed(2))].join(' ')});}
P.sort((p,q)=>p.gap-q.gap);
console.log('pairs',P.length);
for(const p of P.slice(0,8))console.log(`gap=${p.gap.toFixed(3)}\n  A ${p.A}\n  B ${p.B}`);
