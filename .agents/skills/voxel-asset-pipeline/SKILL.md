---
name: voxel-asset-pipeline
description: End-to-end method for producing and integrating real 3D assets for the voxel rally game — reference board, procedural Blender builder, self-checking exports, multi-view self-review, then wiring into the engine's dirt, livery, damage and instancing contracts. Use when creating, fixing or importing any model in this repo.
---

# Voxel asset pipeline (this repo)

Written after the 2026-10-10 asset program. Follow it for every model, not just the car.

## 1. Reference before geometry
- Collect real references first and build a contact sheet: `shots/moodboard-*.png`
  (Wikimedia Commons API, then PIL montage). Never model from memory.
- Write measured targets into a reference sheet (`tools/blender/RALLY-REFERENCE.md`) and
  design against numbers, not vibes.

## 2. Build with a headless, deterministic script
- Blender is driven headless: `blender --background --python tools/blender/<build>.py -- --out assets/models/<name>.glb`.
- Geometry from explicit vertex and face tables. No operator booleans (Blender 5 has no
  `bpy.ops.object.boolean`), no procedural texture nodes (Noise, ColorRamp …) — they are
  silently dropped by the glTF exporter.
- Voxel look: blocks are 0.10 m; art-direct the silhouette as a **side-profile bitmap**
  extruded across the width (`PROFILE` rows + `WIDTHS` per row). Far easier to iterate than
  hand-placed blocks.
- One mesh node per part, named `<domain>_<part>`, each with custom properties
  (`rally_part`, `rally_panel`, `rally_pivot`, `rally_spin_axis`) so the engine can map
  panels, dirt and damage regions.
- Anything that must rotate is authored in its **own local frame** with the node origin at the
  pivot (wheels: geometry local to the hub, `rally_spin_axis = Y`). Do not bake world
  coordinates into a rotating part, and never subtract the origin twice.

## 3. The script must self-check and refuse to ship junk
Print and fail on: bounding box against the reference sheet, min_z (must sit on the ground),
per-wheel open-arch gap, node count, triangle count, file size. A degenerate export must exit
non-zero.

## 4. Review your own render before reporting (hard rule)
- Render at least side, front, rear and three-quarter:
  `blender --background --python tools/blender/preview_model.py -- --model <glb> --out shots/<v>.png --night --view side|front|rear|3q`
- Montage with system `python3` + PIL into `shots/review-*.png`, then **open that sheet with
  your read tool** and hunt for: floating or detached parts, buried parts, plain slab fascias,
  bright specks, holes in the silhouette, wheels off the ground, asymmetry, scaffolding-looking
  hardware.
- List the failings in writing, fix, re-render, re-read. Only then report, and say what was
  fixed and what still fails. A single three-quarter view hides almost everything.

## 5. Import into the engine through its contracts
- Loader: `src/render/assets.js` — `loadModel(name, fallbackFactory)` and
  `loadModelNodes(name)` (cache, never throws, empty Map on failure). Every asset path keeps a
  procedural fallback and logs one startup line saying whether the asset path is active.
- Props: `src/world/streaming.js` swaps geometry/material on the existing InstancedMesh
  containers; never change placement, capacity or physics.
- Car: keep the `aPanel`, `aLivUv`, `aLiv`, `aLamp` attributes and `built.ranges` damage
  regions (`src/render/carMesh.js`) — a GLB car must rebuild them from part names.
- Never re-scale an imported body per axis; fit it uniformly to the physics envelope
  (wheel centres ±1.31, track 1.52, tyre radius 0.335, wheelbase fixed).

## 6. Prove it
- `node src/debug/tests.js` must stay green, plus a test asserting the imported geometry keeps
  the attributes and damage ranges.
- The portal browser has no WebGL context and the container Chromium hangs — verify visually
  in the user's Firefox (`open-on-desktop` skill) or by headless Blender renders, and use
  numeric checks (bbox, bytes, node names) for automated proof.
