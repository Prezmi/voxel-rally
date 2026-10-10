// Perf harness for ?perftest=1 only. Never installed without that flag
// (main.js `params()` -> cfg.perftest). It samples the *live* rAF loop, so the
// numbers are real wall-clock frame times, not the shot-mode render probe.
//
// One console line every 2 s with: fps, frame ms mean/p95, draw calls,
// triangles, resident terrain chunks, prop instances, tile instances.
// A final line starting PERF_SUMMARY carries the fps at 10 s / 30 s / 60 s.
import { DT } from '../core/time.js';

const MARKS = [10000, 30000, 60000];

// The same lines go to the console (the ask) and, under the flag only, into a
// hidden #perflog node: headless Chrome 149 does not forward page console.log to
// stderr, so `--dump-dom` is how a run is actually captured.
function emit(line) {
  console.log(line);
  try {
    let el = document.getElementById('perflog');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'perflog';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    el.textContent += line + '\n';
  } catch (e) { /* DOM not ready: console line is enough */ }
}

export function startPerfHarness({ loop, renderer, stream, dirt, carGroup, durationMs = 70000 }) {
  // Triangles the *car* costs, measured once: the scene graph under view.group is
  // static (only matrices change), so one walk at boot is enough and the harness can
  // attribute the difference between renderer.info.tris and the stream's own layers.
  let carTris = 0;
  if (carGroup) {
    carGroup.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const g = o.geometry;
      carTris += g.index ? g.index.count / 3 : (g.attributes.position ? g.attributes.position.count / 3 : 0);
    });
  }

  const t0 = performance.now();
  let prev = t0;
  let winFrames = 0;
  let winSum = 0;
  const winD = [];                       // frame deltas of the open 2 s window
  const fpsAt = {};
  const inner = loop.onFrame;
  let ended = false;
  let lastLog = 0;
  let lastFps = 0;                   // fps of the most recent completed window
  // Sim advance, counted where it actually happens (a stepSim wrapper), so the
  // number is honest even if the loop forgets to pay back its accumulator.
  let simSteps = 0, simStepsAt = 0;
  const stepFn = loop.stepSim;
  loop.stepSim = (dt) => { simSteps++; stepFn(dt); };

  const p95 = () => {
    if (!winD.length) return 0;
    const s = Float64Array.from(winD);
    s.sort();
    return s[Math.min(s.length - 1, Math.max(0, Math.round(s.length * 0.95) - 1))];
  };

  loop.onFrame = (l) => {
    const now = performance.now();
    const d = now - prev;
    prev = now;
    if (d > 0 && d < 8000) { winFrames++; winSum += d; winD.push(d); }

    const t = now - t0;
    for (const m of MARKS) if (fpsAt[m] === undefined && t >= m) {
      fpsAt[m] = winFrames >= 3 ? 1000 / (winSum / winFrames) : lastFps;
    }

    if (t - lastLog >= 2000 && winFrames >= 3) {   // one line / 2 s
      lastLog = t;
      const mean = winSum / winFrames;
      const ss = (simSteps - simStepsAt) * DT / Math.max(1e-3, winSum / 1000);
      const st = stream.stats;
      const bd = st.breakdown || {};
      const k = (v) => (((v || 0) / 1000).toFixed(1));
      const sp = st.species || {};
      const spLine = Object.entries(sp).filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]).map(([n2, n]) => `${n2}=${n}`).join(' ');
      // The same rate-independence check as before, plus the per-category triangle
      // cost so "the trees eat the frame" is a number and not a feeling.
      emit(`PERF t=${(t / 1000).toFixed(1)}s fps=${(1000 / mean).toFixed(1)} ` +
        `sim=${ss.toFixed(3)} s/s ` +
        `frame=${mean.toFixed(2)}/${p95().toFixed(2)}ms calls=${renderer.info.calls} ` +
        `tris=${renderer.info.tris} stris=${st.tris} chunks=${st.chunks} props=${st.props} tiles=${st.tiles} ` +
        `remesh=${st.remeshes} gen=${st.generated} dirtMs=${dirt.stats.msMean.toFixed(2)}`);
      emit(`PERF_BD ktris trees=${k(bd.treesNear + bd.treesFar)}(near ${k(bd.treesNear)}/far ${k(bd.treesFar)}) ` +
        `props=${k(bd.propsNear + bd.propsFar + bd.other)} terrain=${k(bd.terrain)} tiles=${k(bd.tiles)} ` +
        `car=${(carTris / 1000).toFixed(1)} other=${((renderer.info.tris - (bd.treesNear + bd.treesFar + bd.propsNear + bd.propsFar + bd.other + bd.terrain + bd.tiles) - carTris) / 1000).toFixed(1)} ` +
        `species ${spLine}`);
      winFrames = 0; winSum = 0; winD.length = 0;
      lastFps = 1000 / mean;
      simStepsAt = simSteps;
    }

    if (!ended && t >= durationMs) {
      ended = true;
      const g = (m) => (fpsAt[m] !== undefined ? fpsAt[m].toFixed(1) : 'n/a');
      const st = stream.stats;
      const bd = st.breakdown || {};
      const k = (v) => (((v || 0) / 1000).toFixed(1));
      emit(`PERF_SUMMARY fps@10s=${g(10000)} fps@30s=${g(30000)} fps@60s=${g(60000)} ` +
        `chunks=${st.chunks} props=${st.props} tiles=${st.tiles} ` +
        `calls=${renderer.info.calls} tris=${renderer.info.tris}`);
      emit(`PERF_SUMMARY_BD ktris trees=${k(bd.treesNear + bd.treesFar)}(near ${k(bd.treesNear)}/far ${k(bd.treesFar)}) ` +
        `props=${k(bd.propsNear + bd.propsFar + bd.other)} terrain=${k(bd.terrain)} tiles=${k(bd.tiles)} car=${(carTris / 1000).toFixed(1)}`);
    }
    if (inner) inner(l);
  };
}
