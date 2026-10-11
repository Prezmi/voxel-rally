// Vehicle assembler: the normative physics step of docs/02 §9.
// Order is part of the model and must not change.
import { v3, q4, quatFromYaw, quatMul, normalizeQ, mul3v, crossInto, clamp } from '../core/math3.js';
import { Body, GRAVITY } from './body.js';
import { Wheel } from './wheel.js';
import { makeCar, suspensionConstants, restLengthOf, COMPOUNDS, TYRE_BASE, G } from './car-params.js';
import { suspensionForce, suspensionPrep, unsprungStep, travelConstraint, TYRE_K } from './suspension.js';
import { tyreForces, brakeAndDrive } from './tyre.js';
import { raycastContact, edgeImpulse } from './raycast-terrain.js';
import { computeSteer } from './steering.js';
import { applyDrive, applyBrakes } from './diff.js';
import { Powertrain } from './powertrain.js';
import { DamageState } from './damage.js';
import { surface } from '../world/surfaces.js';
import {
  createRollover, resetRollover, rolloverStep, gateInput, isDrivable, isRolled,
  startRighting, spinDownWheels, RIGHT_DURATION_S,
} from './rollover.js';

const HULL = [
  [1, -1, 1], [1, -1, -1], [-1, -1, 1], [-1, -1, -1],
  [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
];
const K_HULL = 260000, C_HULL = 5200;

export class Vehicle {
  constructor(carId, world, opts = {}) {
    this.params = makeCar(carId, opts.setup || {});
    this.world = world;
    this.body = new Body(this.params);
    this.wheels = [0, 1, 2, 3].map((i) => new Wheel(i, this.params));
    this.susp = suspensionConstants(this.params);
    this.restLength = restLengthOf(this.params);
    this.powertrain = new Powertrain(this);
    this.damage = new DamageState();
    this.compound = COMPOUNDS[this.params.setup.compound] || COMPOUNDS.MED;
    this.assists = opts.assists || { abs: false, tc: false, counterSteer: false, autoShift: true };
    this.setup = this.params.setup;

    this.weightN = this.params.mass * GRAVITY;
    this.wetness = 0;
    this.frozen = 0;
    this.tyreTemp = 0;
    this.grainPhase = 0;
    this.rpm = this.params.engine.idle;
    this.redlineOmega = 400;
    this.steerAngle = 0;
    this.groundSpeed = 0;
    this.speed = 0;

    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
    this.vContact = v3();
    this._vHub = v3();
    this._tmp = v3();
    this._tmp2 = v3();
    this._local = v3();
    this._hubLocal = v3();
    this.hullLocal = HULL.map(([sx, sy, sz]) =>
      v3(sx * this.params.hull.x,
         this.params.hull.cy + sy * this.params.hull.y,
         sz * this.params.hull.z));
    // Scenery collision probes (src/world/prop-colliders.js): the hull footprint at
    // axle height, corners first so a trunk cannot slip between two probes.
    { const hx = this.params.hull.x, hz = this.params.hull.z;
      this.propPoints = [v3(hx, 0, hz), v3(hx, 0, -hz), v3(-hx, 0, hz), v3(-hx, 0, -hz),
        v3(hx, 0, 0), v3(-hx, 0, 0), v3(0, 0, hz), v3(0, 0, -hz)]; }
    this.propColliders = null;      // set by the stage once the prop list is loaded
    this.propHitCd = 0;             // damage cooldown, so one tree is one hit
    this.events = [];               // impacts for audio / FX / damage
    // docs/02 §9 gives the wheel a finer step than the body. The tyre contact
    // spring (200 kN/m) against an 18 kg unsprung mass is a ~20 Hz mode and the
    // staggered body<->wheel coupling needs h <= 1/400 s to stay quiet.
    this.substeps = opts.substeps || 4;
    this.slipTotal = 0;
    this.airborneWheels = 0;
    this.lastImpact = 0;
    // Rollover state (src/car/rollover.js): classification, timers, righting routine.
    // The gated copy of the input lives here so nothing allocates in the fixed step.
    this.rollover = createRollover();
    this._gateIn = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
  }

  placeAt(x, z, yaw, groundY) {
    const p = this.params;
    const b = this.body;
    b.pos.x = x; b.pos.z = z;
    quatFromYaw(yaw, b.quat);
    b.refreshFrame();

    // Sit the car on its own wheels, in static equilibrium, and tilted to the road.
    // A level body cannot satisfy a road that grades and banks across its own
    // wheelbase - the start line here falls 0.15 m across the track - and starting
    // level pins two wheels against a travel limit before the first substep, which
    // is what throws the car off the road. Each corner carries a quarter of the
    // weight, each axle sags by its own spring rate, and the tyre is pre-loaded by
    // the unsprung mass: starting at the rest length with an unloaded tyre instead
    // yanks the wheels down at ~180 m/s^2 and the hop/pitch modes ring the car into
    // the air.
    const Lmin = this.restLength - p.bumpStop;
    const Lmax = this.restLength + p.droopStop;
    const nCorner = this.weightN / 4;
    const tyreComp = (nCorner + p.unsprung * GRAVITY) / TYRE_K;
    const sagOf = (axle) => clamp(nCorner / (axle === 0 ? this.susp.kFront : this.susp.kRear), 0, p.bumpStop);

    const seat = [];
    const base = this._seatQ || (this._seatQ = q4());
    const tilt = this._seatTilt || (this._seatTilt = q4());
    let avgG = 0;
    for (let pass = 0; pass < 3; pass++) {
      let sumH = 0;
      seat.length = 0;
      avgG = 0;
      for (const w of this.wheels) {
        mul3v(b.m, w.mountLocal, w.hub);
        w.hub.x += x; w.hub.z += z;
        const g = this.world.groundHeight(w.hub.x, w.hub.z);
        avgG += g;
        // World height this hub must have for that corner to sit at its static
        // length on a pre-loaded tyre.
        const wantH = g + TYRE_BASE.r - tyreComp + (this.restLength - sagOf(w.axle));
        seat.push(wantH, w.mountLocal.x, w.mountLocal.z);
        sumH += wantH;
      }
      // hub_world_y = posY + mountY + pitch*mountLocal.x - roll*mountLocal.z:
      // pitch is a rotation about body +Z (+ = nose up) and so RAISES the front
      // mount; roll is a rotation about body +X and drops the right side. Getting
      // either sign backwards pitches the car into the road instead of onto it.
      const hbar = sumH / 4;
      let numP = 0, denP = 0, numR = 0, denR = 0;
      for (let i = 0; i < 12; i += 3) {
        const dh = seat[i] - hbar, lx = seat[i + 1], lz = seat[i + 2];
        numP += lx * dh; denP += lx * lx;
        numR += lz * dh; denR += lz * lz;
      }
      const pitch = clamp(denP > 1e-9 ? numP / denP : 0, -0.18, 0.18);
      const roll = clamp(denR > 1e-9 ? -numR / denR : 0, -0.18, 0.18);
      quatFromYaw(yaw, base);
      tilt.x = roll * 0.5; tilt.y = 0; tilt.z = pitch * 0.5; tilt.w = 1;
      normalizeQ(tilt);
      quatMul(base, tilt, b.quat);
      b.refreshFrame();
      this._seatY = hbar - p.mountY;
    }
    avgG /= 4;
    // The caller may name the surface it wants the car sitting on (the road bed);
    // keep the equilibrium shape, shift it onto that surface.
    const equilibriumY = this._seatY + (groundY !== undefined ? (groundY - avgG) : 0);
    const groundHeights = [];
    let lo = -Infinity, hi = Infinity;
    for (const w of this.wheels) {
      mul3v(b.m, w.mountLocal, w.hub);
      w.hub.x += x; w.hub.z += z;
      const g = this.world.groundHeight(w.hub.x, w.hub.z);
      groundHeights.push(g);
      lo = Math.max(lo, g + TYRE_BASE.r + Lmin - w.hub.y);
      hi = Math.min(hi, g + TYRE_BASE.r + Lmax - w.hub.y);
    }

    // When the ground under the four mounts differs by more than the travel, no
    // height satisfies every wheel. Take the middle of the feasible band rather
    // than an extreme, then make sure the hull floor clears the highest column:
    // starting with the hull buried makes the contact penalty launch the car.
    const feasible = lo <= hi;
    let y = feasible ? clamp(equilibriumY, lo, hi) : (lo + hi) * 0.5;
    const hullFloorOffset = p.hull.y - p.hull.cy;      // CoM -> hull underside
    const maxG = Math.max(...groundHeights);
    if (y < maxG + hullFloorOffset + 0.03) y = maxG + hullFloorOffset + 0.03;

    b.pos.y = y;
    b.vel.x = 0; b.vel.y = 0; b.vel.z = 0;
    b.angVel.x = 0; b.angVel.y = 0; b.angVel.z = 0;
    b.prevPos.x = x; b.prevPos.y = y; b.prevPos.z = z;
    // prevQuat is what the renderer interpolates against; setting it to identity
    // makes a car placed on a banked road visibly snap upright on the first frame.
    b.prevQuat.x = b.quat.x; b.prevQuat.y = b.quat.y;
    b.prevQuat.z = b.quat.z; b.prevQuat.w = b.quat.w;
    b.refreshFrame();
    for (const w of this.wheels) {
      mul3v(b.m, w.mountLocal, w.hub);
      w.hub.x += b.pos.x; w.hub.y += b.pos.y; w.hub.z += b.pos.z;
      w.vy = 0; w.omega = 0;
      w.groundY = this.world.groundHeight(w.hub.x, w.hub.z);
      // Rest each wheel on the ground at the length this body height implies,
      // clamped to travel: no fake compression, no wheel left hanging in droop.
      w.y = w.hub.y - clamp(w.hub.y - (w.groundY + TYRE_BASE.r - tyreComp), Lmin, Lmax);
      w.compression = tyreComp;
      w.lastGroundY = w.groundY;
      w.susp = 0; w.suspRaw = 0; w.suspVel = 0; w.N = 0; w.NPrev = 0;
      w.slipTime = 0;
    }
    this.powertrain.rpm = this.params.engine.idle;
    this.powertrain.gear = 0;   // a respawn/standing launch starts in FIRST
    this.powertrain.cut = 0;
    resetRollover(this.rollover);
  }

  /** Convenience: several modules read `car.mass`; the real store is the body. */
  get mass() { return this.body.mass; }

  _localSet(x, y, z) { const l = this._local; l.x = x; l.y = y; l.z = z; return l; }

  setInput(input) { this.input = input; }

  /** Hand the car the solid scenery grid (see src/world/prop-colliders.js). */
  setPropColliders(grid) { this.propColliders = grid || null; }

  /** True while the car is on its side, on its roof, or being righted. */
  rolled() { return isRolled(this); }

  /**
   * Right the car where it lies (RESET key / restart pad). The stage clock and the
   * damage already taken are untouched: the recovery costs time, not a free re-run.
   */
  rightNow(dur = RIGHT_DURATION_S) { startRighting(this, dur); }

  step(dt) {
    const b = this.body;
    b.snapshot();

    // 0) rollover state: angle, timers, and the righting routine, which owns the body
    // for the length of the slerp (no tyre / suspension work while it runs).
    rolloverStep(this, dt);
    if (this.rollover.right) return this.events;

    // 1) input already read by the caller, with drive / steering / handbrake cut while
    // the car is on its side or its roof; 2) engine and gears (docs/02 §9)
    const gin = gateInput(this, this.input, this._gateIn);
    const drivable = isDrivable(this);
    computeSteer(this, gin);
    const shaft = this.powertrain.step(dt, gin);
    applyBrakes(this, gin.brake, gin.handbrake);
    applyDrive(this, shaft, gin.handbrake);
    if (!drivable) for (const w of this.wheels) w.driveTorque = 0;
    this.damage.syncWheels(this.wheels);

    this.grainPhase += dt * 2 * Math.PI * 24;
    if (this.grainPhase > 1e6) this.grainPhase -= 1e6;

    // 3) wheel substeps (docs/02 §9: the wheel runs finer than the body)
    const h = dt / this.substeps;
    for (let sub = 0; sub < this.substeps; sub++) {
      b.refreshFrame();
      b.clearForces();

      // Pass A: geometry, contact, suspension kinematics (so the anti-roll bar
      // sees this step's travel on both ends of the axle, not last step's).
      for (const w of this.wheels) {
        mul3v(b.m, w.mountLocal, w.hub);
        w.hub.x += b.pos.x; w.hub.y += b.pos.y; w.hub.z += b.pos.z;
        // angVel is in WORLD frame, so the lever arm must be world too.
        crossInto(b.angVel, this._localSet(w.hub.x - b.pos.x, w.hub.y - b.pos.y, w.hub.z - b.pos.z), this._tmp);
        w.hubVy = b.vel.y + this._tmp.y;
        raycastContact(w, this.world);
      }
      suspensionPrep(this);

      // Pass B: forces.
      for (const w of this.wheels) {
        suspensionForce(w, this, h);

        // Wheel axes in world (body frame rotated by steer about body Y).
        const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
        // local forward = (cs, 0, -sn), local right = (sn, 0, cs)
        const lf = this._tmp2;
        lf.x = cs; lf.y = 0; lf.z = -sn;
        mul3v(b.m, lf, w.forward);
        lf.x = sn; lf.y = 0; lf.z = cs;
        mul3v(b.m, lf, w.right);

        // Contact point velocity: v + omega x (contact - CoM), all in world frame.
        // The mount offset is what makes yaw produce lateral velocity at the
        // axle: without it the front and rear slip angles move together and the
        // car has no yaw damping, so any corner diverges into a spin.
        this._local.x = w.hub.x - b.pos.x;
        this._local.y = (w.y - w.rGeo) - b.pos.y;
        this._local.z = w.hub.z - b.pos.z;
        crossInto(b.angVel, this._local, this._vHub);
        this.vContact.x = b.vel.x + this._vHub.x;
        this.vContact.y = b.vel.y + this._vHub.y;
        this.vContact.z = b.vel.z + this._vHub.z;

        tyreForces(w, this, h);
        brakeAndDrive(w, this, h);
        accumulateOnBody(this, w);
        unsprungStep(w, this, h);
        travelConstraint(w, this);
      }

      hullContact(this, h);
      propContact(this, h);
      b.applyGravityAero();
      b.integrate(h);
      applyDeformationAndDamage(this, h);
    }

    // 4) once per step: tyre temperature, aggregates, event drain
    let slip = 0, air = 0;
    for (const w of this.wheels) { slip += w.slipEnergy; if (w.Fvert <= 0) air++; }
    this.slipTotal = slip;
    this.airborneWheels = air;
    this.tyreTemp = clamp(this.tyreTemp + (slip / 60000 - this.tyreTemp * 0.06) * dt, 0, 1);
    if (!drivable) spinDownWheels(this, dt);
    this.groundSpeed = b.groundSpeed;
    this.speed = b.speed;
    if (!Number.isFinite(b.pos.y) || !Number.isFinite(b.vel.y)) this.recover();
    return this.events;
  }

  recover() {
    this.body.recover();
    for (const w of this.wheels) {
      w.y = this.body.pos.y - this.restLength;
      w.vy = 0; w.omega = 0; w.N = 0; w.NPrev = 0;
      w.susp = 0; w.suspRaw = 0; w.suspVel = 0;
    }
    this.powertrain.rpm = this.params.engine.idle;
  }
}

function accumulateOnBody(car, w) {
  const b = car.body;
  const fx = (w.Flon + w.Froll) * w.forward.x + w.Flat * w.right.x;
  const fy = (w.Flon + w.Froll) * w.forward.y + w.Flat * w.right.y;
  const fz = (w.Flon + w.Froll) * w.forward.z + w.Flat * w.right.z;

  b.force.x += fx; b.force.y += fy + w.N; b.force.z += fz;

  // Tyre forces enter the body through the suspension, not at the patch. The
  // effective application height above the ground is the suspension's roll/pitch
  // centre: with a vertical arm the roll centre sits low, so the roll arm about
  // the CoM is (comY - forceCentre), not the whole CoM height. Using the full
  // height over-rolls the car, unloads the inside rear, and the rear axle then
  // saturates -> no yaw damping -> the car spins.
  const ax = w.contact.x - b.pos.x;
  const ay = (w.groundY + car.params.forceCentre) - b.pos.y;
  const az = w.contact.z - b.pos.z;
  b.torque.x += ay * fz - az * fy;
  b.torque.y += az * fx - ax * fz;
  b.torque.z += ax * fy - ay * fx;

  const mx = w.hub.x - b.pos.x, my = w.hub.y - b.pos.y, mz = w.hub.z - b.pos.z;
  b.torque.x += -mz * w.N;
  b.torque.z += mx * w.N;
}

// ---- scenery collision (src/world/prop-colliders.js) -----------------------
// Trees, rocks, tents, gantry legs and fence lines are solid. The probe radius is
// half the track plus a finger of mudguard, so the car stops on the body rather than
// on a wheel that slipped past the trunk.
const PROP_PROBE_R = 0.55, PROP_RESTITUTION = 0.3, PROP_SCRUB = 0.55, PROP_PUSH_MAX = 1.5;

function propContact(car, h) {
  const grid = car.propColliders;
  if (!grid || !grid.count) return;
  const b = car.body;
  const probes = car.propPoints;
  const out = car._propHit || (car._propHit = { nx: 0, nz: 0, depth: 0, shape: null });
  let depth = 0, nx = 0, nz = 0, rx = 0, rz = 0, hx = 0, hz = 0, species = -1;
  for (let k = 0; k < probes.length; k++) {
    mul3v(b.m, probes[k], car._tmp);
    const px = b.pos.x + car._tmp.x, pz = b.pos.z + car._tmp.z;
    if (grid.hit(px, pz, PROP_PROBE_R, out) <= 0) continue;
    if (out.depth <= depth) continue;
    depth = out.depth; nx = out.nx; nz = out.nz;
    rx = car._tmp.x; rz = car._tmp.z; hx = px; hz = pz; species = out.shape.prop;
  }
  if (depth <= 0) return;

  // 1) push out along the shape's shortest axis. A car that ends up INSIDE a shape
  // (a spawn, a restart, a step that tunnelled a thin post) comes back out the way it
  // went in: it is never trapped.
  const push = Math.min(depth + 1e-3, PROP_PUSH_MAX);
  b.pos.x += nx * push; b.pos.z += nz * push;

  // 2) velocity at the contact point: kill the inward part with restitution ~0.3 and
  // scrub the tangential slide (the car sideslips along the trunk, it does not slide
  // freely past it).
  car._local.x = rx; car._local.y = 0; car._local.z = rz;
  crossInto(b.angVel, car._local, car._vHub);
  const vx = b.vel.x + car._vHub.x, vz = b.vel.z + car._vHub.z;
  const vn = vx * nx + vz * nz;
  if (vn < 0) { const j = -(1 + PROP_RESTITUTION) * vn; b.vel.x += nx * j; b.vel.z += nz * j; }
  const tx = -nz, tz = nx;
  const vt = vx * tx + vz * tz;
  b.vel.x += tx * -vt * PROP_SCRUB; b.vel.z += tz * -vt * PROP_SCRUB;
  b.angVel.x *= 0.7; b.angVel.y *= 0.7; b.angVel.z *= 0.7;

  // 3) the wheels lose their drive speed with the car: a tree does not let the
  // drivetrain keep winding the engine up.
  for (const w of car.wheels) w.omega *= 0.6;

  // 4) damage + feedback, once per hit (cooldown), scaled by closing speed.
  const speed = Math.hypot(vx, vz);
  car.propHitCd -= h;
  if (car.propHitCd > 0 || speed < 1.5) return;
  car.propHitCd = 0.3;
  const impulse = Math.min(240000, car.mass * speed * 1.6);
  // Local +X is forward (the body frame is yawed a quarter turn, cf. fx.js rear =
  // -m[0]), so the front axle is the rx > 0 half.
  const wi = (rx > 0 ? 0 : 2) + (rz > 0 ? 1 : 0);    // nearest corner of the car
  if (rx > 0) car.damage.registerFrontHit(impulse);
  car.damage.registerWheelImpact(wi, impulse);
  car.damage.registerSteerHit(impulse);
  car.damage.syncWheels(car.wheels);
  car.events.push({ type: 'propHit', species, impulse, speed, x: hx, y: b.pos.y, z: hz, nx, nz });
}

function hullContact(car, h) {
  const b = car.body;
  const locals = car.hullLocal;
  for (let k = 0; k < locals.length; k++) {
    const lp = locals[k];
    mul3v(b.m, lp, car._tmp);
    const rx = car._tmp.x, ry = car._tmp.y, rz = car._tmp.z;   // world offset from the CoM
    const px = b.pos.x + rx, py = b.pos.y + ry, pz = b.pos.z + rz;
    const g = car.world.groundHeight(px, pz);
    const pen = g - py;
    if (pen <= 0) continue;
    // Velocity at that point (car._tmp is already the world-frame offset).
    crossInto(b.angVel, car._tmp, car._tmp2);
    const vx = b.vel.x + car._tmp2.x, vy = b.vel.y + car._tmp2.y, vz = b.vel.z + car._tmp2.z;

    let fn = K_HULL * Math.min(pen, 0.5) - C_HULL * Math.min(20, Math.max(-20, vy));
    if (fn < 0) fn = 0;
    if (fn > 8 * car.mass * GRAVITY) fn = 8 * car.mass * GRAVITY;

    // Scraping friction against the ground.
    const sp = Math.hypot(vx, vz);
    let fx = 0, fz = 0;
    if (sp > 0.05) {
      const mu = 0.55;
      const f = -mu * fn;
      fx = f * (vx / sp);
      fz = f * (vz / sp);
    }

    // The whole wrench, not just the force. A hull corner is 2 m from the CoM:
    // pushing it up without the matching moment lifts the entire car off its
    // wheels instead of rotating the buried corner out of the ground, which is
    // what used to launch the car a metre and a half into the air.
    b.force.x += fx; b.force.y += fn; b.force.z += fz;
    b.torque.x += ry * fz - rz * fn;
    b.torque.y += rz * fx - rx * fz;
    b.torque.z += rx * fn - ry * fx;

    if (vy < -4) {
      const impulse = Math.min(200000, car.mass * Math.abs(vy) * 0.6);
      car.events.push({ type: 'impact', impulse, x: px, y: py, z: pz, normal: vy });
      if (vy < -6) car.damage.registerFrontHit(impulse);
    }
  }
}

function applyDeformationAndDamage(car, h) {
  for (let i = 0; i < car.wheels.length; i++) {
    const w = car.wheels[i];
    const surf = surface(w.surfaceId);

    // Rut carving is disabled: a loaded wheel must never push the ground down. The
    // soft-surface feel stays (tyre.js reads world.rutAt(), which now reports 0, and
    // the `sink` term of the tyre); only the heightfield displacement is gone.

    // Block break-off (docs/02 §7): loose surface + a hard vertical hit.
    if (surf.loose && w.vy < -6 && car.world.breakLooseBlock) {
      const bx = Math.floor(w.contact.x), bz = Math.floor(w.contact.z);
      const by = Math.floor(w.groundY) - 1;
      car.world.breakLooseBlock(bx, by, bz);
    }

    // Edge / kerb kick.
    const kick = edgeImpulse(w);
    if (kick > 0) {
      const impulse = Math.min(60000, w.N * kick * 0.5 + car.params.unsprung * Math.abs(w.vy) * kick);
      if (impulse > 3000) {
        car.events.push({ type: 'edge', impulse, wheel: i, x: w.contact.x, y: w.groundY, z: w.contact.z });
        car.damage.registerWheelImpact(i, impulse);
      }
    }

    // Hard suspension compression = a hit on that corner.
    if (w.susp <= -car.params.bumpStop * 0.98 && w.N > 9000) {
      car.damage.registerWheelImpact(i, w.N * 1.4);
      car.lastImpact = w.N;
    }
  }
}
