#!/usr/bin/env python3
"""Voxel stage-surface blocks -> assets/models/stage_blocks.glb

Headless:
    blender --background --python tools/blender/build_stage_blocks.py -- \
        --out assets/models/stage_blocks.glb

One mesh node per surface key from src/world/surfaces.js, named block_<key>.
Each block is 1.00 x 1.00 m; the TOP face carries real relief built from explicit
vertex/face tables (no booleans, no mesh operators). Materials are Principled BSDF
parameter values only - no noise/ramp/procedural nodes, since those are dropped by
the glTF exporter. All the material character lives in the vertex colours.

Art rules baked in here (in-game review 2026-10-10, shots/review-assets-in-game.png):
  * asphalt  near-black, fine aggregate, sparse bright chippings, faint sheen
  * gravel   loose chippings with real height variation, dark fines between them
  * dirt     two wheel ruts + a crowned centre, ruts darker, crown drier/lighter
  * grass    short tufts in two greens with a darker soil edge
  * every tile must butt seamlessly into its neighbour: all height and colour
    features are PERIODIC over the 1 m tile (wrapped cell hashes + integer
    frequencies), so z(0,j) == z(n,j) and colour(0,j) == colour(n,j). A non-periodic
    edit makes the tiles read as a shuffled deck of plates and is rejected here.
  * the slab skirt reaches SKIRT below the origin plane, and is coloured as the
    material body, so a tile on uneven ground never shows a floating bright edge.

Colours are the sRGB palette anchors of src/world/palette.js / surfaces.js converted
to scene-linear: the engine reads COLOR_0 as linear, so writing raw sRGB hex values
renders everything washed-out and pale (that is what made the last pass look cheap).
"""

import json
import math
import os
import struct
import sys

WIDTH = 1.00
DEPTH = 1.00
TOP_PLANE = 0.18           # nominal top of the slab
FLOOR = 0.020              # never carve through the slab
SKIRT = 0.45               # how far the tile wall sinks below its own origin

# key -> palette.js / surfaces.js anchors, art-directed for driving distance.
# tone = (light, dark) sRGB anchors; col = base material anchor (surfaces.js id).
SURFACES = {
    # surfaces.js:31  asphalt - near-black, faint sheen
    "asphalt": dict(n=22, color=0x232322, tone=(0x3C3B38, 0x121213), rough=0.42,
                    metal=0.06, coat=0.25,
                    note="near-black, fine aggregate, sparse chippings, sheen"),
    # surfaces.js:40  gravel - loose chippings
    "gravel":  dict(n=40, color=0x8B7C62, tone=(0x7E6F53, 0x38311F), rough=0.90,
                    metal=0.0, coat=0.0, note="loose chippings, real height variation"),
    # surfaces.js:109 dirt - two ruts + crown
    "dirt":    dict(n=24, color=0x6B4F32, tone=(0x6B5236, 0x2C1F12), rough=0.94,
                    metal=0.0, coat=0.0, note="two wheel ruts along X, crowned centre"),
    # surfaces.js:49  mud - sunk, wet, smeared
    "mud":     dict(n=22, color=0x4F3A28, tone=(0x5C4530, 0x2A1D13), rough=0.62,
                    metal=0.0, coat=0.45, note="darker, smoother, wet, shallow ripples"),
    # surfaces.js:67  grass - short tufts, soil edge
    "grass":   dict(n=32, color=0x53713A, tone=(0x5F8632, 0x1E2F14), rough=0.88,
                    metal=0.0, coat=0.0, note="short tufts, darker soil edge"),
    # surfaces.js:84  stone - cracked slabs
    "stone":   dict(n=22, color=0x6B6B66, tone=(0x82817A, 0x44443F), rough=0.60,
                    metal=0.02, coat=0.0, note="slab with cracked seams"),
    # surfaces.js:75  sand - fine ripples
    "sand":    dict(n=34, color=0xC9B184, tone=(0xDCC698, 0x8E7A55), rough=0.95,
                    metal=0.0, coat=0.0, note="fine ripples"),
    # surfaces.js:92  peat - dark fibrous lumps
    "peat":    dict(n=27, color=0x3B2F22, tone=(0x4E3E28, 0x1E1810), rough=0.98,
                    metal=0.0, coat=0.10, note="dark fibrous lumps"),
    # surfaces.js:58  snow - wind ridges
    "snow":    dict(n=22, color=0xE7EDF1, tone=(0xF2F6F9, 0x9FB0C4), rough=0.70,
                    metal=0.0, coat=0.05, note="wind ridges"),
    # surfaces.js:101 ice - melt grooves, glossy
    "ice":     dict(n=18, color=0xA8C6D4, tone=(0xC6DCE8, 0x6E8FA3), rough=0.22,
                    metal=0.05, coat=0.40, note="near flat with faint melt grooves"),
}
REQUIRED = ["asphalt", "gravel", "dirt", "mud", "grass", "stone", "sand", "peat"]
MIN_BYTES = 40000


# ---------------------------------------------------------------- utilities
def hsh(i, j, salt):
    """Deterministic integer hash -> 0..1 (geometry only, not a texture node)."""
    n = (i * 374761393 + j * 668265263 + salt * 1274126177) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    n = (n ^ (n >> 16)) & 0xFFFFFFFF
    return n / 4294967295.0


def wh(i, j, salt, period):
    """Wrapped cell hash: identical at i and i+period -> seamless tile edges."""
    p = max(1, period)
    return hsh(i % p, j % p, salt)


def gauss(x, mu, sigma):
    return math.exp(-((x - mu) * (x - mu)) / (2.0 * sigma * sigma))


def pbump(v, c, s):
    """Gaussian bump on a circle: v wraps at 0/1, so it matches the next tile."""
    d = abs(v - c)
    d = min(d, 1.0 - d)
    return math.exp(-(d * d) / (2.0 * s * s))


def s2l(c):
    """sRGB byte -> scene-linear channel (glTF COLOR_0 and Base Color are linear)."""
    v = c / 255.0
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def rgb(c):
    return (s2l((c >> 16) & 255), s2l((c >> 8) & 255), s2l(c & 255))


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


# ------------------------------------------------- top-face height functions
# Every feature is periodic over the tile: wrapped cell hashes and integer
# frequencies of u/v = i/n, j/n.
def z_asphalt(i, j, n):
    u, v = i / n, j / n
    z = 0.1700
    z += 0.0026 * wh(i, j, 11, n)                        # fine aggregate grains
    z += 0.0012 * math.sin(2 * math.pi * (2 * u)) * math.sin(2 * math.pi * (3 * v))
    z -= 0.0022 * (pbump(v, 0.34, 0.055) + pbump(v, 0.66, 0.055))   # polished wheel lines
    if wh(i, j, 19, n) > 0.93:                           # occasional chipping
        z += 0.0028
    return z


def z_gravel(i, j, n):
    per = max(1, n // 4)                                 # one chip per 4 cells
    ci, cj = (i // 4) % per, (j // 4) % per
    chip = wh(ci, cj, 23, per)
    r = math.hypot((i % 4) - 1.5, (j % 4) - 1.5) / 2.1213
    dome = max(0.0, 1.0 - r * r) ** 1.3                  # chippings of varied height
    z = 0.1120 + 0.0620 * chip * dome                    # up to 6 cm of loose chipping
    z += 0.0060 * wh(i, j, 29, n)                        # grit between the chippings
    z += 0.0030 * math.sin(2 * math.pi * (2 * i / n)) * math.cos(2 * math.pi * (3 * j / n))
    return z


def z_dirt(i, j, n):
    u, v = i / n, j / n
    rut = pbump(v, 0.29, 0.088) + pbump(v, 0.71, 0.088)
    rut *= 0.82 + 0.18 * (0.5 + 0.5 * math.sin(2 * math.pi * u))       # meander, one wave
    crown = 0.55 * pbump(v, 0.50, 0.115) + pbump(v, 0.0, 0.060)
    z = 0.1620 - 0.0300 * rut + 0.0140 * crown
    z += 0.0030 * math.sin(2 * math.pi * (2 * u + v))
    z += 0.0040 * wh(i, j, 37, n)
    return z


def z_mud(i, j, n):
    u, v = i / n, j / n
    z = 0.1500                                          # sunk, wet, smoother
    z += 0.0060 * math.sin(2 * math.pi * (6 * u) + 1.6 * math.sin(2 * math.pi * (3 * v)))
    z += 0.0032 * math.sin(2 * math.pi * (4 * v))
    z -= 0.0120 * (pbump(v, 0.32, 0.110) + pbump(v, 0.68, 0.110))      # soft wheel smear
    z += 0.0024 * wh(i, j, 43, n)
    return z


def z_grass(i, j, n):
    per, per8 = max(1, n // 4), max(1, n // 8)          # tuft cells + coarser patch field
    ci, cj = (i // 4) % per, (j // 4) % per
    bi, bj = (i // 8) % per8, (j // 8) % per8
    patch = wh(bi, bj, 67, per8)                        # some patches are worn/bare
    t = wh(ci, cj, 53, per) * (0.30 + 0.70 * patch)
    d = math.hypot((i % 4) - 1.5, (j % 4) - 1.5) / 2.1213
    dome = max(0.0, 1.0 - d * d) ** 1.6                 # a tuft is a dome, not a flat patch
    tuft = 0.0
    if t > 0.24:
        tuft = ((t - 0.24) / 0.76) ** 1.1 * 0.0430 * dome
    z = 0.1275 + tuft + 0.0022 * wh(i, j, 59, n) + 0.0045 * patch
    return z


def z_stone(i, j, n):
    q = max(1, n // 11) if n % 11 == 0 else max(1, n // 8)
    per = max(1, n // q)
    si, sj = (i // q) % per, (j // q) % per
    ox = (wh(si, sj, 61, per) - 0.5) * 0.55             # jagged seam offsets
    oy = (wh(si, sj, 67, per) - 0.5) * 0.55
    dx = abs((i / float(q)) - ((i // q) + 0.5 + ox))    # seams run across the tile
    dy = abs((j / float(q)) - ((j // q) + 0.5 + oy))
    seam = max(1.0 - min(1.0, dx / 0.16), 1.0 - min(1.0, dy / 0.16))
    z = 0.1748 + 0.0060 * (wh(si, sj, 71, per) - 0.5)   # tilted panels
    z -= 0.0110 * seam                                  # cracked seams
    z += 0.0018 * wh(i, j, 73, n)
    return z


def z_sand(i, j, n):
    u, v = i / n, j / n
    z = 0.1655
    z += 0.0046 * math.sin(2 * math.pi * (14 * v) + 2.1 * math.sin(2 * math.pi * (2 * u)))
    z += 0.0016 * math.sin(2 * math.pi * (3 * u + 2 * v))
    z += 0.0012 * wh(i, j, 79, n)
    return z


def z_peat(i, j, n):
    per = max(1, n // 3)
    ci, cj = (i // 3) % per, (j // 3) % per
    l = wh(ci, cj, 83, per)
    d = math.hypot((i % 3) - 1.0, (j % 3) - 1.0) / 1.9
    dome = max(0.0, 1.0 - d * d)
    z = 0.1330 + 0.0360 * l * dome - 0.0110 * (1.0 - l)
    z += 0.0026 * wh(i, j, 89, n)
    return z


def z_snow(i, j, n):
    u, v = i / n, j / n
    z = 0.1685 + 0.0120 * math.sin(2 * math.pi * (4 * u) + 3.0 * math.sin(2 * math.pi * (2 * v)))
    z += 0.0050 * wh(i, j, 97, n) * math.sin(2 * math.pi * (6 * v))
    return z


def z_ice(i, j, n):
    u, v = i / n, j / n
    z = 0.1770 + 0.0026 * math.sin(2 * math.pi * (4 * u + 2 * v))
    z += 0.0014 * wh(i, j, 101, n)
    return z


# ------------------------------------------------------ colour tint functions
# t = 0 -> dark anchor, t = 1 -> light anchor. Same periodicity rule as height.
def t_asphalt(i, j, n):
    t = 0.10 + 0.16 * wh(i, j, 13, n) + 0.10 * wh(i, j, 7, n)
    if wh(i, j, 19, n) > 0.93:
        t += 0.42                                       # bright chipping in the mat
    u, v = i / n, j / n
    t -= 0.12 * (pbump(v, 0.34, 0.055) + pbump(v, 0.66, 0.055))   # polished = darker
    return clamp(t, 0.0, 1.0)


def t_gravel(i, j, n):
    per = max(1, n // 4)
    ci, cj = (i // 4) % per, (j // 4) % per
    chip = wh(ci, cj, 23, per)
    d = math.hypot((i % 4) - 1.5, (j % 4) - 1.5) / 2.1213
    dome = max(0.0, 1.0 - d * d)
    t = 0.16 + 0.50 * chip                              # each chip its own tone
    t += 0.20 * dome * chip                             # lit crown of the chip
    t -= 0.24 * (1.0 - dome)                            # shaded fines between chips
    return clamp(t, 0.0, 1.0)


def t_dirt(i, j, n):
    u, v = i / n, j / n
    rut = pbump(v, 0.30, 0.075) + pbump(v, 0.70, 0.075)
    t = 0.46 + 0.16 * wh(i, j, 41, n)
    t -= 0.40 * rut                                     # ruts: damp, dark, compacted
    t += 0.22 * pbump(v, 0.50, 0.115)                   # crown: dry, pale dust
    return clamp(t, 0.0, 1.0)


def t_mud(i, j, n):
    u, v = i / n, j / n
    t = 0.34 + 0.18 * wh(i, j, 47, n)
    t += 0.20 * math.sin(2 * math.pi * (6 * u) + 1.6 * math.sin(2 * math.pi * (3 * v)))
    t -= 0.24 * (pbump(v, 0.32, 0.110) + pbump(v, 0.68, 0.110))
    return clamp(t, 0.0, 1.0)


def t_grass(i, j, n):
    per, per8 = max(1, n // 4), max(1, n // 8)
    ci, cj = (i // 4) % per, (j // 4) % per
    bi, bj = (i // 8) % per8, (j // 8) % per8
    patch = wh(bi, bj, 67, per8)                        # worn / bare patches
    t = wh(ci, cj, 53, per)
    d = math.hypot((i % 4) - 1.5, (j % 4) - 1.5) / 2.1213
    dome = max(0.0, 1.0 - d * d)
    v = 0.12 + 0.50 * t                                 # each tuft its own green
    v += 0.34 * dome * t                                # lit tips
    v -= 0.30 * (1.0 - dome)                            # shaded soil at the base
    if patch < 0.32:
        v *= 0.40                                       # soil showing through the sward
    return clamp(v, 0.0, 1.0)


def t_stone(i, j, n):
    q = max(1, n // 11) if n % 11 == 0 else max(1, n // 8)
    per = max(1, n // q)
    si, sj = (i // q) % per, (j // q) % per
    t = 0.30 + 0.45 * wh(si, sj, 71, per) + 0.12 * wh(i, j, 73, n)
    ox = (wh(si, sj, 61, per) - 0.5) * 0.55
    oy = (wh(si, sj, 67, per) - 0.5) * 0.55
    dx = abs((i / float(q)) - ((i // q) + 0.5 + ox))
    dy = abs((j / float(q)) - ((j // q) + 0.5 + oy))
    seam = max(1.0 - min(1.0, dx / 0.16), 1.0 - min(1.0, dy / 0.16))
    return clamp(t - 0.45 * seam, 0.0, 1.0)


def t_sand(i, j, n):
    u, v = i / n, j / n
    t = 0.42 + 0.24 * wh(i, j, 81, n)
    t += 0.24 * math.sin(2 * math.pi * (14 * v) + 2.1 * math.sin(2 * math.pi * (2 * u)))
    return clamp(t, 0.0, 1.0)


def t_peat(i, j, n):
    per = max(1, n // 3)
    ci, cj = (i // 3) % per, (j // 3) % per
    l = wh(ci, cj, 83, per)
    return clamp(0.12 + 0.66 * l, 0.0, 1.0)


def t_snow(i, j, n):
    u, v = i / n, j / n
    t = 0.55 + 0.30 * wh(i, j, 99, n)
    t += 0.30 * math.sin(2 * math.pi * (4 * u) + 3.0 * math.sin(2 * math.pi * (2 * v)))
    return clamp(t, 0.0, 1.0)


def t_ice(i, j, n):
    u, v = i / n, j / n
    t = 0.45 + 0.30 * wh(i, j, 103, n)
    t += 0.20 * math.sin(2 * math.pi * (4 * u + 2 * v))
    return clamp(t, 0.0, 1.0)


HEIGHTS = {"asphalt": z_asphalt, "gravel": z_gravel, "dirt": z_dirt, "mud": z_mud,
           "grass": z_grass, "stone": z_stone, "sand": z_sand, "peat": z_peat,
           "snow": z_snow, "ice": z_ice}
TINTS = {"asphalt": t_asphalt, "gravel": t_gravel, "dirt": t_dirt, "mud": t_mud,
         "grass": t_grass, "stone": t_stone, "sand": t_sand, "peat": t_peat,
         "snow": t_snow, "ice": t_ice}
# grass carries visible soil, so its edge is browned rather than just darker
SOIL_EDGE = {"grass": (0x241C12, 0.55)}


def check_periodic(key):
    """Every height/colour feature must repeat over 1.00 m or the tiles will not butt."""
    n = SURFACES[key]["n"]
    fn, tn = HEIGHTS[key], TINTS[key]
    bad = 0
    for k in range(n + 1):
        if abs(fn(0, k, n) - fn(n, k, n)) > 1e-5 or abs(fn(k, 0, n) - fn(k, n, n)) > 1e-5:
            bad += 1
        if abs(tn(0, k, n) - tn(n, k, n)) > 1e-4 or abs(tn(k, 0, n) - tn(k, n, n)) > 1e-4:
            bad += 1
    return bad


# ------------------------------------------------------------ mesh builders
def build_block(key, spec):
    """Explicit vertex + face tables for one 1.00 x 1.00 tile with a sunk skirt."""
    n = spec["n"]
    fn, tn = HEIGHTS[key], TINTS[key]
    verts, cols = [], []
    light, dark = rgb(spec["tone"][0]), rgb(spec["tone"][1])
    soil = None
    if key in SOIL_EDGE:
        soil_hex, soil_w = SOIL_EDGE[key]
        soil = rgb(soil_hex)

    # relief range, for height-driven shading (ruts dark, chipping crowns light)
    zall = [fn(i, j, n) for j in range(n + 1) for i in range(n + 1)]
    zlo, zhi = min(zall), max(zall)
    zspan = max(1e-4, zhi - zlo)
    zmid = sum(zall) / len(zall)

    def rim(i, j):
        e = min(i, n - i, j, n - j)                     # 0 on the shared tile edge
        return 1.0 if e >= 2 else (0.92 if e == 1 else 0.80)

    def tint(i, j):
        t = tn(i, j, n)
        z = fn(i, j, n)
        t = clamp(t + 0.42 * ((z - zlo) / zspan - 0.5), 0.0, 1.0)
        edge = (i == 0 or i == n or j == 0 or j == n)
        if edge:                                    # contact shade: hides the seam
            t *= 0.80
        c = [dark[k] * (1.0 - t) + light[k] * t for k in range(3)]
        if edge and soil:                           # darker soil collar on grass
            c = [c[k] * (1.0 - soil_w) + soil[k] * soil_w for k in range(3)]
        return c

    top_idx = {}
    for j in range(n + 1):
        for i in range(n + 1):
            raw = fn(i, j, n)
            z = clamp(zmid + (raw - zmid) * rim(i, j), FLOOR + 0.010, TOP_PLANE)
            verts.append((WIDTH * i / n, DEPTH * j / n, z))
            top_idx[(i, j)] = len(verts) - 1
            cols.extend(tint(i, j) + [1.0])

    faces = []
    for j in range(n):                    # top surface quads
        for i in range(n):
            faces.append((top_idx[(i, j)], top_idx[(i + 1, j)],
                          top_idx[(i + 1, j + 1)], top_idx[(i, j + 1)]))

    body = [dark[k] * 0.55 for k in range(3)]      # the material body, not white
    bot = {}
    for j in range(n + 1):
        for i in range(n + 1):
            if i not in (0, n) and j not in (0, n):
                continue                            # only the rim needs bottom verts
            k = len(verts)
            verts.append((WIDTH * i / n, DEPTH * j / n, -SKIRT))
            cols.extend(body + [1.0])
            bot[(i, j)] = k

    for i in range(n):                    # skirt walls (one quad per border cell)
        faces.append((top_idx[(i, 0)], bot[(i, 0)], bot[(i + 1, 0)], top_idx[(i + 1, 0)]))
        faces.append((top_idx[(i, n)], top_idx[(i + 1, n)], bot[(i + 1, n)], bot[(i, n)]))
    for j in range(n):
        faces.append((top_idx[(0, j)], top_idx[(0, j + 1)], bot[(0, j + 1)], bot[(0, j)]))
        faces.append((top_idx[(n, j)], bot[(n, j)], bot[(n, j + 1)], top_idx[(n, j + 1)]))
    faces.append((bot[(0, 0)], bot[(0, n)], bot[(n, n)], bot[(n, 0)]))   # underside plug

    return verts, faces, cols


def make_material(name, spec):
    from bpy import data as D
    mat = D.materials.new(name)
    if mat.node_tree is None:
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

    # vertex colours carry the whole material; a plain Attribute node feeds them to
    # Base Color so the exporter writes COLOR_0 (no procedural nodes). The base
    # factor stays near white so the export does not multiply the tones twice.
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_type = "GEOMETRY"
    try:
        attr.attribute_name = "Col"
    except Exception:
        pass
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Base Color"].default_value = (0.92, 0.92, 0.92, 1.0)
    set_in("Roughness", spec["rough"])
    set_in("Metallic", spec["metal"])
    if spec.get("coat"):
        set_in("Coat Weight", spec["coat"])
    return mat


# ------------------------------------------------------------- glb verifier
def read_glb(path):
    with open(path, "rb") as fh:
        blob = fh.read()
    magic, _ver, total = struct.unpack("<III", blob[:12])
    if magic != 0x46546C67:
        raise ValueError("not a GLB")
    off, doc, bin_off = 12, None, None
    while off + 8 <= total:
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
    comp_bytes = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}[acc["componentType"]]
    if acc["type"] != "VEC3":
        raise ValueError("expected a VEC3 POSITION accessor")
    view = doc["bufferViews"][acc["bufferView"]]
    base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    size = comp_bytes * acc["count"] * 3
    data = blob[bin_off + base:bin_off + base + size]
    vals = struct.unpack("<%s" % ("f" * acc["count"] * 3), data)
    xs = [vals[k] for k in range(0, len(vals), 3)]
    ys = [vals[k] for k in range(1, len(vals), 3)]
    zs = [vals[k] for k in range(2, len(vals), 3)]
    return xs, ys, zs


def verify(path):
    blob, doc, bin_off = read_glb(path)
    meshes = doc.get("meshes", [])
    accessors = doc.get("accessors", [])
    rows, missing = [], []
    found = set()
    for node in doc.get("nodes", []):
        name = node.get("name", "")
        if not name.startswith("block_"):
            continue
        key = name[len("block_"):]
        found.add(key)
        mi = node.get("mesh")
        prim = meshes[mi]["primitives"][0]
        xs, ys, zs = accessor_bbox(doc, blob, bin_off, prim["attributes"]["POSITION"])
        spans = (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))
        extents = sorted(((spans[0], "x"), (spans[1], "y"), (spans[2], "z")))
        up = extents[0][1]                                # thinnest axis = thickness
        horiz = [e for e in extents[1:]]
        up_vals = {"x": xs, "y": ys, "z": zs}[up]
        # top face = vertices above the slab origin; the skirt is far below it
        top = [v for v in up_vals if v > 0.05]
        tris = accessors[prim["indices"]]["count"] // 3
        if "COLOR_0" not in prim["attributes"]:
            missing.append(key + " (no COLOR_0)")
        rows.append(dict(key=key, name=name,
                         w=max(horiz[0][0], horiz[1][0]), d=min(horiz[0][0], horiz[1][0]),
                         zmin=min(top), zmax=max(top), tris=tris))
    for key in REQUIRED:
        if key not in found:
            missing.append(key)
    return blob, rows, found, missing


# -------------------------------------------------------------------- main
def main():
    args = sys.argv
    if "--" in args:
        args = args[args.index("--") + 1:]
    else:
        args = args[1:]
    out = "assets/models/stage_blocks.glb"
    for k, a in enumerate(args):
        if a == "--out" and k + 1 < len(args):
            out = args[k + 1]
    out = os.path.abspath(out)

    import bpy
    D = bpy.data
    for ob in list(D.objects):
        D.objects.remove(ob, do_unlink=True)

    total_tris = 0
    seams = 0
    for key in SURFACES:
        spec = dict(SURFACES[key])
        spec["key"] = key
        seams += check_periodic(key)
        verts, faces, cols = build_block(key, spec)
        tris = sum(len(f) - 2 for f in faces)
        mesh = D.meshes.new("block_" + key)
        mesh.from_pydata(verts, [], faces)
        mesh.validate(verbose=False)
        mesh.update()
        attr = mesh.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        attr.data.foreach_set("color", cols)
        mat = make_material("mat_" + key, spec)
        mesh.materials.append(mat)
        obj = D.objects.new("block_" + key, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.select_set(True)
        total_tris += tris
        print("built  block_%-8s verts=%d faces=%d tris=%d" % (key, len(verts), len(faces), tris))

    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True,
                              export_apply=True, export_materials="EXPORT",
                              export_cameras=False, export_lights=False,
                              export_yup=True)

    blob, rows, found, missing = verify(out)
    size = len(blob)
    print("\n--- self-check: %s ---" % out)
    glb_tris = 0
    for row in sorted(rows, key=lambda r: r["key"]):
        glb_tris += row["tris"]
        print("node %-15s w=%.3f d=%.3f top_z=[%.4f, %.4f] relief=%.4f tris=%d"
              % (row["name"], row["w"], row["d"], row["zmin"], row["zmax"],
                 row["zmax"] - row["zmin"], row["tris"]))
    print("nodes found      : %d (%s)" % (len(found), " ".join(sorted(found))))
    print("edge continuity  : %d non-periodic edge samples (must be 0)" % seams)
    print("total triangles  : %d (glb) / %d (built)" % (glb_tris, total_tris))
    print("file size bytes  : %d" % size)

    ok = True
    if missing:
        print("FAIL missing nodes: %s" % ", ".join("block_" + k for k in missing))
        ok = False
    if seams:
        print("FAIL tiles do not butt: %d edge samples differ across the 1 m seam" % seams)
        ok = False
    if size < MIN_BYTES:
        print("FAIL file size %d < %d" % (size, MIN_BYTES))
        ok = False
    for key in REQUIRED:
        r = next((x for x in rows if x["key"] == key), None)
        if r is None:
            continue
        if abs(r["w"] - 1.0) > 0.002 or abs(r["d"] - 1.0) > 0.002:
            print("FAIL %s footprint %.3f x %.3f" % (key, r["w"], r["d"]))
            ok = False
        if r["zmax"] - r["zmin"] < 0.001:
            print("FAIL %s top face has no relief" % key)
            ok = False
    if not ok:
        sys.exit(1)
    print("OK all %d expected nodes present, relief present, tiles butt, size >= %d"
          % (len(REQUIRED), MIN_BYTES))
    sys.exit(0)


main()
