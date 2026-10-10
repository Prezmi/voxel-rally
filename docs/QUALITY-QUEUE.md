# Quality queue

Read by `tools/self-improve.sh` (hourly trigger). The loop takes **the top unfinished
item only**, fixes it, verifies, commits, pushes, then marks it done here.

Rules for the loop: one item per run, tests must stay green and never shrink, no new
external libraries or downloaded assets, never edit `PLAN.md`, never weaken a test,
keep the frame under ~220k triangles, at most one headless screenshot pass.

Format: `- [ ] P<n> · <item>` where P1 is highest priority. Mark done as
`- [x] P<n> · <item> · done <commit>`.

## Open

- [ ] P1 · checkpoint and start banner plates in `src/world/props.js:608-614` still use
      the near-coplanar slab sandwich that caused the gantry checkerboard; rebuild them
      as one solid core with bands running through it
- [ ] P2 · dead/bare trees have no billboard band so they pop out at ~90 m while pines
      and oaks reach 320 m; add a sprite entry in `src/world/props.js` (`SPRITE_PROPS`)
- [ ] P3 · mud, sand and peat still carry the old heavy sink values in
      `src/world/surfaces.js` after the gravel retune, so those surfaces are far slower
      than intended; retune to a consistent band
- [ ] P4 · `src/game/ghost.js:30` still says top speed ~70 m/s, stale after the
      powertrain retune, and any ghost pace built on it is wrong
- [ ] P5 · the `fx` toggle has no settings-screen row (only the `P` key and the saved
      setting); add a row in the same wood-banner style so mobile users can reach it
- [ ] P6 · prop and glb materials export with `doubleSided` true from Blender
      (`build_stage_props.py:518` `make_material`); set `use_backface_culling` so the
      FrontSide override in `streaming.js` is not needed
- [ ] P7 · road surface still shows over-light patches in the near field because
      `src/render/renderer.js` applies `tone = 0.82 + 0.40 * tile`; narrow that spread
      to about 12 percent and let ruts get slightly glossier
- [ ] P8 · night stages have no headlight beams; add two cheap cone volumes or a spot
      light plus road decals that stay inside the frame budget
- [ ] P9 · livery number roundel is hard to read past ~15 m; raise the decal resolution
      or draw the number as geometry so it reads at distance
- [ ] P10 · the left-handed touch layout is CSS-only and unverified; make it a real
      mirrored layout and prove it with a shot
- [ ] P11 · quality LOW now streams chunks to 250 m for the far vegetation band; confirm
      LOW frame time is not worse than MEDIUM and clamp if it is
- [ ] P12 · tyres have no tread relief once caked; add a cheap normal or relief term in
      the tyre dirt shader in `src/render/carMesh.js`
- [ ] P13 · backfire flames have no audio cue; add a short procedural pop through the
      existing audio layer, gated by the same `fx` setting
- [ ] P14 · depth of field and bloom are not present; a single cheap post pass
      (depth-based blur near the far edge plus a low-res bright-pass bloom) would sell
      the atmosphere; must stay inside the frame budget and be gated by quality

## Done

<!-- the loop appends completed items here -->
