// Rally HUD (docs/07 F4: "zegar, split, limit, uszkodzenia, 4 wskaźniki kół").
// Layout follows .agents/skills/game-ui-ux: anchors + containers (never pixel
// positions), viewport-relative units + safe-area insets (CSS side, index.html),
// a screen-state stack, keyboard/gamepad focus on menus, and — the important one —
// DOM writes driven by stage events plus a low-rate clock tick, so the overlay
// costs nothing in the frame (docs/06 §1 "no DOM events in the hot path").
// Everything the player reads is Polish; code comments stay English.
import { bus } from '../core/events.js';
import { formatSplit, formatTime } from './timing.js';
import { STATE } from './stage.js';

const RAD2DEG = 180 / Math.PI;
const WHEEL_LABELS = ['PRZ L', 'PRZ P', 'TYŁ L', 'TYŁ P'];
// Fixed state table: the gauge never builds a new string for a state it already shows.
const WHEEL_STATE = {
  GRIP: { label: 'CZEPNE', cls: 'ok' },
  SLIP: { label: 'UŚLIZG', cls: 'warn' },
  LOCK: { label: 'BLOKADA', cls: 'bad' },
  DRIVE: { label: 'NAPĘD', cls: 'drive' },
  AIR: { label: 'POWIERTRZE', cls: 'air' },
};

export class RallyHud {
  /** `doc` is a document-like object: createElement/getElementById/body only, so
   *  the same class is testable headless against a stub DOM (tools/stagetest.mjs). */
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.enabled = true;
    this.bus = opts.bus || bus;
    this._root = doc.getElementById('rally') || doc.createElement('div');
    if (!this._root.parentNode && doc.body) { this._root.className = 'rally'; doc.body.appendChild(this._root); }

    // --- anchored panels (containers flow their children; CSS owns the anchors) ---
    this.clock = this._panel('rly-clock');
    this.clockTime = this._child(this.clock, 'div', 'big');
    this.clockSector = this._child(this.clock, 'div', 'row');
    this.clockLimit = this._child(this.clock, 'div', 'row');

    this.left = this._panel('rly-left');
    this.sectorList = this._child(this.left, 'div', 'rows');
    this.penaltyList = this._child(this.left, 'div', 'rows pen');
    this.damageLine = this._child(this.left, 'div', 'row dmg');

    this.wheels = this._panel('rly-wheels');
    this.gauges = [];
    for (let i = 0; i < 4; i++) {
      const g = this._child(this.wheels, 'div', 'gauge');
      const lab = this._child(g, 'div', 'lab');
      const bar = this._child(g, 'div', 'bar');
      const fill = this._child(bar, 'div', 'fill');
      const val = this._child(g, 'div', 'val');
      lab.textContent = WHEEL_LABELS[i];
      this.gauges.push({ el: g, fill, val, lastCls: '', lastVal: '', lastW: '' });
    }

    // --- tablice u góry ekranu (PLAN.md §10): stage name, sector, split, limit and
    // the pace notes rendered as road signs. One full-width strip, capped at 10 vh by
    // CSS, transparent, anchored to the safe area — it never sits over the racing line
    // (which the camera keeps in the lower half of the frame).
    this.signs = this._panel('rly-signs');
    this.signMeta = this._child(this.signs, 'div', 'sign-meta');
    this.signRow = this._child(this.signs, 'div', 'sign-row');
    this.signChips = [];
    for (let i = 0; i < 4; i++) {
      const c = this._child(this.signRow, 'div', 'sign');
      this.signChips.push({ el: c, last: '', lastCls: '' });
    }
    this._signNotes = [];

    this.modal = this._panel('rly-modal');
    this.modalBody = this._child(this.modal, 'div', 'modal-box');
    this.modalTitle = this._child(this.modalBody, 'div', 'title');
    this.modalRows = this._child(this.modalBody, 'div', 'rows');
    this.menu = [];
    this.focus = 0;

    // --- screen-state stack (skills/game-ui-ux #5): hud <- countdown <- result ---
    this.stack = ['hud'];
    this._modalOpen = false;

    // Text caches: a DOM write happens only when the string actually changed.
    this._txt = { time: '', sector: '', limit: '', sectors: '', penalties: '', damage: '', title: '', rows: '', signMeta: '', sign0: '', sign1: '', sign2: '', sign3: '' };
    this._acc = 0; this._accSlow = 0; this._accSign = 0;
    this._dirty = { sectors: true, penalties: true, signs: true };
    this._events = { checkpoints: [], penalties: [], result: null, countdown: -1, started: false };
    this._padPrev = [false, false, false, false];
    this.pendingActivate = false;

    this._subscribe();
  }

  _panel(cls) { const el = this.doc.createElement('div'); el.className = `panel ${cls}`; this._root.appendChild(el); return el; }
  _child(parent, tag, cls) { const el = this.doc.createElement(tag); el.className = cls; parent.appendChild(el); return el; }
  _setText(el, key, text) { if (this._txt[key] === text) return; this._txt[key] = text; el.textContent = text; }

  // ---- event-driven state (skills/game-ui-ux #6): handlers only flag + store ----
  _subscribe() {
    const ev = this._events;
    this.bus.on('countdown', (p) => { ev.countdown = p.value; this._dirty.countdown = true; });
    this.bus.on('start', () => {
      ev.started = true; ev.countdown = 0;
      this._pop('countdown');
      this._dirty.sectors = true; this._dirty.limit = true;
    });
    this.bus.on('checkpoint', (p) => { ev.checkpoints.push(p); this._dirty.sectors = true; this._dirty.limit = true; });
    this.bus.on('penalty', (p) => { ev.penalties.push(p); this._dirty.penalties = true; });
    this.bus.on('finished', (r) => { ev.result = r; this._showResult(r); });
    this.bus.on('dnf', (r) => { ev.result = r; this._showResult(r); });
    this.bus.on('stage-reset', () => this._reset());
    // Pace notes arrive as events (docs/06 §4): the handler only flags + remembers,
    // the strip itself is redrawn at the slow rate.
    this.bus.on('pace-note', (n) => {
      if (this._signNotes.length > 3) this._signNotes.shift();
      this._signNotes.push(n);
      this._dirty.signs = true;
    });
    this.bus.on('checkpoint', () => { this._dirty.signs = true; });
  }

  _reset() {
    const ev = this._events;
    ev.checkpoints.length = 0; ev.penalties.length = 0; ev.result = null; ev.countdown = -1; ev.started = false;
    this._signNotes.length = 0;
    this._dirty.signs = true;
    this.stack.length = 1; this.stack[0] = 'hud';
    this._dirty.sectors = true; this._dirty.penalties = true; this._dirty.countdown = true;
    for (const g of this.gauges) { g.lastCls = ''; g.lastVal = ''; g.lastW = ''; }
    this._setModal(false);
  }

  _push(name) { if (!this.stack.includes(name)) this.stack.push(name); this._syncStack(); }
  _pop(name) { const i = this.stack.indexOf(name); if (i >= 0) this.stack.splice(i, 1); this._syncStack(); }
  top() { return this.stack[this.stack.length - 1]; }
  _syncStack() { this._setModal(this.top() !== 'hud'); }
  _setModal(open) {
    if (open === this._modalOpen) return;
    this._modalOpen = open;
    this.modal.className = open ? 'panel rly-modal open' : 'panel rly-modal';
  }

  _showResult(r) {
    const title = r.result === STATE.FINISHED ? 'META' : 'DNF';
    const why = r.result === STATE.FINISHED ? '' : ({ limit: 'limit czasu przekroczony', gates: 'dwa brakujące checkpointy', stuck: 'auto stanęło' }[r.reason] || r.reason);
    this.modalTitle.textContent = `${title}  ${formatTime(r.total)}`;
    let rows = `split vs referencja  ${formatSplit(r.split)}   limit ${formatTime(r.limit)}\n`;
    for (const s of r.sectors) rows += `S${s.index}  ${s.time >= 0 ? formatTime(s.time) : '—'}  ${formatSplit(s.split)}\n`;
    for (const p of r.penalties) rows += `KARA  +${p.seconds}s  ${p.label}\n`;
    if (why) rows += why;
    this._setText(this.modalRows, 'rows', rows);
    this._buildMenu(r.result === STATE.FINISHED ? ['Restart odcinka [ENTER]', 'Wróć do gry [ESC]'] : ['Restart odcinka [ENTER]', 'Wróć do gry [ESC]']);
    this._push('result');
  }

  /** Focus navigation: something is always focused while a modal is open. */
  _buildMenu(items) {
    for (const m of this.menu) if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
    this.menu.length = 0;
    for (const label of items) {
      const el = this.doc.createElement('div');
      el.className = 'menu-item';
      el.textContent = label;
      this.modalBody.appendChild(el);
      this.menu.push({ el, label });
    }
    this.focus = 0;
    this._syncFocus();
  }

  _syncFocus() {
    for (let i = 0; i < this.menu.length; i++) {
      const m = this.menu[i];
      const cls = i === this.focus ? 'menu-item focus' : 'menu-item';
      if (m.el.className !== cls) m.el.className = cls;
    }
  }

  moveFocus(d) {
    if (!this.menu.length) return null;
    this.focus = (this.focus + d + this.menu.length) % this.menu.length;
    this._syncFocus();
    return this.menu[this.focus];
  }

  activate() { return this.menu.length ? this.menu[this.focus] : null; }

  /** Gamepad menu navigation (docs/06 §5) — polled at the slow rate, no allocation. */
  _pollPad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return 0;
    const pads = navigator.getGamepads();
    for (let p = 0; p < pads.length; p++) {
      const gp = pads[p];
      if (!gp || !gp.buttons) continue;
      const up = gp.buttons[12] && gp.buttons[12].pressed;
      const down = gp.buttons[13] && gp.buttons[13].pressed;
      const a = gp.buttons[0] && gp.buttons[0].pressed;
      let d = 0;
      if (down && !this._padPrev[1]) d = 1;
      else if (up && !this._padPrev[0]) d = -1;
      this._padPrev[0] = up; this._padPrev[1] = down; this._padPrev[2] = a;
      if (a && !this._padPrev[3]) return 100;      // A = activate
      this._padPrev[3] = a;
      if (d) return d;
    }
    return 0;
  }

  /** Low-rate update. `dt` is a *frame* dt (render rate), never the sim dt: this
   *  only schedules text work, the stage clock itself is integrated in timing.js. */
  update(dt, ctx) {
    if (!this.enabled) return;
    this._acc += dt;
    this._accSlow += dt;
    if (this._acc >= 1 / 20) { this._acc = 0; this._drawWheels(ctx); this._drawClock(ctx); }
    this._accSign += dt;
    if (this._accSign >= 1 / 12) { this._accSign = 0; this._drawSigns(ctx); }
    if (this._accSlow >= 1 / 8) {
      this._accSlow = 0;
      const d = this._pollPad();
      if (d === 100) this._activateFromPad();
      else if (d) this.moveFocus(d);
      this._drawLists(ctx);
    }
  }

  /**
   * The tablice strip (PLAN.md §10). Written text is cached per chip, so a frame
   * that changes nothing costs four comparisons — no DOM churn, no allocation.
   */
  _drawSigns(ctx) {
    const t = ctx.stage.timing, st = ctx.stage;
    const sec = t.activeSector;
    const secNo = sec ? sec.index : t.sectors.length;
    const name = ctx.stageName || 'ODCINEK';
    const rem = t.limitRemaining;
    this._setText(this.signMeta, 'signMeta',
      `${name}  ·  SEKTOR ${secNo}/${t.sectors.length}  ·  SPLIT ${formatSplit(t.liveSplit)}`
      + `  ·  LIMIT ${rem >= 0 ? formatTime(rem) : '00:00.00'}`);

    // Chip 0: the note the co-driver has just called (voice output == HUD text, docs/05 §7).
    // The last note the co-driver called stays on the board until the next one is
    // called (a tablica does not blink off mid-corner).
    const live = ctx.voice && ctx.voice.currentText ? ctx.voice.currentText
      : (this._signNotes.length ? this._signNotes[this._signNotes.length - 1].text : '');
    const spoken = live;
    this._setChip(0, spoken, spoken ? 'sign now' : 'sign');
    // Chips 1..3: the notes still ahead, with the distance to the corner they warn about.
    const list = ctx.notes || [];
    let shown = 0;
    for (let i = 0; i < list.length && shown < 3; i++) {
      const n = list[i];
      if (n.apexArc <= st.arc) continue;
      const d = Math.round((n.apexArc - st.arc) / 10) * 10;
      const cls = n.priority >= 3 ? 'sign hi' : 'sign next';
      this._setChip(1 + shown, `${n.text}  ${d} m`, cls);
      shown++;
    }
    for (; shown < 3; shown++) this._setChip(1 + shown, '', 'sign');
  }

  _setChip(i, text, cls) {
    const c = this.signChips[i];
    if (c.last !== text) { c.last = text; c.el.textContent = text; }
    if (c.lastCls !== cls) { c.lastCls = cls; c.el.className = cls; }
  }

  _drawClock(ctx) {
    const t = ctx.stage.timing, st = ctx.stage;
    this._setText(this.clockTime, 'time', formatTime(t.total));
    const sec = t.activeSector;
    const secNo = sec ? sec.index : t.sectors.length;
    const split = formatSplit(t.liveSplit);
    const cp = ctx.stage.nextGate;
    this._setText(this.clockSector, 'sector',
      `SEKTOR ${secNo}/${t.sectors.length}   CP ${Math.min(cp - 1, t.sectors.length)}/${t.sectors.length}   SPLIT ${split}`);
    const rem = t.limitRemaining;
    const warn = t.limit > 0 && rem < 15;
    const line = t.limit > 0
      ? `LIMIT ${rem >= 0 ? formatTime(rem) : '00:00.00'}${warn ? '  ⚠' : ''}${t.penaltyTotal ? `   KARY +${t.penaltyTotal}s` : ''}`
      : `kary +${t.penaltyTotal}s`;
    this._setText(this.clockLimit, 'limit', line);
    if (st.state === STATE.PRE_START && this.top() === 'hud') {
      this.modalTitle.textContent = `START ZA ${Math.max(0, st.countdown).toFixed(1)} s`;
      this._buildMenu([]);
      this._push('countdown');
    }
  }

  _drawLists(ctx) {
    const ev = this._events;
    if (this._dirty.sectors) {
      this._dirty.sectors = false;
      let s = '';
      const secs = ctx.stage.timing.sectors;
      for (let i = 0; i < secs.length; i++) {
        const sec = secs[i];
        const live = ctx.stage.state === STATE.RUNNING && ev.checkpoints.length === i;
        s += `S${sec.index}  ${sec.time >= 0 ? formatTime(sec.time) : live ? formatTime(ctx.stage.timing.total - ctx.stage.timing.refUpTo(i - 1)) : '—'}  ${sec.time >= 0 ? formatSplit(sec.split) : ''}\n`;
      }
      this._setText(this.sectorList, 'sectors', s);
    }
    if (this._dirty.penalties) {
      this._dirty.penalties = false;
      let s = '';
      for (const p of ev.penalties) s += `KARA  +${p.record.seconds}s  ${p.record.label}\n`;
      this._setText(this.penaltyList, 'penalties', s);
    }
    const dm = ctx.car.damage;
    const susp = dm.susp.map((v) => (v * 100).toFixed(0)).join(' ');
    const brk = dm.brake.map((v) => (v * 100).toFixed(0)).join(' ');
    const dmg = `USZKODY  zawieszenie ${susp}%  hamulce ${brk}%  silnik ${(dm.enginePowerScale * 100).toFixed(0)}%`;
    this._setText(this.damageLine, 'damage', dmg);
  }

  _drawWheels(ctx) {
    const ws = ctx.car.wheels;
    for (let i = 0; i < 4; i++) {
      const w = ws[i], g = this.gauges[i];
      const air = (w.airborneFrames || 0) > 0 || w.airborne;
      const alphaDeg = w.alpha * RAD2DEG;
      let s;
      if (air) s = WHEEL_STATE.AIR;
      else if (w.kappa <= -0.85) s = WHEEL_STATE.LOCK;
      else if (Math.abs(alphaDeg) > 9 || w.slipEnergy > 12000) s = WHEEL_STATE.SLIP;
      else if (w.kappa >= 0.7) s = WHEEL_STATE.DRIVE;
      else s = WHEEL_STATE.GRIP;
      const cls = `gauge ${s.cls}`;
      if (g.el.className !== cls) g.el.className = cls;
      // Number tells the player *which* wheel and how much (PLAN.md §8 #2).
      const num = air ? `air ${(w.airborneFrames || 0)}`
        : s === WHEEL_STATE.LOCK ? `kappa ${w.kappa.toFixed(2)}`
        : s === WHEEL_STATE.DRIVE ? `kappa ${w.kappa.toFixed(2)}`
        : Math.abs(alphaDeg) > 9 ? `ślizg ${Math.abs(alphaDeg).toFixed(0)}°`
        : `N ${(w.N / 1000).toFixed(1)} kN`;
      if (g.lastVal !== num) { g.lastVal = num; g.val.textContent = `${s.label} ${num}`; }
      const w2 = Math.min(100, Math.round(w.slipEnergy / 400)).toFixed(0) + '%';
      if (g.lastW !== w2) { g.lastW = w2; g.fill.style.width = w2; }
    }
  }

  _activateFromPad() {
    // Gamepad "A" = ENTER. The action itself stays in main.js (UI never drives the sim).
    this.pendingActivate = true;
  }

  toggle() {
    this.enabled = !this.enabled;
    this._root.className = this.enabled ? 'rally' : 'rally off';
    return this.enabled;
  }
}
