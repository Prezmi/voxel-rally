# VOXEL RALLY v2 — design notes

The v2 rebuild keeps only the concept from v1: voxel rally time
attack in the browser, Three.js, no build step. Everything else was
written fresh.

## Pillars

1. Chunky and readable. Big voxels, bold colours, hard shadows, one
   texture atlas. The game should read at a glance at speed.
2. The surface is the game. Grip, drag and dust differ per surface,
   and the road is always the fast line.
3. Rally structure, arcade feel. Countdown, checkpoints, splits,
   pace notes, best times. Physics is weighty but forgiving: the
   drift model damps lateral velocity by surface grip instead of
   simulating tyres.

## World generation

`src/world/stage.js` is pure and deterministic. There is no fixed
world box: a stage is a route (a Catmull Rom spline sampled every
metre, kilometres long) plus analytic terrain. Ground height and
surface at any point are computed on demand from seeded noise blended
into the road's height profile near the route, cached per 1 m column.
Named stages use hand authored routes written as segment lists
(length + total heading change); the generator fits the spline to the
design length, so a 6.1 km Ouninpohja really is 6.1 km. Corners are
scored from curvature into severities 1 (tightest) to 6 (fastest) and
get chevron boards, red/white corner posts, rally tape, hay bales,
spectators and marshals. Checkpoints are spaced evenly along the
whole route.

Rendering (`src/world/mesher.js`) meshes 16 x 16 cell chunks with
hidden face culling, directional face shading and a cheap baked
ambient occlusion at block edges. Chunks stream in around the car
(a few per frame, distance sorted) and are disposed behind it; a
coarse vertex coloured shell mesh covers the whole stage area so the
horizon always has hills. Time of day presets (Day, Golden Hour,
Dusk, Overcast) drive the sky shader, sun, fog and exposure.
Only visible faces are emitted: column sides appear only where the
neighbour is lower, split into 1 m bands so textures never stretch.
Visual height is quantized to 0.25 m steps for the terraced voxel
look; physics uses the smooth heightfield.

## Car physics

`src/car/physics.js` is a pure fixed-step model. Velocity lives in
the world frame; forces are computed in the car frame. Lateral
velocity is damped exponentially by grip, which gives natural drifts
on loose surfaces and a big slide on the handbrake. Speed-sensitive
steering, slope gravity, crest airtime with landing impacts, and
per-surface drag round it out. Liveries scale grip and acceleration.

## Presentation

Merged geometry everywhere: one mesh per terrain chunk, one merged
prop mesh per chunk, one for the car body, one for the distant hill
shell. A gradient sky dome with sun disc and horizon haze, voxel
clouds tinted by the light, distance fog matched to the horizon,
ACES tone mapping, a CSS vignette, and a shadow-casting sun that
follows the car and swings with the time of day. Dust is a single
pooled `THREE.Points` system coloured by surface, and dirt visibly
builds up on the car's lower body the longer it runs loose. Sound
is a small WebAudio synth: engine oscillators, wind and skid noise,
beeps. Quality settings scale view distance, shadow size, pixel
ratio and dust rate for a 60 fps target at Medium on a laptop.

Deliberately skipped for stability: a ghost car of the best run.
