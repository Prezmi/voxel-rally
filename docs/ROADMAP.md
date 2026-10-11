# ROADMAP — finishing Voxel Rally

Written 2026-10-11 after the player review. Each phase is one bounded work package
with an acceptance check, executed by itself, verified with a real in-game capture.
No phase starts before the previous one is captured and green. The hourly loop
(`tools/self-improve.sh`) is paused for the duration of phases A–E so it cannot
collide with structural edits.

## Phase A — picture correctness

A1. Dust and gear-shift feel. The rear of the car chalks white after a few seconds
    of driving, which is the mud veil, not dirt. Acceptance: in a 3000 frame driving
    capture the rear panels keep body colour, dirt reads as splatter on the lower
    half, and a gear change produces a dark exhaust puff with a short flame instead
    of a white haze.
A2. Far vegetation art and spacing. Down the road, distant trees read as brown
    sticks. Acceptance: the far billboard band paints canopy mass, not trunks, and
    tree spacing along the route is planned, clusters and clearings with a minimum
    gap near the road, no uniform wall. Re-baked maps only.
A3. Sky, sun and horizon. Acceptance: blue zenith with a warm horizon, a visible sun
    disc that blooms through canopy gaps, and a distant hill and treeline layer
    filling the view out to the settings draw distance with no empty band.

## Phase B — handling

B1. High speed stability and braking. Acceptance: braking distance from 100 km/h
    measured in simulation inside 38 to 45 m on gravel and 26 to 32 m on tarmac, yaw
    gain per steering input never exceeds a pinned ceiling above 120 km/h, steering
    rate falls with speed, no snap oversteer on throttle lift, and the numbers are
    pinned by tests.

## Phase C — tracks as content, not generation

C1. Authored tracks with distinct environments, WRC-style: tarmac vineyard, gravel
    forest, snow stage, desert canyon, lakeside, farmland. Each has its own spline,
    surface mix, biome bands and a hand placed scenery layer, baked into the map
    files. Acceptance: six map files, each under 16 MB, loading in under 500 ms, zero
    generation while driving, and each recognisably different in one capture.
C2. Main menu track selection as tiles. Cards with track name, country, surface and
    length, keyboard and touch navigable, the chosen track persisted. Random track
    generation is removed from normal play and stays available only as an explicit
    debug route. Acceptance: one capture of the menu showing the tiles.

## Phase D — code cleanup

D1. Split the oversized modules, `src/game/hud-rally.js` at 1100 lines and
    `src/world/streaming.js` at 937, into cohesive units, remove the dead legacy post
    chain and any dead shims, unify the tuning tables into one place per subsystem,
    and split the 3666 line test file by subsystem. Acceptance: no source file over
    about 600 lines, no dead module left, the whole suite still green and organised
    per subsystem.

## Phase E — plan and docs

E1. Rewrite PLAN.md to the truth: the abolished zero-asset pillar, the asset
    pipeline, preset maps, i18n, the post stack, the technical budget as actually
    measured, and the AAA feel checklist marked pass or fail with the numbers.
