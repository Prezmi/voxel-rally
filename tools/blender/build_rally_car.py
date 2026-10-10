# Voxel rally car, designed as parts then assembled (PLAN.md §10).
#
# Each part is its own mesh named car_<part> with a `rally_panel` property, so the game can
# map blocks to dirt panels and damage ranges. Blocks are 0.10 m. Self-checks the envelope
# and refuses to export a degenerate model.
#
#   blender --background --python tools/blender/build_rally_car.py -- \
#       --out assets/models/rally_a.glb --wb 2.62 --track 1.52 --r 0.335
import math
import os
import sys

import bpy


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    vals = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--") and i + 1 < len(argv):
            vals[a[2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    return vals


A = parse_args()
WB = float(A.get("wb", 2.62))
TRACK = float(A.get("track", 1.52))
R = float(A.get("r", 0.335))
TW = float(A.get("tw", 0.34))
OUT = str(A.get("out", "assets/models/rally.glb"))
B = float(A.get("block", 0.10))
MIN_FILE = int(A.get("min_kb", 60)) * 1024

HALF = WB / 2.0
COLS = 44
ZTOP = 1.40
X0 = -0.5 * COLS * B
HW = (TRACK + 0.16) / 2.0              # body half width
WHEEL_OUT = 0.06                       # all four wheels pushed outboard
ARCH_REAR = (5, 12)                    # arches widened: 8 columns each
ARCH_FRONT = (31, 38)
TREAD_W = 3 * B                        # three-block wide tread ring
SIDE_W = (TW - TREAD_W) / 2.0          # lighter sidewall band each side

COLL = bpy.context.collection


def cx(c):
    return X0 + (c + 0.5) * B


def cz(row):
    return ZTOP - (row + 0.5) * B


# ---------------------------------------------------------------- parts
PARTS = {}   # part name -> list of (material, x, y0, z, sx, sy, sz)
PART_ORIGIN = {}   # part name -> (x, y, z) node origin, so a part can be rotated about its own pivot


def put(part, material, x, z, y0=None, sx=B, sy=None, sz=B):
    PARTS.setdefault(part, []).append(
        (material, x, 0.0 if y0 is None else y0, z, sx, sy if sy is not None else HW * 2.0, sz))


def row(part, material, c0, c1, r, sy=None, skip_cols=()):
    for c in range(c0, c1 + 1):
        if c in skip_cols:
            continue
        put(part, material, cx(c), cz(r), sy=sy)


def box(part, material, c0, c1, r0, r1, sy=None, skip_cols=()):
    for r in range(r0, r1 + 1):
        row(part, material, c0, c1, r, sy=sy, skip_cols=skip_cols)


# ---------------------------------------------------------------- chassis
def part_chassis():
    box("chassis", "trim", 8, 34, 12, 12)                      # floor
    box("chassis", "carbon", 6, 37, 11, 11, sy=HW * 2.0 + 0.02)  # undertray / skirts
    row("chassis", "carbon", 40, 43, 11)                        # front splitter
    for sgn in (1, -1):                                        # mudguards
        for c in (4, 5, 29, 30):
            put("chassis", "trim", cx(c), 0.24, y0=sgn * (HW + 0.05), sy=B * 0.8)


# ---------------------------------------------------------------- cabin (thin glazing line)
def part_cabin():
    # reference sheet: the greenhouse is the dominant mass and the glass is THREE blocks
    # tall (sill z 0.95, roof z 1.40), with painted pillars between the windows
    row("cabin", "paint", 12, 29, 0)          # roof panel
    row("cabin", "glass", 14, 27, 1)          # side glazing, top
    row("cabin", "glass", 14, 27, 2)          # side glazing, middle
    row("cabin", "glass", 14, 27, 3)          # side glazing, bottom
    # B pillar splits the side windows so they read as two doors
    row("cabin", "paint", 20, 21, 1)
    row("cabin", "paint", 20, 21, 2)
    row("cabin", "paint", 20, 21, 3)
    # A and C pillars, two blocks wide
    for (c0, c1) in ((12, 13), (28, 29)):
        for r in (1, 2, 3):
            row("cabin", "paint", c0, c1, r)
    # raked windscreen and rear screen follow the pillars down
    for c in (30, 31):
        for r in (2, 3):
            put("cabin", "glass", cx(c), cz(r))
    for c in (10, 11):
        for r in (2, 3):
            put("cabin", "glass", cx(c), cz(r))
    # roof lamp bar (night stage) with four lamps, proud of the roof panel
    for c in range(15, 28):
        put("cabin", "carbon", cx(c), ZTOP + 0.035, sy=0.60, sz=0.03)
    for c in (16, 19, 22, 25):
        put("cabin", "lamp", cx(c), ZTOP + 0.090, sy=0.24, sz=0.09)


# ---------------------------------------------------------------- bonnet, boot, flanks
def part_bodywork():
    box("hood", "paint", 26, 38, 4, 6)        # bonnet + cowl, shortened by two columns
    box("boot", "paint", 4, 12, 4, 6)         # boot lid
    skip = set(range(ARCH_REAR[0], ARCH_REAR[1] + 1)) | set(range(ARCH_FRONT[0], ARCH_FRONT[1] + 1))
    box("flank", "paint", 3, 40, 7, 10, skip_cols=skip)
    box("flank", "trim", 3, 40, 11, 11, skip_cols=skip)
    box("flank", "paint", 13, 25, 4, 6)      # door / waist band, sill at row 4 (z 0.95)
    row("flank", "paint", 26, 28, 4)          # cowl under the raked screen

    # real arch flares: four blocks tall, bulging well past the flank
    for sgn in (1, -1):
        for (c0, c1) in (ARCH_REAR, ARCH_FRONT):
            for c in range(c0 - 1, c1 + 2):
                for r, bulge in ((7, 0.050), (8, 0.085), (9, 0.105), (10, 0.080)):
                    put("fender", "paint", cx(c), cz(r), y0=sgn * (HW + bulge), sy=0.070)

    # number panels, proud of each flank
    for sgn in (1, -1):
        y = sgn * (HW + 0.014)
        for c in range(15, 21):
            for r in (6, 7, 8):
                put("plate", "livery", cx(c), cz(r), y0=y, sy=0.022)


def part_livery():
    # livery split: white door panels against the red paint
    for sgn in (1, -1):
        y = sgn * (HW + 0.016)
        for c in range(13, 26):
            for r in (4, 5):
                put("doorpanel", "livery", cx(c), cz(r), y0=y, sy=0.024)
    # white roof panel
    for c in range(13, 29):
        put("roofpanel", "livery", cx(c), ZTOP + 0.012, sy=0.80, sz=0.024)


def part_mudflaps():
    # mudflaps behind both rear wheels, three blocks tall, hanging off the rear flank
    for sgn in (1, -1):
        for c in (2, 3):
            for r in (11, 12, 13):
                put("mudflap", "trim", cx(c), cz(r), y0=sgn * (HW + 0.095), sy=0.030)


def part_diffuser():
    # rear diffuser: a block row plus fins under the rear bumper
    row("diffuser", "carbon", 0, 5, 11, sy=HW * 2.0)
    for c in (1, 2, 3, 4):
        put("diffuser", "carbon", cx(c), 0.12, sy=1.10, sz=0.16)


# ---------------------------------------------------------------- fascia, lights, hardware
def part_fascia():
    box("fascia", "paint", 39, 42, 5, 7)        # front clip above the bumper
    box("fascia", "trim", 41, 43, 8, 10)        # front bumper
    box("fascia", "paint", 1, 4, 5, 7)          # rear clip
    box("fascia", "trim", 0, 3, 8, 10)          # rear bumper
    for sgn in (1, -1):
        # main clusters on the front clip
        for c in (42, 43):
            for r in (5, 6):
                put("lamps", "lamp", cx(c), cz(r), y0=sgn * TRACK * 0.26, sy=0.10)
        # two auxiliary rally driving lamps, lower and outboard
        for c in (41, 42):
            put("lamps", "lamp", cx(c), cz(8), y0=sgn * TRACK * 0.30, sy=0.10)
        # tail lamps
        for c in (0, 1):
            for r in (5, 6):
                put("lamps", "tail", cx(c), cz(r), y0=sgn * TRACK * 0.28, sy=0.10)
        put("fascia", "trim", cx(30), 1.10, y0=sgn * (HW + 0.06), sy=B)
    put("fascia", "metal", cx(3), 0.34, y0=HW * 0.45, sy=0.14)

    # snorkel: bonnet to A-pillar on the left flank
    for i, (c, z) in enumerate([(37, 0.95), (36, 1.05), (35, 1.15), (34, 1.25), (33, 1.35)]):
        put("snorkel", "carbon", cx(c), z, y0=HW + 0.015, sy=B)


# ---------------------------------------------------------------- rear wing
def part_wing():
    row("spoiler", "carbon", 0, 6, 4, sy=HW * 2.0 + 0.04)
    for c in (2, 4):
        put("spoiler", "carbon", cx(c), cz(5), sy=0.06)
        put("spoiler", "carbon", cx(c), cz(6), sy=0.06)


# ---------------------------------------------------------------- wheels
def part_wheels():
    half = TRACK / 2.0 + WHEEL_OUT          # planted rally track
    specs = [("fl", HALF, half), ("fr", HALF, -half),
             ("rl", -HALF, half), ("rr", -HALF, -half)]
    for tag, x, y in specs:
        part = "wheel_" + tag
        # geometry is built in the wheel's LOCAL frame so the node pivot is the hub:
        # spin = rotate the node about +Y, steer = rotate its parent about +Z.
        PART_ORIGIN[part] = (x, y, R)
        n = int(round(R / B)) + 1
        for i in range(-n, n + 1):
            for j in range(-n, n + 1):
                dx = i * B
                dz = j * B
                d = math.hypot(dx, dz)
                if d > R + 0.5 * B:
                    continue
                lz = dz
                if R + lz - 0.5 * B < -0.001:
                    lz = 0.5 * B - R
                if d >= R - 0.20:                       # three-block thick tread ring
                    put(part, "tread", x + dx, R + lz, y0=y, sy=TREAD_W)
                    for sgn in (1, -1):                 # lighter sidewall band each side
                        put(part, "sidewall", x + dx, R + lz,
                            y0=y + sgn * (TREAD_W + SIDE_W) * 0.5, sy=SIDE_W)
                    continue
                if d >= R - 0.26:
                    key = "rim_dark"                    # rim lip shadow
                elif d <= 0.115:
                    key = "hub"
                else:
                    # five blocky alloy spokes, each split from the next by a dark gap
                    ang = math.atan2(dz, dx)
                    sec = int((ang + math.pi) * 5.0 / math.pi) % 10
                    key = "alloy" if sec % 2 == 0 else "rim_dark"
                put(part, key, x + dx, R + lz, y0=y, sy=TREAD_W)
        sgn = 1 if y > 0 else -1
        # hub nut, centred on the hub and proud of the outboard face
        put(part, "nut", x, R, y0=y + sgn * (TW * 0.5 - 0.010), sy=0.050)
        for i in range(-2, 3):
            for j in range(-2, 3):
                if math.hypot(i * B, (j + 1) * B) <= 1.6 * B:
                    put(part, "brake", x + i * B, R + max(0.5 * B - R, (j + 1) * B),
                        y0=y - sgn * (TW * 0.45), sy=0.03)
        put(part, "caliper", x + 0.28, R + 0.20, y0=y - sgn * (TW * 0.50), sy=0.05)


# ---------------------------------------------------------------- materials
def mat(name, rgb, metallic=0.0, rough=0.5, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = None
    for n in m.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            bsdf = n
            break
    if bsdf:
        def put_(k, v):
            if k in bsdf.inputs:
                try:
                    bsdf.inputs[k].default_value = v
                except Exception:
                    pass
        put_("Base Color", (rgb[0], rgb[1], rgb[2], 1.0))
        put_("Metallic", metallic)
        put_("Roughness", rough)
        put_("Emission Color", (emit[0], emit[1], emit[2], 1.0) if emit else (0, 0, 0, 1))
        put_("Emission Strength", strength)
    m.diffuse_color = (rgb[0], rgb[1], rgb[2], 1.0)
    return m


MATERIALS = {
    "paint": lambda: mat("rally_paint", (0.74, 0.055, 0.040), 0.35, 0.32),
    "livery": lambda: mat("rally_livery", (0.96, 0.96, 0.94), 0.05, 0.35, (0.9, 0.9, 0.9), 0.35),
    "trim": lambda: mat("rally_trim", (0.030, 0.030, 0.034), 0.05, 0.60),
    "carbon": lambda: mat("rally_carbon", (0.016, 0.016, 0.018), 0.20, 0.40),
    "glass": lambda: mat("rally_glass", (0.14, 0.20, 0.26), 0.70, 0.05),
    "rubber": lambda: mat("rally_tyre", (0.012, 0.012, 0.014), 0.0, 0.94),
    "tread": lambda: mat("rally_tread", (0.014, 0.014, 0.016), 0.0, 0.95),
    "sidewall": lambda: mat("rally_sidewall", (0.175, 0.175, 0.190), 0.0, 0.72),
    "nut": lambda: mat("rally_nut", (0.86, 0.72, 0.16), 1.0, 0.22),
    "alloy": lambda: mat("rally_alloy", (0.80, 0.81, 0.84), 0.60, 0.24, (0.55, 0.55, 0.58), 0.12),
    "rim_dark": lambda: mat("rally_rim", (0.07, 0.07, 0.08), 0.40, 0.60),
    "hub": lambda: mat("rally_hub", (0.70, 0.70, 0.72), 1.0, 0.20),
    "brake": lambda: mat("rally_brake", (0.36, 0.36, 0.38), 0.90, 0.45),
    "caliper": lambda: mat("rally_caliper", (0.55, 0.05, 0.05), 0.20, 0.45),
    "metal": lambda: mat("rally_metal", (0.28, 0.28, 0.30), 0.90, 0.40),
    "lamp": lambda: mat("rally_lamp", (0.95, 0.93, 0.86), 0.0, 0.20, (1.0, 0.95, 0.82), 8.0),
    "tail": lambda: mat("rally_tail", (0.58, 0.02, 0.02), 0.0, 0.28, (0.80, 0.02, 0.02), 4.0),
}

PANEL_OF_PART = {
    "chassis": "under", "cabin": "roof", "hood": "hood", "boot": "rear",
    "flank": "flank", "fender": "flank", "plate": "flank", "fascia": "front",
    "lamps": "front", "snorkel": "hood", "spoiler": "rear",
    "doorpanel": "flank", "roofpanel": "roof", "mudflap": "rear", "diffuser": "under",
    "wheel_fl": "wheel", "wheel_fr": "wheel", "wheel_rl": "wheel", "wheel_rr": "wheel",
}


def emit_meshes():
    objs = []
    for part, blocks in PARTS.items():
        ox, oy, oz = PART_ORIGIN.get(part, (0.0, 0.0, 0.0))
        verts = []
        faces = []
        for (material, x, y0, z, sx, sy, sz) in blocks:
            hx, hy, hz = sx * 0.5, sy * 0.5, sz * 0.5
            lx, ly, lz = x - ox, y0 - oy, z - oz
            base = len(verts)
            verts += [
                (lx - hx, ly - hy, lz - hz), (lx + hx, ly - hy, lz - hz),
                (lx + hx, ly + hy, lz - hz), (lx - hx, ly + hy, lz - hz),
                (lx - hx, ly - hy, lz + hz), (lx + hx, ly - hy, lz + hz),
                (lx + hx, ly + hy, lz + hz), (lx - hx, ly + hy, lz + hz),
            ]
            faces += [
                (base, base + 3, base + 2, base + 1),
                (base + 4, base + 5, base + 6, base + 7),
                (base, base + 1, base + 5, base + 4),
                (base + 1, base + 2, base + 6, base + 5),
                (base + 2, base + 3, base + 7, base + 6),
                (base + 3, base + 0, base + 4, base + 7),
            ]
        me = bpy.data.meshes.new("car_" + part)
        me.from_pydata(verts, [], faces)
        bad = me.validate(verbose=False)
        me.update()
        o = bpy.data.objects.new("car_" + part, me)
        o.location = (ox, oy, oz)
        COLL.objects.link(o)
        wanted = []
        for (material, *_rest) in blocks:
            if material not in wanted:
                wanted.append(material)
        slot = {m: i for i, m in enumerate(wanted)}
        for m in wanted:
            o.data.materials.append(MATERIALS[m]())
        i = 0
        for poly in o.data.polygons:
            poly.material_index = slot[blocks[i // 6][0]]
            poly.use_smooth = False
            i += 1
        o["rally_part"] = part
        o["rally_panel"] = PANEL_OF_PART.get(part, "flank")
        o["rally_pivot"] = list(PART_ORIGIN.get(part, (0.0, 0.0, 0.0)))
        if part.startswith("wheel_"):
            o["rally_spin_axis"] = "Y"
        if bad:
            print("WARN invalid mesh %s" % o.name)
        objs.append(o)
    return objs


def world_bbox(o):
    xs = [w.x for w in (o.matrix_world @ v.co for v in o.data.vertices)]
    zs = [w.z for w in (o.matrix_world @ v.co for v in o.data.vertices)]
    if not xs:
        return (0.0, 0.0, 0.0, 0.0)
    return (min(xs), max(xs), min(zs), max(zs))


def dims(objs):
    xs, ys, zs = [], [], []
    for o in objs:
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            xs.append(w.x); ys.append(w.y); zs.append(w.z)
    if not xs:
        return (0.0, 0.0, 0.0, 0.0)
    return (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs), min(zs))


def main():
    for o in list(COLL.objects):
        bpy.data.objects.remove(o, do_unlink=True)

    part_chassis()
    part_cabin()
    part_bodywork()
    part_fascia()
    part_wing()
    part_livery()
    part_mudflaps()
    part_diffuser()
    part_wheels()

    objs = emit_meshes()
    bpy.context.view_layer.update()      # o.location -> matrix_world must settle before measuring
    counts = ", ".join("%s:%d" % (k, len(v)) for k, v in sorted(PARTS.items()))
    print("parts %s" % counts)
    for part, org in sorted(PART_ORIGIN.items()):
        print("PIVOT %s at %.2f,%.2f,%.2f" % (part, org[0], org[1], org[2]))
    for o in objs:
        x0, x1, z0, z1 = world_bbox(o)
        print("BBOX %s z=[%.2f,%.2f] x=[%.2f,%.2f]" % (o.name, z0, z1, x0, x1))
    d = dims(objs)
    print("DIM length=%.2f width=%.2f height=%.2f min_z=%.2f" % d)
    if d[0] < 4.0 or d[2] < 1.40 or d[3] < -0.011:
        print("FAIL: bad envelope, refusing to export")
        return 1

    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]

    os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
    try:
        bpy.ops.export_scene.gltf(filepath=os.path.abspath(OUT), export_format="GLB",
                                  use_selection=True, export_apply=True, export_yup=True,
                                  export_materials="EXPORT", export_image_format="AUTO",
                                  export_animations=False,
                                  export_draco_mesh_compression_enable=False)
    except Exception as e:
        print("EXPORT FAILED: %s" % e)
        return 1

    size = os.path.getsize(os.path.abspath(OUT))
    tris = sum(2 * len(o.data.polygons) for o in objs)
    print("OK wrote %s meshes=%d triangles=%d bytes=%d" % (OUT, len(objs), tris, size))
    if size < MIN_FILE:
        print("FAIL: export too small (%d bytes)" % size)
        return 1
    return 0


sys.exit(main())
