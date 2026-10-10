import { GeoBuilder } from '../src/render/primitives.js';
import { buildGateGeometry as newGate } from '../src/world/props.js';
import { GeoBuilder as GB } from '../src/render/primitives.js';
// old build, verbatim from HEAD, to prove the checker detects the defect it is for

function oldGate(GeoBuilder, THREE) {
  const g = new GeoBuilder();
  // post colour anchored down from 0xf3f5f8: a near-white 10.7 x 1.1 m banner plus 6 m
  // banded poles read as pale plates against the dark forest at a distance.
  const post = 0xcbb691, red = 0xb8362c, dark = 0x1c242c, warm = 0xe8b45c;
  for (const s of [-1, 1]) {
    // Post: 0.42 m square, 6.2 m tall, banded so it reads at distance.
    g.box(s * 5.4, 3.1, 0, 0.21, 3.1, 0.21, post);
    g.box(s * 5.4, 1.15, 0, 0.24, 0.45, 0.24, red);
    g.box(s * 5.4, 2.65, 0, 0.24, 0.45, 0.24, red);
    g.box(s * 5.4, 4.15, 0, 0.24, 0.35, 0.24, red);
    // Guy wire / brace so the post has a base, not a floating stick.
    g.box(s * 5.4, 0.16, 0, 0.52, 0.16, 0.52, dark);
    // Lamp: warm panel facing down the road, plus its housing.
    g.box(s * 4.7, 5.28, 0, 0.42, 0.20, 0.30, dark);
    g.box(s * 4.7, 5.02, 0, 0.32, 0.10, 0.22, warm);
    // Pennant on top of the post (moves in the wind of a passing car visually).
    g.boxRot(s * 5.4, 6.55, 0.34, 0.55, 0.30, 0.03, 0.25, s < 0 ? red : post);
  }
  // Beam + banner across the carriageway. The old build stacked three near-coplanar
  // slabs (pale plate z 0, red plate z 0.16, 1.1 m chequered tabs z 0.18) over the same
  // 10.7 m span: the depth pass could not separate them and the whole banner came back
  // as a white/red checkerboard. One solid plate per face now, every face at least 4 cm
  // clear of the next, plus dark lettering blocks so it reads as a named start board.
  g.box(0, 5.62, 0, 5.7, 0.24, 0.30, dark);
  g.box(0, 5.10, 0, 5.35, 0.55, 0.12, post);            // solid banner plate (opaque)
  // Lettering and end tabs are carried on BOTH faces: the gantry is placed with a
  // road-tangent normal, so a single-sided board came back blank from the start line.
  for (const sz of [-1, 1]) {
    g.box(0, 5.10, sz * 0.17, 5.35, 0.55, 0.05, post);
    for (const s of [-1, 1]) g.box(s * 4.95, 5.10, sz * 0.24, 0.40, 0.55, 0.06, red);
    // Five dark name blocks across the plate, wide enough to read as text at 100 m.
    for (let k = 0; k < 5; k++) g.box(-3.1 + k * 1.55, 5.10, sz * 0.24, 0.34, 0.24, 0.06, dark);
  }
  g.box(0, 4.28, 0.10, 2.6, 0.42, 0.06, dark);
  return g.toGeometry(THREE);
}


class FakeGeo { setAttribute(n,a){this[n]=a.array;} setIndex(i){this.idx=i;} computeBoundingSphere(){} }
const T = { BufferGeometry: FakeGeo, Float32BufferAttribute: class { constructor(a){this.array=a;} } };
function facesOf(fn){
  const geo = fn(GeoBuilder, T);
  const pos=geo.position, nrm=geo.normal, col=geo.color, idx=geo.idx, F=[];
  for(let t=0;t<idx.length;t+=3){const a=idx[t]*3,b=idx[t+1]*3,c=idx[t+2]*3;
    const n=[nrm[a],nrm[a+1],nrm[a+2]];const d=n[0]*pos[a]+n[1]*pos[a+1]+n[2]*pos[a+2];
    const rgb=[0,1,2].map(k=>(col[a+k]+col[b+k]+col[c+k])/3);
    let min=[pos[a],pos[a+1],pos[a+2]],max=[...min];
    for(const k of [b,c])for(let x=0;x<3;x++){min[x]=Math.min(min[x],pos[k+x]);max[x]=Math.max(max[x],pos[k+x]);}
    F.push({n,d,rgb,min,max});}
  return {F, tris: idx.length/3};
}
function clash(F, EPS=0.10){
  const out=[]; let minGap=Infinity;
  for(let i=0;i<F.length;i++)for(let j=i+1;j<F.length;j++){const A=F[i],B=F[j];
    const dot=A.n[0]*B.n[0]+A.n[1]*B.n[1]+A.n[2]*B.n[2];
    if(dot<0.999)continue;
    const gap=Math.abs(A.d-B.d);
    const na=Math.abs(A.n[0])>0.5?0:(Math.abs(A.n[1])>0.5?1:2);
    const nb=Math.abs(B.n[0])>0.5?0:(Math.abs(B.n[1])>0.5?1:2);
    let ov=true;
    for(let x=0;x<3;x++){ if(x===na||x===nb)continue; if(A.max[x]<B.min[x]||B.max[x]<A.min[x])ov=false; }
    if(!ov)continue;
    const dc=Math.hypot(...A.rgb.map((v,k)=>v-B.rgb[k]));
    if(dc<0.06)continue;
    minGap=Math.min(minGap,gap);
    if(gap<EPS)out.push({gap,A,B});
  }
  return {out,minGap};
}
for (const [name, fn] of [['OLD', oldGate], ['NEW', newGate]]) {
  const {F, tris} = facesOf(fn);
  const r = clash(F);
  console.log(`${name} tris=${tris} clashes=${r.out.length} minGap=${r.minGap.toFixed(3)}`);
  const seen=new Set();
  for(const c of r.out){const k=[c.A.min,c.A.max,c.B.min,c.B.max].flat().map(v=>v.toFixed(2)).join(',');if(seen.has(k))continue;seen.add(k);
    console.log(`   gap=${c.gap.toFixed(3)} n=${c.A.n.map(v=>v.toFixed(2))} A d=${c.A.d.toFixed(2)} [${c.A.min.map(v=>v.toFixed(2))}]..[${c.A.max.map(v=>v.toFixed(2))}]  B d=${c.B.d.toFixed(2)} [${c.B.min.map(v=>v.toFixed(2))}]..[${c.B.max.map(v=>v.toFixed(2))}]`);}
}
