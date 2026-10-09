// F3 acceptance tool (docs/07 "Faza 3 — Brud", criterion A/B/C).
// Drives the car for 30 simulated seconds on a purpose-built flat strip of each
// of the four surfaces, prints the 16-panel dirt vector and proves the four masks
// differ in WHICH panels, in thickness and in tone — not merely in brightness.
// Headless: no GPU, no renderer, only the dirt system and the physics.
import { Vehicle } from '../src/car/vehicle.js';
import { DirtSystem } from '../src/dirt/dirt.js';
import { PanelDirt, PANELS, PANEL_COUNT } from '../src/dirt/panel-dirt.js';
import { SURF, surface } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';

const G = 9.81;
// settings.lensDirt default: the lens is a dialled accent, never a filter over the
// road (PLAN.md §8 #5).
const LENS_DEFAULT = 0.45;

/** Same synthetic ground the physics regression tests use (src/debug/tests.js). */
class FlatWorld {
  constructor(surfaceId) { this.surfaceId = surfaceId; this.rutDepth = 0; }
  groundHeight() { return 0; }
  surfaceAt() { return this.surfaceId; }
  rutAt() { return this.rutDepth; }
  addRut() { return false; }
  breakLooseBlock() { return false; }
  columnTopAt() { return 0; }
}

/** Oval the car follows: pure pursuit with a handbrake pulse, so the run produces
 *  both rolling churn (straight) and slip (the pulses). */
function driveSurface(surfaceId, seconds = 30, lensAmount = LENS_DEFAULT) {
  const world = new FlatWorld(surfaceId);
  const car = new Vehicle('A', world, { assists: { abs: false, tc: false, counterSteer: false, autoShift: true } });
  const dirt = new DirtSystem();
  dirt.lens.setAmount(lensAmount);
  const R = 70;
  car.placeAt(0, 0, 0, 0);

  const input = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
  const steps = Math.round(seconds / DT);
  let steerCmd = 0;
  let t0 = performance.now();
  let frames = 0;
  let peakLens = 0;
  for (let i = 0; i < steps; i++) {
    const sp = Math.max(1, car.body.groundSpeed);
    const look = Math.max(16, sp * 1.2);
    const th = Math.atan2(car.body.pos.z + R, car.body.pos.x) - look / R;
    const tx = R * Math.cos(th), tz = -R + R * Math.sin(th);
    const heading = Math.atan2(car.body.forward.z, car.body.forward.x);
    let dAng = Math.atan2(tz - car.body.pos.z, tx - car.body.pos.x) - heading;
    while (dAng > Math.PI) dAng -= 2 * Math.PI;
    while (dAng < -Math.PI) dAng += 2 * Math.PI;
    const cmd = -Math.atan((2 * car.params.wheelbase * Math.sin(dAng)) / look) / car.params.steerMax;
    steerCmd += (cmd - steerCmd) * Math.min(1, 12 * DT);
    input.steer = Math.max(-1, Math.min(1, steerCmd));
    input.throttle = 0.9;
    input.brake = 0;
    input.handbrake = (i % 1080) < 70 ? 0.7 : 0;   // a slide every 9 s
    car.setInput(input);
    car.step(DT);
    dirt.step(car, DT);
    if (dirt.lens.severity() > peakLens) peakLens = dirt.lens.severity();
    if (frames % 8 === 7) dirt.frame(car);   // 60 Hz render cadence
    frames++;
  }
  const total = performance.now() - t0;
  return { car, dirt, seconds, steps, frames, peakLens, msPerStep: total / frames };
}

/** Parked control: the car must not collect anything. */
function parkedRun(surfaceId, seconds = 30) {
  const world = new FlatWorld(surfaceId);
  const car = new Vehicle('A', world, { assists: { abs: false, tc: false, counterSteer: false, autoShift: true } });
  const dirt = new DirtSystem();
  car.placeAt(0, 0, 0, 0);
  const input = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
  for (let i = 0; i < Math.round(seconds / DT); i++) { car.setInput(input); car.step(DT); dirt.step(car, DT); }
  return dirt;
}

// ---------------------------------------------------------------- reporting
const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

function vector(dirt) {
  const out = [];
  for (let i = 0; i < PANEL_COUNT; i++) {
    out.push({ key: PANELS[i].key, name: PANELS[i].name, load: dirt.panels.load(i), thick: dirt.panels.thick[i], wet: dirt.panels.wet[i], dust: dirt.panels.dust[i], tone: hex(dirt.panels.cr[i], dirt.panels.cg[i], dirt.panels.cb[i]) });
  }
  return out;
}

function toneRGB(dirt, i) { return [dirt.panels.cr[i], dirt.panels.cg[i], dirt.panels.cb[i]]; }

function dirtySet(dirt) {
  const s = new Set();
  for (let i = 0; i < PANEL_COUNT; i++) if (dirt.panels.load(i) >= 0.15) s.add(i);
  return s;
}

function jaccardDistance(a, b) {
  let inter = 0;
  for (const v of a) if (b.has(v)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : 1 - inter / union;
}

function meanThick(dirt) {
  let s = 0;
  for (let i = 0; i < PANEL_COUNT; i++) s += dirt.panels.thick[i];
  return s / PANEL_COUNT;
}

/** Colour distance over the panels that are actually dirty on either car. */
function toneDistance(a, b) {
  const set = new Set([...dirtySet(a), ...dirtySet(b)]);
  if (!set.size) return 0;
  let s = 0, n = 0;
  for (const i of set) {
    const ra = toneRGB(a, i), rb = toneRGB(b, i);
    s += Math.hypot(ra[0] - rb[0], ra[1] - rb[1], ra[2] - rb[2]) * 255;
    n++;
  }
  // Weight the mean by how dirty the panel is on either car, so an empty panel
  // pair cannot dilute the number.
  let wsum = 0, w = 0;
  for (const i of set) {
    const weight = Math.max(a.panels.load(i), b.panels.load(i));
    const ra = toneRGB(a, i), rb = toneRGB(b, i);
    wsum += Math.hypot(ra[0] - rb[0], ra[1] - rb[1], ra[2] - rb[2]) * 255 * weight;
    w += weight;
  }
  return w > 0 ? wsum / w : s / Math.max(1, n);
}

const KEYS = ['gravel', 'asphalt', 'mud', 'snow'];
const IDS = { gravel: SURF.GRAVEL, asphalt: SURF.ASPHALT, mud: SURF.MUD, snow: SURF.SNOW };
const runs = {};
console.log('VOXEL RALLY — F3 dirt mask test (30 s per surface)\n');
for (const k of KEYS) {
  const r = driveSurface(IDS[k], 30);
  runs[k] = r;
  const v = vector(r.dirt);
  const surf = surface(IDS[k]);
  console.log(`${k.toUpperCase()}  surface dirtColor ${hex(...[
    ((surf.dirtColor >> 16) & 255) / 255, ((surf.dirtColor >> 8) & 255) / 255, (surf.dirtColor & 255) / 255,
  ])}  endSpeed ${r.car.body.groundSpeed.toFixed(1)} m/s  slipTotal ${(r.car.slipTotal / 1000).toFixed(1)} kW  rubber ${r.dirt.panels.rubber.map((x) => x.toFixed(2)).join('/')}`);
  for (const p of v) {
    if (p.load < 0.02) continue;
    console.log(`   ${p.name.padEnd(16)} load ${p.load.toFixed(3)}  thick ${p.thick.toFixed(3)} wet ${p.wet.toFixed(3)} dust ${p.dust.toFixed(3)}  tone ${p.tone}`);
  }
  const compact = v.map((p) => `${p.load.toFixed(2)}`).join(' ');
  console.log(`   vector: [${compact}]`);
  console.log(`   tone:   ${v.map((p) => p.tone).join(' ')}`);
  console.log('');
}

// ---- A: the four masks differ
console.log('--- mask differences (pairwise) ---');
let minJac = 1, minTone = 999, minThick = 999, minChannel = 999;
for (let a = 0; a < KEYS.length; a++) {
  for (let b = a + 1; b < KEYS.length; b++) {
    const ka = KEYS[a], kb = KEYS[b];
    const da = runs[ka].dirt, db = runs[kb].dirt;
    const jd = jaccardDistance(dirtySet(da), dirtySet(db));
    // A mask may differ in any of the three channels docs/04 defines (thick plate,
    // wet sheen, dry dust), so the distance is the widest channel difference.
    let th = 0, we = 0, du = 0;
    for (let i = 0; i < PANEL_COUNT; i++) {
      th += Math.abs(da.panels.thick[i] - db.panels.thick[i]);
      we += Math.abs(da.panels.wet[i] - db.panels.wet[i]);
      du += Math.abs(da.panels.dust[i] - db.panels.dust[i]);
    }
    const channel = Math.max(th, we, du);
    minChannel = Math.min(minChannel, channel);
    const tone = toneDistance(da, db);
    minJac = Math.min(minJac, jd); minTone = Math.min(minTone, tone); minThick = Math.min(minThick, th);
    const setA = [...dirtySet(da)].map((i) => PANELS[i].key).join(',');
    const setB = [...dirtySet(db)].map((i) => PANELS[i].key).join(',');
    console.log(`${ka} vs ${kb}: jaccardDist=${jd.toFixed(2)}  channelL1 max(thick ${th.toFixed(2)}, wet ${we.toFixed(2)}, dust ${du.toFixed(2)}) = ${channel.toFixed(2)}  toneDelta=${tone.toFixed(0)}/255`);
    console.log(`   dirty(${ka}) = ${setA || '-'}`);
    console.log(`   dirty(${kb}) = ${setB || '-'}`);
  }
}
{
  const da = runs.gravel.dirt, db = runs.mud.dirt;
  var mgThick = 0;
  for (let i = 0; i < PANEL_COUNT; i++) mgThick += Math.abs(da.panels.thick[i] - db.panels.thick[i]);
}
const park = parkedRun(SURF.GRAVEL, 30);
const parkLoad = park.panels.totalLoad();
const parkRubber = runs.asphalt.dirt.panels.rubber.reduce((s, v) => s + v, 0);
const asphaltLoad = runs.asphalt.dirt.panels.totalLoad();
const mudLoad = runs.mud.dirt.panels.totalLoad();
const mudTone = runs.mud.dirt, aspTone = runs.asphalt.dirt;
let aspMudTone = 0;
for (let i = 0; i < PANEL_COUNT; i++) {
  const ra = toneRGB(aspTone, i), rm = toneRGB(mudTone, i);
  aspMudTone = Math.max(aspMudTone, Math.hypot(ra[0] - rm[0], ra[1] - rm[1], ra[2] - rm[2]) * 255);
}
console.log(`parked(30 s on gravel): totalLoad=${parkLoad.toFixed(4)} rubber=${park.panels.rubber.reduce((s, v) => s + v, 0).toFixed(3)}`);
console.log(`asphalt totalLoad=${asphaltLoad.toFixed(3)} asphalt-vs-mud max tone delta=${aspMudTone.toFixed(0)}/255 asphalt rubber sum=${parkRubber.toFixed(2)}`);
console.log(`min pairwise: jaccardDist=${minJac.toFixed(2)} channelL1=${minChannel.toFixed(2)} mudVsGravelThickL1=${mgThick.toFixed(2)} toneDelta=${minTone.toFixed(0)}/255`);

// ---- B: wash
console.log('\n--- wash (docs/04 §4.2: dirtMap *= 0.08, panelDirt *= 0.1, rubber stays) ---');
const washResults = [];
for (const k of KEYS) {
  const d = runs[k].dirt;
  const before = d.panels.totalLoad();
  const toneBefore = toneRGB(d, 5);
  const rubberBefore = d.panels.rubber.reduce((s, v) => s + v, 0);
  d.washFull(1);
  const after = d.panels.totalLoad();
  const rubberAfter = d.panels.rubber.reduce((s, v) => s + v, 0);
  const toneAfter = toneRGB(d, 5);
  const ratio = before > 0 ? after / before : 0;
  washResults.push({ k, before, after, ratio, rubberAfter });
  console.log(`${k}: before ${before.toFixed(3)} -> after ${after.toFixed(3)}  ratio ${(ratio * 100).toFixed(2)}%  tonePanel(PRÓG L) ${hex(...toneBefore)} -> ${hex(...toneAfter)}  rubber sum ${rubberBefore.toFixed(2)} -> ${rubberAfter.toFixed(2)}`);
}
const worstRatio = Math.max(...washResults.map((r) => r.ratio));
const rubberKept = Math.min(...washResults.map((r) => r.rubberAfter));

// ---- C: cost
console.log('\n--- cost (300 frames of the whole dirt system) ---');
{
  const world = new FlatWorld(SURF.GRAVEL);
  const car = new Vehicle('A', world, { assists: { abs: false, tc: false, counterSteer: false, autoShift: true } });
  const dirt = new DirtSystem();
  car.placeAt(0, 0, 0, 0);
  car.body.vel.x = 22;
  car.wheels.forEach((w) => { w.omega = 22 / w.rEff; });
  const input = { throttle: 0.8, brake: 0, steer: 0.25, handbrake: 0, shiftUp: 0, shiftDown: 0 };
  for (let i = 0; i < 240; i++) { car.setInput(input); car.step(DT); dirt.step(car, DT); } // warm up
  const samples = [];
  for (let i = 0; i < 300; i++) {
    const t0 = performance.now();
    car.setInput(input); car.step(DT); dirt.step(car, DT);
    samples.push(performance.now() - t0);
  }
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const sorted = samples.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.floor(samples.length * 0.95)];
  console.log(`sim+ DirtSystem per 1/120 step: mean ${mean.toFixed(3)} ms  p95 ${p95.toFixed(3)} ms  max ${sorted[samples.length - 1].toFixed(3)} ms`);
  // The frame budget view: 8 substeps per 60 Hz frame (what main.js really runs).
  console.log(`per rendered frame (8 substeps): mean ${(mean * 8).toFixed(3)} ms  p95 ${(p95 * 8).toFixed(3)} ms  (budget 1.20 ms)`);
  console.log('dirt-only system mean ' + dirt.stats.msMean.toFixed(3) + ' ms/step p95 ' + dirt.p95().toFixed(3) + ' ms max ' + dirt.stats.msMax.toFixed(3) + ' ms  splats/frame ' + dirt.stats.splats);
  var costMean = mean * 8, costP95 = p95 * 8;
}

// ---- verdict
const ok = [];
ok.push(['four masks differ in panel set (min jaccardDist >= 0.35)', minJac >= 0.35, minJac.toFixed(2)]);
ok.push(['four masks differ in thickness/wetness/dust (min channelL1 >= 1.2)', minChannel >= 1.2, minChannel.toFixed(2)]);
ok.push(['gravel vs mud differ in plate thickness (thickL1 >= 1.5)', mgThick >= 1.5, mgThick.toFixed(2)]);
ok.push(['four masks differ in tone (min toneDelta >= 25/255)', minTone >= 25, minTone.toFixed(0)]);
ok.push(['parked car gains no dirt', parkLoad < 0.01, parkLoad.toFixed(4)]);
ok.push(['asphalt does not gain mud-toned dirt', aspMudTone > 40 && asphaltLoad < mudLoad * 0.5, 'delta ' + aspMudTone.toFixed(0) + ' load ' + asphaltLoad.toFixed(2) + ' vs mud ' + mudLoad.toFixed(2)]);
ok.push(['wash leaves < 5% of the driven dirt', worstRatio < 0.05, `${(worstRatio * 100).toFixed(2)}%`]);
ok.push(['wash keeps tyre rubber', rubberKept > 0.2, rubberKept.toFixed(2)]);
ok.push(['dirt cost < 1.2 ms per frame', costMean < 1.2, `mean ${costMean.toFixed(3)} p95 ${costP95.toFixed(3)}`]);
console.log('');
for (const [name, pass, detail] of ok) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
const failed = ok.filter((r) => !r[1]);
console.log(`\n${ok.length - failed.length}/${ok.length} acceptance checks passed`);
if (failed.length) process.exitCode = 1;

export { driveSurface, parkedRun, runs };

// --- lens readability (settings.lensDirt, PLAN.md §8 #5) -----------------------
// The lens is the one dirt surface the player cannot look away from: 60 s of gravel
// with handbrake slides must leave the view readable, and lensDirt = 0 must be spotless.
console.log('\n--- lens readability (60 s gravel with slides) ---');
const lensDefault = driveSurface(SURF.GRAVEL, 60, 0.45);
const lensFull = driveSurface(SURF.GRAVEL, 60, 1.0);
const lensOff = driveSurface(SURF.GRAVEL, 60, 0);
for (const [name, r] of [['lensDirt 0.45 (default)', lensDefault], ['lensDirt 1.0', lensFull], ['lensDirt 0', lensOff]]) {
  const l = r.dirt.lens;
  console.log(`${name.padEnd(24)} peak severity ${r.peakLens.toFixed(3)}  end smudge ${l.smudge.toFixed(3)} grime ${l.grime.toFixed(3)} blobs ${l.blobCount}`);
}
const lensChecks = [
  ['view stays readable at the default lens strength (peak severity <= 0.30)', lensDefault.peakLens <= 0.30, lensDefault.peakLens.toFixed(3)],
  ['lensDirt 0 keeps the view spotless', lensOff.peakLens < 1e-6, lensOff.peakLens.toFixed(6)],
  ['the wiper/airflow keep grime below its cap', lensDefault.dirt.lens.grime <= 0.30, lensDefault.dirt.lens.grime.toFixed(3)],
  ['full strength is a visible, stronger option', lensFull.peakLens > lensDefault.peakLens, `${lensFull.peakLens.toFixed(3)} > ${lensDefault.peakLens.toFixed(3)}`],
];
let lensPass = 0;
for (const [name, ok, detail] of lensChecks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (ok) lensPass++; }
console.log(`${lensPass}/${lensChecks.length} lens readability checks passed`);
