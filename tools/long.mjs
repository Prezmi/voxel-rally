import { arcRun } from '../src/debug/tests.js';
import { SURF } from '../src/world/surfaces.js';
for (const hb of [0, 1]) for (const thr of [0, 0.4]) {
  const r = arcRun(SURF.GRAVEL, 20, 60, { handbrake: hb, hbStart: 1.2, hbDur: 0.5, throttle: thr, seconds: 10 });
  console.log(`hb=${hb} throttle=${thr} slip=${(r.maxBodySlip*57.3).toFixed(1)} cross=${r.crossTrack.toFixed(1)} end=${r.endSpeed.toFixed(1)}`);
}
