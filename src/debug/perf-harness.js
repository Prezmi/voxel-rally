// Perf harness for ?perftest=1 only. Never installed without that flag
// (main.js `params()` -> cfg.perftest). It samples the *live* rAF loop, so the
// numbers are real wall-clock frame times, not the shot-mode render probe.
//
// One console line every 2 s with: fps, frame ms mean/p95, draw calls,
// triangles, resident terrain chunks, prop instances, tile instances.
// A final line starting PERF_SUMMARY carries the fps at 10 s / 30 s / 60 s.
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

export function startPerfHarness({ loop, renderer, stream, dirt, durationMs = 70000 }) {
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
      const st = stream.stats;
      emit(`PERF t=${(t / 1000).toFixed(1)}s fps=${(1000 / mean).toFixed(1)} ` +
        `frame=${mean.toFixed(2)}/${p95().toFixed(2)}ms calls=${renderer.info.calls} ` +
        `tris=${renderer.info.tris} stris=${st.tris} chunks=${st.chunks} props=${st.props} tiles=${st.tiles} ` +
        `remesh=${st.remeshes} gen=${st.generated} dirtMs=${dirt.stats.msMean.toFixed(2)}`);
      winFrames = 0; winSum = 0; winD.length = 0;
      lastFps = 1000 / mean;
    }

    if (!ended && t >= durationMs) {
      ended = true;
      const g = (m) => (fpsAt[m] !== undefined ? fpsAt[m].toFixed(1) : 'n/a');
      const st = stream.stats;
      emit(`PERF_SUMMARY fps@10s=${g(10000)} fps@30s=${g(30000)} fps@60s=${g(60000)} ` +
        `chunks=${st.chunks} props=${st.props} tiles=${st.tiles} ` +
        `calls=${renderer.info.calls} tris=${renderer.info.tris}`);
    }
    if (inner) inner(l);
  };
}
