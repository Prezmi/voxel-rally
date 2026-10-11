// Pace notes derived from the road geometry only — nothing here is hand-authored
// (PLAN.md §2 "Pilot wypisuje notatki generowane z geometrii trasy (nie wpisane
// ręcznie)", docs/03 §6, notation per docs/07 F4).
//
// Pipeline:
//   1. curvature of the spline (road.kappa, already the heading derivative per metre)
//      is lightly smoothed, then every local extremum tighter than FLAT_RADIUS is a
//      candidate corner. That is the *only* source of corner notes, which is what
//      tools/pacenote-test.mjs audits (0 false notes, 0 misses).
//   2. radius -> rally severity 1..6 (1 = crawl hairpin, 6 = fast kink), sign of the
//      curvature -> L/R, turn angle over the corner group -> HAIRPIN / DON'T CUT,
//      road.feature -> GARB / DOŁ / SKOK / WODA / MOST, camber+grade feed the wording.
//   3. the trigger point is a *time* rule, not a fixed distance: the note is called
//      early enough that the co-driver finishes before the corner arrives at the
//      speed the ghost will actually carry there (docs/07 F4: "margines czasu
//      ≥ 1.2 s przed zakrętem"), with the braking distance folded in.
//   4. triggers are pushed apart so the voice never has to talk over itself.
import { FEATURE } from '../world/road-spline.js';
import { effectiveMu, surface } from '../world/surfaces.js';
import { G } from '../car/car-params.js';
import { t, getLang } from '../core/i18n.js';

export const FLAT_RADIUS = 200;      // m: curvature flatter than this needs no note
export const LEAD_MIN = 1.2;         // s, docs/07 F4 hard requirement
export const LEAD_TARGET = 1.45;     // s: a little slack on top of the requirement
export const MERGE_GAP = 55;         // m of less-curved road still inside one corner sequence
export const NOTE_MIN_GAP = 34;      // m between two trigger points (voice never stacks)
export const STRAIGHT_MIN = 260;     // m of flat road that deserves a "HANT" (hands off)

export const KIND = { CORNER: 'corner', FEATURE: 'feature', STRAIGHT: 'straight' };
export const PRIORITY = { LOW: 1, NORMAL: 2, HIGH: 3 };   // docs/05 §7: CAUTION preempts

const SEVERITY_R = [18, 28, 42, 65, 105, FLAT_RADIUS];     // radius (m) -> class 1..6
// Feature words go through src/core/i18n.js: EN CREST / DIP / JUMP / WATER / BRIDGE,
// PL GARB / DOŁ / SKOK / WODA / MOST. The rest of the call set is the same table.
const FEATURE_KEYS = {
  [FEATURE.CREST]: 'note.crest', [FEATURE.DIP]: 'note.dip', [FEATURE.JUMP]: 'note.jump',
  [FEATURE.WATER]: 'note.water', [FEATURE.BRIDGE]: 'note.bridge',
};
const featureWord = (f) => (FEATURE_KEYS[f] ? t(FEATURE_KEYS[f]) : '');

/** Moving-average smoothing of the curvature: kills 1-2 m sampling noise, keeps corners. */
export function smoothCurvature(road, w = 3) {
  const n = road.n, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -w; k <= w; k++) { const j = i + k; if (j < 0 || j >= n) continue; s += road.kappa[j]; c++; }
    out[i] = c ? s / c : 0;
  }
  return out;
}

/**
 * Every curvature extremum tighter than FLAT_RADIUS: a local maximum of |curvature|
 * over a +/- VERIFY_WINDOW m comparison. Exported so the audit walks the same
 * definition and can check it against the raw road.kappa values.
 */
export function curvatureExtrema(road, opts = {}) {
  const w = opts.smooth ?? 3, D = opts.window ?? 12;
  const k = w > 0 ? smoothCurvature(road, w) : road.kappa;
  const flat = 1 / (opts.flatRadius ?? FLAT_RADIUS);
  const out = [];
  const n = road.n;
  for (let i = 1; i < n - 1; i++) {
    const a = Math.abs(k[i]);
    if (a < flat) continue;
    let isPeak = true;
    for (let d = 2; d <= D; d++) {
      const l = i - d >= 0 ? Math.abs(k[i - d]) : 0;
      const r = i + d < n ? Math.abs(k[i + d]) : 0;
      if (l > a + 1e-6 || r > a + 1e-6) { isPeak = false; break; }
    }
    if (!isPeak) continue;
    // Skip plateaux: only keep the first index of a flat-topped run so one corner
    // does not produce several notes.
    if (i > 1 && Math.abs(k[i - 1]) > a - 1e-7) continue;
    out.push({
      index: i, arc: road.s[i], kappa: k[i], absKappa: a, radius: 1 / a,
      dir: k[i] > 0 ? 'R' : 'L',
    });
  }
  return out;
}

function severityFor(radius) {
  for (let i = 0; i < SEVERITY_R.length; i++) if (radius <= SEVERITY_R[i]) return i + 1;
  return 7;
}

/** Turn angle across a corner group (integral of curvature) — hairpins are >= 150 deg. */
function groupAngle(road, k, from, to) {
  let a = 0;
  for (let i = from; i <= to; i++) a += k[i] * (i < road.n - 1 ? road.s[i + 1] - road.s[i] : 1);
  return a;
}

/** Estimated spoken length of a note (deterministic, used by the voice queue). */
export function speechDuration(text) {
  const tokens = text.split(/[\s→]+/).filter(Boolean).length;
  return Math.max(0.55, Math.min(2.4, 0.42 + 0.26 * tokens));
}

/**
 * @param road  generated road
 * @param ghost solveGhost() output — supplies the speed the note is timed against
 */
export function buildPaceNotes(road, ghost, opts = {}) {
  const flat = opts.flatRadius ?? FLAT_RADIUS;
  const k = smoothCurvature(road, opts.smooth ?? 3);
  const n = road.n;
  // Candidate corners: the same raw-kappa extremum scan the audit uses (no smoothing,
  // 20 m comparison window) so notes and audit agree on what a corner is.
  const extrema = curvatureExtrema(road, { smooth: 0, window: opts.window ?? 20, flatRadius: flat });

  // ---- 1. merge extrema that belong to one corner sequence (chicanes, long bend) ----
  const groups = [];
  for (const e of extrema) {
    const g = groups[groups.length - 1];
    // Only extrema that turn the SAME way merge into one corner group: a chicane is
    // two corners and every board has to show the direction of the one it describes
    // (a mixed-sign group made the sign label disagree with the road).
    if (g && e.arc - g.endArc <= MERGE_GAP && e.dir === g.dir) {
      g.endArc = e.arc; g.endIndex = e.index;
      if (e.radius < g.radius) { g.radius = e.radius; g.index = e.index; g.kappa = e.kappa; g.dir = e.dir; }
      g.parts++;
    } else groups.push({ startIndex: e.index, endIndex: e.index, startArc: e.arc, endArc: e.arc, index: e.index, arc: e.arc, kappa: e.kappa, radius: e.radius, dir: e.dir, parts: 1 });
  }

  const notes = [];
  const pushNote = (g) => {
    const apexIndex = g.index;
    const apexArc = road.s[apexIndex];
    // Radius from the raw spline curvature across the group, not from the smoothed
    // peak: the note has to describe the road the car actually meets.
    let kRaw = 0;
    for (let i = Math.max(0, g.startIndex - 10); i <= Math.min(n - 1, g.endIndex + 10); i++)
      if (Math.abs(road.kappa[i]) > kRaw) kRaw = Math.abs(road.kappa[i]);
    if (kRaw > 1e-4 && 1 / kRaw < g.radius) { g.radius = 1 / kRaw; }
    const sev = severityFor(g.radius);
    if (sev > 6) return null;
    // Signed turn across the group: that integral is the direction the road really
    // makes here, so the board's arrow and Polish word can never disagree with it.
    const turn = groupAngle(road, k, Math.max(0, g.startIndex - 8), Math.min(n - 1, g.endIndex + 8));
    const angle = Math.abs(turn);
    g.dir = (Math.abs(turn) > 1e-3 ? turn : (road.kappa[apexIndex] || g.kappa)) > 0 ? 'R' : 'L';
    const hairpin = road.feature[apexIndex] === FEATURE.HAIRPIN || angle >= 150 * Math.PI / 180;
    // Feature inside the corner group (docs/03 §3 markFeatures): crest/dip/jump/water/bridge.
    const feats = [], featIds = [];
    for (let i = Math.max(0, g.startIndex - 25); i <= Math.min(n - 1, g.endIndex + 12); i++) {
      const f = road.feature[i];
      const fw = featureWord(f);
      if (fw && feats.indexOf(fw) < 0) { feats.push(fw); featIds.push(f); }
    }
    const graded = Math.abs(road.grade[apexIndex]) > 0.05;
    const cambered = Math.abs(road.camber[apexIndex]) > 0.035;
    let text = '';
    if (sev === 1) text += t('note.caution') + ' ';             // docs "Caution": the slowest class
    // ENGLISH calls the class as a word (ONE..FIVE) and the side as a word; the Polish
    // build keeps the compact numeric notation (1L) it always spoke.
    text += getLang() === 'en'
      ? `${t('note.sev' + Math.min(5, sev))} ${t(g.dir === 'L' ? 'note.left' : 'note.right')}`
      : `${sev}${g.dir}`;
    if (hairpin) text += ' ' + t('note.dontCut');               // cutting a >150 deg hairpin leaves the corridor
    if (cambered) text += ' ' + t(g.kappa > 0 ? 'note.horn' : 'note.dissa');
    if (feats.length) text += ' ' + feats.join(' ');
    const priority = (sev === 1 || hairpin
      || featIds.indexOf(FEATURE.JUMP) >= 0 || featIds.indexOf(FEATURE.WATER) >= 0)
      ? PRIORITY.HIGH : (sev >= 5 ? PRIORITY.LOW : PRIORITY.NORMAL);
    // Speed the note is timed against: what the ghost carries at the apex.
    const v = Math.max(4, ghost.speedAt(apexArc));
    const mu = ghost.muEff[apexIndex] ?? effectiveMu(surface(road.surfaceId[apexIndex]), 0, 0);
    const aBrake = Math.max(3, mu * G * 0.85);
    // Time rule first (docs/07 F4), braking distance second (docs/02 §6).
    const lead = Math.max(v * LEAD_TARGET, (v * v) / (2 * aBrake), 22);
    notes.push({
      kind: KIND.CORNER, priority, text, severity: sev, dir: g.dir,
      radius: g.radius, apexIndex, apexArc, arcFrom: g.startArc, arcTo: g.endArc,
      angle, hairpin, graded, cambered, features: feats, parts: g.parts,
      ghostSpeed: v, brakeDecel: aBrake, lead, leadTime: lead / v,
      triggerArc: apexArc - lead, duration: speechDuration(text),
    });
    return notes[notes.length - 1];
  };
  for (const g of groups) pushNote(g);

  // ---- 2. feature-only notes: a crest/jump/bridge where the road is otherwise flat ----
  for (let i = 1; i < n - 1; i++) {
    const f = road.feature[i];
    const word = featureWord(f);
    if (!word) continue;
    if (Math.abs(k[i]) > 1 / flat) continue;              // already inside a corner note
    let near = false;
    for (const nn of notes) if (Math.abs(nn.apexArc - road.s[i]) < 70) { near = true; break; }
    if (near) continue;
    // Collapse consecutive samples of the same feature into one call.
    let last = false;
    for (const q of notes) if (q.kind === KIND.FEATURE && q.featureId === f && Math.abs(q.apexArc - road.s[i]) < 60) { last = true; break; }
    if (last) continue;
    const v = Math.max(4, ghost.speedAt(road.s[i]));
    const mu = ghost.muEff[i] ?? effectiveMu(surface(road.surfaceId[i]), 0, 0);
    const aBrake = Math.max(3, mu * G * 0.85);
    const lead = Math.max(v * LEAD_TARGET, (v * v) / (2 * aBrake), 22);
    notes.push({
      kind: KIND.FEATURE, priority: (f === FEATURE.JUMP || f === FEATURE.WATER) ? PRIORITY.HIGH : PRIORITY.NORMAL,
      text: word, severity: 0, dir: '', radius: Infinity,
      apexIndex: i, apexArc: road.s[i], arcFrom: road.s[i], arcTo: road.s[i],
      featureId: f, features: [word], hairpin: false, graded: false, cambered: false, parts: 1,
      ghostSpeed: v, brakeDecel: aBrake, lead, leadTime: lead / v,
      triggerArc: road.s[i] - lead, duration: speechDuration(word),
    });
  }

  // ---- 3. flat-out sections: "HANT" (hands off) only where the spline really is flat ----
  {
    let runStart = -1;
    for (let i = 0; i <= n; i++) {
      const flatHere = i < n && Math.abs(k[i]) <= 1 / flat;
      if (flatHere && runStart < 0) runStart = i;
      if ((!flatHere || i === n) && runStart >= 0) {
        const len = road.s[Math.min(n - 1, i - 1)] - road.s[runStart];
        if (len >= STRAIGHT_MIN) {
          let near = false;
          for (const nn of notes) if (nn.apexArc >= road.s[runStart] - 5 && nn.apexArc <= road.s[i - 1] + 5) { near = true; break; }
          if (!near) {
            const v = Math.max(4, ghost.speedAt(road.s[runStart] + 40));
            notes.push({
              kind: KIND.STRAIGHT, priority: PRIORITY.LOW, text: 'HANT', severity: 0, dir: '',
              radius: Infinity, apexIndex: runStart, apexArc: road.s[runStart],
              arcFrom: road.s[runStart], arcTo: road.s[Math.min(n - 1, i - 1)],
              features: [], hairpin: false, graded: false, cambered: false, parts: 1,
              ghostSpeed: v, brakeDecel: 8, lead: 0, leadTime: 0,
              triggerArc: road.s[runStart] + 5, duration: speechDuration('HANT'),
            });
          }
        }
        runStart = -1;
      }
    }
  }

  notes.sort((a, b) => a.apexArc - b.apexArc);

  // ---- 4. order + minimum gap: push triggers apart, merge when a note no longer fits ----
  const kept = [];
  let merged = 0, dropped = 0;
  for (const nn of notes) {
    const prev = kept[kept.length - 1];
    if (prev && nn.kind === KIND.CORNER && prev.kind === KIND.CORNER) {
      const minAllowed = nn.apexArc - nn.ghostSpeed * LEAD_MIN;   // the docs/07 F4 floor
      let trig = nn.triggerArc;
      if (trig < prev.triggerArc + NOTE_MIN_GAP) trig = prev.triggerArc + NOTE_MIN_GAP;
      if (trig > minAllowed) {
        // Two corners closer than the voice can name separately: one combined call,
        // exactly like a real co-driver ("5L → 4R"). Not a dropped corner.
        prev.text = `${prev.text} → ${nn.text}`;
        prev.duration = speechDuration(prev.text);
        prev.priority = Math.max(prev.priority, nn.priority);
        prev.arcTo = Math.max(prev.arcTo, nn.arcTo);
        prev.parts += nn.parts;
        prev.mergedWith = (prev.mergedWith || 0) + 1;
        merged++;
        continue;
      }
      nn.triggerArc = trig;
      nn.lead = nn.apexArc - trig;
      nn.leadTime = nn.lead / nn.ghostSpeed;
    } else if (prev && trigIsBefore(nn, prev)) {
      dropped++;                                     // feature note inside an earlier call window
      continue;
    }
    kept.push(nn);
  }
  for (let i = 0; i < kept.length; i++) kept[i].index = i;

  return {
    seed: road.seed, notes: kept, extrema, merged, dropped,
    count: kept.length,
  };

  function trigIsBefore(a, b) { return a.triggerArc < b.triggerArc; }
}

// ---------------------------------------------------------------------------
// The HUD note cursor: ONE note (the corner actually being approached) plus at most
// one small preview of the next. Distances and the countdown are the real metres to
// the corner and the seconds left at the car's CURRENT speed - never the ghost lead
// the voice trigger is built on, which is what made signs appear far too early.
export const NOTE_VIEW_S = 2.6;    // s of road the active sign covers
export const NOTE_VIEW_MIN = 55;   // m floor: a slow/stopped car still sees the bend

/**
 * @param notes note array from buildPaceNotes (sorted by apexArc)
 * @param arc   distance the car has covered on the spline
 * @param speed current ground speed in m/s
 * @returns {active, activeDist, activeEta, preview, previewDist, previewEta}
 */
export function selectNotes(notes, arc, speed, opts = {}) {
  const secs = opts.secs ?? NOTE_VIEW_S;
  const floor = opts.min ?? NOTE_VIEW_MIN;
  const v = Math.max(0, speed || 0);
  const win = Math.max(floor, v * secs);
  const out = { active: null, activeDist: 0, activeEta: 0, preview: null, previewDist: 0, previewEta: 0 };
  const ahead = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const dd = n.apexArc - arc;
    if (dd <= -2) continue;                     // already driven through
    if (dd > win * 2) break;                    // sorted by apexArc: nothing nearer follows
    ahead.push({ n, dd });
  }
  if (ahead.length && ahead[0].dd <= win) {
    out.active = ahead[0].n;
    out.activeDist = Math.max(0, ahead[0].dd);
    out.activeEta = out.activeDist / Math.max(3, v);
    if (ahead.length > 1) {
      out.preview = ahead[1].n;
      out.previewDist = Math.max(0, ahead[1].dd);
      out.previewEta = out.previewDist / Math.max(3, v);
    }
  }
  return out;
}

// The runtime cursor lives in voice.js (Voice.advance walks the note list on the fixed
// sim step and emits 'pace-note' on the bus) so exactly one module decides *when* a
// note is called — the HUD only previews what that cursor has not consumed yet.
