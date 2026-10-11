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
    "bark_pine":  (0x1A1007, 0.95),   # pine bark, deep red-brown
    "bark_pine_b":(0x2C1B0B, 0.95),   # pine bark band (lighter course in the stack)
    "bark_oak":   (0x231707, 0.95),   # oak bark
    "bark_oak_b": (0x3A2510, 0.95),   # oak bark band / branch wood
    "bark_snag":  (0x20190F, 0.95),   # dead wood, grey-brown
    "bark_snag_b":(0x332A1B, 0.95),   # weathered grey check on a snag
    "bark_birch": (0x6E6859, 0.90),   # pale birch trunk
    "bark_birch_b":(0x544E42, 0.90),  # birch trunk in shade (root flare, lee side)
    "bark_band":  (0x262219, 0.90),   # birch bark lenticel bands
    "timber":     (0x352D21, 0.90),   # props.js:411 corner / fence post
    "wood_board": (0x6B5230, 0.88),
    # Four tones per species. The old anchors (pine_mid 0x21421F, leaf_mid 0x3C5F24,
    # birch_mid 0x44692A) sat too high and too desaturated: with a 2.1 key light and
    # ACES on top, baseColorFactor lands in pale mint and every species collapses into
    # one tone. These are pulled down 25-40% in value and pushed toward green/yellow.
    "pine_dark":  (0x09190D, 0.95),   # conifer tier, shaded underside
    "pine_mid":   (0x12300F, 0.95),   # conifer body
    "pine_lit":   (0x1C4A14, 0.95),   # sunlit cap of a tier
    "pine_rim":   (0x3F6218, 0.95),   # warm rim lobe on the lit side
    "leaf_dark":  (0x10250C, 0.95),   # broadleaf crown, shaded underside
    "leaf_mid":   (0x1E3D11, 0.95),   # broadleaf body
    "leaf_lit":   (0x2C5A16, 0.95),   # sunlit crown mass
    "leaf_rim":   (0x52701E, 0.95),   # warm rim, lit edge of the crown
    "birch_dark": (0x12270E, 0.95),   # birch is finer and a touch yellower than oak
    "birch_mid":  (0x214213, 0.95),
    "birch_lit":  (0x305C1C, 0.95),
    "birch_rim":  (0x5C7626, 0.95),
    "bush_dark":  (0x0C1E0B, 0.95),   # understory shrub, shaded underside
    "bush_mid":   (0x173211, 0.95),
    "bush_lit":   (0x234818, 0.95),
    "bush_rim":   (0x3E5E1E, 0.95),
    "fern_dark":  (0x08170A, 0.95),   # fern frond, underside / back fronds
    "fern_mid":   (0x11290F, 0.95),   # frond body
    "fern_lit":   (0x1B3F14, 0.95),   # frond tip catching the key
    "fern_rim":   (0x2C5518, 0.95),   # warm rim on the front fronds
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
    "fence_mesh":  (0x8F8D82, 0.60),  # spectator fence mesh battens
    # Marshal tent tones. The old "canvas" (0xD9CFB4) sheet read as broken geometry
    # at rally speed, so the tents get their own mid-tan canvas plus a barn-red roof
    # that sits inside the rally red/white furniture family.
    "tent_canvas": (0xB5A27C, 0.85),  # sunlit tent wall
    "tent_shade":  (0x6F6449, 0.85),  # tent wall in shade / back face
    "tent_roof":   (0x8B3327, 0.70),  # coloured tent roof, matches gate_red
    "tent_roof_2": (0x5E241C, 0.70),  # shaded roof step / ridge
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
# A foliage cluster is a filled VOLUME with four tones, not a plate:
#   * the deep shadow mass is the widest block and hangs below the branch plane, so the
#     underside of a canopy reads dark from the road instead of pale mint;
#   * two mid-tone flank masses at different spans carry the body of the cluster, so the
#     silhouette is lumpy rather than a stepped square disc;
#   * the sunlit mass sits proud of the cluster top and off-centre, never a full plate;
#   * one warm rim lobe on the lit side is hung LOWER than the crown, which is what makes
#     the edge of a canopy droop instead of reading as a shelf.
# Every half-extent and offset comes out of hsh(), which also keeps two differently
# coloured faces off the same plane (coplanar_conflicts() below fails the export if a
# differently-coloured face pair ever lands coplanar and overlapping - that is what
# dithered the old flat plates into one pale mass).
def cluster(salt, cx, cz, r, hz, tones, arms=1.0, droop=1.0):
    dark, mid, lit, rim = tones
    a = hsh(salt, 1, 17); b = hsh(salt, 2, 23); c = hsh(salt, 3, 41)
    d = hsh(salt, 4, 59); e = hsh(salt, 5, 71); f = hsh(salt, 6, 83)
    side = 1.0 if salt % 2 == 0 else -1.0
    return [
        (cx, (b - 0.5) * r * 0.20, cz - hz * (0.30 + 0.20 * droop),
         r * (0.95 + 0.07 * a) * arms, r * (0.93 + 0.08 * b), hz * 0.37, dark),
        (cx + (a - 0.5) * r * 0.52, (d - 0.5) * r * 0.70, cz + hz * 0.02,
         r * (0.78 + 0.11 * c) * arms, r * (0.74 + 0.13 * a), hz * 0.33, mid),
        (cx - (d - 0.5) * r * 0.44, (c - 0.5) * r * 0.64, cz + hz * (0.16 + 0.12 * e),
         r * (0.65 + 0.13 * b) * arms, r * (0.69 + 0.15 * f), hz * 0.30, mid),
        (cx + (e - 0.5) * r * 0.36, (f - 0.5) * r * 0.42, cz + hz * (0.32 + 0.12 * b),
         r * (0.51 + 0.15 * d) * arms, r * (0.49 + 0.15 * e), hz * 0.27, lit),
        (cx + side * r * (0.70 + 0.17 * f), (a - 0.5) * r * 0.52,
         cz - hz * (0.06 + 0.18 * droop), r * (0.18 + 0.08 * b), r * (0.20 + 0.10 * c),
         hz * (0.23 + 0.09 * d), rim),
    ]


def conifer(salt, cx, cz, r, hz, tones, arms=1.0):
    """Four-box cluster for a conifer tier: same four tones, one less mass per tier so a
    six-tier pine stays inside the near-band triangle budget."""
    dark, mid, lit, rim = tones
    a = hsh(salt, 1, 17); b = hsh(salt, 2, 23); c = hsh(salt, 3, 41)
    d = hsh(salt, 4, 59); e = hsh(salt, 5, 71)
    side = 1.0 if salt % 3 == 0 else -1.0
    return [
        (cx, (b - 0.5) * r * 0.16, cz - hz * 0.30,
         r * (0.97 + 0.05 * a) * arms, r * (0.95 + 0.06 * b), hz * 0.40, dark),
        (cx + (a - 0.5) * r * 0.30, (d - 0.5) * r * 0.52, cz + hz * 0.06,
         r * (0.74 + 0.13 * c) * arms, r * (0.72 + 0.14 * d), hz * 0.34, mid),
        (cx - (c - 0.5) * r * 0.34, (e - 0.5) * r * 0.40, cz + hz * 0.30,
         r * (0.48 + 0.16 * e) * arms, r * (0.46 + 0.16 * a), hz * 0.28, lit),
        (cx + side * r * (0.62 + 0.20 * d), (e - 0.5) * r * 0.62,
         cz - hz * 0.16, r * (0.17 + 0.09 * d), r * (0.19 + 0.11 * b),
         hz * (0.26 + 0.10 * c), rim),
    ]


def trunk(cx, cz_top, hx_base, hx_top, mat, steps, flare=True, mat_alt=None,
          bark_every=3, salt=0, branch=None):
    """Root flare (two stacked offset pads wider than the trunk), a taper, bark banding
    (every `bark_every` course lands in the lighter bark tone) and branch stubs the
    canopy sits on. Each course carries a few centimetres of z/y/r jitter so the band
    courses do not share a plane with the course above it."""
    out = []
    if flare:
        out.append((cx, 0, 0.11, hx_base * 1.72, hx_base * 1.64, 0.11, mat_alt or mat))
        out.append((cx + hx_base * 0.24, -hx_base * 0.19, 0.30,
                    hx_base * 1.28, hx_base * 1.21, 0.10, mat))
    step = (cz_top - 0.40) / steps
    for s in range(steps):
        r = hx_base + (hx_top - hx_base) * (s / max(1, steps - 1))
        zj = (hsh(salt + s, 7, 101) - 0.5) * 0.06
        yj = (hsh(salt + s, 9, 103) - 0.5) * 0.04
        rj = (hsh(salt + s, 11, 107) - 0.5) * 0.04
        out.append((cx, yj, 0.40 + step * s + step * 0.5 + zj, r + rj, r + rj * 0.6,
                    step * 0.5, mat if (mat_alt is None or s % bark_every) else mat_alt))
    for _bi, (bx, by, bz, bhx, bhy, bhz) in enumerate(branch or ()):  # branch structure
        out.append((cx + bx, by, bz + (hsh(salt + _bi, 3, 109) - 0.5) * 0.03,
                    bhx, bhy, bhz, mat_alt or mat))
    return out


PROPS = {}

# --- pine: conical crown of 5 tiers over a flared, barked trunk. Node is kept at or
# under NEAR_LOD_TRIS[PROP.PINE] (props.js:491, 320 tris) on purpose: over budget the
# streaming layer throws the baked node away for the cheap procedural near build
# (streaming.js:235-244) and none of this work is ever drawn.
_pine = trunk(0, 3.55, 0.34, 0.17, "bark_pine", 3, mat_alt="bark_pine_b", bark_every=2,
              salt=3)
_pine_tiers = [(3.35, 2.24, 0.72), (4.55, 1.92, 0.68), (5.70, 1.60, 0.62),
               (6.85, 1.26, 0.56), (7.95, 0.86, 0.48)]
for _t, (_z, _r, _hz) in enumerate(_pine_tiers):
    _pine.extend(conifer(3 + _t, 0, _z, _r, _hz, ("pine_dark", "pine_mid", "pine_lit",
                                                  "pine_rim")))
_pine.append((0, 0, 9.02, 0.15, 0.15, 0.30, "pine_mid"))            # leader/spike
PROPS["tree_pine"] = dict(instance=True, blocks=_pine)

# --- oak: spreading branch structure the crown clusters sit on (SPRITE_SPEC 5.6 x 7.2)
_dec = trunk(0, 3.05, 0.38, 0.22, "bark_oak", 2, mat_alt="bark_oak_b", bark_every=2,
             salt=21,
             branch=[(0.72, 0.10, 3.02, 0.62, 0.17, 0.17),
                     (-0.66, -0.14, 3.34, 0.17, 0.58, 0.16),
                     (0.12, 0.76, 2.70, 0.16, 0.62, 0.15)])
_dec_tiers = [(4.25, 2.24, 0.72), (5.45, 2.42, 0.76), (6.62, 1.72, 0.58)]
for _t, (_z, _r, _hz) in enumerate(_dec_tiers):
    _fn = cluster if _t == 0 else conifer
    _dec.extend(_fn(21 + _t, (-0.34 if _t == 0 else (0.30 if _t == 1 else -0.22)), _z,
                    _r, _hz, ("leaf_dark", "leaf_mid", "leaf_lit", "leaf_rim"),
                    arms=1.0 if _t != 1 else 0.94))
PROPS["tree_deciduous"] = dict(instance=True, blocks=_dec)

# --- birch: slim pale trunk, dark lenticel bands, finer and tighter crown
_birch = trunk(0, 4.30, 0.24, 0.12, "bark_birch", 4, mat_alt="bark_band", bark_every=2,
               salt=41,
               branch=[(0.36, 0.10, 3.42, 0.34, 0.11, 0.11),
                       (-0.32, -0.08, 4.04, 0.11, 0.32, 0.10)])
for _t, (_z, _r, _hz) in enumerate([(4.55, 1.58, 0.56), (5.60, 1.82, 0.62),
                                    (6.65, 1.56, 0.54)]):
    _fn = cluster if _t == 1 else conifer
    _birch.extend(_fn(41 + _t, 0, _z, _r, _hz,
                      ("birch_dark", "birch_mid", "birch_lit", "birch_rim"),
                      arms=0.94))
_birch.append((0, 0, 7.78, 0.13, 0.13, 0.20, "birch_mid"))
PROPS["tree_birch"] = dict(instance=True, blocks=_birch)

# --- dead snag: root flare, weathered bark check, tapered stack, broken limbs
_dead = trunk(0, 5.90, 0.34, 0.13, "bark_snag", 3, mat_alt="bark_snag_b", bark_every=2,
              salt=51,
              branch=[(0.58, 0.06, 2.86, 0.58, 0.15, 0.15),
                      (-0.16, 0.62, 4.32, 0.14, 0.58, 0.14)])
PROPS["tree_dead"] = dict(instance=True, blocks=_dead)

# --- shrub: soil collar, stub, two four-tone masses plus a pair of rim sprigs
_bush = [(0, 0, 0.04, 0.88, 0.86, 0.045, "soil")]                # soil collar
_bush.append((0, 0.02, 0.30, 0.13, 0.13, 0.26, "bark_snag"))     # stub
_bush.extend(cluster(61, -0.14, 0.92, 0.88, 0.46,
                     ("bush_dark", "bush_mid", "bush_lit", "bush_rim"), droop=1.2))
_bush.extend(cluster(67, 0.64, 1.34, 0.58, 0.34,
                     ("bush_dark", "bush_mid", "bush_lit", "bush_rim"), droop=1.0))
PROPS["bush"] = dict(instance=True, blocks=_bush)

# --- fern: dense crown of arching fronds, taller tufts at the back, soil crown at the
# foot. FERN has no NEAR_LOD_TRIS entry in props.js, so this node is adopted whole.
_fern = [(0, 0, 0.05, 0.62, 0.60, 0.056, "soil")]
for _k, (_a, _len, _h, _tone) in enumerate([(0.0, 1.00, 0.92, "fern_lit"),
                                            (1.05, 0.92, 0.84, "fern_mid"),
                                            (2.10, 0.86, 0.78, "fern_rim"),
                                            (3.20, 1.18, 1.24, "fern_lit"),
                                            (4.30, 0.80, 0.66, "fern_dark")]):
    j1 = 1.0 + (hsh(_k, 5, 109) - 0.5) * 0.30
    j2 = 1.0 + (hsh(_k, 9, 113) - 0.5) * 0.30
    _cx, _cz = math.cos(_a) * _len * 0.42 * j1, math.sin(_a) * _len * 0.42 * j2
    _fern.append((_cx * 0.35, _cz * 0.35, _h * (0.42 + 0.021 * _k),
                  0.097 + 0.011 * _k, 0.104 - 0.009 * _k, _h * (0.42 + 0.017 * _k),
                  "fern_mid" if _k % 2 else "fern_dark"))                # stem
    _fern.append((_cx, _cz, _h * (0.865 + 0.019 * _k), 0.09 + 0.031 * _k,
                  0.30 + 0.047 * (_k % 3), _h * (0.20 + 0.023 * _k), _tone))
_fern.append((0.02, 0.12, 1.36, 0.21, 0.19, 0.17, "fern_rim"))        # taller tuft
PROPS["fern"] = dict(instance=True, blocks=_fern)

# hedgerow: 3 m of continuous block hedge, soil foot, four tones, no gaps. Every course
# is jittered in z as well as y so two differently coloured faces never share a plane.
_hedge = [(0, 0, 0.05, 1.50, 0.52, 0.055, "soil")]
for i in range(7):                      # face blocks along X = 3.0 m
    x = -1.5 + 0.215 + i * 0.43
    jit = (hsh(i, 3, 83) - 0.5) * 0.10
    zz = 0.42 + (hsh(i, 11, 87) - 0.5) * 0.05
    g = "bush_mid" if i % 2 == 0 else "leaf_mid"
    _hedge.append((x, jit, zz, 0.21, 0.50 - 0.02 * (i % 3), 0.38, g))
    _hedge.append((x - 0.045, jit + 0.03, 0.95 + (hsh(i, 13, 91) - 0.5) * 0.09,
                   0.195, 0.455 - 0.031 * (i % 2), 0.20, "leaf_dark"))
for i in range(6):                      # lit + warm rim ragged top course
    x = -1.25 + i * 0.50 + (hsh(i, 7, 89) - 0.5) * 0.10
    _hedge.append((x, (hsh(i, 5, 91) - 0.5) * 0.14,
                   1.26 + (hsh(i, 17, 93) - 0.5) * 0.08, 0.30, 0.44, 0.18,
                   "leaf_rim" if i % 3 == 0 else ("leaf_lit" if i % 2 else "bush_lit")))
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
     (0.0, 0.0, 1.31, 0.70, 0.62, 0.11, "gate_dark"),        # roof, 0.22 m thick
     (0.0, 0.55, 0.85, 0.40, 0.10, 0.26, "hivis_yel"),       # panel proud of the cabin
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
    # Top beam. The old truss was a 0.32 m deep upper chord at 7.30, a 0.20 m lower
    # chord at 6.70 and seven 0.18 m hangers on a 2.0 m pitch: three thin separated
    # plates that from the start line read as a stray stepped block row floating
    # above the banner. One deep solid beam with a tie beam under it and four thick
    # webs, all in one steel tone, so it reads as the gantry's own top beam. Overall
    # top stays 7.46 m and the span stays +/-7.10 m, matching the checkpoint gate.
    g.append((0, 0, 7.20, 7.10, 0.34, 0.26, "pole_steel"))              # top beam
    g.append((0, 0, 6.60, 7.10, 0.30, 0.14, "pole_steel"))              # tie beam
    for k in (-2, -1, 1, 2):                                           # webs
        g.append((k * 3.0, 0, 6.90, 0.60, 0.26, 0.42, "pole_steel"))
    for k in range(-2, 3):                                            # beam livery
        if k % 2:
            continue
        g.append((k * 2.80, 0.0, 7.20, 0.70, 0.40, 0.22, "gate_red"))
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
    # Banner board: ONE solid opaque core plate with the red bands running clean
    # THROUGH it, so every coloured face of the board sits on its own plane. The old
    # build was a pale 0.32 m canvas plate with 0.05 m red lettering slabs and 0.16 m
    # red end tabs stacked along the same Y axis with their faces 10 mm apart
    # (cloth 0.16 / lettering 0.17, cloth 0.48 / lettering 0.47) and every material
    # exported doubleSided, so the depth pass dithered pale canvas against gate_red
    # across the whole 9 m span - a white/red checkerboard, not a board. Nothing here
    # is coplanar or closer than 12 cm to a face of another colour, no sheet is under
    # 0.28 m thick, and there is no alpha anywhere.
    g.append((0, 0, 4.30, 4.30, 0.14, 0.70, "canvas"))                # solid core plate
    for k in range(6):                                                # red bands, through the core
        g.append((-3.44 + k * 1.376, 0, 4.30, 0.40, 0.34, 0.58, "gate_red"))
    for s in (-1, 1):                                                 # solid end tabs
        g.append((s * 4.60, 0, 4.30, 0.40, 0.44, 0.84, "gate_red"))
    return g


def _marshal_tent():
    """Readable marshal hut: 3.0 x 3.0 m footprint, eaves at 2.0 m, ridge at 2.5 m.

    The previous build was a 5.8 x 5.2 m marquee whose walls, back and front were
    single 0.10-0.12 m near-white canvas quads spanning the whole 5.8 m width, with
    three 0.60 m pale roof plates stacked over them. At rally distance the shell
    silhouette was a flat pale sheet with a stepped edge, i.e. broken geometry. Every
    panel here is a solid box at least 0.16 m thick, no two faces of a different
    colour are coplanar or closer than 0.12 m, and the roof is a coloured 3-step
    cap so the silhouette reads as a hut."""
    g = []
    for sx in (-1, 1):                                                  # ground pads
        for sy in (-1, 1):
            g.append((sx * 1.25, sy * 1.25, 0.05, 0.22, 0.22, 0.05, "stone_dark"))
    # Walls: 0.16 m thick, 1.5 m half-span, eaves at 2.0 m.
    g.append((0, 1.42, 1.00, 1.50, 0.08, 1.00, "tent_shade"))           # back wall
    for s in (-1, 1):
        g.append((s * 1.42, 0, 1.00, 0.08, 1.42, 1.00, "tent_shade"))   # side walls
        g.append((s * 1.00, -1.42, 1.00, 0.50, 0.08, 1.00, "tent_canvas"))  # front
    g.append((0, -1.05, 0.95, 0.50, 0.10, 0.95, "wood_board"))          # door leaf
    g.append((0, -1.42, 1.95, 0.78, 0.14, 0.12, "timber"))              # lintel
    # Roof: three filled steps, widest lowest, coloured, ridge at 2.50 m.
    for w, z, mat in ((1.70, 2.06, "tent_roof"),
                      (1.34, 2.24, "tent_roof"),
                      (0.92, 2.42, "tent_roof_2")):
        g.append((0, 0, z, w, w, 0.12, mat))
    g.append((0, 0, 2.50, 0.42, 1.50, 0.05, "tent_roof_2"))             # ridge cap
    g.append((0, -1.75, 0.42, 0.55, 0.22, 0.42, "wood_board"))         # front table
    for s in (-1, 1):                                                   # crates
        g.append((s * 1.15, 1.75, 0.26, 0.40, 0.22, 0.26, "timber"))
    g.append((-1.85, -1.85, 1.30, 0.06, 0.06, 1.30, "timber"))          # corner flag
    g.append((-1.50, -1.85, 2.42, 0.35, 0.03, 0.24, "gate_red"))
    return g


def _fence_panel():
    g = []
    for s in (-1, 1):
        g.append((s * 1.90, 0, 0.62, 0.09, 0.09, 0.62, "timber"))       # posts
        g.append((s * 1.90, 0, 0.06, 0.22, 0.22, 0.06, "stone_dark"))   # feet
    g.append((0, 0, 1.12, 1.95, 0.06, 0.08, "wood_board"))              # top rail
    g.append((0, 0, 0.72, 1.95, 0.06, 0.07, "wood_board"))              # mid rail
    g.append((0, 0, 0.22, 1.95, 0.06, 0.07, "wood_board"))              # kick rail
    # Battens: solid 0.14 x 0.12 m verticals, not 0.10 x 0.06 m paper strips.
    for k in range(7):
        g.append((-1.62 + k * 0.54, 0, 0.53, 0.07, 0.06, 0.42, "fence_mesh"))
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
        "bush": (1.5, 1.85, 1.6, 2.4), "fern": (1.05, 1.55, 1.3, 2.3),
        "hedgerow": (1.35, 1.70, 2.9, 3.3)}
HIERARCHY = ["tree_pine", "tree_birch", "tree_deciduous", "bush", "hedgerow"]
SOLID_CHECK = ["tree_pine", "tree_deciduous", "tree_birch", "bush", "hedgerow"]

# Near-band triangle budget, mirroring NEAR_LOD_TRIS in src/world/props.js:491. The
# streaming layer compares the ADOPTED node against that budget (streaming.js:235-244):
# a species over it is swapped for the cheap procedural near build, so an over-budget
# node is a node the driver never sees. Kept in the builder so a richer tree cannot
# silently opt itself out of the near band - and so the vegetation frame cost (near
# 90 k triangles) cannot grow just because the model got prettier.
VEG_BUDGET = {"tree_pine": 320, "tree_deciduous": 240, "tree_birch": 270,
              "bush": 150, "tree_dead": 90, "fern": 170, "hedgerow": 330}


def coplanar_conflicts(blocks):
    """Count pairs of DIFFERENT-material faces that land on the same plane and overlap.
    Two opposite colours sharing a plane is what made the old flat canopy plates and the
    banner board dither into one pale mass in the depth pass. Same-material contact is
    fine (a hedge is built out of touching blocks of one tone)."""
    faces = []
    for cx, cy, cz, hx, hy, hz, m in blocks:
        for ax, (u, v, uh, vh) in ((0, (cy, cz, hy, hz)), (1, (cx, cz, hx, hz)),
                                   (2, (cx, cy, hx, hy))):
            for s in (-1, 1):
                co = (cx, cy, cz)[ax] + s * (hx, hy, hz)[ax]
                faces.append((ax, round(co, 4), u - uh, u + uh, v - vh, v + vh, m))
    bad = []
    for i in range(len(faces)):
        ax, co, a0, a1, b0, b1, mi = faces[i]
        for j in range(i + 1, len(faces)):
            ax2, co2, c0, c1, d0, d1, mj = faces[j]
            if ax != ax2 or mi == mj or abs(co - co2) > 1e-4:
                continue
            if min(a1, c1) - max(a0, c0) > 1e-3 and min(b1, d1) - max(b0, d0) > 1e-3:
                bad.append("%s/%s @%c%.2f" % (mi, mj, "xyz"[ax], co))
    return bad


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
    # Single-sided is part of the export contract, not a shading preference. The glTF
    # exporter writes doubleSided = not use_backface_culling, and left at the Blender
    # default (culling off) EVERY material in this file exported doubleSided. A prop is
    # a stack of closed boxes, so the far wall of each face drew on the same depth as
    # the face in front of it - that is what dithered the 9 m banner board into a
    # white/red checker. The engine had to paper over it (side = FrontSide in
    # src/world/streaming.js); with culling on here, that override is dead code and the
    # checkerboard cannot come back. The verify() gate below fails the export if any
    # material still lands doubleSided.
    mat.use_backface_culling = True
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


def double_sided_materials(doc):
    """Materials the export marks doubleSided (queue P6). A solid prop must never land
    doubleSided: the engine must be able to draw the adopted node as it comes."""
    return [m.get("name", "?") for m in doc.get("materials", []) if m.get("doubleSided")]


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
    return blob, rows, found, missing, doc


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
    flats = {}
    veg_objs = set()
    for key in PROPS:
        blocks = PROPS[key]["blocks"]
        if key in SOLID_CHECK:
            solids[key] = find_gaps(blocks)
        if key in VEG_BUDGET:
            flats[key] = coplanar_conflicts(blocks)
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
        if key in SPEC:
            veg_objs.add(obj.name)
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

    # Optional vegetation-only export for the preview renders: the full props.glb stacks
    # every node on the origin, so a camera on the whole file frames the gate, not a tree.
    if "--preview-veg" in args:
        pv = os.path.abspath(args[args.index("--preview-veg") + 1])
        ROW = {"tree_pine": 0.0, "tree_deciduous": 7.0, "tree_birch": 14.0,
               "tree_dead": 20.0, "bush": 24.0, "fern": 27.0, "hedgerow": 31.0}
        for ob in bpy.context.scene.objects:
            ob.select_set(ob.name in veg_objs)
            key = ob.name[len("prop_"):]
            if key in ROW:
                ob.location.x = ROW[key]
        bpy.ops.export_scene.gltf(filepath=pv, export_format="GLB", use_selection=True,
                                  export_apply=True, export_materials="EXPORT",
                                  export_cameras=False, export_lights=False,
                                  export_yup=True)
        print("preview glb      : %s" % pv)

    blob, rows, found, missing, doc = verify(out)
    size = len(blob)
    glb_tris = sum(r["triangles"] for r in rows)

    print("\n--- self-check: %s ---" % out)
    for r in rows:
        key = r["name"][len("prop_"):]
        solid = ("see-through %d" % solids[key]) if key in solids else "-"
        flat = (" coplanar %d" % len(flats[key])) if key in flats else ""
        print("node %-22s w=%6.2f m  h=%6.2f m  d=%6.2f m  tris=%5d  %s%s"
              % (r["name"], r["width_m"], r["height_m"], r["depth_m"], r["triangles"],
                 solid, flat))
    print("nodes found      : %d / %d" % (len(found), len(EXPECTED)))
    dbl = double_sided_materials(doc)
    print("doubleSided mats : %d / %d" % (len(dbl), len(doc.get("materials", []))))
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
    if dbl:
        print("FAIL %d materials export doubleSided (backface culling off in "
              "make_material): %s" % (len(dbl), ", ".join(dbl[:8])))
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
    for key, g in flats.items():
        if g:
            print("FAIL %s has %d coplanar opposite-colour face pairs (the depth pass "
                  "dithers those into one flat mass): %s"
                  % (key, len(g), ", ".join(g[:6])))
            ok = False
    veg_tris = 0
    for key, budget in VEG_BUDGET.items():
        r = by_name.get(key)
        if not r:
            continue
        veg_tris += r["triangles"]
        if r["triangles"] > budget:
            print("FAIL %s tris %d > near-band budget %d (props.js NEAR_LOD_TRIS): "
                  "streaming would swap the node for the procedural near build"
                  % (key, r["triangles"], budget))
            ok = False
    print("vegetation triangles (near band at worst): %d" % veg_tris)
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
