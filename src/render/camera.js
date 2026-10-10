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

function damp(current, target, rate, dt) {
  return target + (current - target) * Math.exp(-rate * dt);
}

export class ChaseCamera {
  constructor(renderer) {
    this.camera = renderer.camera;
    this.pos = new THREE.Vector3(0, 3, -8);
    this.look = new THREE.Vector3();
    this.shake = 0;
    this.orbitAngle = 0;
    this.baseFov = this.camera.fov || 62;
    this._init = false;
  }

  /** Impacts feed this; cameraShake scales it (docs/04). */
  addShake(amount) { this.shake = Math.min(1.2, this.shake + amount); }

  update(car, dt, mode = settings.cameraMode) {
    const b = car.body;
    const speed = b.groundSpeed;
    _fwd.set(b.forward.x, 0, b.forward.z);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(1, 0, 0);
    _fwd.normalize();

    _target.set(b.pos.x, b.pos.y + 0.55, b.pos.z);

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
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(_look);
      this.camera.fov = this.baseFov + Math.min(22, speed * 0.35);
      this.camera.updateProjectionMatrix();
      return;
    }

    // CHASE / BUMPER: the pivot trails further out and rises with speed, which
    // is what makes a slide readable.
    const bumper = mode === 'BUMPER';
    // Pre-start framing: at rest the pivot sat 6.2 m back / 2.05 m up, which filled the
    // lower frame with the rear panel and left the car as a dark lump with no roof line
    // and no lamp bar. Below ~6 m/s the rig eases back and up; by 6 m/s it is identical
    // to the driving rig again, so the in-stage feel is untouched.
    const crawl = Math.max(0, 1 - speed / 6);
    const back = bumper ? 1.1 : 6.2 + Math.min(4.5, speed * 0.20) + crawl * 1.9;
    const high = bumper ? 0.75 : 2.05 + Math.min(1.4, speed * 0.045) + crawl * 0.85;

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

    _want.set(_target.x - dirX * back, _target.y + high, _target.z - dirZ * back);

    // Keep the camera off the ground: the terrain is a heightfield, so sample it.
    if (car.world && car.world.groundHeight) {
      const g = car.world.groundHeight(_want.x, _want.z);
      if (_want.y < g + 0.9) _want.y = g + 0.9;
    }

    this._apply(_want, _target, bumper ? 26 : 7.5, dt, this.baseFov + Math.min(20, speed * 0.32));

    if (this.shake > 0.001) {
      const k = this.shake * settings.cameraShake;
      const t = performance.now() * 0.001;
      this.camera.position.x += Math.sin(t * 41.3) * 0.09 * k;
      this.camera.position.y += Math.sin(t * 57.7) * 0.12 * k;
      this.camera.position.z += Math.sin(t * 33.1) * 0.09 * k;
      this.shake = Math.max(0, this.shake - dt * 2.6);
    }
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
