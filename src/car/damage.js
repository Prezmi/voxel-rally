// Damage: impulses -> parameters -> visuals (docs/02 §8). Damage changes k and c,
// not just the mesh (pillar P7).
import { clamp } from '../core/math3.js';

export class DamageState {
  constructor() {
    this.susp = [1, 1, 1, 1];        // spring/damper multiplier per wheel
    this.brake = [1, 1, 1, 1];
    this.steerRatio = 1.0;
    this.steerSlack = 0;
    this.enginePowerScale = 1.0;
    this.frontHits = 0;
    this.lights = [1, 1];
    this.bodyDents = [];             // {x,y,z,depth} for the voxel body visual
    this.totalSeverity = 0;
  }

  /** docs/02 §8 thresholds. impulse in newtons. */
  registerWheelImpact(wheelIndex, impulse) {
    if (impulse < 4000) return 0;
    let sev = 0;
    if (impulse > 9000 && this.susp[wheelIndex] > 0.72) {
      this.susp[wheelIndex] = Math.max(0.72, this.susp[wheelIndex] * 0.86);
      sev += 0.3;
    }
    if (impulse > 14000 && this.brake[wheelIndex] > 0.35) {
      this.brake[wheelIndex] = Math.max(0.35, this.brake[wheelIndex] * 0.7);
      sev += 0.5;
    }
    this.totalSeverity += sev;
    return sev;
  }

  registerSteerHit(impulse) {
    if (impulse < 5000) return;
    this.steerSlack = Math.min(0.18, this.steerSlack + 0.05);
    this.steerRatio = 1 + this.steerSlack;
    this.totalSeverity += 0.2;
  }

  registerFrontHit(impulse) {
    if (impulse < 12000) return;
    this.frontHits++;
    if (this.frontHits >= 3 && this.enginePowerScale > 0.82) {
      this.enginePowerScale = 0.82;                 // -18 % (docs/02 §8)
    }
    this.lights[0] = 0;
    this.totalSeverity += 0.4;
  }

  /** Apply to the per-wheel damage caches the tyre/suspension code reads. */
  syncWheels(wheels) {
    for (let i = 0; i < wheels.length; i++) {
      wheels[i].damage.springScale = this.susp[i];
      wheels[i].damage.dampScale = this.susp[i];
      wheels[i].damage.brakeScale = this.brake[i];
    }
  }

  service(freeFraction = 0.7) {
    const f = clamp(freeFraction, 0, 1);
    for (let i = 0; i < 4; i++) {
      this.susp[i] = 1 - (1 - this.susp[i]) * (1 - f);
      this.brake[i] = 1 - (1 - this.brake[i]) * (1 - f);
    }
    this.steerSlack *= (1 - f);
    this.steerRatio = 1 + this.steerSlack;
    this.enginePowerScale = 1 - (1 - this.enginePowerScale) * (1 - f);
    this.frontHits = 0;
    this.lights = [1, 1];
  }

  get severityPct() { return clamp(this.totalSeverity / 4, 0, 1); }
}
