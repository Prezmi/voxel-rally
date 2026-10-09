// Rally HUD — layout read off Colin McRae Rally (PLAN.md §10, SYSTEM-NOTES §14).
//   * co-driver SIGN BOARD across the top: drawn corner glyph + severity digit + the
//     distance to the corner counting down in metres (CMR1 manual: "co-driver arrow
//     indicator", CMR04: "co-driver signs"), hard-capped at 10 vh by CSS.
//   * SPEEDOMETER CLUSTER bottom-right: SVG tacho with a redline band, ticks, an
//     animated needle, a shift cue, a big km/h number, a gear window and three small
//     state gauges (CMR04: "revs, gear / max throttle, speed, water / oil / turbo" —
//     we show what this game actually simulates: engine health + suspension per axle).
//   * STAGE PROGRESS BAR top-left with the checkpoint markers and a car tick
//     (CMR04: "on screen stage progress ... a marker representing the car").
//   * SMALL time cluster top-left: total, split vs reference (negative = ahead,
//     CMR04 wording), limit remaining, penalties. No big numbers in the middle.
//   * four per-wheel state segments bottom-left (PLAN.md §8 #2) — colour first,
//     numbers only in FULL mode.
//   * HUD density like the CMR options screen: FULL / MINIMAL / OFF (key N).
// Density + mode live in core/settings.js so the choice survives a reload.
// Everything is generated in code: SVG paths built from maths, no image, no fetch.
// DOM is built ONCE in the constructor; the frame path only mutates cached text,
// classes, style.left/width and one SVG transform (docs/06 §1, docs/07 budgets).
import { bus } from '../core/events.js';
import { formatSplit, formatTime } from './timing.js';
import { STATE } from './stage.js';
import { settings } from '../core/settings.js';

const RAD2DEG = 180 / Math.PI;
const SVG_NS = 'http://www.w3.org/2000/svg';
const WHEEL_LABELS = ['PRZ L', 'PRZ P', 'TYŁ L', 'TYŁ P'];
const MODES = ['FULL', 'MINIMAL', 'OFF'];
const MODE_LABEL = { FULL: 'HUD: pełny', MINIMAL: 'HUD: minimalny', OFF: 'HUD: wyłączony' };
// Tacho geometry (SVG user units, 200x200 box, y down). Sweep runs clockwise from
// bottom-left (135 deg) through the top to bottom-right (405 deg) — the racing shape.
const T_CX = 100, T_CY = 100, T_R = 82, T_START = 135, T_SWEEP = 270;
// Fixed state table: a gauge never builds a new string for a state it already shows.
const WHEEL_STATE = {
  GRIP: { label: 'CZEPNE', cls: 'ok' },
  SLIP: { label: 'UŚLIZG', cls: 'warn' },
  LOCK: { label: 'BLOKADA', cls: 'bad' },
  DRIVE: { label: 'NAPĘD', cls: 'drive' },
  AIR: { label: 'POWIETRZE', cls: 'air' },
};

function polar(r, deg) {
  const a = deg * Math.PI / 180;
  return [T_CX + r * Math.cos(a), T_CY + r * Math.sin(a)];
}
function arcPath(r, f0, f1) {
  const a0 = T_START + f0 * T_SWEEP, a1 = T_START + f1 * T_SWEEP;
  const p0 = polar(r, a0), p1 = polar(r, a1);
  return `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
}

/** A corner arrow drawn as a path: a straight run that bends by `turnDeg`.
 *  Built once per severity (SYSTEM-NOTES §14: 6 ≈ flat-out kink, 1 = caution/hairpin),
 *  normalised into the glyph box so all seven look like one family. */
function turnGlyph(turnDeg, straight) {
  const pts = [];
  let x = 0, y = 0, a = -Math.PI / 2;
  if (straight) { pts.push([0, -34], [0, 26]); }
  else {
    const steps = Math.max(3, Math.round(Math.abs(turnDeg) / 12));
    const dth = (turnDeg * Math.PI / 180) / steps;
    pts.push([0, 0]);
    for (let i = 0; i < steps; i++) {
      a += dth;
      x += Math.cos(a) * 16; y += Math.sin(a) * 16;
      pts.push([x, y]);
    }
  }
  const tip = pts[pts.length - 1];
  const back = straight ? -Math.PI / 2 : a + Math.PI;
  pts.push([tip[0] + Math.cos(back + 0.5) * 13, tip[1] + Math.sin(back + 0.5) * 13]);
  pts.pop();
  pts.push([tip[0] + Math.cos(back - 0.5) * 13, tip[1] + Math.sin(back - 0.5) * 13]);
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const s = Math.min(64 / w, 64 / h);
  const ox = 32 - (x0 + w / 2) * s, oy = 32 - (y0 + h / 2) * s;
  let d = '';
  for (let i = 0; i < pts.length; i++) {
    const px = (pts[i][0] * s + ox).toFixed(1), py = (pts[i][1] * s + oy).toFixed(1);
    d += (i === 0 ? 'M' : 'L') + px + ' ' + py;
  }
  return d;
}

export class RallyHud {
  /** `doc` is a document-like object (createElement[/NS], getElementById, body) so the
   *  same class is testable headless against the stub DOM in tools/stagetest.mjs. */
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.bus = opts.bus || bus;
    this.mode = settings.hudMode || 'FULL';
    this.arrows = settings.showCoDriverArrows !== false;
    this._root = doc.getElementById('rally') || doc.createElement('div');
    // The density class always goes on the root: in the browser #rally already exists
    // in index.html, so an "only if we created it" branch would leave the CSS modes inert.
    this._root.className = 'rally mode-' + this.mode.toLowerCase();
    if (!this._root.parentNode && doc.body) doc.body.appendChild(this._root);

    // ---- tablice / sign board (top strip, CMR co-driver signs) ----
    this.signs = this._panel('rly-signs');
    this.signMeta = this._child(this.signs, 'div', 'sign-meta');
    this.signRow = this._child(this.signs, 'div', 'sign-row');
    this.signChips = [];
    for (let i = 0; i < 4; i++) {
      const c = this._child(this.signRow, 'div', 'sign');
      const svg = this._svg(c, 'svg', { viewBox: '0 0 64 64', class: 'glyph' });
      const path = this._svg(svg, 'path', { class: 'gpath' });
      const num = this._child(c, 'div', 's-num');
      const col = this._child(c, 'div', 's-col');
      const txt = this._child(col, 'div', 's-txt');
      const dist = this._child(col, 'div', 's-dist');
      this.signChips.push({ el: c, path, num, txt, dist, k: '', keyNum: '', keyTxt: '', keyDist: '' });
    }

    // ---- time cluster (small, top-left) + stage progress bar under it ----
    this.time = this._panel('rly-time');
    this.tTotal = this._child(this.time, 'div', 't-total');
    this.tSplit = this._child(this.time, 'div', 't-split');
    this.tLimit = this._child(this.time, 'div', 't-limit');
    this.prog = this._panel('rly-prog');
    this.progLabel = this._child(this.prog, 'div', 'p-label');
    this.progBar = this._child(this.prog, 'div', 'p-bar');
    this.progActive = this._child(this.progBar, 'div', 'p-active');
    this.progCar = this._child(this.progBar, 'div', 'p-car');
    this.progCps = [];
    this.progTimes = this._child(this.prog, 'div', 'rows p-times');

    // ---- speedometer cluster (bottom-right) ----
    this.cluster = this._panel('rly-cluster');
    const tacho = this._child(this.cluster, 'div', 'tacho');
    const svg = this._svg(tacho, 'svg', { viewBox: '0 0 200 200', class: 'tface' });
    this._svg(svg, 'circle', { cx: T_CX, cy: T_CY, r: T_R + 10, class: 'tring' });
    this._svg(svg, 'path', { d: arcPath(T_R, 0, 1), class: 'tscale' });
    this._svg(svg, 'path', { d: arcPath(T_R, 0.86, 1), class: 'tred' });
    this._svg(svg, 'path', { d: this._ticksPath(10), class: 'tticks' });
    this.needle = this._svg(svg, 'path', { d: `M${T_CX} ${T_CY + 10}L${T_CX} ${T_CY - T_R + 6}`, class: 'tneedle', transform: `rotate(${T_START + 90} ${T_CX} ${T_CY})` });
    this._svg(svg, 'circle', { cx: T_CX, cy: T_CY, r: 7, class: 'thub' });
    this.cue = this._child(tacho, 'div', 'tcue');
    this.speedEl = this._child(this.cluster, 'div', 'speed');
    this.speedVal = this._child(this.speedEl, 'div', 'v');
    this.speedUnit = this._child(this.speedEl, 'div', 'u');
    this.gearEl = this._child(this.cluster, 'div', 'gear');
    this.minis = this._child(this.cluster, 'div', 'minis');
    this.mini = [];
    const MINI = [['SILNIK', 'engine'], ['ZAWIS PRZ', 'front'], ['ZAWIS TYŁ', 'rear']];
    for (let i = 0; i < MINI.length; i++) {
      const m = this._child(this.minis, 'div', 'mini');
      const lab = this._child(m, 'div', 'lab'); lab.textContent = MINI[i][0];
      const bar = this._child(m, 'div', 'bar');
      const fill = this._child(bar, 'div', 'fill');
      this.mini.push({ el: m, fill, key: MINI[i][1], last: '' });
    }

    // ---- four per-wheel segments (bottom-left, near the tacho) ----
    this.wheels = this._panel('rly-wheels');
    this.gauges = [];
    for (let i = 0; i < 4; i++) {
      const g = this._child(this.wheels, 'div', 'w');
      const lab = this._child(g, 'div', 'lab'); lab.textContent = WHEEL_LABELS[i];
      const bar = this._child(g, 'div', 'bar');
      const fill = this._child(bar, 'div', 'fill');
      const val = this._child(g, 'div', 'val');
      this.gauges.push({ el: g, fill, val, lastCls: '', lastVal: '', lastW: '' });
    }

    // ---- modal screen stack: countdown / result (kept in every density mode) ----
    this.modal = this._panel('rly-modal');
    this.modalBody = this._child(this.modal, 'div', 'modal-box');
    this.modalTitle = this._child(this.modalBody, 'div', 'title');
    this.modalRows = this._child(this.modalBody, 'div', 'rows');
    this.menu = [];
    this.focus = 0;

    this.stack = ['hud'];
    this._modalOpen = false;
    this._txt = { signMeta: '', time: '', split: '', limit: '', sectors: '', penalties: '', title: '', rows: '', prog: '' };
    this._acc = 0; this._accGauge = 0; this._accSign = 0; this._accSlow = 0;
    this._dirty = { sectors: true, penalties: true };
    this._events = { checkpoints: [], penalties: [], result: null, countdown: -1, started: false };
    this._padPrev = [false, false, false, false];
    // Pre-allocated sign slots: the sign scan never allocates in the frame path.
    this._pick = [{ n: null, d: 0 }, { n: null, d: 0 }, { n: null, d: 0 }, { n: null, d: 0 }];
    this.pendingActivate = false;
    this._subscribe();
  }

  // ---------- build helpers (constructor-time only) ----------
  _panel(cls) { const el = this.doc.createElement('div'); el.className = 'panel ' + cls; this._root.appendChild(el); return el; }
  _child(parent, tag, cls) { const el = this.doc.createElement(tag); el.className = cls; parent.appendChild(el); return el; }
  _svg(parent, tag, attrs) {
    const d = this.doc;
    const el = d.createElementNS ? d.createElementNS(SVG_NS, tag) : d.createElement(tag);
    if (attrs && el.setAttribute) for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }
  /** Attribute write, cached per element+name: no DOM write when the value is the same. */
  _setA(el, name, value) {
    if (!el.setAttribute) return;
    const cache = el.__cache || (el.__cache = {});
    if (cache[name] === value) return;
    cache[name] = value;
    el.setAttribute(name, value);
  }
  _setText(el, key, text) { if (this._txt[key] === text) return; this._txt[key] = text; el.textContent = text; }
  _setCls(el, cls) { if (el.className !== cls) el.className = cls; }
  _ticksPath(n) {
    let d = '';
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const a = T_START + f * T_SWEEP;
      const p0 = polar(T_R - (i % 2 ? 6 : 11), a), p1 = polar(T_R + 3, a);
      d += `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)}L${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
    }
    return d;
  }
  /** Glyph per severity 1..6 (a tighter corner = a bigger bend), hairpin, straight. */
  _glyphs() {
    if (this._glyphMap) return this._glyphMap;
    const m = new Map();
    for (let s = 1; s <= 6; s++) m.set('s' + s, turnGlyph(150 - (s - 1) * 22, false));
    m.set('hairpin', turnGlyph(200, false));
    m.set('flat', turnGlyph(0, false));
    m.set('crest', turnGlyph(0, true));
    this._glyphMap = m;
    return m;
  }

  // ---------- event-driven state (skills/game-ui-ux #6) ----------
  _subscribe() {
    const ev = this._events;
    this.bus.on('countdown', (p) => { ev.countdown = p.value; });
    this.bus.on('start', () => {
      ev.started = true; ev.countdown = 0;
      this._pop('countdown');
      this._dirty.sectors = true; this._dirty.limit = true;
    });
    this.bus.on('checkpoint', (p) => {
      ev.checkpoints.push(p);
      this._dirty.sectors = true; this._dirty.limit = true;
      this._syncProgress(p);
    });
    this.bus.on('penalty', (p) => { ev.penalties.push(p); this._dirty.penalties = true; });
    this.bus.on('finished', (r) => { ev.result = r; this._showResult(r); });
    this.bus.on('dnf', (r) => { ev.result = r; this._showResult(r); });
    this.bus.on('stage-reset', () => this._reset());
  }

  /** Checkpoint markers + sector labels are laid out once, on the first gate event. */
  _syncProgress(p) {
    if (this.progCps.length) return;
    const st = p && p.stage;
    if (!st || !st.gates) return;
    const total = st.gates[st.gates.length - 1].arc || 1;
    for (let i = 1; i < st.gates.length; i++) {
      const g = st.gates[i];
      const m = this._child(this.progBar, 'div', 'p-cp');
      m.style.left = (100 * g.arc / total).toFixed(2) + '%';
      m.textContent = 'S' + (g.number !== undefined ? Math.max(1, g.number) : i);
      this.progCps.push(m);
    }
    this._dirty.progLabels = true;
  }

  _reset() {
    const ev = this._events;
    ev.checkpoints.length = 0; ev.penalties.length = 0; ev.result = null; ev.countdown = -1; ev.started = false;
    this.stack.length = 1; this.stack[0] = 'hud';
    this._dirty.sectors = true; this._dirty.penalties = true;
    for (const g of this.gauges) { g.lastCls = ''; g.lastVal = ''; g.lastW = ''; }
    for (const m of this.mini) m.last = '';
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
    let rows = `czas  ${formatTime(r.total)}   split vs referencja  ${formatSplit(r.split)}   limit ${formatTime(r.limit)}\n`;
    for (const s of r.sectors) rows += `S${s.index}  ${s.time >= 0 ? formatTime(s.time) : '—'}  ${formatSplit(s.split)}\n`;
    for (const p of r.penalties) rows += `KARA  +${p.seconds}s  ${p.label}\n`;
    if (why) rows += why;
    this._setText(this.modalRows, 'rows', rows);
    this._buildMenu(['Restart odcinka [ENTER]', 'Wróć do gry [ESC]']);
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
      const cls = i === this.focus ? 'menu-item focus' : 'menu-item';
      this._setCls(this.menu[i].el, cls);
    }
  }
  moveFocus(d) {
    if (!this.menu.length) return null;
    this.focus = (this.focus + d + this.menu.length) % this.menu.length;
    this._syncFocus();
    return this.menu[this.focus];
  }
  activate() { return this.menu.length ? this.menu[this.focus] : null; }

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
      if (a && !this._padPrev[3]) return 100;      // A = ENTER
      this._padPrev[3] = a;
      if (d) return d;
    }
    return 0;
  }

  // ---------- density modes (CMR "Game Displays: Full / Minimal / Off") ----------
  setMode(m) {
    if (MODES.indexOf(m) < 0) return this.mode;
    this.mode = m;
    settings.hudMode = m;
    this._setCls(this._root, 'rally mode-' + m.toLowerCase());
    return m;
  }
  cycleMode() {
    const i = (MODES.indexOf(this.mode) + 1) % MODES.length;
    return this.setMode(MODES[i]);
  }
  toggle() { return this.cycleMode(); }        // old key name, same behaviour

  /** Low-rate update. `dt` is a frame dt (render rate), never the sim dt. */
  update(dt, ctx) {
    if (!ctx || !ctx.stage) return;
    // The countdown / result modals live in every density mode (CMR keeps the stage
    // result regardless of the display option).
    const st = ctx.stage;
    if (st.state === STATE.PRE_START && this.top() === 'hud') {
      this._setText(this.modalTitle, 'count', `START ZA ${Math.max(0, st.countdown).toFixed(1)} s`);
      this._buildMenu([]);
      this._push('countdown');
    }
    if (this.mode === 'OFF') {
      if (this.top() !== 'hud') { const d = this._pollPad(); if (d === 100) this.pendingActivate = true; else if (d) this.moveFocus(d); }
      return;
    }
    this._acc += dt;
    this._accGauge += dt;
    if (this._acc >= 1 / 30) { this._acc = 0; this._drawCluster(ctx); this._drawClock(ctx); }
    if (this._accGauge >= 1 / 20) { this._accGauge = 0; if (this.mode === 'FULL') this._drawWheels(ctx); }
    this._accSign += dt;
    if (this._accSign >= 1 / 20) { this._accSign = 0; this._drawSigns(ctx); }
    this._accSlow += dt;
    if (this._accSlow >= 1 / 8) {
      this._accSlow = 0;
      const d = this._pollPad();
      if (d === 100) this.pendingActivate = true;
      else if (d) this.moveFocus(d);
      if (this.mode === 'FULL') this._drawLists(ctx);
    }
  }

  /** Speedometer cluster: tacho + needle + shift cue + km/h + gear + state gauges. */
  _drawCluster(ctx) {
    const car = ctx.car, pt = car.powertrain || car.engine || null;
    const redline = (car.params && car.params.engine && car.params.engine.redline) || 7000;
    const max = Math.ceil(redline / 1000) * 1000;
    const rpm = Math.max(0, pt ? pt.rpm : 0);
    const f = Math.max(0, Math.min(1, rpm / max));
    const deg = Math.round(225 + f * T_SWEEP);
    this._setA(this.needle, 'transform', `rotate(${deg} ${T_CX} ${T_CY})`);
    const near = f >= 0.93;
    this._setCls(this.cue, near ? 'tcue on' : 'tcue');
    const kmh = Math.round((car.body ? car.body.groundSpeed : (car.speed || 0)) * 3.6);
    if (this._txt.kmh !== kmh) { this._txt.kmh = kmh; this.speedVal.textContent = String(kmh); }
    const moving = kmh > 2;
    const gear = pt ? pt.gear : 0;
    const gl = !moving ? 'N' : String(gear + 1);
    if (this._txt.gear !== gl) {
      this._txt.gear = gl;
      this.gearVal(gl);
    }
    if (this.mode === 'FULL') {
      const dm = car.damage;
      for (let i = 0; i < this.mini.length; i++) {
        const m = this.mini[i];
        let v = 1;
        if (m.key === 'engine') v = dm ? dm.enginePowerScale : 1;
        else if (m.key === 'front') v = dm ? (dm.susp[0] + dm.susp[1]) * 0.5 : 1;
        else v = dm ? (dm.susp[2] + dm.susp[3]) * 0.5 : 1;
        const w = Math.round(Math.max(0, Math.min(1, v)) * 100) + '%';
        if (m.last !== w) { m.last = w; m.fill.style.width = w; }
        this._setCls(m.el, v > 0.94 ? 'mini' : v > 0.8 ? 'mini warn' : 'mini bad');
      }
    }
  }
  gearVal(gl) {
    const cls = gl === 'N' ? 'gear' : 'gear on';
    if (this._txt.gearCls !== cls) { this._txt.gearCls = cls; this.gearEl.className = cls; }
    this.gearEl.textContent = gl;
  }

  /** Sign board: corner glyph + severity + the metres left to the corner. */
  _drawSigns(ctx) {
    const t = ctx.stage.timing, st = ctx.stage;
    const sec = t.activeSector;
    const secNo = sec ? sec.index : t.sectors.length;
    const name = ctx.stageName || 'ODCINEK';
    const rem = t.limitRemaining;
    this._setText(this.signMeta, 'signMeta',
      `${name}  ·  SEKTOR ${secNo}/${t.sectors.length}  ·  SPLIT ${formatSplit(t.liveSplit)}`
      + `  ·  LIMIT ${rem >= 0 ? formatTime(rem) : '00:00.00'}`);

    const chips = this.mode === 'FULL' ? 4 : 1;
    if (!this.arrows) {
      for (let i = 0; i < chips; i++) this._setChip(this.signChips[i], '', 0, 0, '', 'sign');
      return;
    }
    const list = ctx.notes || [];
    const arc = st.arc;
    const v = ctx.car.body ? ctx.car.body.groundSpeed : 0;
    const win = 110 + v * 3.0;                 // the sign window grows with speed
    const spoken = ctx.voice && ctx.voice.currentText ? ctx.voice.currentText : '';
    let n = 0;
    for (let i = 0; i < list.length && n < chips; i++) {
      const a = list[i];
      if (a.apexArc < arc - 25) continue;      // corner already driven
      const dd = a.apexArc - arc;
      if (dd > win + (a.priority >= 3 ? 90 : 0)) continue;
      this._pick[n].n = a;
      this._pick[n].d = Math.max(0, Math.round(dd / 5) * 5);
      n++;
    }
    for (let i = 0; i < chips; i++) {
      const c = this.signChips[i];
      if (i >= n) { this._setChip(c, '', 0, 0, '', 'sign'); continue; }
      const a = this._pick[i].n, d = this._pick[i].d;
      const key = a.severity ? 's' + a.severity : (a.text.indexOf('DON') >= 0 ? 'hairpin' : 'crest');
      const num = a.severity ? String(a.severity) : '';
      const txt = a.severity ? a.text : a.text;
      const cls = 'sign ' + (a.dir === 'L' ? 'dir-l' : 'dir-r')
        + (a.priority >= 3 ? ' hi' : '')
        + (spoken && a.text === spoken ? ' now' : '')
        + (i === 0 ? ' lead' : '');
      this._setChip(c, key, num, d, txt, cls);
    }
  }
  _setChip(c, key, num, dist, txt, cls) {
    if (c.k !== key) { c.k = key; this._setA(c.path, 'd', this._glyphs().get(key) || ''); }
    if (c.keyNum !== num) { c.keyNum = num; c.num.textContent = num; }
    if (c.keyTxt !== txt) { c.keyTxt = txt; c.txt.textContent = txt; }
    const ds = dist > 0 ? `${dist} m` : '';
    if (c.keyDist !== ds) { c.keyDist = ds; c.dist.textContent = ds; }
    this._setCls(c.el, dist > 0 ? cls : 'sign idle');
  }

  /** Stage progress bar: car tick + active sector highlight. */
  _drawClock(ctx) {
    const t = ctx.stage.timing, st = ctx.stage;
    this._setText(this.tTotal, 'time', formatTime(t.total));
    const split = t.liveSplit;
    this._setText(this.tSplit, 'split', `SPLIT ${formatSplit(split)}`);
    this._setCls(this.tSplit, split <= 0 ? 't-split ahead' : 't-split behind');
    const rem = t.limitRemaining;
    const warn = t.limit > 0 && rem < 15;
    this._setText(this.tLimit, 'limit', (t.limit > 0
      ? `LIMIT ${rem >= 0 ? formatTime(rem) : '00:00.00'}${warn ? '  ⚠' : ''}` : 'LIMIT —')
      + (t.penaltyTotal ? `  KARY +${t.penaltyTotal}s` : ''));
    this._setCls(this.tLimit, warn ? 't-limit warn' : 't-limit');

    const gates = st.gates || [];
    const total = gates.length ? (gates[gates.length - 1].arc || 1) : 1;
    const pos = Math.max(0, Math.min(1, st.furthest / total));
    const pct = (pos * 100).toFixed(1) + '%';
    if (this._txt.prog !== pct) { this._txt.prog = pct; this.progCar.style.left = pct; }
    const sec = t.activeSector;
    if (sec) {
      const a = (100 * sec.from / total).toFixed(1) + '%';
      const w = (100 * (sec.to - sec.from) / total).toFixed(1) + '%';
      if (this._txt.pactive !== a + w) {
        this._txt.pactive = a + w;
        this.progActive.style.left = a; this.progActive.style.width = w;
      }
      this._setText(this.progLabel, 'prog', `SEKTOR ${sec.index}/${t.sectors.length}`);
    } else {
      this._setText(this.progLabel, 'prog', `POSTĘP ${(pos * 100).toFixed(0)}%`);
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
      this._setText(this.progTimes, 'sectors', s);
    }
    if (this._dirty.penalties) {
      this._dirty.penalties = false;   // the penalty total is already folded into t-limit
    }
  }

  /** Four per-wheel segments: colour tells the story, numbers only in FULL. */
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
      const cls = `w ${s.cls}`;
      if (g.lastCls !== cls) { g.lastCls = cls; g.el.className = cls; }
      const num = air ? ''
        : s === WHEEL_STATE.LOCK || s === WHEEL_STATE.DRIVE ? `kappa ${w.kappa.toFixed(2)}`
        : Math.abs(alphaDeg) > 9 ? `${Math.abs(alphaDeg).toFixed(0)}°`
        : `${(w.N / 1000).toFixed(1)} kN`;
      const label = `${s.label} ${num}`.trim();
      if (g.lastVal !== label) { g.lastVal = label; g.val.textContent = label; }
      const w2 = Math.min(100, Math.round(w.slipEnergy / 400)) + '%';
      if (g.lastW !== w2) { g.lastW = w2; g.fill.style.width = w2; }
    }
  }
}
