// Direct test of integrateQ: a pure BODY-frame pitch rate must change
// pitch by omega*dt and roll by nothing, at every yaw.
import { quatFromYaw, quatMul, normalizeQ, integrateQ, quatToMat3, mul3v, mul3vT } from '../src/core/math3.js';
const q0 = {x:0,y:0,z:0,w:1}, base = {x:0,y:0,z:0,w:1}, tilt = {x:0,y:0,z:0,w:1};
for (const yaw of [0.4, 1.57]) {
  quatFromYaw(yaw, base);
  tilt.x = 0; tilt.y = 0; tilt.z = 0.0027/2; tilt.w = 1; normalizeQ(tilt);
  quatMul(base, tilt, q0);
  const m = new Float64Array(9); quatToMat3(q0, m);
  // body-frame pitch rate of 1 rad/s, expressed in world (what the model stores in angVel)
  const wBody = {x:0,y:0,z:1}, wWorld = {x:0,y:0,z:0};
  mul3v(m, wBody, wWorld);
  const q = { ...q0 };
  integrateQ(q, wBody, 1/480);
  const m2 = new Float64Array(9); quatToMat3(q, m2);
  console.log(`yaw=${yaw} m1 ${m[1].toExponential(6)} -> ${m2[1].toExponential(6)} d=${(m2[1]-m[1]).toExponential(3)}   m7 ${m[7].toExponential(3)} -> ${m2[7].toExponential(3)} d=${(m2[7]-m[7]).toExponential(3)}`);
  console.log(`   expected dPitch = ${(1/480).toExponential(4)}  (body-frame pitch rate 1 rad/s)`);
  // sanity: recover body-frame components of the increment
  const E = new Float64Array(9);
  for (let r=0;r<3;r++) for (let c=0;c<3;c++){ let s=0; for(let k=0;k<3;k++) s+=m2[r*3+k]*m[c*3+k]; E[r*3+c]=s; }
  console.log(`   increment axial (body frame) = ${(0.5*(E[7]-E[5])).toExponential(3)} ${(0.5*(E[2]-E[6])).toExponential(3)} ${(0.5*(E[3]-E[1])).toExponential(3)}`);
  const W = new Float64Array(9);
  for (let r=0;r<3;r++) for (let c=0;c<3;c++){ let s=0; for(let k=0;k<3;k++) s+=m2[3*k+r]*m[3*k+c]; W[r*3+c]=s; } // m2^T? careful
  console.log(`   increment axial (world-ish m2^T m) = ${(0.5*(W[7]-W[5])).toExponential(3)} ${(0.5*(W[2]-W[6])).toExponential(3)} ${(0.5*(W[3]-W[1])).toExponential(3)}`);
}
