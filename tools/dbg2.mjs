import { noise2, noise3, fbm2, ridge2, warp2, smoothstep, value2 } from '../src/world/noise.js';
console.log('noise2(1,2,0)=', noise2(1,2,0));
console.log('noise2(0.3,0.7,12345)=', noise2(0.3,0.7,12345));
console.log('noise3(1,2,3,0)=', noise3(1,2,3,0));
console.log('fbm2(0,0)=', fbm2(0,0,{octaves:4,seed:12345,freq:1/220}));
console.log('ridge2(0,0)=', ridge2(0,0,{octaves:4,seed:12345,freq:1/300}));
console.log('warp2(0,0,12345,12)=', warp2(0,0,12345,12));
console.log('smoothstep(0.45,0.85,0.6)=', smoothstep(0.45,0.85,0.6));
console.log('value2(1,2,3)=', value2(1,2,3));
