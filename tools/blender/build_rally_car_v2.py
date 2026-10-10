# Clean-sheet voxel rally car, drawn from the mood board (shots/moodboard-rally.png).
#
# The silhouette is a side-profile bitmap (front to the right) extruded across the car with a
# per-row width profile, so the shape is art-directed rather than grown from block tables.
#
#   blender --background --python tools/blender/build_rally_car_v2.py -- \
#       --out assets/models/rally_v2.glb
import math
import os
import sys

import bpy

A = {}
argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []
i = 0
while i < len(argv):
    if argv[i].startswith("--") and i + 1 < len(argv):
        A[argv[i][2:]] = argv[i + 1]
        i += 2
    else:
        i += 1

WB = float(A.get("wb", 2.62))
TRACK = float(A.get("track", 1.52))
R = float(A.get("r", 0.335))
B = 0.10
OUT = str(A.get("out", "assets/models/rally_v2.glb"))
COLS = 44
ZTOP = 1.40
X0 = -0.5 * COLS * B
COLL = bpy.context.collection

# ------------------------------------------------------------------ side profile
# . empty   B paint   G glass   U dark lower body   C carbon   L head lamp   T tail lamp
# W white livery   N number panel   V wing plate   D diffuser   P splitter
PROFILE = [
    "............................................",   # 0  lamp rail sits above
    "............BBBBBBBBBBBBBBBBB...............",   # 1  roof
    "...........BBGGGGGGGGGGGGGGGG...............",   # 2  glass top, raked 1 col/row
    "..........BBGGGGGGGGBBGGGGGGGG..............",   # 3  glass + B pillar
    ".........BBGGGGGGGGGBBGGGGGGGGG.............",   # 4  glass bottom
    "......BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB......",   # 5  beltline
    "....BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB....",   # 6  shoulder
    "..BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB..",   # 7  widest
    "..BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB..",   # 8
    "..BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB..",   # 9
    "...BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB....",   # 10
    "....UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU.......",   # 11  rocker / lower
    ".........UUUUUUUUUUUUUUUUUUUUUUUU...........",   # 12  sill
    ".........CCCCCCCCCCCCCCCCCCCCC............",   # 13  undertray
]

# half width of the body at each profile row (metres); arch flares add more locally
WIDTHS = [0.00, 0.78, 0.79, 0.80, 0.80, 0.85, 0.87, 0.88, 0.88, 0.87,
          0.85, 0.82, 0.80, 0.76]

ARCH_REAR = (5, 12)          # open arch gap, 0.86 m wide
ARCH_FRONT = (31, 38)
ARCH_ROWS = (8, 9, 10, 11)   # 0.74 m tall opening

MAT_OF = {".": None, "B": "paint", "G": "glass", "U": "trim", "C": "carbon",
          "L": "lamp", "T": "tail", "W": "livery", "N": "livery", "V": "carbon",
          "D": "metal", "P": "carbon"}


def cx(c):
    return X0 + (c + 0.5) * B


def cz(r):
    return ZTOP - (r + 0.5) * B


BLOCKS = {}
ORIGIN = {}


def put(part, mat, x, z, y0=0.0, sx=B, sy=B, sz=B):
    BLOCKS.setdefault(part, []).append((mat, x, y0, z, sx, sy, sz))


def build_body():
    for r, line in enumerate(PROFILE):
        hw = WIDTHS[r]
        if hw <= 0:
            continue
        for c, ch in enumerate(line[:COLS]):
            mat = MAT_OF.get(ch)
            if mat is None:
                continue
            if r in ARCH_ROWS and (ARCH_REAR[0] <= c <= ARCH_REAR[1] or
                                   ARCH_FRONT[0] <= c <= ARCH_FRONT[1]):
                continue                      # open wheel arch
            put("body", mat, cx(c), cz(r), sy=hw * 2.0)


def build_arch_flares():
    """Widebody arch lips that bulge past the flank and frame the open gap."""
    for sgn in (1, -1):
        for (c0, c1) in (ARCH_REAR, ARCH_FRONT):
            for c in range(c0 - 1, c1 + 2):
                for r in range(7, 12):
                    edge = max(0.80, WIDTHS[r])
                    put("fender", "paint", cx(c), cz(r),
                        y0=sgn * (edge + 0.045), sy=0.075)


def build_livery():
    for sgn in (1, -1):
        y = sgn * 0.895
        for c in range(13, 25):
            for r in (6, 7, 8):
                put("panel", "livery", cx(c), cz(r), y0=y, sy=0.025)
        for c in range(26, 38):                # bonnet stripe
            put("panel", "livery", cx(c), cz(6), y0=y, sy=0.025)
        for c in range(11, 20):                # rear quarter panel
            put("panel", "livery", cx(c), cz(7), y0=y, sy=0.025)
    for c in range(13, 27):                    # white roof, narrower than the rail base
        put("panel", "livery", cx(c), ZTOP + 0.014, sy=0.86, sz=0.028)


def build_hardware():
    # roof lamp bar: dark carbon rail raised on two feet so it reads clear of the white
    # roof panel, with four pods spaced apart (never one white blob)
    for c in (15, 25):
        put("lamps", "carbon", cx(c), ZTOP + 0.030, sy=0.34, sz=0.08)
    put("lamps", "carbon", cx(20), ZTOP + 0.080, sx=1.30, sy=0.56, sz=0.08)
    for c in (14.5, 17.5, 20.5, 23.5):
        put("lamps", "lamproof", cx(c), ZTOP + 0.165, sx=0.14, sy=0.22, sz=0.10)

    # ---- front fascia: closed nose, bumper frame, recessed grille between the lamp
    #      clusters, lamps set INTO the frame, splitter below, tow hook on the offside
    put("fascia", "paint", cx(38), cz(6), sy=1.74)      # bonnet front, closes the nose
    put("fascia", "paint", cx(39), cz(6), sy=1.74)
    put("fascia", "paint", cx(40), 0.75, sy=1.72)      # bumper top land
    FACE = ["BBBBBBBBBBBBBBB",                          # B bumper, M grille bar,
            "BB..BM.M.MB..BB",                          # . open (lamp / grille slot)
            "BB..BM.M.MB..BB",
            "BBBBBBBBBBBBBBB"]
    ZROW = (0.75, 0.65, 0.55, 0.45)
    for k, line in enumerate(FACE):
        for j, ch in enumerate(line):
            if ch == ".":
                continue
            put("fascia", {"B": "paint", "M": "metal", "G": "trim"}[ch], cx(41), ZROW[k],
                y0=-0.84 + j * 0.12, sy=0.12)
    for sgn in (1, -1):                                 # lamps recessed 0.10 back
        put("lamps", "lamp", cx(40), 0.60, y0=sgn * 0.54, sx=0.10, sy=0.24, sz=0.20)
    put("grille", "trim", cx(40), 0.60, sx=0.10, sy=0.60, sz=0.30)   # grille back wall
    put("splitter", "carbon", 1.90, 0.37, sx=0.44, sy=1.76, sz=0.06)
    put("fascia", "metal", 2.02, 0.44, y0=-0.40, sx=0.26, sy=0.13, sz=0.09)  # tow hook arm
    put("fascia", "metal", 2.13, 0.34, y0=-0.40, sx=0.08, sy=0.13, sz=0.16)  # hook drop

    # mirrors on stalks welded to the beltline
    for sgn in (1, -1):
        put("fascia", "trim", cx(31), 0.90, y0=sgn * 0.82, sy=0.14)
        put("fascia", "trim", cx(31), 0.90, y0=sgn * 0.93, sy=0.10)

    # ---- snorkel: one continuous duct on the left flank, every block touching its
    #      neighbour, its foot on the bonnet shelf and its nose on the A pillar
    for c in range(29, 37):
        put("snorkel", "carbon", cx(c), 1.00, y0=0.83, sy=0.14)
    put("snorkel", "carbon", cx(36), 0.90, y0=0.83, sy=0.14)
    put("snorkel", "carbon", cx(36), 0.82, y0=0.83, sy=0.14)
    put("snorkel", "trim", cx(37), 1.00, y0=0.83, sy=0.14, sx=0.12)   # intake mouth

    # ---- rear wing: struts land on the boot lid, endplates overlap the plate edge
    for c in (2, 6):
        for z in (0.80, 0.90, 1.00):
            put("spoiler", "carbon", cx(c), z, sx=0.16, sy=0.13)
    put("spoiler", "carbon", cx(3.5), 1.10, sx=0.92, sy=1.76, sz=0.10)
    put("spoiler", "carbon", cx(3.5), 1.18, sx=0.10, sy=1.76, sz=0.08)  # trailing edge lip
    for sgn in (1, -1):
        put("spoiler", "carbon", cx(3.5), 1.08, y0=sgn * 0.92, sx=0.88, sy=0.08, sz=0.30)

    # ---- rear fascia: dark panel with the tail clusters flush into it
    for z in (0.65, 0.55):
        for (y0, sy) in ((-0.78, 0.38), (0.0, 0.58), (0.78, 0.38)):
            put("rear", "trim", cx(1), z, y0=y0, sy=sy)
        for sgn in (1, -1):
            put("rear", "tail", cx(1), z, y0=sgn * 0.44, sy=0.30)
    put("rear", "trim", cx(1), 0.45, sy=1.80)

    # diffuser fins and mudflaps
    for c in range(4, 11, 2):
        put("diffuser", "carbon", cx(c), 0.24, sy=0.10, sz=0.20)
    for sgn in (1, -1):
        for c in (14, 15):
            put("flap", "trim", cx(c), 0.30, y0=sgn * 0.86, sy=0.09, sz=0.26)


def build_wheels():
    y_out = TRACK / 2.0 + 0.06
    for tag, x, y in (("fl", WB / 2.0, y_out), ("fr", WB / 2.0, -y_out),
                      ("rl", -WB / 2.0, y_out), ("rr", -WB / 2.0, -y_out)):
        part = "wheel_" + tag
        ORIGIN[part] = (x, y, R)               # node pivot at the hub: spin about +Y
        n = int(round(R / B)) + 1
        for i in range(-n, n + 1):
            for j in range(-n, n + 1):
                dx, dz = i * B, j * B
                d = math.hypot(dx, dz)
                if d > R + 0.5 * B:
                    continue
                lz = dz
                if R + lz - 0.5 * B < -0.001:
                    lz = 0.5 * B - R
                if d >= R - 0.06:
                    key = "rubber"                  # tread band
                elif d >= 0.19:
                    key = "sidewall"                # one continuous dark ring
                else:
                    continue                        # face is built as a clean disc
                put(part, key, dx, lz, sy=0.34)
        sgn = 1 if y > 0 else -1
        fp = 0.055                                  # alloy face: one bright disc
        for i in range(-4, 5):
            for j in range(-4, 5):
                if math.hypot(i * fp, j * fp) <= 0.19:
                    put(part, "alloy", i * fp, j * fp, sx=fp, sy=0.32, sz=fp)
        for k in range(5):                          # five dark separated spokes
            a = math.radians(90.0 + k * 72.0)
            for t in (0.070, 0.120, 0.170):
                put(part, "rim_dark", math.cos(a) * t, math.sin(a) * t,
                    y0=sgn * 0.185, sx=0.085, sy=0.06, sz=0.085)
        put(part, "nut", 0.0, 0.0, y0=sgn * 0.205, sx=0.11, sy=0.07, sz=0.11)


# ------------------------------------------------------------------ materials
def mat(name, rgb, metallic=0.0, rough=0.5, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    bsdf = None
    for n in m.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            bsdf = n
            break
    if bsdf:
        def p(k, v):
            if k in bsdf.inputs:
                try:
                    bsdf.inputs[k].default_value = v
                except Exception:
                    pass
        p("Base Color", (rgb[0], rgb[1], rgb[2], 1.0))
        p("Metallic", metallic)
        p("Roughness", rough)
        p("Emission Color", (emit[0], emit[1], emit[2], 1.0) if emit else (0, 0, 0, 1))
        p("Emission Strength", strength)
    m.diffuse_color = (rgb[0], rgb[1], rgb[2], 1.0)
    return m


MATERIALS = {
    "paint": lambda: mat("rally_paint", (0.72, 0.050, 0.038), 0.35, 0.32),
    "livery": lambda: mat("rally_livery", (0.95, 0.95, 0.93), 0.05, 0.35, (0.9, 0.9, 0.9), 0.10),
    "trim": lambda: mat("rally_trim", (0.030, 0.030, 0.034), 0.05, 0.60),
    "carbon": lambda: mat("rally_carbon", (0.018, 0.018, 0.020), 0.20, 0.40),
    "glass": lambda: mat("rally_glass", (0.34, 0.43, 0.53), 0.25, 0.18),
    "rubber": lambda: mat("rally_tyre", (0.012, 0.012, 0.014), 0.0, 0.94),
    "sidewall": lambda: mat("rally_sidewall", (0.062, 0.062, 0.068), 0.0, 0.86),
    "alloy": lambda: mat("rally_alloy", (0.70, 0.72, 0.76), 0.20, 0.34, (0.55, 0.57, 0.60), 0.14),
    "rim_dark": lambda: mat("rally_rim", (0.020, 0.020, 0.024), 0.20, 0.55),
    "hub": lambda: mat("rally_hub", (0.70, 0.70, 0.73), 0.30, 0.25),
    "nut": lambda: mat("rally_nut", (0.92, 0.80, 0.18), 0.25, 0.30, (0.90, 0.75, 0.15), 0.25),
    "brake": lambda: mat("rally_brake", (0.34, 0.34, 0.36), 0.90, 0.45),
    "metal": lambda: mat("rally_metal", (0.28, 0.28, 0.30), 0.90, 0.40),
    "lamp": lambda: mat("rally_lamp", (0.95, 0.93, 0.86), 0.0, 0.20, (1.0, 0.95, 0.82), 3.0),
    "lamproof": lambda: mat("rally_lamproof", (0.90, 0.90, 0.86), 0.0, 0.25, (1.0, 0.94, 0.80), 1.6),
    "tail": lambda: mat("rally_tail", (0.58, 0.02, 0.02), 0.0, 0.28, (0.80, 0.02, 0.02), 4.0),
}

PANEL_OF = {"body": "flank", "fender": "flank", "panel": "flank", "lamps": "front",
            "fascia": "front", "grille": "front", "splitter": "under", "rear": "rear",
            "snorkel": "hood", "spoiler": "rear", "diffuser": "under",
            "flap": "rear", "wheel_fl": "wheel", "wheel_fr": "wheel",
            "wheel_rl": "wheel", "wheel_rr": "wheel"}


def emit():
    objs = []
    for part, blocks in BLOCKS.items():
        origin = ORIGIN.get(part, (0.0, 0.0, 0.0))
        # wheel blocks were authored in the wheel's own frame, so only the node moves
        ox, oy, oz = (0.0, 0.0, 0.0) if part.startswith("wheel_") else origin
        verts, faces = [], []
        for (m, x, y0, z, sx, sy, sz) in blocks:
            hx, hy, hz = sx * 0.5, sy * 0.5, sz * 0.5
            lx, ly, lz = x - ox, y0 - oy, z - oz
            base = len(verts)
            verts += [(lx - hx, ly - hy, lz - hz), (lx + hx, ly - hy, lz - hz),
                      (lx + hx, ly + hy, lz - hz), (lx - hx, ly + hy, lz - hz),
                      (lx - hx, ly - hy, lz + hz), (lx + hx, ly - hy, lz + hz),
                      (lx + hx, ly + hy, lz + hz), (lx - hx, ly + hy, lz + hz)]
            faces += [(base, base + 3, base + 2, base + 1),
                      (base + 4, base + 5, base + 6, base + 7),
                      (base, base + 1, base + 5, base + 4),
                      (base + 1, base + 2, base + 6, base + 5),
                      (base + 2, base + 3, base + 7, base + 6),
                      (base + 3, base + 0, base + 4, base + 7)]
        me = bpy.data.meshes.new("car_" + part)
        me.from_pydata(verts, [], faces)
        me.validate(verbose=False)
        me.update()
        o = bpy.data.objects.new("car_" + part, me)
        o.location = origin
        COLL.objects.link(o)
        wanted = []
        for (m, *_r) in blocks:
            if m not in wanted:
                wanted.append(m)
        slot = {m: k for k, m in enumerate(wanted)}
        for m in wanted:
            o.data.materials.append(MATERIALS[m]())
        k = 0
        for poly in o.data.polygons:
            poly.material_index = slot[blocks[k // 6][0]]
            poly.use_smooth = False
            k += 1
        o["rally_part"] = part
        o["rally_panel"] = PANEL_OF.get(part, "flank")
        o["rally_pivot"] = list(origin)
        if part.startswith("wheel_"):
            o["rally_spin_axis"] = "Y"
        objs.append(o)
    return objs


def main():
    for o in list(COLL.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    build_body()
    build_arch_flares()
    build_livery()
    build_hardware()
    build_wheels()
    objs = emit()
    bpy.context.view_layer.update()

    for o in objs:
        if o.name.startswith("car_wheel_"):
            print("PIVOT %s at %.2f,%.2f,%.2f" % (o.name, o.location.x, o.location.y, o.location.z))
    xs, ys, zs = [], [], []
    for o in objs:
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            xs.append(w.x); ys.append(w.y); zs.append(w.z)
    print("DIM length=%.2f width=%.2f height=%.2f min_z=%.2f"
          % (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs), min(zs)))
    for (c0, c1) in (ARCH_REAR, ARCH_FRONT):
        print("GAP arch cols %d..%d width=%.2f" % (c0, c1, (c1 - c0 + 1) * B))
    h = max(zs) - min(zs)
    L = max(xs) - min(xs)
    # the roof lamp pods sit above the body line, so the body envelope is checked separately
    print("BODY roof_top=%.2f ground=%.2f" % (ZTOP, min(zs)))
    if not (1.40 <= h <= 1.64 and 4.20 <= L <= 4.50 and min(zs) >= -0.011):
        print("FAIL: envelope outside the reference sheet")
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
    if size < 60000:
        print("FAIL: export too small")
        return 1
    return 0


sys.exit(main())
