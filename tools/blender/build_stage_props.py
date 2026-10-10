#!/usr/bin/env python3
"""Stage furniture -> assets/models/props.glb

Headless:
    blender --background --python tools/blender/build_stage_props.py -- \
        --out assets/models/props.glb

One mesh node per prop, named prop_<name>, in the project's voxel/block language:
every block is written from an explicit vertex + face table (no booleans, no mesh
operators, no cone/sphere primitives). Materials are Principled BSDF parameter
values only - no texture / noise / ramp nodes, since the glTF exporter drops those.

Vegetation rules baked in here after the in-game review (shots/review-assets-in-game.png):
  * a tree is a TRUNK STACK you can see, plus layered FOLIAGE PLATES that step inward
    going up - never a scatter of random cubes, never a green blob;
  * three tones per tree (shaded underside / mid flanks / lit top plate), so the
    layering reads at driving distance;
  * plates are full square discs with overlapping height, so a ray through the crown
    has no see-through gap: the builder voxelises each tree and fails on any enclosed
    empty run along X, Y or Z;
  * fixed height hierarchy: pine 9.4 m > birch 7.8 m > deciduous 7.3 m > bush 1.65 m
    > hedgerow 1.45 m, matching SPRITE_SPEC in src/world/props.js.
Colours are the sRGB anchors of src/world/props.js / palette.js converted to
scene-linear: the engine treats baseColorFactor as linear, so raw sRGB hex renders
every green as pale mint (the exact fault the review flagged).
"""

import json
import math
import os
import struct
import sys

MAX_TRIS_PER_PROP = 4000
MAX_TRIS_TOTAL = 60000
MAX_HEIGHT_M = 200.0
VOXEL = 0.25                              # resolution of the see-through-gap check

# ------------------------------------------------------------------ palette
# props.js:375/382/388 trunk + bark, paintFoliage bases (props.js:196-244),
# surfaces.js / palette.js stone tones, props.js gate + marshal colours.
# Foliage anchors are deliberately deep: the sun key is 2.1 with ACES, which lifts
# everything, so a mid-green anchor renders as pale mint.
C = {
    "bark_pine":  (0x241809, 0.95),   # props.js:382 pine trunk, darkened
    "bark_oak":   (0x33220F, 0.95),   # props.js:375 oak trunk, darkened
    "bark_snag":  (0x2C2417, 0.95),   # props.js:389 dead wood
    "bark_birch": (0x7D7768, 0.90),   # props.js:243 pale birch trunk
    "bark_band":  (0x2A2620, 0.90),   # birch bark bands
    "timber":     (0x352D21, 0.90),   # props.js:411 corner / fence post
    "wood_board": (0x6B5230, 0.88),
    "pine_dark":  (0x16301A, 0.95),   # shaded underside of a conifer tier
    "pine_mid":   (0x21421F, 0.95),   # props.js:196 pine foliage base
    "pine_lit":   (0x2F5730, 0.95),   # lit top plate of a tier
    "leaf_dark":  (0x26411A, 0.95),   # shaded underside of a broadleaf crown
    "leaf_mid":   (0x3C5F24, 0.95),   # props.js:238 oak foliage base
    "leaf_lit":   (0x547A30, 0.95),   # lit crown top
    "birch_dark": (0x2A4A1E, 0.95),
    "birch_mid":  (0x44692A, 0.95),   # props.js:196 birch foliage base, de-minted
    "birch_lit":  (0x5C8536, 0.95),
    "bush_dark":  (0x1F3615, 0.95),   # props.js:250 bush foliage base
    "bush_mid":   (0x33511E, 0.95),
    "bush_lit":   (0x476B2A, 0.95),
    "soil":       (0x241C12, 0.95),   # darker soil collar at the hedge/ground line
    "stone_lit":  (0x77766E, 0.72),   # palette.js stone tone
    "stone_mid":  (0x5C5C57, 0.65),   # surfaces.js:84 stone
    "stone_dark": (0x44443F, 0.70),
    "gate_post":  (0xB89E73, 0.70),   # props.js:436
    "gate_red":   (0x9E2A22, 0.60),   # props.js:436
    "gate_dark":  (0x141A20, 0.55),   # props.js:436
    "lamp_warm":  (0xE8B45C, 0.40),   # props.js:436
    "hivis":      (0xC85F12, 0.80),   # spectator hi-vis jacket
    "hivis_yel":  (0xC8A62F, 0.75),   # props.js:421 marshal tab
    "trouser":    (0x22292F, 0.90),   # props.js:397
    "skin":       (0xA8846A, 0.85),   # props.js:398
    "pole_steel":  (0x6A6E74, 0.70),  # start gantry / banner arch steelwork
    "canvas":      (0xD9CFB4, 0.85),  # marshal tent canvas, sunlit side
    "canvas_shade":(0x8E8672, 0.85),  # tent canvas in shade / back wall
    "chequer":     (0x1A1C1F, 0.60),  # start-line chequer tabs
    "fence_mesh":  (0xA6A49A, 0.55),  # spectator fence mesh battens
}

# ------------------------------------------------------------------ helpers
def hsh(i, j, salt):
    n = (i * 374761393 + j * 668265263 + salt * 1274126177) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    n = (n ^ (n >> 16)) & 0xFFFFFFFF
    return n / 4294967295.0


def box(verts, faces, fmat, mat_idx, cx, cy, cz, hx, hy, hz):
    """One axis-aligned block from an explicit vertex/face table. Height = Z."""
    k = len(verts)
    verts.extend([
        (cx - hx, cy - hy, cz - hz), (cx + hx, cy - hy, cz - hz),
        (cx + hx, cy + hy, cz - hz), (cx - hx, cy + hy, cz - hz),
        (cx - hx, cy - hy, cz + hz), (cx + hx, cy - hy, cz + hz),
        (cx + hx, cy + hy, cz + hz), (cx - hx, cy + hy, cz + hz),
    ])
    for quad in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
                 (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        faces.append(tuple(k + q for q in quad))
        fmat.append(mat_idx)


def build(spec_blocks):
    verts, faces, fmat = [], [], []
    for cx, cy, cz, hx, hy, hz, mat in spec_blocks:
        box(verts, faces, fmat, MAT_ORDER.index(mat), cx, cy, cz, hx, hy, hz)
    return verts, faces, fmat


MAT_ORDER = list(C)


# --------------------------------------------------------------- vegetation
# A foliage cluster is a filled volume, not a slab: the wide shaded base plate stays
# centred on the branch so the stack can never be seen through, but the mid flanks and
# the lit crown sit at their own x/y offset with their own half-depths, and two lobes
# stick out on opposite quarters at different heights and tones. That breaks the
# "stack of identical square plates" read the in-game capture showed from ground level.
# Overlapping hz values keep the stack solid; the builder voxelises each tree and fails
# on any enclosed empty run along X, Y or Z.
def tier(salt, cx, cz, r, hz, idx, dark, mid, lit, arms=1.0):
    a = hsh(salt, idx, 17)
    b = hsh(idx, salt, 23)
    o = hsh(salt + 5, idx, 41) - 0.5     # cluster offset, always inside r
    q = hsh(idx, salt + 7, 59) - 0.5
    lo = hsh(salt + 2, idx, 71)
    side = 1.0 if (salt + idx) % 2 == 0 else -1.0
    out = [
        (cx, 0, cz - hz * 0.42, r * arms, r, hz * 0.46, dark),           # shaded underside
        (cx + o * r * 0.34, q * r * 0.34, cz + hz * 0.04,
         r * (0.80 + 0.12 * a) * arms, r * (0.78 + 0.14 * b), hz * 0.30, mid),   # near flank
        (cx - o * r * 0.26, -q * r * 0.30, cz + hz * 0.20,
         r * (0.66 + 0.14 * b) * arms, r * (0.70 + 0.12 * a), hz * 0.26, mid),   # far flank
        (cx + o * r * 0.46, q * r * 0.44, cz + hz * 0.46,
         r * (0.50 + 0.14 * b) * arms, r * (0.50 + 0.14 * a), hz * 0.42, lit),   # lit crown
        (cx + side * r * (0.66 + 0.18 * a), (b - 0.5) * r * 0.7,
         cz - hz * 0.10, r * 0.16, r * 0.16, hz * 0.36, dark),           # jutting sprig
        (cx - side * r * (0.60 + 0.16 * lo), (a - 0.5) * r * 0.86,
         cz + hz * 0.24, r * (0.15 + 0.11 * lo), r * (0.15 + 0.13 * lo),
         hz * (0.28 + 0.20 * abs(q)), lit if lo > 0.5 else mid),          # deeper side lobe
    ]
    return out


def trunk(cx, cz_top, hx_base, hx_top, mat, steps, flare=True, mat_alt=None):
    """Visible tapered trunk stack; every step is its own block."""
    out = []
    if flare:
        out.append((cx, 0, 0.14, hx_base * 1.55, hx_base * 1.55, 0.16, mat))
    step = cz_top / steps
    for s in range(steps):
        r = hx_base + (hx_top - hx_base) * (s / max(1, steps - 1))
        out.append((cx, 0, 0.16 + step * s + step * 0.5, r, r, step * 0.5,
                    mat if (mat_alt is None or s % 3) else mat_alt))
    return out


PROPS = {}

# --- pine: conical stack of 6 tiers over a visible trunk (SPRITE_SPEC 4.6 w x 9.4 h)
_pine = trunk(0, 3.30, 0.36, 0.18, "bark_pine", 5)
_pine_tiers = [(3.15, 2.28, 0.66), (4.30, 1.98, 0.62), (5.45, 1.68, 0.58),
               (6.55, 1.36, 0.54), (7.60, 1.02, 0.48), (8.55, 0.64, 0.42)]
for _t, (_z, _r, _hz) in enumerate(_pine_tiers):
    _pine.extend(tier(3 + _t, 0, _z, _r, _hz, _t, "pine_dark", "pine_mid", "pine_lit"))
_pine.append((0, 0, 9.20, 0.16, 0.16, 0.22, "pine_mid"))            # leader/spike
PROPS["tree_pine"] = dict(instance=True, blocks=_pine)

# --- deciduous / oak: trunk + branches + 5 crown plates (SPRITE_SPEC 5.6 w x 7.2 h)
_dec = trunk(0, 3.00, 0.36, 0.20, "bark_oak", 4)
_dec += [(0.55, 0, 2.95, 0.60, 0.16, 0.16, "bark_oak"),
         (-0.50, 0, 3.20, 0.16, 0.55, 0.16, "bark_oak")]
_dec_tiers = [(4.05, 2.30, 0.62), (4.90, 2.60, 0.66), (5.75, 2.35, 0.62),
              (6.45, 1.80, 0.54), (7.00, 1.10, 0.40)]
for _t, (_z, _r, _hz) in enumerate(_dec_tiers):
    _dec.extend(tier(21 + _t, 0, _z, _r, _hz, _t, "leaf_dark", "leaf_mid", "leaf_lit",
                     arms=1.0 if _t % 2 == 0 else 0.92))
PROPS["tree_deciduous"] = dict(instance=True, blocks=_dec)

# --- birch: slim pale trunk with dark bands, narrow tall crown (4.4 w x 7.8 h)
_birch = trunk(0, 3.60, 0.24, 0.12, "bark_birch", 6, mat_alt="bark_band")
_birch_tiers = [(4.00, 1.55, 0.52), (4.75, 1.85, 0.56), (5.50, 1.95, 0.56),
                (6.20, 1.68, 0.52), (6.85, 1.28, 0.46), (7.40, 0.78, 0.36)]
for _t, (_z, _r, _hz) in enumerate(_birch_tiers):
    _birch.extend(tier(41 + _t, 0, _z, _r, _hz, _t, "birch_dark", "birch_mid", "birch_lit",
                       arms=0.95))
_birch.append((0, 0, 7.78, 0.14, 0.14, 0.16, "birch_mid"))
PROPS["tree_birch"] = dict(instance=True, blocks=_birch)

# --- dead tree / snag: bare trunk stack + broken branch stubs (no canopy)
_dead = trunk(0, 5.30, 0.34, 0.14, "bark_snag", 6)
_dead += [(0.62, 0, 2.90, 0.68, 0.15, 0.15, "bark_snag"),
          (-0.55, 0, 3.60, 0.15, 0.60, 0.15, "bark_snag"),
          (0.15, 0.60, 4.30, 0.15, 0.62, 0.15, "bark_snag"),
          (-0.30, -0.35, 4.85, 0.42, 0.14, 0.14, "bark_snag"),
          (0.28, 0.15, 5.62, 0.20, 0.20, 0.30, "bark_snag")]
PROPS["tree_dead"] = dict(instance=True, blocks=_dead)

# --- bush: 3 short tiers over a stub trunk (SPRITE_SPEC 2.3 w x 1.7 h)
_bush = trunk(0, 0.55, 0.13, 0.10, "bark_snag", 2, flare=False)
for _t, (_z, _r, _hz) in enumerate([(0.58, 0.82, 0.30), (0.96, 1.00, 0.34), (1.34, 0.66, 0.26)]):
    _bush.extend(tier(61 + _t, 0, _z, _r, _hz, _t, "bush_dark", "bush_mid", "bush_lit"))
_bush.append((0, 0, 0.04, 0.86, 0.86, 0.045, "soil"))          # soil collar, hides the base
PROPS["bush"] = dict(instance=True, blocks=_bush)

# hedgerow: 3 m of continuous block hedge, soil foot, 3 tones, no gaps
_hedge = [(0, 0, 0.05, 1.50, 0.50, 0.055, "soil")]
for i in range(8):                      # 8 face blocks along X = 3.0 m
    x = -1.5 + 0.375 + i * 0.375
    jit = (hsh(i, 3, 83) - 0.5) * 0.10
    g = "bush_mid" if i % 2 == 0 else "leaf_mid"
    _hedge.append((x, jit, 0.42, 0.21, 0.50, 0.38, g))          # lower course, solid
    _hedge.append((x, jit, 0.95, 0.20, 0.46, 0.20, "leaf_dark"))  # shaded middle
for i in range(6):                      # lit, ragged top course
    x = -1.25 + i * 0.50 + (hsh(i, 7, 89) - 0.5) * 0.10
    _hedge.append((x, (hsh(i, 5, 91) - 0.5) * 0.14, 1.28, 0.30, 0.44, 0.18,
                   "leaf_lit" if i % 2 else "bush_lit"))
PROPS["hedgerow"] = dict(instance=True, blocks=_hedge)

# rock: grey block cluster
PROPS["rock"] = dict(instance=True, blocks=(
    [(-0.45, -0.20, 0.32, 0.50, 0.48, 0.32, "stone_mid"),
     (0.42, 0.22, 0.26, 0.44, 0.42, 0.26, "stone_dark"),
     (0.10, -0.42, 0.22, 0.36, 0.34, 0.22, "stone_lit"),
     (-0.12, 0.30, 0.62, 0.34, 0.30, 0.34, "stone_mid"),
     (0.30, -0.12, 0.70, 0.26, 0.26, 0.26, "stone_lit"),
     (0.02, 0.04, 1.06, 0.22, 0.22, 0.20, "stone_mid")]
))

# stone wall: 2 m section of stacked grey blocks
_wall = []
for course in range(4):
    z = 0.20 + course * 0.28
    n = 4 if course % 2 == 0 else 3
    off = 0.0 if course % 2 == 0 else 0.25
    for b in range(n):
        x = -1.0 + off + (b + 0.5) * (2.0 / n)
        if abs(x) > 1.0:
            continue
        jit = (hsh(course, b, 97) - 0.5) * 0.06
        tone = ["stone_mid", "stone_lit", "stone_dark"][(course + b) % 3]
        _wall.append((x, jit, z, 1.0 / n - 0.02, 0.24, 0.14, tone))
_wall.append((0, 0, 0.035, 1.05, 0.30, 0.035, "stone_dark"))
PROPS["stone_wall"] = dict(instance=True, blocks=_wall)

# fence post (props.js:411 timber post + dark base)
PROPS["fence_post"] = dict(instance=True, blocks=(
    [(0, 0, 0.12, 0.28, 0.28, 0.12, "gate_dark"),
     (0, 0, 0.85, 0.11, 0.11, 0.73, "timber"),
     (0, 0, 1.62, 0.13, 0.13, 0.05, "gate_dark")]
))

# fence rail: 2 m rail between two posts
PROPS["fence_rail"] = dict(instance=True, blocks=(
    [(0, 0, 0.92, 1.0, 0.07, 0.09, "timber"),      # 2.0 m top rail
     (0, 0, 0.58, 1.0, 0.07, 0.09, "timber"),      # 2.0 m lower rail
     (-1.12, 0, 0.62, 0.12, 0.12, 0.62, "timber"),  # post stubs at each end
     (1.12, 0, 0.62, 0.12, 0.12, 0.62, "timber")]
))

# marshal post: post + small cabin + flag
PROPS["marshal_post"] = dict(instance=True, blocks=(
    [(0, 0, 1.30, 0.13, 0.13, 1.30, "timber"),
     (0, 0, 0.10, 0.42, 0.42, 0.10, "gate_dark"),
     (0.0, 0.0, 0.80, 0.60, 0.52, 0.45, "bush_dark"),         # cabin
     (0.0, 0.0, 1.32, 0.70, 0.62, 0.08, "gate_dark"),        # roof
     (0.0, 0.55, 0.85, 0.40, 0.05, 0.26, "hivis_yel"),       # cabin window / panel
     (0.0, 0.0, 2.45, 0.14, 0.14, 0.12, "gate_dark"),        # flag staff top
     (0.26, 0.0, 2.72, 0.26, 0.02, 0.20, "gate_red")]        # flag cloth
))

# spectator: blocky person, hi-vis jacket, 1.7 m (props.js:397-398)
PROPS["spectator"] = dict(instance=True, blocks=(
    [(-0.10, 0, 0.22, 0.09, 0.10, 0.22, "trouser"),
     (0.10, 0, 0.22, 0.09, 0.10, 0.22, "trouser"),
     (0, 0, 0.91, 0.22, 0.18, 0.47, "hivis"),
     (-0.27, 0, 0.91, 0.05, 0.07, 0.42, "hivis"),
     (0.27, 0, 0.91, 0.05, 0.07, 0.42, "hivis"),
     (0, 0, 1.38, 0.22, 0.18, 0.02, "hivis_yel"),
     (0, 0, 1.53, 0.15, 0.14, 0.15, "skin")]
))


# Gate dimensions are the ones the running game builds, block for block, from
# src/world/props.js:432-461 buildGateGeometry (streaming.js:161-175 places the
# instanced gate with scale 1, so the glb must be the same size as the procedural
# geometry). In-game: posts centred at +/-5.4 m (10.8 m span, 11.22 m outer),
# 0.42 m square and 6.2 m tall, 11.4 m beam, top of the pennant at 6.85 m.
# props.js is Y-up (box cx, cy=height, cz=depth); Blender is Z-up, so the in-game
# (x, y, z, hx, hy, hz) becomes (x, z, y, hx, hz, hy) below.
def _gate(start):
    g = []
    # Pennant is boxRot(..., yaw 0.25) about the vertical axis in props.js:447; the
    # projected half-extents keep the same bbox without a mesh operator.
    yaw = 0.25
    pen_x = 0.55 * math.cos(yaw) + 0.03 * math.sin(yaw)
    pen_z = 0.55 * math.sin(yaw) + 0.03 * math.cos(yaw)
    for s in (-1, 1):
        # props.js:444  g.box(s * 5.4, 0.16, 0, 0.52, 0.16, 0.52, dark)
        g.append((s * 5.4, 0, 0.16, 0.52, 0.52, 0.16, "gate_dark"))
        # props.js:440  post: 0.42 m square, 6.2 m tall
        g.append((s * 5.4, 0, 3.1, 0.21, 0.21, 3.1, "gate_post"))
        # props.js:441-443  red bands
        g.append((s * 5.4, 0, 1.15, 0.24, 0.24, 0.45, "gate_red"))
        g.append((s * 5.4, 0, 2.65, 0.24, 0.24, 0.45, "gate_red"))
        g.append((s * 5.4, 0, 4.15, 0.24, 0.24, 0.35, "gate_red"))
        # props.js:445-446  lamp housing + warm panel at 4.7 m
        g.append((s * 4.7, 0, 5.28, 0.42, 0.30, 0.20, "gate_dark"))
        g.append((s * 4.7, 0, 5.02, 0.32, 0.22, 0.10, "lamp_warm"))
        # props.js:447  pennant on top of the post
        g.append((s * 5.4, 0.34, 6.55, pen_x, pen_z, 0.30, "gate_red" if s < 0 else "gate_post"))
    # props.js:450-451  11.4 m beam + 5.35 m banner over the lane
    g.append((0, 0, 5.62, 5.7, 0.30, 0.24, "gate_dark"))
    g.append((0, 0, 5.10, 5.35, 0.14, 0.55, "gate_post"))
    g.append((0, 0.16, 5.10, 5.35, 0.03, 0.55, "gate_red"))
    for s in (-1, 1):
        # props.js:453-454  chequered corner tabs
        g.append((s * 5.0, 0.18, 5.10, 0.55, 0.02, 0.55, "gate_red"))
        g.append((s * 4.4, 0.18, 5.10, 0.55, 0.02, 0.55, "gate_post"))
    if start:
        # props.js:457  name board, plus the start blocks either side of the line
        g.append((0, 0.10, 4.28, 2.6, 0.06, 0.42, "gate_dark"))
        g.append((0, 0.16, 4.28, 2.4, 0.04, 0.32, "gate_post"))
        g.append((-1.15, 0, 0.30, 0.24, 0.24, 0.30, "gate_red"))
        g.append((1.15, 0, 0.30, 0.24, 0.24, 0.30, "gate_red"))
    return g


PROPS["gate_checkpoint"] = dict(instance=True, blocks=_gate(False))
PROPS["gate_start"] = dict(instance=False, blocks=_gate(True))

# flag: rectangular cloth on a pole
PROPS["flag"] = dict(instance=True, blocks=(
    [(0, 0, 0.06, 0.22, 0.22, 0.06, "gate_dark"),
     (0, 0, 1.60, 0.05, 0.05, 1.54, "timber"),
     (0, 0, 3.22, 0.07, 0.07, 0.08, "gate_post"),
     (0.60, 0, 2.85, 0.56, 0.02, 0.36, "gate_red"),
     (0.60, 0, 2.33, 0.42, 0.02, 0.16, "gate_post")]
))

# sign board: 1 m wooden board with a dark frame (pace notes)
PROPS["sign_board"] = dict(instance=True, blocks=(
    [(-0.42, 0, 0.45, 0.06, 0.06, 0.45, "timber"),
     (0.42, 0, 0.45, 0.06, 0.06, 0.45, "timber"),
     (0, 0, 1.22, 0.55, 0.05, 0.38, "gate_dark"),
     (0, 0.06, 1.22, 0.50, 0.03, 0.33, "wood_board"),
     (0, 0.10, 1.50, 0.58, 0.02, 0.05, "gate_dark"),
     (0, 0.10, 0.94, 0.58, 0.02, 0.05, "gate_dark")]
))

# ------------------------------------------------- start-line furniture
# The opening frame has to read as a rally start, not as an empty lane: a truss
# gantry on the line, a banner arch down the road, a marshal tent on each verge and
# a fence panel that instances into a spectator line along both sides. Placed by
# Streaming._placeStartProps, which uses the same across-road = model X convention
# as _gate above, so every span below is in metres across the carriageway.
def _start_gantry():
    g = []
    for s in (-1, 1):
        x = s * 6.8
        for d in (-0.7, 0.7):
            g.append((x, d, 3.50, 0.20, 0.20, 3.50, "pole_steel"))      # legs
            g.append((x, d, 0.11, 0.36, 0.36, 0.11, "stone_dark"))      # foot pads
        for k in range(1, 5):                                           # struts
            g.append((x, 0, k * 1.55, 0.18, 0.80, 0.10, "pole_steel"))
        for k in range(3):                                              # stepped bracing
            g.append((x, -0.55 + k * 0.55, 0.75 + k * 1.55, 0.09, 0.40, 0.78, "pole_steel"))
            g.append((x, 0.55 - k * 0.55, 0.75 + k * 1.55, 0.09, 0.40, 0.78, "pole_steel"))
    g.append((0, 0, 7.30, 7.10, 0.34, 0.16, "pole_steel"))              # upper chord
    g.append((0, 0, 6.70, 7.10, 0.34, 0.10, "pole_steel"))              # lower chord
    for k in range(-3, 4):
        g.append((k * 2.0, 0, 7.00, 0.09, 0.30, 0.30, "pole_steel"))    # hangers
    # Start board. The old build was a 0.06 m dark plate at y 0.30, a 0.03 m canvas at
    # 0.36 and eight 0.02 m pale/near-black chequer tabs at 0.40: three near-coplanar
    # surfaces over the same 9.2 m span, so the depth pass could not separate them and
    # the alternating tabs aliased into a white/red checkerboard. One thick opaque plate
    # with a frame now, plus solid lettering blocks proud of BOTH faces (the gantry is
    # placed on a road tangent and is read from either side). No alpha anywhere.
    g.append((0, 0.30, 5.55, 4.80, 0.12, 0.84, "gate_dark"))           # frame, opaque
    g.append((0, 0.30, 5.55, 4.55, 0.16, 0.70, "canvas"))              # solid canvas plate
    for s in (-1, 1):
        for k in range(5):                                            # word row 1
            g.append((-3.30 + k * 1.65, 0.30 + s * 0.20, 5.80, 0.58, 0.05, 0.17, "gate_red"))
        for k in range(3):                                            # word row 2
            g.append((-2.30 + k * 2.30, 0.30 + s * 0.20, 5.25, 0.85, 0.05, 0.13, "gate_dark"))
        g.append((s * 5.35, 0.30, 5.55, 0.45, 0.16, 0.84, "gate_red"))  # solid end tabs
    return g


def _banner_arch():
    g = []
    for s in (-1, 1):
        g.append((s * 5.9, 0, 2.30, 0.28, 0.28, 2.30, "pole_steel"))    # posts
        g.append((s * 5.9, 0, 0.12, 0.46, 0.46, 0.12, "stone_dark"))    # pads
    rib = (4.55, 5.15, 5.60, 5.85, 5.60, 5.15, 4.55)                    # stepped rib
    for k, z in enumerate(rib):
        g.append((-5.20 + k * 1.73, 0, z, 0.95, 0.32, 0.26, "pole_steel"))
    # Banner cloth: one thick plate carrying its own lettering blocks on both faces.
    # As with the gantry, the old 0.03-0.05 m pale cloth + 0.03 m red trim + 0.05 m
    # chequer end tabs sat within 5 cm of each other and came back as dithered pale
    # slabbing over the lane.
    g.append((0, 0.32, 4.30, 4.55, 0.12, 0.84, "gate_dark"))           # frame, opaque
    g.append((0, 0.32, 4.30, 4.30, 0.16, 0.70, "canvas"))              # solid cloth plate
    for s in (-1, 1):
        for k in range(4):                                            # lettering
            g.append((-2.70 + k * 1.80, 0.32 + s * 0.20, 4.50, 0.62, 0.05, 0.18, "gate_red"))
        for k in range(2):                                            # lower rule
            g.append((-1.35 + k * 2.70, 0.32 + s * 0.20, 3.90, 1.05, 0.05, 0.10, "gate_dark"))
        g.append((s * 4.60, 0.32, 4.30, 0.40, 0.16, 0.84, "gate_red"))  # solid end tabs
    return g


def _marshal_tent():
    g = []
    for s in (-1, 1):
        g.append((s * 2.9, -2.4, 1.05, 0.09, 0.09, 1.05, "timber"))     # end posts
        g.append((s * 2.9, 2.4, 1.05, 0.09, 0.09, 1.05, "timber"))
        g.append((s * 2.85, 0, 1.55, 0.07, 2.40, 0.07, "timber"))       # side rails
    g.append((0, 2.45, 1.35, 2.90, 0.06, 1.35, "canvas_shade"))         # back wall
    for s in (-1, 1):                                                   # side walls
        g.append((s * 2.85, 0, 1.30, 0.05, 2.40, 1.30, "canvas_shade"))
    # Roof: three filled steps plus a ridge cap, widest lowest, so nothing shows through
    for w, z in ((2.95, 1.75), (2.25, 2.15), (1.50, 2.55)):
        g.append((0, 0, z, w, 2.55, 0.30, "canvas"))
    g.append((0, 0, 2.88, 0.75, 2.60, 0.10, "canvas_shade"))            # ridge cap
    g.append((0, -2.45, 1.00, 2.90, 0.05, 1.00, "canvas"))              # front wall
    for s in (-1, 1):                                                   # door halves
        g.append((s * 2.05, -2.45, 1.50, 0.85, 0.05, 0.50, "canvas"))
    g.append((0, -2.45, 2.05, 0.95, 0.05, 0.16, "timber"))              # lintel
    g.append((0, -1.60, 0.44, 0.90, 0.55, 0.44, "wood_board"))          # table
    for s in (-1, 1):
        g.append((s * 1.75, -1.55, 0.26, 0.38, 0.38, 0.26, "timber"))   # crates
    g.append((0, 2.10, 3.60, 0.05, 0.05, 0.72, "timber"))               # ridge flagpole
    g.append((0.55, 2.10, 3.95, 0.55, 0.02, 0.34, "gate_red"))
    return g


def _fence_panel():
    g = []
    for s in (-1, 1):
        g.append((s * 1.90, 0, 0.62, 0.09, 0.09, 0.62, "timber"))       # posts
        g.append((s * 1.90, 0, 0.06, 0.22, 0.22, 0.06, "stone_dark"))   # feet
    g.append((0, 0, 1.12, 1.95, 0.05, 0.07, "wood_board"))              # top rail
    g.append((0, 0, 0.72, 1.95, 0.05, 0.06, "wood_board"))              # mid rail
    for k in range(7):                                                  # mesh battens
        g.append((-1.62 + k * 0.54, 0, 0.55, 0.05, 0.03, 0.55, "fence_mesh"))
    return g


PROPS["start_gantry"] = dict(instance=False, blocks=_start_gantry())
PROPS["banner_arch"] = dict(instance=False, blocks=_banner_arch())
PROPS["marshal_tent"] = dict(instance=False, blocks=_marshal_tent())
PROPS["spectator_fence"] = dict(instance=True, blocks=_fence_panel())

EXPECTED = ["prop_" + k for k in PROPS]

# Vegetation contract, checked against the export: height bands and the hierarchy
# pine > birch > deciduous > bush > hedgerow. Sizes match SPRITE_SPEC in props.js.
SPEC = {"tree_pine": (8.9, 9.6, 4.2, 5.0), "tree_deciduous": (6.8, 7.6, 4.8, 5.8),
        "tree_birch": (7.4, 8.1, 3.8, 4.8), "tree_dead": (5.4, 6.6, 1.6, 3.2),
        "bush": (1.5, 1.85, 1.6, 2.4), "hedgerow": (1.35, 1.70, 2.9, 3.3)}
HIERARCHY = ["tree_pine", "tree_birch", "tree_deciduous", "bush", "hedgerow"]
SOLID_CHECK = list(SPEC)


def find_gaps(blocks):
    """Voxalise a prop and count real holes: an empty voxel that is walled in on both
    sides of all three axes, i.e. a ray that can pass straight through the foliage.
    Stepped tier edges and jutting sprigs are not holes, so they must not count."""
    occ = set()
    for cx, cy, cz, hx, hy, hz, _m in blocks:
        for i in range(int(math.floor((cx - hx) / VOXEL)), int(math.ceil((cx + hx) / VOXEL))):
            for j in range(int(math.floor((cy - hy) / VOXEL)), int(math.ceil((cy + hy) / VOXEL))):
                for k in range(int(math.floor((cz - hz) / VOXEL)), int(math.ceil((cz + hz) / VOXEL))):
                    if k >= 0:
                        occ.add((i, j, k))
    if not occ:
        return 0
    reach = 2                                   # a hole narrower than 0.50 m is nothing

    def wall(v, axis, sign):
        for step in range(1, reach + 1):
            n = tuple(list(v[i] + (sign * step if i == axis else 0) for i in range(3)))
            if n in occ:
                return True
            if n not in inside:
                return False
        return False

    inside = set()
    i0 = min(v[0] for v in occ); i1 = max(v[0] for v in occ)
    j0 = min(v[1] for v in occ); j1 = max(v[1] for v in occ)
    k0 = min(v[2] for v in occ); k1 = max(v[2] for v in occ)
    for i in range(i0, i1 + 1):
        for j in range(j0, j1 + 1):
            for k in range(k0, k1 + 1):
                inside.add((i, j, k))
    gaps = 0
    for v in inside:
        if v in occ:
            continue
        if all(wall(v, ax, s) for ax in range(3) for s in (-1, 1)):
            gaps += 1
    return gaps


# ------------------------------------------------------------------ materials
def s2l(c):
    """sRGB byte -> scene-linear channel (glTF baseColorFactor is linear)."""
    v = c / 255.0
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def make_material(name):
    from bpy import data as D
    color, rough = C[name]
    mat = D.materials.new("mat_" + name)
    mat.use_nodes = True
    nt = mat.node_tree
    for nb in list(nt.nodes):
        if nb.type != "BSDF_PRINCIPLED" and nb.type != "OUTPUT_MATERIAL":
            nt.nodes.remove(nb)
    bsdf = next(nb for nb in nt.nodes if nb.type == "BSDF_PRINCIPLED")

    def set_in(label, value):
        for inp in bsdf.inputs:
            if inp.name == label:
                inp.default_value = value
                return True
        return False

    r, g, b = s2l((color >> 16) & 255), s2l((color >> 8) & 255), s2l(color & 255)
    bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
    set_in("Roughness", rough)
    set_in("Metallic", 0.0)
    return mat


# ------------------------------------------------------------------ glb reader
def read_glb(path):
    with open(path, "rb") as fh:
        blob = fh.read()
    magic, _ver, total = struct.unpack("<III", blob[:12])
    if magic != 0x46546C67:
        raise ValueError("not a GLB")
    off, doc, bin_off = 12, None, None
    while off + 8 <= len(blob):
        clen, ctype = struct.unpack("<II", blob[off:off + 8])
        off += 8
        if ctype == 0x4E4F534A:
            doc = json.loads(blob[off:off + clen].decode("utf-8"))
        elif ctype == 0x004E4942:
            bin_off = off
        off += clen
    if doc is None or bin_off is None:
        raise ValueError("glb has no JSON or BIN chunk")
    return blob, doc, bin_off


def accessor_bbox(doc, blob, bin_off, acc_idx):
    acc = doc["accessors"][acc_idx]
    comp = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}[acc["componentType"]]
    view = doc["bufferViews"][acc["bufferView"]]
    base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    fmt = {5126: "f", 5125: "I", 5123: "H", 5122: "h", 5121: "B", 5120: "b"}[acc["componentType"]]
    n = acc["count"] * 3 if acc["type"] == "VEC3" else acc["count"]
    data = blob[bin_off + base:bin_off + base + comp * n]
    return struct.unpack("<%d%s" % (n, fmt), data)


def verify(path):
    blob, doc, bin_off = read_glb(path)
    meshes, accessors = doc.get("meshes", []), doc.get("accessors", [])
    rows, found = [], set()
    for node in doc.get("nodes", []):
        name = node.get("name", "")
        if not name.startswith("prop_"):
            continue
        found.add(name)
        prim = meshes[node["mesh"]]["primitives"]
        lo = [1e9] * 3
        hi = [-1e9] * 3
        tris = 0
        for p in prim:
            vals = accessor_bbox(doc, blob, bin_off, p["attributes"]["POSITION"])
            for k in range(3):
                lo[k] = min(lo[k], min(vals[k::3]))
                hi[k] = max(hi[k], max(vals[k::3]))
            if "indices" in p:
                tris += accessors[p["indices"]]["count"] // 3
            else:
                tris += len(vals) // 9
        w, h, d = hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]   # export_yup: Y is up
        rows.append(dict(name=name, width_m=round(w, 3), height_m=round(h, 3),
                         depth_m=round(d, 3), triangles=tris,
                         instance=PROPS[name[len("prop_"):]]["instance"]))
    rows.sort(key=lambda r: r["name"])
    missing = [n for n in EXPECTED if n not in found]
    return blob, rows, found, missing


# ------------------------------------------------------------------------ main
def main():
    args = sys.argv
    args = args[args.index("--") + 1:] if "--" in args else args[1:]
    out = "assets/models/props.glb"
    for k, a in enumerate(args):
        if a == "--out" and k + 1 < len(args):
            out = args[k + 1]
    out = os.path.abspath(out)
    manifest_path = os.path.join(os.path.dirname(out), "props.manifest.json")

    import bpy
    D = bpy.data
    for ob in list(D.objects):
        D.objects.remove(ob, do_unlink=True)
    materials = {name: make_material(name) for name in MAT_ORDER}

    total = 0
    solids = {}
    for key in PROPS:
        blocks = PROPS[key]["blocks"]
        if key in SOLID_CHECK:
            solids[key] = find_gaps(blocks)
        verts, faces, fmat = build(blocks)
        mesh = D.meshes.new("prop_" + key)
        mesh.from_pydata(verts, [], faces)
        mesh.validate(verbose=False)
        mesh.update()
        for name in MAT_ORDER:
            mesh.materials.append(materials[name])
        for i, m in enumerate(fmat):
            mesh.polygons[i].material_index = m
        obj = D.objects.new("prop_" + key, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.select_set(True)
        tris = sum(len(f) - 2 for f in faces)
        total += tris
        print("built  prop_%-16s blocks=%3d verts=%4d tris=%d"
              % (key, len(blocks), len(verts), tris))

    os.makedirs(os.path.dirname(out), exist_ok=True)
    try:
        bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True,
                                  export_apply=True, export_materials="EXPORT",
                                  export_cameras=False, export_lights=False, export_yup=True)
    except TypeError:
        bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True,
                                  export_apply=True, export_yup=True)

    blob, rows, found, missing = verify(out)
    size = len(blob)
    glb_tris = sum(r["triangles"] for r in rows)

    print("\n--- self-check: %s ---" % out)
    for r in rows:
        key = r["name"][len("prop_"):]
        solid = ("see-through %d" % solids[key]) if key in solids else "-"
        print("node %-22s w=%6.2f m  h=%6.2f m  d=%6.2f m  tris=%5d  %s"
              % (r["name"], r["width_m"], r["height_m"], r["depth_m"], r["triangles"], solid))
    print("nodes found      : %d / %d" % (len(found), len(EXPECTED)))
    print("total triangles  : %d (glb) / %d (built)" % (glb_tris, total))
    print("file size bytes  : %d" % size)

    doc = dict(generated_by="tools/blender/build_stage_props.py", source_glb=os.path.basename(out),
               total_triangles=glb_tris, file_bytes=size, props=rows)
    with open(manifest_path, "w") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")
    print("manifest written : %s" % manifest_path)

    ok = True
    if missing:
        print("FAIL missing nodes: %s" % ", ".join(missing))
        ok = False
    if glb_tris > MAX_TRIS_TOTAL:
        print("FAIL total triangles %d > %d" % (glb_tris, MAX_TRIS_TOTAL))
        ok = False
    by_name = {r["name"][len("prop_"):]: r for r in rows}
    for key, (hmin, hmax, wmin, wmax) in SPEC.items():
        r = by_name.get(key)
        if not r:
            continue
        if not hmin <= r["height_m"] <= hmax:
            print("FAIL %s height %.2f m outside [%.2f, %.2f] m" % (key, r["height_m"], hmin, hmax))
            ok = False
        if not wmin <= max(r["width_m"], r["depth_m"]) <= wmax:
            print("FAIL %s spread %.2f m outside [%.2f, %.2f] m"
                  % (key, max(r["width_m"], r["depth_m"]), wmin, wmax))
            ok = False
    hs = [by_name[k]["height_m"] for k in HIERARCHY if k in by_name]
    if len(hs) == len(HIERARCHY) and any(a <= b for a, b in zip(hs, hs[1:])):
        print("FAIL height hierarchy broken: %s" % " > ".join("%.2f" % h for h in hs))
        ok = False
    for key, g in solids.items():
        if g:
            print("FAIL %s has %d see-through gaps in its foliage" % (key, g))
            ok = False
    for r in rows:
        if r["height_m"] > MAX_HEIGHT_M:
            print("FAIL %s height %.2f m > %.1f m" % (r["name"], r["height_m"], MAX_HEIGHT_M))
            ok = False
        if r["triangles"] > MAX_TRIS_PER_PROP:
            print("FAIL %s tris %d > %d" % (r["name"], r["triangles"], MAX_TRIS_PER_PROP))
            ok = False
        if r["height_m"] <= 0 or r["width_m"] <= 0 or r["depth_m"] <= 0:
            print("FAIL %s degenerate bounds" % r["name"])
            ok = False
    if not ok:
        sys.exit(1)
    print("OK %d nodes, budgets + height hierarchy + solid canopies respected" % len(rows))
    sys.exit(0)


main()
