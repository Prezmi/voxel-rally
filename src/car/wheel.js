// Per-wheel state (docs/02 §2-§3). Order is normative: front L, front R, rear L, rear R.
import { v3 } from '../core/math3.js';
import { TYRE_BASE } from './car-params.js';

export const WHEEL_ORDER = ['FL', 'FR', 'RL', 'RR'];

export class Wheel {
  constructor(index, params) {
    const axle = index < 2 ? 0 : 1;
    const side = (index % 2 === 0) ? -1 : 1;      // -1 left, +1 right (local +Z = right)
    this.i = index;
    this.id = WHEEL_ORDER[index];
    this.axle = axle;
    this.side = side;
    this.mountLocal = v3(
      axle === 0 ? params.wheelbase / 2 : -params.wheelbase / 2,
      params.mountY,
      side * (axle === 0 ? params.trackFront : params.trackRear) / 2,
    );

    // Integrated state.
    this.y = 0;          // world height of the wheel centre
    this.vy = 0;         // its vertical velocity
    this.omega = 0;      // rad/s

    // Per-step cache (no allocation in the hot loop).
    this.hub = v3();     // suspension mount point in world
    this.hubVy = 0;
    this.contact = v3(); // contact patch in world
    this.groundY = 0;
    this.surfaceId = 0;
    this.lastGroundY = 0;
    this.compression = 0;
    this.contactOn = false;
    this.edgeStep = 0;   // metres of vertical step at the contact column

    this.susp = 0;       // suspension extension (m, - = bump)
    this.suspRaw = 0;
    this.suspVel = 0;
    this.N = 0;
    this.NPrev = 0;
    this.rEff = TYRE_BASE.r;
    this.rGeo = TYRE_BASE.r;   // constant geometric radius (rEff varies with load)

    this.steer = 0;
    this.forward = v3(1, 0, 0);
    this.right = v3(0, 0, 1);
    this.vx = 0;         // velocity of the contact point along the wheel heading
    this.vyLat = 0;      // ...and to the wheel's right
    this.kappa = 0;
    this.alpha = 0;
    this.kappaDenom = 0.5;   // the max() guard of docs/02 §3.2, needed by the implicit spin step
    this.slipSlope = 0;      // local dF/dkappa / Fpeak at this step's operating point
    this.muEff = 0.8;

    this.Flon = 0;
    this.Flat = 0;
    this.Froll = 0;
    this.Fplough = 0;
    this.Fvert = 0;      // vertical tyre force from the ground
    this.slipEnergy = 0; // W, feeds dirt + audio + decals
    this.slip = 0;
    this.slipTime = 0;   // s of sustained slip (snow ridge build)
    this._probeDue = false;

    this.brakeTorque = 0;
    this.driveTorque = 0;
    this.airborneFrames = 0;
    this.damage = { brakeScale: 1, springScale: 1, dampScale: 1 };
  }

  reset(pos, yaw) {
    this.y = pos.y - 0.335;
    this.vy = 0;
    this.omega = 0;
    this.N = 0; this.NPrev = 0;
    this.susp = 0; this.suspVel = 0;
    this.kappa = 0; this.alpha = 0;
    this.Flon = this.Flat = this.Froll = this.Fplough = 0;
    this.slipEnergy = 0; this.slip = 0; this.slipTime = 0;
    this.airborneFrames = 0;
  }
}
