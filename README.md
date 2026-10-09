# Voxel Rally

A browser-based procedural rally sim built with Three.js (ES modules, no bundler
required). Stages are time attacks against a clock and a ghost, not head-to-head
racing: the surface is the main opponent, each of the four wheels gets its own
load and slip, and the car visibly collects dirt according to what it drove on.
Everything — terrain, road, car mesh, textures, dirt, sound — is generated from a
seed in code; the repo contains no image, model or audio files.

Design inspiration and the three project pillars are in `PLAN.md` and
`docs/01-design.md`.

## Run it

```
npm run dev          # python3 -m http.server 8090
```

then open `index.html` at http://localhost:8090/ . No build step; `index.html`
carries the import map and `src/main.js` boots the stage.

```
npm test             # node src/debug/tests.js  (physics regression suite + determinism)
npm run test:world   # node src/debug/tests.js world
```

Stage options are query parameters handled in `src/main.js`: `?seed=`,
`?biome=`, `?car=`, `?len=`, `?surface=`, `?cam=`, `?tod=`, `?rain=`, `?q=`,
`?post=0`, `?frames=`, `?stats=1`.

## Controls

Verified against `src/game/input.js` and the `input.on(...)` block in `src/main.js`.

| Key | Action |
| --- | --- |
| `W` / `↑` | throttle |
| `S` / `↓` | brake |
| `A` `D` / `←` `→` | steer left / right |
| `Space` | handbrake |
| `Q` / `E` | shift down / up |
| `C` | cycle camera: CHASE → ONBOARD → BUMPER → FREE |
| `H` | toggle debug HUD |
| `N` | toggle rally HUD |
| `M` | mute / unmute the co-driver voice |
| `P` / `Esc` | pause |
| `R` | restart the run |
| `X` | wash the car (tyre rubber stays) |
| `V` | wipe the camera lens |
| `L` | cycle lens-dirt amount (0.45 → 0 → 1) |
| `B` | toggle rain |
| `F1` `F2` `F3` | difficulty NOVICE / RALLY / PRO |
| `1` `2` `3` | quality preset LOW / MED / HIGH |
| `Tab` / `Enter` | move focus in the menu / activate the menu item |

## How it is built

- `src/core/` — fixed-step loop, time (`DT = 1/120 s`), math, seeded RNG,
  settings, event bus.
- `src/car/` — vehicle body, suspension, tyre, wheel, steering, differential,
  powertrain, damage, raycast terrain contact.
- `src/world/` — noise, terrain generation, palette, surface table, road spline,
  road carve, chunks, mesher, streaming.
- `src/render/` — renderer, lighting, primitives, car mesh, camera, lens dirt,
  post composite.
- `src/dirt/` — dirt map, per-panel dirt, emitters, wash, dirt lens.
- `src/game/` — stage rules, timing, checkpoints/gates, ghost, pace notes,
  co-driver voice, rally HUD, input.
- `src/debug/` — on-screen HUD and the Node regression tests.
- `src/audio/` — planned procedural audio; currently empty.

Three.js r169 (MIT) is vendored at `vendor/three.module.js`, with
`vendor/addons/OrbitControls.js` and `vendor/addons/mergeGeometries.js`. It is
the only third-party dependency, and there are no binary assets of any kind.

## Status

Work in progress. `PLAN.md` §6 and `docs/07-roadmap.md` define phases F0–F7:

- F0 bootstrap, F1 world + box-car driving, F2 per-wheel physics — implemented.
- F3 dirt (map, panels, wash, lens) — implemented.
- F4 rally loop (stage, timing, penalties, pace notes, ghost, rally HUD) —
  implemented; `SYSTEM-NOTES.md` records its deviations.
- F5 polish — partially present (`src/render/post.js`, rut/trace-related world
  features); `src/audio/` is still empty, so the procedural engine/tyre/road
  audio described in `docs/05-audio.md` is not there yet.
- F6 content (8 stages, 4 cars, championship) and F7 hardening (gamepad,
  accessibility, balance, long-session stability) — not finished, although the
  LOW/MED/HIGH quality presets already exist.

Expect broken edges and unfinished systems; treat the repo as a sim under
construction.

## Physics

`docs/02-physics.md` specifies the model: a rigid body (1240 kg, semi-implicit
Euler) on four independent suspension arms whose normal load `N_i` is the only
source of grip, plus a per-wheel tyre model, differential, powertrain and
surface table, all run at a fixed `DT = 1/120 s`.

`PHYSICS-NOTES.md` is the running record of where the code has departed from that
document and why — e.g. solving the tyre slip/spin coupling implicitly instead of
explicitly, allowing the strut to pull, the handbrake lever being re-sized, and a
postmortem on `integrateQ` rotating the body about world axes while being fed
body-frame rates — each entry backed by measurements from `tools/`.

## Tools

`tools/*.mjs` are headless harness scripts: they import the sim straight from
`src/` (no renderer, no DOM) and drive it in Node, so physics can be validated
without a browser. They cover parked-car traces and road-bed behaviour
(`bed2..bed13`, `roadbed`, `place`), cornering and braking sweeps (`arc`, `arc2`,
`turn*`, `brake`, `hb`, `spin`), whole-stage drive-throughs (`smoke`, `long`,
`straight`), stability and energy diagnostics (`covar`, `grow`, `jac`, `stab`,
`nan`, `intq`, `steptrace`) and dirt/road masking checks (`dirtmask`,
`tile-tone`). `PHYSICS-NOTES.md` names which harness produced which measurement.
