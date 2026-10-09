// LENS DIRT (docs/04 §6 "brud na obiektywie"): what the camera sees through a
// dirty windscreen and a sprayed lens. Deliberately NOT the same state as the
// panel dirt: the lens integrates *spray that reaches the camera* plus the
// windscreen panel, and it is wiped by airflow and by the wiper.
//
// Pure state + numbers so it is testable in Node; the overlay quad and its shader
// live in render/dirt-lens.js.
import { clamp } from '../core/math3.js';

export const LENS_BLOBS = 10;

// Readability rule (PLAN.md §8 #5: the camera must not "swim", and the player has
// to read the road through it). docs/04 §6 asks for dirt on the lens, but the lens
// is the one dirt surface the player cannot look away from, so its states are
// capped: a *cap*, not a growth curve. Grime that only the wiper could remove used
// to ratchet to 1.0 within half a stage and the view stayed filthy for the rest of
// it, which is exactly what the lens is not allowed to do.
export const LENS_CAP = { smudge: 0.50, grime: 0.30, blob: 0.30 };
const AUTO_WIPER_AT = 0.22;      // severity that triggers the automatic wiper
const AUTO_WIPER_COOLDOWN = 3.5; // s, so it does not flutter

export class LensDirt {
  constructor() {
    // smudge = overall haze 0..1, grime = dried splatter 0..1, wet = water film.
    this.smudge = 0;
    this.grime = 0;
    this.wet = 0;
    // Blob field: x, y (screen 0..1), size, strength. Static, written in place.
    this.blobs = new Float32Array(LENS_BLOBS * 4);
    this.blobCount = 0;
    this.wiper = 0;          // seconds of wiper stroke left
    this.wiperPhase = 0;     // 0..1 sweep position, drives the shader
    this.autoWiper = true;   // the view is never allowed to stay dirty
    this.amount = 1;         // settings.lensDirt: 0 = lens dirt off entirely
    this._wipeCooldown = 0;
    this._lcg = 0x9e3779b9 >>> 0;
    this._blobClock = 0;
  }

  /** 0..1 readability scale, from settings.lensDirt. 0 clears and stays clean. */
  setAmount(a) {
    const v = clamp(a, 0, 1);
    if (v === 0 && this.amount !== 0) this.clear();
    this.amount = v;
  }

  _rand() {
    // Own deterministic stream (docs/06 §1 "determinizm"), never Math.random.
    this._lcg = (this._lcg * 1664525 + 1013904223) >>> 0;
    return this._lcg / 4294967296;
  }

  /** `spray` is the emission rate the emitters reported for this frame. */
  update(dt, spray, speed, rain, windscreen) {
    if (this.amount <= 0) { if (this.smudge || this.grime || this.blobCount) this.clear(); return; }
    // Spray lands on the lens: proportional to how much material the tyres throw
    // and to how close it is being kicked toward the camera behind the car.
    const land = spray * dt * 0.16 * this.amount;
    this.smudge = Math.min(LENS_CAP.smudge * this.amount, this.smudge + land);
    this.grime = Math.min(LENS_CAP.grime * this.amount, this.grime + land * 0.45);
    if (rain > 0) this.wet = Math.min(1, this.wet + rain * dt * 1.2);

    // New splatter blobs, at a capped rate so the overlay never gets busy.
    this._blobClock += dt;
    if (spray > 0.4 && this._blobClock > 0.6 && this.blobCount < LENS_BLOBS) {
      this._blobClock = 0;
      const i = this.blobCount * 4;
      this.blobs[i] = 0.15 + this._rand() * 0.7;
      this.blobs[i + 1] = 0.12 + this._rand() * 0.72;
      this.blobs[i + 2] = 0.035 + this._rand() * 0.085;
      this.blobs[i + 3] = 0;
      this.blobCount++;
    }
    for (let i = 0; i < this.blobCount; i++) {
      const k = i * 4 + 3;
      this.blobs[k] = Math.min(LENS_CAP.blob * this.amount, this.blobs[k] + land * 2.2);
    }

    // Cleaning: airflow past the camera, the wiper, and evaporation.
    const airflow = 0.06 + speed * 0.010;
    this.smudge = Math.max(0, this.smudge - dt * airflow * (0.55 + 0.45 * (1 - this.grime)));
    // Dried grime also flakes off on its own. Without this term the only way to
    // clear the lens was the wiper, so severity ratcheted up and stayed there.
    this.grime = Math.max(0, this.grime - dt * (0.020 + speed * 0.0045));
    this.wet = Math.max(0, this.wet - dt * (0.18 + speed * 0.05 + (windscreen > 0.5 ? 0.2 : 0)));

    // Automatic wiper: the view is a control surface, not a texture.
    this._wipeCooldown = Math.max(0, this._wipeCooldown - dt);
    if (this.autoWiper && this.wiper <= 0 && this._wipeCooldown <= 0 && this.severity() > AUTO_WIPER_AT) {
      this.wiper = 0.55;
      this._wipeCooldown = AUTO_WIPER_COOLDOWN;
    }

    // Dried grime only the wiper can move fast.
    if (this.wiper > 0) {
      this.wiper -= dt;
      this.wiperPhase = 1 - Math.max(0, this.wiper) / 0.55;
      const cut = dt * 2.6;
      this.grime = Math.max(0, this.grime - cut);
      this.smudge = Math.max(0, this.smudge - cut * 1.4);
      for (let i = 0; i < this.blobCount; i++) {
        this.blobs[i * 4 + 3] = Math.max(0, this.blobs[i * 4 + 3] - cut * 1.6);
      }
      if (this.wiper <= 0) {
        this.wiper = 0;
        this.wiperPhase = 0;
        // Sweep the dead blobs out of the field instead of letting them pile up.
        let n = 0;
        for (let i = 0; i < this.blobCount; i++) {
          if (this.blobs[i * 4 + 3] > 0.02) {
            if (n !== i) {
              const a = i * 4, b = n * 4;
              this.blobs[b] = this.blobs[a]; this.blobs[b + 1] = this.blobs[a + 1];
              this.blobs[b + 2] = this.blobs[a + 2]; this.blobs[b + 3] = this.blobs[a + 3];
            }
            n++;
          }
        }
        this.blobCount = n;
      }
    } else {
      this.wiperPhase = 0;
    }
  }

  sweep() { this.wiper = Math.max(this.wiper, 0.55); }

  /** 0..1 how bad the view is — the HUD and the acceptance test read this. */
  severity() { return Math.min(1, (this.smudge * 0.7 + this.grime * 0.5) * this.amount); }

  clear() {
    this.smudge = 0; this.grime = 0; this.wet = 0; this.blobCount = 0;
    this.blobs.fill(0); this.wiper = 0; this.wiperPhase = 0;
  }
}
