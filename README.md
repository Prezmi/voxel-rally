# VOXEL RALLY

Colin McRae meets Minecraft: a chunky voxel rally time attack that runs
in the browser. Drive a box-built rally car flat out through the
classic championship stages, against the clock and your own best time.

## The championship

Eight named stages recreate the character of the classic Colin McRae
Rally tests, each with a hand authored route, its own surfaces,
scenery and light:

| Stage | Country | Length | Character |
| --- | --- | --- | --- |
| Sweet Lamb | Wales, UK | 4.6 km | Mud and gravel, tight forest, overcast, puddles |
| Ouninpohja | Finland | 6.1 km | Flat out gravel, endless crests, lakes, golden hour |
| Acropolis | Greece | 4.6 km | Rocky switchbacks and hairpins, harsh sun |
| Col de Turini | Monte Carlo | 3.6 km | Tarmac hairpin stacks, ice on shaded corners, stone walls |
| Safari | Kenya | 7.2 km | Very fast red dirt across open savanna |
| Vargasen | Sweden | 5.6 km | Snow, snow banks, fast sweeping corners |
| Mineshaft | Australia | 4.4 km | Red gravel over crests, eucalyptus |
| Whaanga Coast | New Zealand | 4.8 km | Flowing cambered gravel, green hills |

Checkpoints sit every 400 to 700 m (a 6 km stage has about 11), splits
compare against your saved best per stage, and the results screen
lists every split. A Free Play mode still builds random seeded stages
(2.4 / 4 / 6 km) in forest, desert and snow, and every stage can be
run at Day, Golden Hour, Dusk or Overcast.

Everything is generated in code at boot. Terrain, road, textures,
props, the car, the sky and even the engine sound are procedural. The
repo contains no image, model or audio asset files.

## Run it

There is no build step. Serve the folder with any static server and
open `index.html`:

```
npm run dev          # python3 -m http.server 8090
```

then visit http://localhost:8090/

Three.js is vendored under `vendor/` and wired up with an import map
in `index.html`. No npm install is needed to play.

## Controls

Keyboard:

| Key | Action |
| --- | --- |
| W / Up arrow | Accelerate |
| S / Down arrow | Brake, reverse when stopped |
| A D / Left Right arrows | Steer |
| Space | Handbrake (drift) |
| R | Reset to road (+5 s penalty) |
| C | Camera: chase / hood |
| M | Mute |
| Esc | Pause |

### Mobile and touch

The game is fully playable on a phone. Menus, stage and car select,
settings, HUD, pause and results all use a responsive layout with big
tap targets that fits a portrait phone screen (tested at 390 x 844)
as well as desktop.

On touch devices, driving buttons appear automatically during a run:

- Left / right steer buttons, bottom left
- Throttle and brake, bottom right
- HB handbrake button
- Pause and CAM (camera) buttons, top right

Touch buttons feed the same input system as the keyboard, so the
driving feel is identical. The canvas resizes on rotation and window
resize, the pixel ratio is capped per quality setting, and phones
default to Low quality on first run so the frame rate stays smooth
(change it any time in Settings).

## The game

- Three biomes: Forest (gravel and mud), Desert (packed dirt and
  sand), Snow (packed snow road, very slippery off it).
- Three stage lengths: Short, Medium, Long. The seed fully decides
  the stage, so the same seed is the same rally for everyone.
- Checkpoints with split times compared against your best, stored
  per stage in `localStorage`.
- Pace notes in the Colin McRae spirit: chevron boards at the road
  side and a HUD call (direction plus severity 1 to 6) before corners.
- Wrong way warning, stage progress bar, countdown start, results
  screen with splits and a NEW BEST badge.
- One car, three liveries with different tunes: Sunset Works
  (balanced), Azure Racing (more grip), Volt GP (faster, driftier).

## Surfaces matter

Grip, drag and dust colour come from the surface under the car:
tarmac grips, gravel slides, mud drags, deep snow bogs the car down.
Staying on the road is the fast way, but cutting the grass on a tight
hairpin is sometimes worth it. Usually not.

## Tests

```
npm test             # node tests/smoke.mjs
```

The smoke suite checks the pure modules directly: stage generation
is deterministic per seed, road heights are finite with sane grades,
the mesher culls hidden faces versus a naive build, and the car
physics steps 2000 times with mixed inputs without NaNs.

## Code map

- `src/world/stage.js` seeded stage generation (pure, no Three)
- `src/world/mesher.js` chunk mesher with hidden face culling
- `src/world/tiles.js` tile atlas ids and surface physics tables
- `src/world/textures.js` canvas painted texture atlas
- `src/car/physics.js` arcade car physics (pure, no Three)
- `src/render/` voxel box builder, props, car mesh, sky, particles
- `src/game/` WebAudio synth and input (keyboard + touch)
- `src/main.js` game state machine, HUD, cameras, race logic
- `DESIGN.md` short design notes for the v2 rebuild

Three.js r169 (MIT) is vendored at `vendor/three.module.js` with
addons under `vendor/addons/`. It is the only third-party dependency.
