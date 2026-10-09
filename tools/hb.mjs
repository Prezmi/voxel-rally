import { arcRun } from '../src/debug/tests.js';
import { SURF } from '../src/world/surfaces.js';
for (const speed of [15, 16, 17, 18]) {
  for (const dur of [0.4, 0.5, 0.6]) {
    const r = arcRun(SURF.GRAVEL, speed, 60, { handbrake: 1, hbStart: 2.0, hbDur: dur, throttle: 0.4, seconds: 6 });
    console.log(`v=${speed} dur=${dur} slip=${(r.maxBodySlip*57.3).toFixed(1)} rec=${r.recovery<0?'-':r.recovery.toFixed(2)}`);
  }
}
