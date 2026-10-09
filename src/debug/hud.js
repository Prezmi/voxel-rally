// Debug HUD (docs/06 §5). DOM panels refreshed at ~12 Hz, never per frame: the
// overlay must not cost draw calls or force layout at 120 Hz.
import { surface } from '../world/surfaces.js';
import { settings } from '../core/settings.js';
import { DT } from '../core/time.js';

const RAD2DEG = 180 / Math.PI;

export class Hud {
  constructor() {
    this.tl = document.getElementById('hud-tl');
    this.tr = document.getElementById('hud-tr');
    this.bl = document.getElementById('hud-bl');
    this.br = document.getElementById('hud-br');
    this._acc = 0;
    this._last = ['', '', '', ''];
    this.enabled = true;
  }

  toggle() {
    this.enabled = !this.enabled;
    const v = this.enabled ? '' : 'none';
    for (const el of [this.tl, this.tr, this.bl, this.br]) if (el) el.style.display = v;
    return this.enabled;
  }

  tick(dt, ctx) {
    this._acc += dt;
    if (this._acc < 1 / 12) return;
    this._acc = 0;
    if (!this.enabled) return;

    const { car, loop, stream, stage, input, arc } = ctx;
    const dirt = ctx.dirt || null;
    const b = car.body;
    const kmh = b.groundSpeed * 3.6;

    const gear = car.powertrain.gear;
    const rpm = car.powertrain.rpm;
    const redline = car.params.engine.redline;
    const bar = (n, v) => '▰'.repeat(Math.round(v * n)) + '▱'.repeat(n - Math.round(v * n));

    this._set(0, [
      `${car.params.name}`,
      `${kmh.toFixed(0).padStart(4)} km/h   ${gear === 0 ? 'N' : gear}`,
      `${bar(22, Math.min(1, rpm / redline))} ${rpm.toFixed(0)} rpm`,
      `throttle ${input.state.throttle.toFixed(2)}  brake ${input.state.brake.toFixed(2)}  hb ${input.state.handbrake.toFixed(2)}`,
      `steer ${(input.state.steer * 100).toFixed(0)}%  -> ${(car.wheels[0].steer * RAD2DEG).toFixed(1)}°`,
    ].join('\n'));

    const surf = surface(car.wheels[2].surfaceId);
    const slip = car.wheels.map((w) => (w.alpha * RAD2DEG).toFixed(1).padStart(6)).join(' ');
    const kap = car.wheels.map((w) => w.kappa.toFixed(2).padStart(6)).join(' ');
    const loads = car.wheels.map((w) => (w.N / 1000).toFixed(1).padStart(6)).join(' ');
    this._set(2, [
      `surface ${surf.name}   mu ${car.wheels[0].muEff.toFixed(2)}`,
      `alpha deg [${slip}]`,
      `kappa     [${kap}]`,
      `load kN   [${loads}]  sum ${(car.wheels.reduce((a, w) => a + w.N, 0) / 1000).toFixed(2)}`,
      `roll ${(Math.asin(Math.max(-1, Math.min(1, -b.m[7]))) * RAD2DEG).toFixed(1)}°  pitch ${(Math.asin(Math.max(-1, Math.min(1, b.m[1]))) * RAD2DEG).toFixed(1)}°  air ${car.airborneWheels}`,
      dirt ? `BRUD ${dirt.panels.summary()}` : '',
      dirt ? `obiektyw ${(dirt.lens.severity() * 100).toFixed(0)}%  brud sim ${dirt.stats.msMean.toFixed(2)} ms  splaty ${dirt.stats.splats}` : '',
    ].filter((l) => l !== '').join('\n'));

    this._set(1, [
      `${stage.biome}  seed ${stage.seed}`,
      // `arc` comes from the caller: main.js owns the current arc position, while
      // `stage` is the generated stage object and has no arc on it. Reading
      // stage.arc here threw on the first tick and took the whole frame loop down
      // (black viewport, HUD only) - the debug overlay must never own game state.
      `arc ${(arc ?? 0).toFixed(0)} / ${stage.roadLength.toFixed(0)} m`,
      `chunks ${stream.stats.chunks}  tris ${(stream.stats.tris / 1000).toFixed(0)}k  props ${stream.stats.props}`,
      `fps ${loop.fps.toFixed(0)}  sim ${loop.simMs.toFixed(2)} ms  draw ${loop.renderMs.toFixed(2)} ms`,
      `steps/frame ${Math.round(1 / DT)} @ ${(1 / DT).toFixed(0)} Hz`,
    ].join('\n'));

    this._set(3, [
      `W/S throttle·brake   A/D steer`,
      `SPACE handbrake   Q/E shift`,
      `C camera ${settings.cameraMode}   H hud   N rally HUD   P pause   R restart`,
      `X mycie auta   V wycieraczka   B deszcz`,
      `F1/F2/F3 quality   T tests`,
      settings.assists.abs ? 'assists ON' : 'assists OFF',
    ].join('\n'));
  }

  _set(i, text) {
    if (this._last[i] === text) return;
    this._last[i] = text;
    const el = [this.tl, this.tr, this.bl, this.br][i];
    if (el) el.textContent = text;
  }

  boot(message) {
    const el = document.getElementById('boot');
    if (el) { el.classList.toggle('hidden', !message); if (message) el.textContent = message; }
  }
}
