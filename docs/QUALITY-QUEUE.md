# Quality queue

Read by `tools/self-improve.sh` (hourly trigger). The loop takes **the top unfinished
item only**, fixes it, verifies, commits, pushes, then marks it done here.

Rules for the loop: one item per run, tests must stay green and never shrink, no new
external libraries or downloaded assets, never edit `PLAN.md`, never weaken a test,
keep the frame under ~220k triangles, at most one headless screenshot pass.

Format: `- [ ] P<n> · <item>` where P1 is highest priority. Mark done as
`- [x] P<n> · <item> · done <commit>`.

## Open

- [ ] P38 · the livery sampler clamps the WHOLE atlas, not the sub-rect: `texture2D(uLivery,
      clamp(vLivUv, 0.03, 0.97))` (`src/render/carMesh.js:385`) against `FLANK_UV.u0 = 0.02`
      (`src/render/car-asset.js:77`) — the flank starts 0.01 atlas units *under* the clamp floor,
      so the rear 0.01/0.11168 = **0.089 m of both flanks** samples one duplicated texel column
      (a flat smear at the tail of the door panel, and it eats any dirt detail there). Clamp per
      projection, or move the flank anchor inside the guard
- [ ] P39 · the livery atlas is not quality-gated: 1024² (4 MB RGBA + 1.3 MB of mips) at every
      preset, while at LOW the roundel lands at 9-12 px on a 1080p screen (`tools/livery-read.mjs`
      measures the column) — a per-preset atlas size / anisotropy dial is free VRAM at LOW
- [ ] P40 · the roundel's legibility ceiling is ~24-28 m: at 9 px (~32 m) only the dark ring
      survives and the digit is a grey smudge, in the mip column of `tools/livery-read.mjs` *and*
      in `shots/quality-roundel-22m.png`. Reading past that needs a bigger roundel (T35 pins
      0.30-0.40 m) or the number as real geometry on the door, not more texture resolution
- [ ] P29 · the same export defect is still live for the hero model: neither car builder
      sets `use_backface_culling`, so `assets/models/rally_v2.glb` (45 materials) and
      `rally_a.glb` (51) all land `doubleSided`, and `src/render/carMesh.js` /
      `car-asset.js` apply no `side` patch at all — the body interior faces are shaded and
      depth-written every frame. Re-export has to re-prove the `car_*` node contract (T10)
      and be read back in a shot, which is why props and tiles were fixed first
- [ ] P30 · `tools/blender/build_stage_blocks.py:78` `REQUIRED` names 8 of the 10 tiles the
      script builds (no `snow`, no `ice`), so the export gate silently guards 8 nodes and
      its own summary under-reports: `nodes found : 10 (...)` next to `OK all 8 expected
      nodes present`
- [ ] P31 · a headless capture races the world build: `tools/shot-run.mjs` waits a fixed
      wall-clock time while the stage needs ~12 s to generate (this run's first pass
      captured the `generowanie etapu: 41% 3450 / 8379 chunks` boot screen, costing a
      screenshot pass); publish a "world ready" flag the harness waits for instead of a timer
- [ ] P32 · with the panel tone spread narrowed, the near-field carriageway patchiness is
      now **geometric**: the road reads as a staircase of 1 m slabs from ~2-20 m (lit top
      face + dark riser alternating at column pitch, visible across the whole lower half
      of `shots/quality-road-tone.png`), so the corridor looks terraced rather than graded;
      grade the corridor columns (or shade the risers) instead of painting over it
- [ ] P33 · the headless shot pass cannot load the hero car: the frame logs
      `[assets] "rally_v2" unavailable (Failed to fetch)` (`src/render/assets.js:23`
      `loadModel`, path built at `:17`) while the same URL answers **200** over the same
      port (`curl -o /dev/null -w %{http_code} http://127.0.0.1:8090/assets/models/rally_v2.glb`),
      so every visual pass judges the procedural car instead of the asset car
- [ ] P34 · the wet-stage gloss mask disagrees with the road mask: `roadishw`
      (`src/render/renderer.js:255`) covers asphalt / gravel / mud / dirt but not PEAT (8),
      while the colour pass `roadish` (`:210`) and the new rut gloss (`:246`) do — a rain
      stage loses roughness on a dirt road and keeps full roughness on a peat one
- [ ] P35 · the night frame is a lit box: past the 26 m pool cut-off the carriageway is
      unlit black all the way to the fog wall (`shots/quality-night-beams.png`, read back),
      so a DUSK stage has a hard visibility wall at ~30 m with nothing marking the road
      beyond it — the beam needs a longer throw dial, or the road edge needs markers that
      catch the pool
- [ ] P36 · no stage is ever truly dark: `stageClimate` (`src/world/road-spline.js:283-287`)
      caps DUSK at tod 0.80-0.87 while the rig's night stop sits at 0.92-1.00 (key 0.14,
      `src/render/lighting.js:28-29`), so the deep-night half of the STOPS table and the whole
      `tod < 0.22` half of the beam gate (`src/render/headlights.js:23-24`) are dead code that
      T29 only asserts in the abstract (`isDark(0.05)`)
- [ ] P37 · the lens flare fires at night off the headlights instead of the sun: two white
      ghost blobs (upper right and lower left of `shots/quality-night-beams.png`) sit in a
      frame where the key is already at dusk strength — `lensFlareAlpha` gates on the sun
      (`sunVis`/`sun`) with no dark-stage term
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
- [ ] P26 · the settings panel no longer fits the screen it is drawn on — **the highest
      of these three, promote it above P6**: nine rows at `pitch = max(rowH + 4,
      ceil(72 / ui))` (`src/game/hud-rally.js:891`) make the modal taller than the
      viewport. At 1280x720 (`uiScale` 2, canvas `H` = 360) the panel is ~382 px, so
      `y = (H - h) / 2` goes negative and the USTAWIENIA banner is cut at the top while
      `WRÓĆ (esc)` is clipped at the bottom (`shots/quality-fx-row.png`, read back); on a
      landscape phone (`H` ~ 390 at `uiScale` 1) it is ~706 px, i.e. it already overflowed
      before the EFEKTY row landed. Fit the panel — shrink the row pitch, page the rows,
      or clamp `y` — so no row can fall off-screen.
- [ ] P27 · turning `fx` off parks the live particles instead of releasing them:
      `FxSystem.step()` returns at `src/fx/fx.js:283` while disabled, so the pools are only
      hidden (`src/render/fx-view.js:112`) and never aged or compacted — switching the
      EFEKTY row back on drops the same plumes mid-life, exactly where they were left
- [ ] P28 · a stored `quality` never re-runs `qualityPreset()`: boot applies the saved
      value with `renderer.setQuality(settings.quality)` only (`src/main.js:163`), while
      the preset columns (`renderScale`, `drawDistance`, `vegFarDistance`, `fxScale`,
      `src/core/settings.js:149-163`) are re-derived only for `?q=` (`src/main.js:102-104`)
      — a player who saved LOW boots on MED render scale and keeps most of the cost

- [ ] P15 · the sky reads as a pale near-white sheet in forest lanes with no blue and no visible sun,
      see `shots/day-pass.png`; deepen the zenith blue, push the horizon haze and make the sun disc
      and its glow bright enough that bloom is obvious through canopy gaps
- [ ] P16 · block tiles on the verge still read as paving slabs along the right edge of the road;
      shrink their span and lift there, or drop them entirely past the carriageway edge
- [ ] P17 · with composer post on, `src/render/dirt-lens.js` is skipped entirely, so the wiper band and
      the wet-film colour shift are lost; fold them into the composite or run the quad for those parts
- [ ] P18 · `camera.js:102` and `main.js:585` both write the composer speed, pick one owner
- [ ] P19 · shot-mode A/B probe in `src/main.js:659-662` pokes the dead `composer.shafts` shim instead of
      the live `shaftsOn` flag
- [ ] P20 · the procedural fallback car body `src/render/car-body.js` still uses the old planar livery UVs
      and slate-blue glass, so a glb load failure smears the new livery
- [ ] P21 · `src/debug/tests.js` T32 wording pins a four extra pass budget while the honest total is six
      since the atmosphere pass landed, restate the pin explicitly

## Done

<!-- the loop appends completed items here -->

- [x] P9 · livery number roundel is hard to read past ~15 m; raise the decal resolution or draw
      the number as geometry so it reads at distance
      · done — the item named one dial (resolution) and the frame showed three faults at once.
      Measured first, in the map: a 0.35 m roundel in a 512 atlas is **20 texels across**, the
      digit 11-14 texels with **1-2 texel strokes**, and the texture was built with
      `minFilter = NearestFilter` + `generateMipmaps = false` — so past ~15 m, where the roundel
      is smaller on screen than in the map, the sampler dropped whole strokes at random. That is
      why it dissolved *gradually with distance* rather than simply looking small. All three fixed:
      (1) `LIVERY_TEXEL` 512 -> **1024** (`src/render/car-livery.js:38`), roundel 40 texels, cost
      4 MB + 1.3 MB of mips per car instead of 1 MB; (2) the number is now **geometry, not a font
      glyph**: every lit cell of the HUD's own 5x7 bitmap (`glyphRows`, exported from
      `src/game/pixel-font.js:150`) is one filled rect at the biggest integer pitch that still
      fits the disc, drawn **bold** (rect = cell+1) so a stroke is 4-5 texels instead of a
      hairline — `liveryNumberRects(carId)` (`src/render/car-livery.js:104`) is pure (no canvas)
      so node can measure it, and `drawLivery` no longer touches `ctx.font`/`fillText`
      (`src/render/car-livery.js:175`), which also removes the platform font dependency that made
      the digit different on every machine; (3) the sampler minifies through a chain now —
      `minFilter = LinearMipmapLinear`, `generateMipmaps true`, `anisotropy 8`, magnification kept
      nearest so the block digit stays a block (`src/render/car-livery.js:57`, applied at `:186-192`).
      The block font is also the game's own sign/HUD language, so the door number matches the rally
      boards. New check **T42** (`src/debug/tests.js:2598`, check at `:2703`) pins all of it: atlas
      >= 1024 and roundel >= 36 texels, per car the lit box sits inside the disc (spill 0.00) and
      on its centre (<= 1 texel), cap >= half the roundel (55-72 %), stroke >= 4 texels (the 4x4
      mip box a 0.35 m roundel sits in at ~18-20 m), ink share of the disc 19-28 % (a dot or a
      plate both fail), the texture built through a stub DOM/three really asks for a mip minFilter +
      chain + anisotropy while staying nearest on magnification, `drawLivery` really paints the
      11-24 cell rects, and the file never goes back to a system font. Proof, first pass, node-only
      (`tools/livery-read.mjs`, read back as `shots/livery-read.png`): the same door minified the
      two ways, at 24/16/12/9 px roundel — the mip column reads 7/3/12/5 down to 12 px (~24 m)
      while the nearest column, same texture, loses strokes by 16 px and is confetti by 12 px: the
      sampler was doing at least as much damage as the resolution. In-game proof, one headless pass
      read back: `shots/quality-roundel-22m.png` (`?showroom=1&view=side&sheetDist=22` — the new
      `?sheetDist` knob, `src/debug/showroom.js:36` + `:75`, since the design sheet always frames at
      7.5 m and cannot answer a distance question) shows the asset car ACTIVE at 22 m with the ring
      and the digit clear on the door, the band and the sponsor strip intact. Note for P33: this
      pass fetched `rally_v2.glb` fine (`[car] asset car "rally_v2" ACTIVE`), so that failure is a
      race, not a permanent state. Residual limits filed as P38-P40 (the atlas-wide UV clamp eats
      0.089 m of the flank, the atlas is not quality-gated, and past ~28 m only the ring survives —
      more resolution cannot buy what a 0.35 m decal cannot show).

- [x] P8 · night stages have no headlight beams; add two cheap cone volumes or a spot
      light plus road decals that stay inside the frame budget
      · done — the item was **half landed and half wrong**, and only a frame could see it.
      The volumes and the pool already exist (added in `099c8c4`, pinned by T29/T30 — that
      run never recorded the item here), so this pass spent itself on the first night frame
      ever captured (seed 95, the DUSK stage `stageClimate` rolls at tod 0.85, bumper cam,
      `shots/quality-night-beams.png`, read back): the pool does land corridor-sized on the
      road, but the shaft drew as **two solid pale cards welded to the nose** — the ramp
      opened at `a: 0.34` *at the lens* (`rings[0]`), and every driver camera (BUMPER,
      ONBOARD, close CHASE) sits at lamp height *inside* the cone, so the near wall of both
      shells filled the lower half of the screen as geometry while the far half, where the
      pool actually lights the road, was the dim part of the curve, and the doubled core
      (`2 * 1.0 * gain 0.16` = 0.32 additive) was brighter than the road it drew over.
      Reshaped the ramp, not the light: four rings `t 0 / 0.20 / 0.55 / 1`, alpha
      `0 / 0.40 / 0.85 / 0` (`src/render/headlights.js:61-63`), gain 0.16 -> 0.13 (`:67`) —
      nothing at the lens, peak at 11 m which is the middle of the pool, nothing at the far
      end — 96 -> 144 triangles for one more band, still inside the 160 a cheap volume may
      cost. The SpotLight, its cone and its footprint were left alone (T30 already proved
      them). The ramp is now readable headless: `shaftWallAlpha(t)` (`:144`) is the ring
      interpolation the shader does per fragment and `shaftPeak()` (`:162`) reports where
      the shaft is brightest and by how much. New check **T41** (`src/debug/tests.js:2542`,
      check at `:2584`) pins it: shell alpha exactly 0 at both ends, the first 4 m of the
      cone the camera sits inside stay under 50 % of peak (47 % now, was >100 % from the
      first ring), exactly one rise and one fall (a banded shaft reads as geometry), the
      peak sits at 35-75 % of the reach *and* over ground the pool lights (2.14 of
      illuminance under it), core additive held to 0.10..0.26 against the old 0.32, rings
      monotone with a lens-sized first ring, and cost re-pinned at <= 160 tris. Proof:
      `node src/debug/tests.js` **52/52 passed** (51 before, +1), `tools/smoke.mjs` drive
      clean, no NaN, T29/T30 unchanged. Not done, deferred: the one allowed screenshot pass
      went to the diagnostic frame, so this ramp has **no after-shot yet** — the next night
      capture must read it back; what that same frame shows wrong about the rest of the
      night is filed as P35-P37 (lit box past the pool, no stage ever rolls the rig's dark
      half, lens flare firing off the lamps).

- [x] P7 · road surface still shows over-light patches in the near field because
      `src/render/renderer.js` applies `tone = 0.82 + 0.40 * tile`; narrow that spread
      to about 12 percent and let ruts get slightly glossier
      · done — the tone field is now pinned and narrowed to `0.94 + 0.12 * tile`
      (`src/render/renderer.js:169`, constants `src/render/road-skin.js:12-15`): a 12.8 %
      band centred on 1.000 instead of 0.82..1.22 (48.8 %, midpoint 1.02 above the panel
      colour, brightest panel lifted 22 %), which keeps PLAN §10 criterion 2 (>= 12 %
      tonal difference between panels of one surface) with no net lift; and the wheel-line
      rut now loses roughness across the packed wear band on every loose road surface, not
      only asphalt (`src/render/renderer.js:246-248`, `RUT_GLOSS` at
      `src/render/road-skin.js:23-27` = 20 % glossier in the rut, feathered 0.10..0.45).
      The numbers were dead GLSL text before, so they moved into a THREE-free module that
      the shader interpolates and the suite asserts on; new check **T28**
      (`src/debug/tests.js:1698`, check at `:1746`) pins the band floor/ceiling, the 1.000
      midpoint, the monotone rut gloss, that the shader compiles the pinned constants
      rather than a literal, and that the rut mask covers exactly the road family minus
      asphalt (which keeps its own stronger compaction term). Proof: `node src/debug/tests.js`
      **39/39 passed** (38 before, +1), `tools/smoke.mjs` drive clean, no NaN. Visual proof,
      one headless pass, read back: `shots/quality-road-tone.png` (seed 12345, bumper cam,
      520 frames) — the near-field carriageway is one worked brown surface with visible
      panel-to-panel variation and no blown pale patches, the pale shoulder line reads
      without blooming. What that shot now shows instead is the 1 m slab stepping of the
      corridor and a car asset that failed to fetch: filed as P32-P34.

- [x] P6 · prop and glb materials export with `doubleSided` true from Blender
      (`build_stage_props.py:518` `make_material`); set `use_backface_culling` so the
      FrontSide override in `streaming.js` is not needed
      · done — the queue line pointed at one line and the defect was the whole asset layer:
      the glTF exporter writes `doubleSided = not material.use_backface_culling`, and with
      the Blender default left alone **every** material in both files the streaming layer
      adopts landed doubleSided — props.glb 38/38, stage_blocks.glb 10/10 — so the far wall
      of every closed voxel drew on the same depth as the face in front of it (the banner
      board checkerboard that P1 rebuilt the geometry for was only half the story) and the
      tile layer that carpets the whole road band paid double the fill. Now single-sided at
      the source: `mat.use_backface_culling = True` in `make_material`
      (`tools/blender/build_stage_props.py:579`, `tools/blender/build_stage_blocks.py:463`),
      both files re-exported headless (`blender --background --python
      tools/blender/build_stage_props.py -- --out assets/models/props.glb`, same for blocks)
      with **geometry proven identical** — 4728 / 16814 triangles and every vertex of all 20
      prop and 10 block nodes byte-equal against the previous files, only the material flags
      and 724 bytes of JSON went away (`props.manifest.json` `file_bytes` 284420 -> 283696),
      and 0 of 21,542 exported triangles wind against the normal they ship with, so culling
      can only ever remove a face that was already shading away from the camera (no hole or
      vanishing surface traded for the checkerboard). The engine workaround is deleted:
      `c.side = THREE.FrontSide` is gone from `_buildStartProps` (`src/world/streaming.js:653`
      `opaque()`), the comment there now names the export as the guarantee. Both builders now
      fail their own export gate on a doubleSided material (`build_stage_props.py:616` + `:729`,
      `build_stage_blocks.py:595` + `:611`), and the new suite check **T27**
      (`src/debug/tests.js:1601`, check at `:1679`) re-reads the shipped glbs and pins 0 doubleSided materials,
      every primitive mapped to one of them, and 0 backfacing windings, with floors (30 nodes /
      48 materials / 30 mapped primitives) so a truncated asset cannot pass vacuously. Visual
      proof, one CDP pass, read back: `shots/quality-single-sided.png` (seed 12345, start
      line) shows the arch bands as one clean striped board at 34 m, both marshal tents and
      both fence lines solid with no hollow or missing face after culling, and the dirt tile
      layer continuous. Proof: `node src/debug/tests.js` **38/38 passed** (37 before, +1).
      Not touched, filed as P29: the two car glbs still export every material doubleSided
      (the car builders never set culling and the car layer has no `side` patch either).

- [x] P5 · the `fx` toggle has no settings-screen row (only the `P` key and the saved
      setting); add a row in the same wood-banner style so mobile users can reach it
      · done — the row is there: `Efekty: wł./wył.` between HUD and JAKOŚĆ in Ustawienia
      (`src/game/hud-rally.js:329`), drawn by the same wood-banner/stone-GUI row path as
      every other row, and main.js applies it (`src/main.js:259` `toggle:fx` ->
      `settings.fx` + `fx.enabled`), persisted by the existing `/^(toggle:|cycle:|quality$)/`
      save path and re-read by the render loop every frame. The row also needed the hit-box
      pool un-capped: it was a fixed 8 DOM boxes (`src/game/hud-rally.js:50,119`) while
      Ustawienia now carries 9 rows, and a row with no box is a row no thumb can tap and
      no keyboard can focus — `_ensureMenuItems(n)` now grows one box per row on demand
      (`src/game/hud-rally.js:350`, called from `_buildMenu` at `:372`). The item's
      premise was wrong: `P` is the menu/pause key (`src/main.js:390`), and the FX branch
      was a second `KeyP` in the same if-chain (HEAD `src/main.js:417`) that could never
      run — so `fx` had no keyboard path at all; that dead branch is now a comment
      (`src/main.js:422-426`). Proof: `node src/debug/tests.js` **37/37 passed** (36
      before, +1), `tools/smoke.mjs` drive clean. New **T26** (`src/debug/tests.js:1505`,
      check at `:1579`) pins the labelled row, a DOM hit box *and* a focus slot for every
      row of all three screens measured from a fresh boot (menu 4/8, settings 9/9,
      controls 1/8 — the settings row only passes because of the pool fix), that the tap
      flips the flag and reaches the save, and that a disabled `FxSystem` holds 0 live
      particles against 108 live while on. Live browser proof: `shots/quality-fx-row.png`
      (one CDP pass, read back) shows EFEKTY: WYŁ. in the right style and place, focused,
      with `settings.fx=false` and `fx.enabled=false` after a tap through the real
      `pendingActivate` path. The same shot shows the 9-row panel standing over the
      viewport edge — filed with two more defects as P26-P28.

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
