// Headless audit of the pace notes + the voice queue (docs/07 F4 criteria:
// "notatki są prawdziwe: 0 fałszywych, margines czasu ≥ 1.2 s przed zakrętem;
// pilot nie nakłada się (kolejka z priorytetem)"). No DOM, no GPU, no assets.
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { planGates } from '../src/game/stage.js';
import { solveGhost, GHOST_TUNE } from '../src/game/ghost.js';
import { buildPaceNotes, curvatureExtrema, FLAT_RADIUS, LEAD_MIN, NOTE_MIN_GAP } from '../src/game/pace-notes.js';
import { Voice } from '../src/game/voice.js';
import { Emitter } from '../src/core/events.js';

const SEED = 12345, BIOME = 'FOREST', LEN = 4200;
let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};

const terrain = makeTerrain(SEED, BIOME);
const road = buildRoad({ seed: SEED, lengthTarget: LEN, terrainHeightAt: terrain.heightAt, biome: BIOME });
const gates = planGates(road, SEED);

// Calibrated reference + the raw physics solve (the audit prints both so the
// reference margin in ghost.js is visible, not hidden).
const ghost = solveGhost(road, { seed: SEED, gates, carId: 'A' });
const raw = solveGhost(road, { seed: SEED, gates, carId: 'A', tune: { referenceSpeedMargin: 1 } });
const notes = buildPaceNotes(road, ghost);

console.log(`stage ${BIOME} seed ${SEED}  road ${road.length.toFixed(0)} m  nodes ${road.n}  gates ${gates.length}`);
console.log(`ghost: ref ${ghost.refTime.toFixed(2)} s (${(3.6 * ghost.avgSpeed).toFixed(1)} km/h avg)`
  + `   raw physics solve ${raw.refTime.toFixed(2)} s (${(3.6 * raw.avgSpeed).toFixed(1)} km/h avg)`
  + `   referenceSpeedMargin ${GHOST_TUNE.referenceSpeedMargin}  solve ${ghost.solveMs.toFixed(1)} ms`);
console.log(`notes: ${notes.count} (corner ${notes.notes.filter((n) => n.kind === 'corner').length},`
  + ` feature ${notes.notes.filter((n) => n.kind === 'feature').length},`
  + ` straight ${notes.notes.filter((n) => n.kind === 'straight').length})  merged ${notes.merged}  dropped ${notes.dropped}`);

console.log('\n i   trigger   apex   radius  class  ghost v   lead m  lead s  text');
for (const n of notes.notes) {
  const cls = n.severity ? `${n.severity}${n.dir}` : n.text.slice(0, 4);
  console.log(`${String(n.index).padStart(3)}  ${n.triggerArc.toFixed(0).padStart(7)}  ${n.apexArc.toFixed(0).padStart(6)}`
    + `  ${(isFinite(n.radius) ? n.radius.toFixed(1) : '—').padStart(7)}  ${cls.padStart(6)}`
    + `  ${n.ghostSpeed.toFixed(1).padStart(7)}  ${n.lead.toFixed(0).padStart(7)}  ${n.leadTime.toFixed(2).padStart(6)}  ${n.text}`);
}

// ---- C. ghost plausibility: never faster than sqrt(mu_eff * g * R) ----
let worstRatio = 0, exceeded = 0;
console.log('\n--- ghost vs friction circle (per sector, tightest corner)');
for (const s of ghost.sectors) {
  const ratio = s.ghostAtTightest / s.frictionCircleSpeed;
  worstRatio = Math.max(worstRatio, ratio);
  if (s.ghostAtTightest > s.frictionCircleSpeed + 1e-3) exceeded++;
  console.log(`  S${s.index} ${s.dist.toFixed(0)} m  czas ${s.time.toFixed(2)} s  avg ${(3.6 * s.avgSpeed).toFixed(1)} km/h`
    + `  R_min ${s.tightestRadius.toFixed(1)} m  ghost ${s.ghostAtTightest.toFixed(2)} m/s`
    + `  sqrt(mu*g*R) ${s.frictionCircleSpeed.toFixed(2)} m/s  ratio ${ratio.toFixed(3)}  mu_eff ${s.muEff.toFixed(3)}`);
}
ok(exceeded === 0 && ghost.overshoot === 0, 'C1 no corner is faster than sqrt(mu_eff*g*R)', `overshoot ${ghost.overshoot.toFixed(4)} m/s, worst ratio ${worstRatio.toFixed(3)}`);
ok(ghost.solveMs <= 200, 'C2 whole-stage solve <= 200 ms', `${ghost.solveMs.toFixed(1)} ms`);
ok(ghost.sectors.length === gates.length - 1, 'C3 per-sector reference times exist for every sector', `${ghost.sectors.length}`);

// ---- A1. every note maps to a real curvature feature of the spline ----
let falseNotes = 0;
for (const n of notes.notes) {
  if (n.kind !== 'corner') continue;
  const a = Math.max(0, Math.min(road.n - 1, Math.round(n.arcFrom) - 10));
  const b = Math.min(road.n - 1, Math.round(n.arcTo) + 10);
  let kMax = 0;
  for (let i = a; i <= b; i++) kMax = Math.max(kMax, Math.abs(road.kappa[i]));
  const realR = kMax > 1e-4 ? 1 / kMax : Infinity;
  if (realR > FLAT_RADIUS * 1.25) { falseNotes++; console.log(`    FALSE  note ${n.index} "${n.text}" at ${n.apexArc.toFixed(0)} m: tightest real radius in window ${realR.toFixed(0)} m`); }
  else if (n.radius > realR * 1.6) { falseNotes++; console.log(`    FALSE  note ${n.index} radius ${n.radius.toFixed(1)} vs spline ${realR.toFixed(1)}`); }
}
ok(falseNotes === 0, 'A1 0 false notes (each note sits on real spline curvature)', `${falseNotes} false`);

// ---- A2. no curvature extremum tighter than FLAT_RADIUS is left uncommented ----
// Independent scan of the raw kappa (no smoothing) at a wider comparison window.
const extrema = curvatureExtrema(road, { smooth: 0, window: 20, flatRadius: FLAT_RADIUS });
let misses = 0;
for (const e of extrema) {
  let covered = false;
  for (const n of notes.notes) {
    if (n.kind !== 'corner') continue;
    if (e.arc >= n.arcFrom - NOTE_MIN_GAP - 20 && e.arc <= n.arcTo + NOTE_MIN_GAP + 20) { covered = true; break; }
  }
  if (!covered) { misses++; console.log(`    MISS  extremum at ${e.arc.toFixed(0)} m  R ${e.radius.toFixed(1)} m  ${e.dir}`); }
}
ok(misses === 0, 'A2 every curvature extremum tighter than the flat threshold has a note',
  `${extrema.length} extrema, ${misses} misses`);

// ---- A3. lead time at ghost speed ----
let minLead = Infinity, maxLead = 0;
for (const n of notes.notes) {
  if (n.kind !== 'corner') continue;
  minLead = Math.min(minLead, n.leadTime); maxLead = Math.max(maxLead, n.leadTime);
}
ok(minLead >= LEAD_MIN, `A3 min lead time >= ${LEAD_MIN} s at ghost speed`, `${minLead.toFixed(2)} s .. ${maxLead.toFixed(2)} s`);

// ---- A4. ordering + no overlapping note windows ----
let orderOk = true, minGap = Infinity, minGapT = Infinity, minGapPair = '';
for (let i = 1; i < notes.notes.length; i++) {
  const p = notes.notes[i - 1], c = notes.notes[i];
  if (c.triggerArc <= p.triggerArc) orderOk = false;
  const gap = c.triggerArc - p.triggerArc;
  const gapT = gap / Math.max(1, c.ghostSpeed);
  if (gap < minGap) { minGap = gap; minGapPair = `${p.index}->${c.index}`; minGapT = gapT; }
}
ok(orderOk, 'A4 notes are ordered along the stage', orderOk ? '' : 'out of order');
ok(minGap >= NOTE_MIN_GAP - 1e-6, 'A4b note windows do not overlap (minimum trigger gap)',
  `${minGap.toFixed(1)} m  (${minGapT.toFixed(2)} s of stage time, pair ${minGapPair})`);

// ---- B. the voice queue serialises: walk the stage at ghost speed ----
const bus = new Emitter();
const track = { list: notes.notes };      // Voice walks the same list the HUD previews
const voice = new Voice({ notes: track, emit: bus, useSpeech: false });
let arc = 0, dt = 1 / 120, stageT = 0, guard = 0, maxQueue = 0, concurrent = 0;
const intervals = [];
bus.on('pace-note-spoken', (n) => { /* counted via spokenLog */ });
while (arc < road.length - 1 && guard++ < 2000000) {
  const v = Math.max(6, ghost.speedAt(arc));   // the first metres are a standing start
  arc += v * dt; stageT += dt;
  voice.advance(arc, dt);
  maxQueue = Math.max(maxQueue, voice.qLen);
  if (voice.speaking && voice.qLen > 0) concurrent++;
}
const log = voice.spokenLog;
let overlaps = 0;
for (let i = 1; i < log.length; i++) if (log[i].at - log[i - 1].at < log[i - 1].dur - 0.001) overlaps++;
console.log(`\n--- voice queue (driven at ghost speed, ${stageT.toFixed(1)} s of stage time)`);
console.log(`    called ${notes.count}  spoken ${log.length}  spoken time ${voice.speakTotal.toFixed(2)} s`
  + `  preemptions ${voice.interrupted}  too-late-dropped ${voice.lost}  max queue ${maxQueue}`);
console.log(`    first 6 spoken: ${log.slice(0, 6).map((l) => `${l.at.toFixed(1)}s "${l.text}" (${l.dur.toFixed(2)}s)`).join('  ')}`);
ok(overlaps === 0, 'B1 no two notes are spoken at the same time (priority queue)', `${overlaps} overlaps`);
ok(voice.speakTotal < stageT * 0.6, 'B2 total spoken time leaves the stage talking-free',
  `${voice.speakTotal.toFixed(2)} s of ${stageT.toFixed(1)} s (${(100 * voice.speakTotal / stageT).toFixed(1)} %)`);
ok(maxQueue <= 3, 'B3 the queue never fills up (nothing gets queued behind a backlog)', `max ${maxQueue} / 8`);
ok(log.length >= notes.count * 0.9, 'B4 nearly every note actually reaches the mic',
  `${log.length}/${notes.count} spoken, ${voice.lost} dropped as too late`);

// ---- D. determinism (PLAN.md §8 #7) ----
const ghost2 = solveGhost(road, { seed: SEED, gates, carId: 'A' });
const notes2 = buildPaceNotes(road, ghost2);
let diffV = 0, diffT = 0;
for (let i = 0; i < road.n; i++) { diffV = Math.max(diffV, Math.abs(ghost.v[i] - ghost2.v[i])); diffT = Math.max(diffT, Math.abs(ghost.t[i] - ghost2.t[i])); }
let diffNote = 0;
for (let i = 0; i < Math.max(notes.count, notes2.count); i++) {
  const a = notes.notes[i], b = notes2.notes[i];
  if (!a || !b) { diffNote++; break; }
  if (a.text !== b.text || a.triggerArc !== b.triggerArc || a.apexArc !== b.apexArc || a.leadTime !== b.leadTime) diffNote++;
}
ok(diffV === 0 && diffT === 0 && ghost.refTime === ghost2.refTime, 'D1 identical ghost for the same seed', `diff v ${diffV} s/t ${diffT}`);
ok(diffNote === 0 && notes.count === notes2.count, 'D2 identical notes for the same seed', `${diffNote} differing notes`);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures ? 1 : 0);
