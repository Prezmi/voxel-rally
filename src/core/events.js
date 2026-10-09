// Minimal emitter. No DOM events in the hot path (docs/06 §1).
export class Emitter {
  constructor() { this._m = new Map(); }
  on(type, fn) {
    let a = this._m.get(type);
    if (!a) { a = []; this._m.set(type, a); }
    a.push(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) {
    const a = this._m.get(type);
    if (!a) return;
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  emit(type, payload) {
    const a = this._m.get(type);
    if (!a) return;
    for (let i = 0; i < a.length; i++) a[i](payload);
  }
}

// One shared bus for gameplay -> UI/FX/audio (docs/06 §4). Modules may still make
// their own Emitter (the dirt system does); the bus is only the stage-level wire.
export const bus = new Emitter();
