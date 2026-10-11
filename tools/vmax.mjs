// Straight-line capability probe for the ghost reference (src/game/ghost.js).
// Measures what car 'A' can *actually* hold on a flat straight per surface, and
// prints the two ceilings the ghost comment quotes: the gearing limit (redline in
// top gear) and the drag-limited cube root the solver computes. Run:
//   node tools/vmax.mjs [carId]
import { Vehicle } from '../src/car/vehicle.js';
import { SURFACES } from '../src/world/surfaces.js';
import { CARS as CARS2, TYRE_BASE } from '../src/car/car-params.js';
import { DT } from '../src/core/time.js';

class FlatWorld {
  constructor(s) { this.s = s; }
  groundHeight() { return 0; }
  surfaceAt() { return this.s; }
  rutAt() { return 0; }
  addRut() { return false; }
  breakLooseBlock() { return false; }
  columnTopAt() { return 0; }
}

const carId = process.argv[2] || 'A';
const p = CARS2[carId] || CARS2.A;
const RHO = 1.2;

// Gearing ceiling: redline engine speed through the tallest ratio, at the tyre radius.
const topRatio = Math.min(...p.gears) * p.finalDrive;
const vGear = (p.engine.redline * Math.PI / 30) / topRatio * TYRE_BASE.r;
// The solver's drag-only ceiling (no rolling resistance, no gearing).
const peakPower = p.engine.maxTorque * p.engine.peakRpm * Math.PI / 30 * p.efficiency;
const vPower = Math.cbrt(2 * peakPower / (RHO * p.aero.cdA));

console.log(`car ${p.id} ${p.name}: peakPower ${(peakPower / 1000).toFixed(1)} kW  gearing ceiling ${vGear.toFixed(1)} m/s (${(vGear * 3.6).toFixed(0)} kph)  solver vPower ${vPower.toFixed(1)} m/s (${(vPower * 3.6).toFixed(0)} kph)`);

for (const s of SURFACES) {
  const w = new FlatWorld(s.id);
  const car = new Vehicle(p.id, w, { assists: { abs: false, tc: false, counterSteer: false, autoShift: true } });
  car.placeAt(0, 0, 0);
  let vtop = 0, gear = 0;
  for (let i = 0; i < Math.round(180 / DT); i++) {
    car.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
    car.step(DT);
    if (car.body.groundSpeed > vtop) { vtop = car.body.groundSpeed; gear = car.gear; }
  }
  console.log(`${s.key.padEnd(8)} terminal ${vtop.toFixed(2)} m/s  ${(vtop * 3.6).toFixed(1)} kph  gear ${gear}  crr ${s.crr}  mu ${s.mu}`);
}
