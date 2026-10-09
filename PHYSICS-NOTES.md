# PHYSICS-NOTES — deviations from `docs/02-physics.md`

Every entry is a place where the code no longer matches the document, why, and what
was measured. Same spirit as the deviations already argued in `docs/08`.

Measured with the harness scripts in `tools/`:
`bed6.mjs` (parked-car trace, `--flat` `--sub=N` `--thr=X`), `bed9.mjs` (per-term energy
breakdown), `bed11.mjs` (synthetic flat world, `--yaw=`), `bed12.mjs` (placement report),
`smoke.mjs` (drive the stage), `intq.mjs` (does `integrateQ` rotate about the right axis),
`covar.mjs` (two parked cars at different yaws must agree in the BODY frame), `grow.mjs`
(growth per step of a 1e-9 perturbation of the parked equilibrium), `steptrace.mjs`
(per-substep power of every term, without touching `src/`), `jac.mjs` (24-DOF finite
difference map — see §7: unreliable at zero speed), `bed13.mjs` (like `bed11` but with a
fresh `Vehicle` per variant and the constants it actually used printed).
`node src/debug/tests.js` runs the §11 regression suite.

---

## 1. The wheel's slip ↔ spin coupling is solved implicitly (docs/02 §3.7)

**Doc:** `omega += (drive - brake - F_lon*r)/I * h` — explicit.

**Why it changed.** With the doc's own numbers the tyre is the stiffest element in the
model: `dF/dkappa ≈ B0*C0*mu*N ≈ 42 kN` per unit slip, so `dF/domega ≈ 28 kN` per rad/s.
Explicit Euler on that coupling overshoots by an order of magnitude every substep, and a
car that is *parked* is exactly where it shows: `kappa` is computed with `max(|vx|,|wr|,0.5)`,
so a 3 cm/s creep reads as 6% slip and the tyre answers with full peak force. Measured on
the flat start line: **2.3 kN per wheel, flipping sign every substep**, with the car at
0.03 m/s. The body then feels a couple of kN alternating at the substep rate.

**Now.** `brakeAndDrive` takes one linear implicit step using the *local* slope of the magic
formula (`w.slipSlope`, `w.kappaDenom`, both set by `tyreForces`):

```
G  = mu*N * slope * r / kappaDenom                 // N per (rad/s)
dw = (T - r*F0) / (I/h + r*G)
F1 = F0 + G*dw                                     // clamped to mu*N and the circle
```

Because the slope is the local one, this collapses back to the explicit case exactly where
the tyre is saturated — a wheel that is spinning away is still free to spin away.
Measured: standstill `Flon` 2.3 kN → 0.01 kN per wheel.

**Cost:** the handbrake lost the behaviour it had been tuned against (see §6).

---

## 2. The strut can pull (docs/02 §2 clamped `N_i >= 0`)

**Doc:** `N_i` is clamped non-negative.

**Why it changed.** A clamped `N` means the strut is not attached to the hub. The body
then flies off the wheels and the travel limit re-attaches it every substep, which
ratchets the car upward: `gravPE` grew by 19 kJ in 2 s on flat ground with the car at zero
throttle (`bed9 --flat`), and the wheels ended 1.6 m above the ground still at their
nominal lengths.

**Now.** `suspensionForce` lets `N` go negative (±60 kN clamp). Whether a *tyre* has grip is
a separate question and is clamped where it is used: `tyreForces` uses
`load = max(0, w.N)` for `F_peak`, rolling resistance and plough, and `brakeAndDrive` caps
with `max(0, w.N)`.

---

## 3. Hull contact applies the whole wrench (docs/02 §8 shell contact)

**Doc:** gives the penalty force; the code applied force only.

**Why it changed.** The hull corners are 2.1 m from the CoM. Pushing a buried corner up
without the matching moment lifts the *whole car* instead of rotating the corner out of the
ground. Measured on flat ground at zero input: `Fy = +47 kN`, `tqPitch = 78 kN·m`, the car
launched 1.5–3 m into the air and ended on its nose.

**Now.** `hullContact` accumulates force and torque for the normal *and* the scraping
friction:

```
torque.x += ry*fz - rz*fn;   torque.y += rz*fx - rx*fz;   torque.z += rx*fn - ry*fx;
```

---

## 4. Sub-block road bed, mesh *and* physics (docs/03)

`docs/03` asks for a sub-block heightfield (`height + rut/16 + micro`) but the mesher used
integer tops and physics only ever read `world.groundHeight()`, so the carved road stepped
by whole 1 m blocks wherever `road.h` crossed a half-metre boundary. The car sat straddling
that step on the start line with three wheels in the air and `v = 0` forever.

**Now.** `Chunk.fine` (Int16, 1/16-block) plus `rut` widened to Int16; a column's surface is
`height + 1 + (fine + rut)/16` metres, exposed as `columnTop()` / `columnTopQ()`.
`carveColumn` works in 1/16 units (`Q = round(targetY*16)`). The mesher keeps tops in
`topQ` and merges top faces only across equal 1/16 heights; wall faces are merged as
per-plane *bands* `[bandLo, bandHi]` instead of the old wall mask.

---

## 5. Placement is a static-equilibrium solve on the road plane (new; docs/02 is silent)

`placeAt` used to put the CoM at `ground + comY` with the wheels just touching. Three bugs
compounded:

- the tyre started **uncompressed**, so the first substeps yanked the wheels down at
  ~180 m/s² (`suspension` pre-loaded, `Fg = 0`);
- a rigid body on springs of two different rates does **not** sag equally: with
  `kF=78 kN/m`, `kR=66 kN/m` the correct sags are 0.0391 / 0.0462 m, so the rear sits
  0.007 m lower;
- a **level** body cannot satisfy a road that grades and banks across its own wheelbase
  (the start line falls 0.15 m across the track), which pins two wheels against a travel
  limit before step one.

**Now.** `placeAt` solves, by least squares against the body-frame mount offsets, the
pitch and roll that put every corner at its static length on a pre-loaded tyre
(`tyreComp = (W/4 + m_unsprung*g)/K_tyre`), iterated three times, clamped to ±0.18 rad.
Sign convention matters and was got wrong once: pitch is a rotation about body **+Z** and
therefore *raises* the front hub (`hub_y = posY + mountY + pitch*mountLocal.x -
roll*mountLocal.z`). Placement at the start line: pitch +0.046, roll −0.043, lengths
0.457 / 0.445 / 0.438 / 0.450 — all inside travel, none pinned.

`prevQuat` is now copied from the placed attitude instead of being left at identity
(the renderer interpolates against it, so a car placed on a banked road snapped upright
on the first frame).

---

## 6. Handbrake lever re-sized, and §3.4's lock limit applied to the spin

`handbrakeGain` (rear brake torque as a multiple of the rear tyre's own peak) went
**2.00 → 1.84** on every car.

With §1 in place a rear fed 2× its peak locks *solid*, and a solid-locked tyre keeps all of
its force along the slide and none across it: T3 measured **59° of body slip** where §11
wants 12–22°. Retuning alone is a cliff, not a fix — 1.80 gives 11.7°, 1.85 gives 26.1° —
so `brakeAndDrive` also enforces §3.4's `kappa_lock = 0.18` as a floor on the wheel's spin
(`omega >= vx*(1-lockLimit)/r`) for the **service** brake only. The handbrake remains the
one control allowed to drag the rear past peak, which is the point of it.

T3 now: **12.1°, recovery 0.88 s** (want 12–22°, < 1.2 s). This is at the bottom edge of
the window and the response to the gain is a cliff; it is the most fragile number in the
model.

---

## 7. `integrateQ` rotated the body about the WORLD axes while feeding it body-frame rates

**Doc:** §9 integrates the attitude from the body-frame Euler equation: `dω/dt` with the
body-frame inertia tensor, then `ω -> quat -> vel -> pos`.

**Why it changed.** `Body.integrate` does exactly that — `ω_body = Rᵀ ω`, the Euler step,
then `integrateQ(quat, _wB, h)` with the *body-frame* ω. But the cross term inside
`integrateQ` had the sign of `ω × q` instead of `q × ω`:

```
q.x += ox*qw + oy*qz - oz*qy     // = 0.5*(0,ω)⊗q  -> WORLD-frame kinematics
q.x += ox*qw - oy*qz + oz*qy     // = 0.5*q⊗(0,ω)  -> BODY-frame kinematics   (§9)
```

so the quaternion was tilted by the triple `(ωx, ωy, ωz)` read along the **world** axes
while `ω` itself was the body-frame vector. The mistake is invisible in a frame audit of
`src/car` — every lever arm and every force there is consistent — which is why it survived
the whole §1–§6 pass, and why it looked like a physics bug: the error is a rotation of ω
about the body axes, so it is **zero when the body happens to be aligned with the world
(yaw 0) and maximal at yaw ±90°**. `tools/intq.mjs`: with a *pure body-frame pitch* rate of
1 rad/s on a nose-up 0.0027 rad attitude, the old code produced in one substep
Δpitch = 1.65e-6 with Δroll = 2.08e-3 at yaw 1.57 (the rate was applied about world Z,
which there *is* the body's roll axis) and Δpitch = 1.92e-3 with Δroll = 8.1e-4 at yaw 0.4.
After the sign fix: Δpitch = ω·h = 2.083e-3 and Δroll = 0 at every yaw.

**Mechanism.** The attitude is tilted without the matching change in the body rates, so
`ω_body·I·ω_body` no longer describes the rotation the quaternion says the body has, while
the wheels are still loaded against the old attitude. Every substep the struts do net work
on a body whose inertia and orientation are out of step (`steptrace.mjs`, 2 s at zero input
on flat ground: `Σ N_i·hubVy_i` = **+147 kJ** at yaw 1.57 with `ΣN` pinned at the car's
weight, against +37 J at yaw 0.4), and the pitch/roll mode rings up. No force law is
responsible — that is why turning off the hull, the travel limit, the bump/droop stops, the
ARB, the tyre forces *or* the suspension changed nothing, why 4/8/16/32 substeps gave
identical results, and why extra damping only hid the symptom.

**Measured.** Growth per 1/120 s step of a 1e-9 perturbation about the parked equilibrium
(`grow.mjs`, the pre-fix column measured on a copy of the modules before the fix):

| yaw | before | after |
|---|---|---|
| 0.4 | 0.9864 (decays) | 0.9861 |
| 1.57 | **1.0128** (≈4.5e6 over 10 s) | 0.9866 |
| −2.991 | **1.0088** | 0.9859 |

`bed11.mjs`, 1200 steps: before — yaw 0.4 `maxRate 0.00 maxDy 0.000`; yaw 1.57
`maxRate 6.54 maxDy 3.594`; yaw −2.991 `maxRate 4.98 maxDy 1.339`. After: `maxRate 0.00
maxDy 0.000` and lengths 0.476/0.476/0.469/0.469 at **all** of yaw 0, 0.4, 0.8, 1.2, 1.57,
2.0, 2.5, −2.991, 3.14 (`bed13.mjs`, which builds a fresh `Vehicle` per variant —
`bed11.mjs` mutates `car.susp`/`car.params` between variants and those objects are shared,
which is where the earlier "doubling the damping fixes it" reading came from). `covar.mjs`,
which compares two runs at yaw 0.4 and yaw 1.57 in the body frame, now agrees to ~1e-12 for
44 s: the parked car is genuinely yaw-invariant again.

Knock-on: `smoke.mjs` advances 12 → 78 along the stage (was 12 → 30) and ends at 22.8 m/s
(was 0.4), `maxAir 4` unchanged; §11 is still 9/9 (T1 82.2 m, T2 ratio 1.13, T3 12.2° /
0.88 s, T7 maxAngVel 0.013); `bed6.mjs --flat` and `bed6.mjs` sit still with `sumN`
12.2 kN against a 12.16 kN car and no wheel at a travel limit.

**Note on `jac.mjs`.** Its 24-DOF finite-difference spectrum must not be believed at zero
speed: `Math.sign(w.vx)` in rolling resistance and the `max(0, …)` clamps are
discontinuous at a parked car, so a 1e-6 probe reads a jump of ~2·crr·N as a derivative and
the QR eigenvalues land wherever the kinks point (it reported |λ| = 1.03 for the *fixed*
code at yaw 1.57, where the car is provably stable). `grow.mjs` — walk the perturbation
through the real substep and renormalise — is the measurement to use; `jac.mjs` is kept
only for the yaw-vs-yaw difference matrix, which is where a frame error shows up first.

---

## 8. Brake and travel numbers already deviating (from the earlier pass, still true)

- `brakeMax` 3600 → 5000 N·m: 3600 caps deceleration at 0.88 g, which cannot satisfy §11
  test 1's 78–92 m.
- travel `[-0.06, +0.11]` → `[-0.10, +0.12]`: static sag 0.037 leaves 0.023 m of dynamic
  travel.
- §11 test 2's 41–46 m/s on a 60 m arc implies 2.9 g with the document's own μ = 1.18.
  The test now asserts against `sqrt(mu_eff*g*R)` = 27.4 m/s asphalt / 22.6 gravel; measured
  22.9 / 20.2, ratio 1.13.
- `Vehicle.substeps = 4` (docs/02 §9 wants a finer wheel step).
- Combined slip is a slip **vector** (`F_peak * magic(hypot(kappa, alpha))` split by
  direction), not proportional scaling of two independent axes: proportional scaling lets a
  fully locked wheel keep almost all of its lateral grip, so a handbrake could never break
  the rear away.
