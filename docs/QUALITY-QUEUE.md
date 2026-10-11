# Quality queue

Read by `tools/self-improve.sh` (hourly trigger). The loop takes **the top unfinished
item only**, fixes it, verifies, commits, pushes, then marks it done here.

Rules for the loop: one item per run, tests must stay green and never shrink, no new
external libraries or downloaded assets, never edit `PLAN.md`, never weaken a test,
keep the frame under ~220k triangles, at most one headless screenshot pass.

Format: `- [ ] P<n> · <item>` where P1 is highest priority. Mark done as
`- [x] P<n> · <item> · done <commit>`.

## Open

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
- [ ] P15 · verge fern/bush sprites hover in mid-air over the terraced verge: placed at
      `world.columnTopAt()` of their own column while the neighbouring block-tile slab
      stands a block higher, so the green plates float (seen at 10-40 m in
      `shots/quality-snags.png`); sit them on the lower of the two column tops
- [ ] P16 · `pickSpecies` hands `PROP.DEAD` 55-70 % of the stand in SWAMP/CANYON, and now
      that snags reach 320 m the biome reads as one brown bristle with no leafy mass;
      cap any single species near 45 % and let the grove pick the dominant one
- [ ] P17 · two checks share the id T21 (the fx pool check in `src/debug/tests.js:562`
      and the gate board check at `:1255`), so the id cannot address one of them; renumber
      the gate check to its place in the sequence (the new vegetation band check is T22)

## Done

<!-- the loop appends completed items here -->

- [x] P2 · dead/bare trees have no billboard band so they pop out at ~90 m while pines
      and oaks reach 320 m; add a sprite entry in `src/world/props.js` (`SPRITE_PROPS`)
      · done — `PROP.DEAD` joined `SPRITE_PROPS`/`SPRITE_SPEC` (`src/world/props.js:20,32`)
      so snags get the mid crossed-quad and the far billboard band like every other tree
      (they used to be dropped at the 90 m hard prop limit), the 6th atlas cell is painted
      as a bare snag with a 0.4 m trunk, a snapped crown and three broken limbs sized to
      the 2.14 m voxel envelope (`src/world/props.js:419-451`), the atlas cell order is now
      derived from `SPRITE_PROPS` so the UV can never drift from the paint order
      (`src/world/props.js:43-49`), and T22 (`src/debug/tests.js:1269`) guards that every
      tree species owns both alpha bands plus its own painted cell. Proof: 33/33 checks
      (32 before, +1) and `shots/quality-snags.png` (CANYON, read back) shows bare snags
      running to the horizon instead of stopping short
- [x] P1 · checkpoint and start banner plates in `src/world/props.js` still use the
      near-coplanar slab sandwich that caused the gantry checkerboard; rebuild them as one
      solid core with bands running through it
      · done in 307e14a by the previous (timed-out) run, never recorded here —
      `GATE_PLANES` + the rebuilt `buildGateGeometry` (`src/world/props.js:722-795`) and
      the coplanar-face guard T21 (`src/debug/tests.js:1205-1256`)
