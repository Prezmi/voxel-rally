// Chase / onboard / bumper / orbit camera (docs/04 §2, camera-systems skill).
// Everything is frame-rate independent: smoothing uses 1 - exp(-k*dt), never a
// per-frame constant, so the feel is the same at 30 or 144 fps.
import * as THREE from 'three';
import { settings } from '../core/settings.js';

const _target = new THREE.Vector3();
const _want = new THREE.Vector3();
const _look = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _upLean = new THREE.Vector3(0, 1, 0);

function damp(current, target, rate, dt) {
  return target + (current - target) * Math.exp(-rate * dt);
}

/**
 * Analytic critically damped spring (camera-systems: a spring, never a per-frame
 * constant). Exact for any dt, so the feel is identical at 30 or 144 fps, and
 * critically damped means it reaches the target without overshooting -> no swing
 * back after a landing or a throttle step.
 */
function springStep(p, v, target, omega, dt) {
  const x0 = p - target;
  const b = v + omega * x0;
  const e = Math.exp(-omega * dt);
  const x = (x0 + b * dt) * e;
  p = target + x;
  v = (b - omega * x) * e;
  return [p, v];
}

// ---- rally speed feel (settings.speedFov / cornerLean / rideSag are 0..1 gains on
// these ceilings; every term is smoothed AND clamped, so the rig can never lurch).
const FOV_SPEED_GAIN = 0.32, FOV_SPEED_MAX = 20;   // deg, deg per m/s
const ONB_FOV_GAIN = 0.35, ONB_FOV_MAX = 22;      // deg, onboard rig
const LEAN_PER_G = 0.0115;   // rad of roll per m/s^2 of lateral acceleration
const LEAN_MAX = 0.105;      // rad (~6 deg) hard ceiling
const LEAN_LPF = 3.2;        // lateral-accel low-pass, 1/s
const LEAN_RATE = 2.4;       // how fast the roll itself settles, 1/s
const LAT_MAX = 14;          // m/s^2 ceiling on the measured lateral accel
const SAG_PER_MS = 0.0028;   // m of ride-height drop per m/s
const SAG_MAX = 0.26;        // m hard ceiling
const SAG_RATE = 2.6;        // settle rate, 1/s


function clamp01(v, fb) {
  return (typeof v === 'number' && Number.isFinite(v)) ? Math.min(1, Math.max(0, v)) : fb;
}

export class ChaseCamera {
  constructor(renderer) {
    this.camera = renderer.camera;
    this.pos = new THREE.Vector3(0, 3, -8);
    this.look = new THREE.Vector3();
    // The sprung follow point the rig is built from (see update(): CHASE).
    this.focus = new THREE.Vector3(0, 0, 0);
    this.focusVel = new THREE.Vector3();
    this.dirX = 1; this.dirZ = 0;
    this.shake = 0;
    this.orbitAngle = 0;
    this.baseFov = this.camera.fov || 62;
    this._init = false;
    this._springInit = false;
    // Speed feel state (all smoothed, all clamped below).
    this.post = (renderer && renderer.post) ? renderer.post : null;  // edge radial blur dial
    this._latV = 0;      // body-frame lateral velocity, last frame (m/s)
    this._latA = 0;      // low-passed lateral acceleration (m/s^2)
    this._lean = 0;      // current camera roll (rad)
    this._sag = 0;       // current ride-height drop (m)
  }

  /** Impacts feed this; cameraShake scales it (docs/04). Capped low on purpose. */
  addShake(amount) { this.shake = Math.min(0.45, this.shake + amount); }

  update(car, dt, mode = settings.cameraMode) {
    const b = car.body;
    const speed = b.groundSpeed;
    _fwd.set(b.forward.x, 0, b.forward.z);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(1, 0, 0);
    _fwd.normalize();

        _target.set(b.pos.x, b.pos.y + 0.55, b.pos.z);

    // ---- lateral acceleration, body frame: the derivative of the lateral velocity
    // (lateral axis = forward x up = (-fz, 0, fx)), low-passed and clamped. Feeds the
    // corner lean only; it never touches the follow spring or the shake budget.
    const latX = -_fwd.z, latZ = _fwd.x;
    const latV = b.vel.x * latX + b.vel.z * latZ;
    const aRaw = Math.max(-LAT_MAX, Math.min(LAT_MAX, (latV - this._latV) / Math.max(1e-4, dt)));
    this._latV = latV;
    this._latA = damp(this._latA, aRaw, LEAN_LPF, dt);
    this._lean = damp(this._lean,
      Math.max(-LEAN_MAX, Math.min(LEAN_MAX, this._latA * LEAN_PER_G))
      * clamp01(settings.cornerLean, 0.55), LEAN_RATE, dt);
    this._sag = damp(this._sag,
      Math.min(SAG_MAX, speed * SAG_PER_MS) * clamp01(settings.rideSag, 0.6), SAG_RATE, dt);

    // The post stack owns the edge radial blur; it only ever sees the speed and clamps
    // it itself, so a POST-off frame or a standstill gets zero smear.
    if (this.post && this.post.setSpeed) this.post.setSpeed(speed);

    if (mode === 'FREE') {
      this.orbitAngle += dt * 0.45;
      const r = 9 + speed * 0.15;
      _want.set(_target.x + Math.cos(this.orbitAngle) * r, _target.y + 3.4, _target.z + Math.sin(this.orbitAngle) * r);
      this._apply(_want, _target, 9, dt, 58);
      return;
    }

    if (mode === 'ONBOARD') {
      _want.set(
        b.pos.x + b.forward.x * 0.55 + 0 * 0.1,
        b.pos.y + 1.16,
        b.pos.z + b.forward.z * 0.55,
      );
      _look.set(
        b.pos.x + b.forward.x * 14,
        b.pos.y + 0.9,
        b.pos.z + b.forward.z * 14,
      );
      this.camera.position.copy(_want);
      this.camera.up.copy(_upLean.set(-_fwd.z * Math.sin(this._lean), Math.cos(this._lean), _fwd.x * Math.sin(this._lean)));
      this.camera.lookAt(_look);
      this.camera.fov = this.baseFov + Math.min(ONB_FOV_MAX, speed * ONB_FOV_GAIN) * clamp01(settings.speedFov, 1);
      this.camera.updateProjectionMatrix();
      return;
    }

    // CHASE / BUMPER
    const bumper = mode === 'BUMPER';
    // Pre-start framing: at rest the pivot sat 6.2 m back / 2.05 m up, which filled the
    // lower frame with the rear panel and left the car as a dark lump with no roof line
    // and no lamp bar. Below ~6 m/s the rig eases back and up; by 6 m/s it is identical
    // to the driving rig again, so the in-stage feel is untouched.
    const crawl = Math.max(0, 1 - speed / 6);
    const back = bumper ? 1.1 : 6.2 + Math.min(4.5, speed * 0.20) + crawl * 2.4;
    // Ride height: the rig sits a decimetre or two lower once the speed is up. Clamped
    // by SAG_MAX and smoothed, and it only lowers the boom, never the framed distance
    // logic below, so the terrain-clearing march still runs on the new height.
    const sag = bumper ? 0 : this._sag;
    const high = bumper ? 0.75 : 2.05 + Math.min(1.4, speed * 0.045) + crawl * 1.15 - sag;

    // Look-ahead along the *velocity*, not the nose: during a slide the camera
    // swings to face where the car is actually going.
    const vx = b.vel.x, vz = b.vel.z;
    const vlen = Math.hypot(vx, vz);
    let dirX = _fwd.x, dirZ = _fwd.z;
    if (vlen > 3.5) {
      const blend = Math.min(1, (vlen - 3.5) / 12);
      dirX = _fwd.x * (1 - blend) + (vx / vlen) * blend;
      dirZ = _fwd.z * (1 - blend) + (vz / vlen) * blend;
      const l = Math.hypot(dirX, dirZ) || 1;
      dirX /= l; dirZ /= l;
    }

    // Height of solid geometry (terrain AND block columns) under a point. Used to
    // keep the rig out of the world: a chase camera that simply damps towards a
    // point behind the car sinks into a hill on every uphill and into the fill of a
    // corner, which is what read as "not following".
    const world = car.world;
    const solidAt = (x, z) => {
      if (!world) return -Infinity;
      let y = -Infinity;
      if (world.groundHeight) y = world.groundHeight(x, z);
      if (world.columnTopAt) {
        const t = world.columnTopAt(Math.floor(x), Math.floor(z));
        if (Number.isFinite(t)) y = Math.max(y, t + 1);
      }
      return y;
    };

    if (!this._springInit) {
      this.focus.copy(_target); this.dirX = dirX; this.dirZ = dirZ; this._springInit = true;
    }

    // ---- follow: a critically damped spring on a FOCUS point, and the camera is
    // then placed at a FIXED offset from that focus. Damping the camera position
    // itself (the old code) changes the car->camera distance every time the offset
    // moves, so the car slid forward in frame on throttle and swung on landings.
    // Here the framed distance is a constant by construction: hypot(back, high).
    const omega = bumper ? 18 : 7.0;
    const omegaY = bumper ? 12 : 3.6;          // vertical is softer: jumps must not yank the rig
    [this.focus.x, this.focusVel.x] = springStep(this.focus.x, this.focusVel.x, _target.x, omega, dt);
    [this.focus.z, this.focusVel.z] = springStep(this.focus.z, this.focusVel.z, _target.z, omega, dt);
    [this.focus.y, this.focusVel.y] = springStep(this.focus.y, this.focusVel.y, _target.y, omegaY, dt);

    // Hard lag caps: a spring alone still trails 3-4 m under full throttle and
    // floats 2 m above the car after a jump. Clamp the error, keep the velocity.
    const lagMax = 1.1 + speed * 0.03;
    const lx = this.focus.x - _target.x, lz = this.focus.z - _target.z;
    const lag = Math.hypot(lx, lz);
    if (lag > lagMax) {
      const k = lagMax / lag;
      this.focus.x = _target.x + lx * k;
      this.focus.z = _target.z + lz * k;
    }
    const gCar = solidAt(_target.x, _target.z);
    const airY = Math.max(0, _target.y - (Number.isFinite(gCar) ? gCar : _target.y));
    const bandY = 0.9 + Math.min(1.4, airY * 0.30);   // a jump may lift the frame, gently
    if (this.focus.y > _target.y + bandY) { this.focus.y = _target.y + bandY; this.focusVel.y = Math.min(0, this.focusVel.y); }
    if (this.focus.y < _target.y - bandY) { this.focus.y = _target.y - bandY; this.focusVel.y = Math.max(0, this.focusVel.y); }

    // Pivot direction: damped separately so a corner rotates the rig instead of
    // snapping it, and the travel direction is kept when the car is sliding.
    this.dirX = damp(this.dirX, dirX, 3.4, dt);
    this.dirZ = damp(this.dirZ, dirZ, 3.4, dt);
    const dl = Math.hypot(this.dirX, this.dirZ) || 1;
    this.dirX /= dl; this.dirZ /= dl;

    _want.set(this.focus.x - this.dirX * back, this.focus.y + high, this.focus.z - this.dirZ * back);

    // ---- never inside terrain or a block: march the boom from the car outwards
    // and lift the rig to the tallest obstruction it would cross, then shorten the
    // boom back to the nominal framed distance so the framing does not breathe.
    if (world) {
      let need = -Infinity;
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        const x = _target.x + (_want.x - _target.x) * t;
        const z = _target.z + (_want.z - _target.z) * t;
        need = Math.max(need, solidAt(x, z) + 0.6);
      }
      if (!Number.isFinite(need)) need = -Infinity;
      // the rig also has to stay clear of the ground directly under it
      need = Math.max(need, solidAt(_want.x, _want.z) + 0.7);
      if (_want.y < need) _want.y = need;
      const nominal = Math.hypot(back, high);
      const dx = _want.x - _target.x, dy = _want.y - _target.y, dz = _want.z - _target.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > nominal * 1.02) {
        const k = nominal / d;
        _want.set(_target.x + dx * k, _target.y + dy * k, _target.z + dz * k);
      }
    }

    // No extra smoothing here: the focus point is already sprung, and a second
    // lag on the rig is what made the car drift to the bottom of the frame.
    this.pos.copy(_want);
    this.camera.position.copy(this.pos);
    // Lean INTO the corner: the up vector is rolled about the (flattened) forward axis
    // by the smoothed, clamped lateral-accel term, so the horizon banks as the car
    // turns in instead of the whole frame sliding.
    this.camera.up.copy(_upLean.set(-_fwd.z * Math.sin(this._lean), Math.cos(this._lean), _fwd.x * Math.sin(this._lean)));

    // Look slightly AHEAD of the car along its travel: the car sits a touch off
    // centre and the corner it is about to turn appears before it arrives.
    const ahead = bumper ? 5 : 3.0 + Math.min(10, speed * 0.22);
    _look.set(this.focus.x + this.dirX * ahead, this.focus.y + 0.45, this.focus.z + this.dirZ * ahead);
    this.look.copy(_look);
    this.camera.lookAt(_look);
    const fovWant = this.baseFov + Math.min(FOV_SPEED_MAX, speed * FOV_SPEED_GAIN) * clamp01(settings.speedFov, 1);
    const f = damp(this.camera.fov, fovWant, 3.0, dt);
    if (Math.abs(f - this.camera.fov) > 0.01) {
      this.camera.fov = f;
      this.camera.updateProjectionMatrix();
    }

    // Feel, not noise - and deliberately applied AFTER the follow, so shake can
    // never feed back into the framing. Sub-centimetre amplitudes: a small speed
    // wash plus a decaying landing bump, and main.js only forwards real landings.
    const speedFeel = Math.min(0.45, speed * 0.0055);   // 0.45 by ~80 m/s
    const k = (this.shake * 0.45 + speedFeel * 0.30) * settings.cameraShake;
    if (k > 0.002) {
      const t = performance.now() * 0.001;
      this.camera.position.x += Math.sin(t * 41.3) * 0.010 * k;
      this.camera.position.y += Math.sin(t * 57.7) * 0.014 * k;
      this.camera.position.z += Math.sin(t * 33.1) * 0.010 * k;
    }
    if (this.shake > 0.001) this.shake = Math.max(0, this.shake - dt * 3.4);
  }

  _apply(want, target, rate, dt, fov) {
    if (!this._init) { this.pos.copy(want); this.look.copy(target); this._init = true; }
    this.pos.x = damp(this.pos.x, want.x, rate, dt);
    this.pos.y = damp(this.pos.y, want.y, rate, dt);
    this.pos.z = damp(this.pos.z, want.z, rate, dt);
    // Yaw-only smoothing of the look point: vertical bobbing is distracting.
    this.look.x = damp(this.look.x, target.x, rate * 1.4, dt);
    this.look.y = damp(this.look.y, target.y, rate * 0.8, dt);
    this.look.z = damp(this.look.z, target.z, rate * 1.4, dt);

    this.camera.position.copy(this.pos);
    this.camera.up.copy(_up);
    this.camera.lookAt(_look.set(this.look.x, this.look.y, this.look.z));
    const f = damp(this.camera.fov, fov, 3.0, dt);
    if (Math.abs(f - this.camera.fov) > 0.01) {
      this.camera.fov = f;
      this.camera.updateProjectionMatrix();
    }
  }
}
