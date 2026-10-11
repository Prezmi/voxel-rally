# Quality queue

Read by `tools/self-improve.sh` (hourly trigger). The loop takes **the top unfinished
item only**, fixes it, verifies, commits, pushes, then marks it done here.

Rules for the loop: one item per run, tests must stay green and never shrink, no new
external libraries or downloaded assets, never edit `PLAN.md`, never weaken a test,
keep the frame under ~220k triangles, at most one headless screenshot pass.

Format: `- [ ] P<n> · <item>` where P1 is highest priority. Mark done as
`- [x] P<n> · <item> · done <commit>`.

## Open

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
- [ ] P18 · `SURFACE_VMAX` (`src/game/ghost.js:32`) is a second per-surface speed table
      (mud 24 m/s, peat 22 m/s) that nothing cross-checks against what the car can
      actually reach; after the drag retune the physics terminal on peat is 24.9 m/s, so
      the reference ceiling now sits only ~13 % under capability and a further retune can
      put it above the physics limit — derive it from the T23 band or pin the margin
- [ ] P19 · the `unknown` fallback row (`src/world/surfaces.js:36`) still carries the
      pre-retune drag scale (crr 0.070 / sink 0.030) under grass-like grip (mu 0.70), so
      an unmapped surface id runs like sand; put it on the band (or alias it to gravel)
      and bring it inside T23
- [ ] P20 · loose-layer churn for dirt is derived from the drag columns
      (`src/dirt/emitters.js:276` `crr * 0.9 + sink * 2.2`), so fitting those for terminal
      speed also cut the mud/sand/peat plumes by a third (mud 0.247 -> 0.168, peat 0.278
      -> 0.187); churn should follow `plough`/looseness, not the speed-fit columns
- [ ] P21 · the ghost has no driveline in its acceleration envelope: `aPow = peakPower /
      (mass * v)` (`src/game/ghost.js:170`) is constant power with no torque curve, no rpm
      band and no gear steps, so the reference pulls from a standstill in a way the car
      cannot (car 'A' needs 4.61 s to 100 kph, T20); the accel pass also carries a dead
      term (`src/game/ghost.js:172` `- (k > CURV_EPS ? 0 : 0)`) while the `cornerDrag`
      knob documented as "extra resistance while cornering" (`:83`) is applied only to the
      braking pass (`:181`) — so cornering scrub is charged in the wrong pass
- [ ] P22 · `powertrainCeiling` derives the gearing cap from `TYRE_BASE.r` = 0.335 m
      (`src/game/ghost.js:56-57`, the unloaded radius) while the wheel model rolls on its
      own dynamic `rGeo`; the cap (71.3 m/s) sits only 3 % over the measured terminal on
      asphalt (69.3) and stone (69.1), so any suspension or tyre-radius change puts the
      cap under the measured value and turns T24 red over a non-defect — derive it from
      the loaded radius, or compare against a measured column instead of a formula
- [ ] P23 · `referenceSpeedMargin` is one scalar that scales straights *and* corners
      together, so the calibration envelope is closing: the acceptance band from T25 /
      stagetest E3+A6+E1 wants ref in 215-223 s (0.73 gives 218.21 s), while E2 caps the
      corner envelope at ratio <= 1 and the tightest apexes sit at 0.721 of
      `sqrt(mu_eff*g*R)` already. The next retune that needs a quicker reference pushes
      the apexes into the friction circle instead of the straights — split it into a
      straight margin and a corner margin (or drive the corners off `gripMargin`) and
      re-pin T25
- [ ] P24 · the E1 placeholder guard (`tools/stagetest.mjs:270` `Math.abs(ghost.refTime
      - LEN / 20) > 5`) is a distance-from-a-fake-number test that ended up *bounding the
      calibration*: at margin 0.75 the reference (213.18 s) landed 3.18 s from LEN/20 =
      210 s and E1 went RED for a non-defect, a fully integrated profile that merely
      happened to average 20 m/s. Judge the profile instead (ghost speed must vary with
      curvature, sector refs must differ from `dist / const`), not the total
- [ ] P25 · the lap the reference is now calibrated against is teleport-assisted: the
      pace driver runs 23 recoveries (maxLat 6.1 m against the 6 m guard) over the
      reference stage (`src/debug/tests.js` T25 detail, `tools/stagetest.mjs` clean run),
      so part of the 222.83 s basis is the on-stage recovery rather than the driver; make
      the driver hold the 7.5 m corridor (lookahead/hairpin term) and re-read
      `referenceSpeedMargin` against the cleaner lap

## Done

<!-- the loop appends completed items here -->

- [x] P4 · the ghost *calibration* is stale after the P3 drag retune: `tools/stagetest.mjs`
      E3 and A6 are RED — the harness driver laps seed 12345 in 222.83 s while
      `referenceSpeedMargin 0.58` still yields ref 268.16 s (20.3 % SLOWER than the driver
      it was tuned to beat, a -44.30 s split, stage limit 28 % too generous), and nothing
      in `src/debug/tests.js` compares the reference with a driven lap
      · done — `referenceSpeedMargin` 0.58 -> **0.73** (`src/game/ghost.js:106`), which puts
      the reference at **218.21 s (69.8 km/h avg, 24.4 m/s peak) = 2.1 % quicker than the
      same driver's 222.83 s lap, a +5.45 s split, limit 05:49.13** — inside every envelope
      the harness states (E3 quicker + within 25 %, A6 |split| < 20 s, E1 > 5 s off the
      LEN/20 = 210 s placeholder, E2 apex ratio 0.573 -> 0.721 of `sqrt(mu g R)`, pacenote
      A3 min note lead still 1.45 s because the note lead is time-scaled). `SURFACE_VMAX`
      did not move: the surface rows and their measured terminals are unchanged, so P18
      stays a separate item. The suite could not see the drift because the driven lap only
      existed in `tools/`, so the pure-pursuit driver was lifted out of `drive()` into
      `src/debug/pace-driver.js:52` (`PACE` table + `createPaceDriver()`, `SLOW_PACE` for the
      DNF paths) and `tools/stagetest.mjs:72` now drives with it — proven bit-identical,
      every step count, sector time, split and the B1 determinism line are unchanged versus
      HEAD (only the two calibration criteria moved). New sibling check **T25**
      (`src/debug/tests.js:1423`, check at `:1485`) drives that whole stage inside the suite
      and pins ref in 0.75..1.00 of the lap, |split| <= 20 s, |ref - LEN/20| > 5 s, the lap
      still inside its own `ref * 1.6` limit, and the lap FINISHED: retune the car or a
      surface row and it fails until the margin follows. Calibration record rewritten with
      the measured numbers (`src/game/ghost.js:85-105`, `SYSTEM-NOTES.md` §9 — the note there
      still quoted 268.3 s / 281.8 s and stale sector refs). Proof: `node src/debug/tests.js`
      **36/36 passed** (35 before, +1), `tools/stagetest.mjs` **ALL PASS** (was 2 FAILURES),
      `tools/pacenote-test.mjs` ALL PASS, `tools/smoke.mjs` clean. Two envelope fragilities
      this surfaced are filed as P23 (one scalar for straights and corners) and P24 (E1
      judges the total against a placeholder), plus P25 (the calibration lap needs 23
      recoveries)

- [x] P4 · `src/game/ghost.js:30` still says top speed ~70 m/s, stale after the
      powertrain retune, and any ghost pace built on it is wrong
      · done — the quoted figure and the ceiling it described were both fiction: the solver
      computed its straight-line cap as the drag-only cube root of peak power (82.3 m/s for
      car 'A'), which is above the tallest gear (71.3 m/s) and 60 % above what the car
      actually holds on the reference surface (gravel 51.6 m/s), while the comment quoted a
      third number (~70 m/s) that nothing produced. Now `powertrainCeiling(car, surfaceRow)`
      (`src/game/ghost.js:55`) is the real cap — the smaller of redline through the tallest
      ratio, and where peak power stops beating rolling + aero — memoised per surface row
      (`:135-136`) and used for `vCap` (`:151`); the comment quotes the measured terminal
      per surface (`:31-37`), the new probe `tools/vmax.mjs` reproduces that column for any
      car, and T24 (`src/debug/tests.js:1363`, check at `:1402`) pins the cap between the
      gearbox and the physics (never over gearing for any of the four cars, never under the
      terminal speed measured on the flat straight, never binding under `SURFACE_VMAX`, and
      the power term must bind for the short-geared car C at 61.0 m/s of its 88.7 m/s
      gearing). Reference pace is unchanged bit-for-bit because the new cap still sits above
      every surface ceiling: `tools/pacenote-test.mjs` ref 268.16 s / raw 168.97 s before and
      after, ALL PASS. The *calibration* drift that item hinted at is a separate defect and
      is filed as the new P4 (stagetest E3/A6 red). Proof: 35/35 checks (34 before, +1),
      `tools/smoke.mjs` drive clean with no NaN

- [x] P3 · mud, sand and peat still carry the old heavy sink values in
      `src/world/surfaces.js` after the gravel retune, so those surfaces are far slower
      than intended; retune to a consistent band
      · done — `crr`/`sink` only re-fitted on the gravel basis (terminal speed of car 'A'
      on the flat straight), `mu`/`plough` untouched so cornering, drift and handbrake are
      unchanged: mud 0.115/0.065 -> 0.084/0.042 (`src/world/surfaces.js:65`), snow
      0.095/0.045 -> 0.050/0.022 (`:74`), grass 0.075/0.030 -> 0.045/0.017 (`:83`), sand
      0.130/0.055 -> 0.070/0.030 (`:91`), peat 0.125/0.075 -> 0.086/0.050 (`:108`), dirt
      0.090/0.040 -> 0.048/0.020 (`:125`) — the whole loose family had to follow or the
      band would not be monotone (mud would have out-run dirt and grass). Measured
      terminal is now a taper instead of a cliff: gravel 186 > grass 150 > dirt 141 >
      snow 132 > sand 122 > mud 103 > peat 90 kph (was 186/123/109/92/92/81/68), with the
      band note at `src/world/surfaces.js:7-15`. T23 (`src/debug/tests.js:1312`) pins the
      band, the monotone drag columns and a max 40 kph step down. Proof: 34/34 checks
      (33 before, +1); T4 still holds mud 0-60 at 4.73 s, T20 gravel unchanged at
      4.61 s / 185.6 kph, and `tools/pacenote-test.mjs` (ghost calibration) still ALL PASS

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
