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

`src/world/stage.js` is pure and deterministic. A Catmull Rom spline
winds across a 256 x 256 m heightfield (fbm value noise); the road is
carved to smoothly varying heights with grades capped near 14%.
Surfaces are painted per cell: road, centre line and dashed markings
on the straights, dirt shoulders, biome ground elsewhere. Corners are
scored from curvature into severities 1 (tightest) to 6 (fastest) and
get chevron boards. Props are scattered by biome with the road kept
clear: trees, rocks, houses, tents, vans, spectators, fences, hay
bales, start/finish gantry and checkpoint banners.

Rendering (`src/world/mesher.js`) meshes 16 x 16 cell chunks. Only
visible faces are emitted: column sides appear only where the
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
mesh for all props, one for the car body. A gradient sky dome with a
sun glow, voxel clouds, distance fog matched to the horizon, ACES
tone mapping, and a shadow-casting sun that follows the car. Dust is
a single pooled `THREE.Points` system coloured by surface. Sound is
a small WebAudio synth: engine oscillators, wind and skid noise,
beeps. Quality settings scale view distance, shadow size, pixel
ratio and dust rate for a 60 fps target at Medium on a laptop.

Deliberately skipped for stability: a ghost car of the best run.
