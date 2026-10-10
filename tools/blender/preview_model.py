# Headless preview render of a GLB: night rally stage, grass stage, three-quarter view.
#
#   blender --background --python tools/blender/preview_model.py -- \
#       --model assets/models/rally_a.glb --out shots/car-night.png --night
import math
import os
import sys

import bpy
from mathutils import Vector


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
MODEL = A.get("model", "assets/models/rally.glb")
OUT = A.get("out", "/tmp/preview.png")
W = int(A.get("w", 1400))
H = int(A.get("h", 880))
NIGHT = str(A.get("night", "1")).lower() not in ("0", "false", "no")
GRASS = str(A.get("grass", "1")).lower() not in ("0", "false", "no")

sc = bpy.context.scene
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

if not os.path.exists(MODEL):
    print("MISSING MODEL: %s" % MODEL)
    sys.exit(1)

bpy.ops.import_scene.gltf(filepath=os.path.abspath(MODEL))
bpy.context.view_layer.update()
_dg = bpy.context.evaluated_depsgraph_get()

xs, ys, zs = [], [], []
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    ev = o.evaluated_get(_dg) or o
    mw = ev.matrix_world
    for v in ev.data.vertices:
        w = mw @ v.co
        xs.append(w.x); ys.append(w.y); zs.append(w.z)
if not xs:
    print("NOTHING IMPORTED")
    sys.exit(1)

cx = (min(xs) + max(xs)) / 2.0
cy = (min(ys) + max(ys)) / 2.0
cz = (min(zs) + max(zs)) / 2.0
size = max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))
zmin = min(zs)
center = Vector((cx, cy, cz))
print("BBOX center=%.2f,%.2f,%.2f size=%.2f zmin=%.2f" % (cx, cy, cz, size, zmin))

for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH"):
    try:
        sc.render.engine = eng
        print("ENGINE:", sc.render.engine)
        break
    except Exception:
        continue

# ---------------------------------------------------------------- world
world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
sc.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg:
    if NIGHT:
        bg.inputs[0].default_value = (0.008, 0.013, 0.026, 1.0)
        bg.inputs[1].default_value = 1.0
    else:
        bg.inputs[0].default_value = (0.42, 0.52, 0.66, 1.0)
        bg.inputs[1].default_value = 1.0

try:
    sc.world.light_settings.use_ambient_light = True
    sc.world.light_settings.ambient_color = (0.10, 0.14, 0.22)
    sc.world.light_settings.ambient = 0.25
except Exception:
    pass


def add_light(name, kind, loc, energy, color, rot=None, size=1.0, spot_size=None, spot_dist=None):
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    data.color = color
    for attr, val in (("size", size),):
        try:
            setattr(data, attr, val)
        except Exception:
            pass
    if spot_size is not None:
        try:
            data.spot_size = spot_size
        except Exception:
            pass
    if spot_dist is not None:
        try:
            data.spot_size = spot_size
            data.cutoff_distance = spot_dist
        except Exception:
            pass
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = loc
    if rot:
        obj.rotation_euler = rot
    return obj


def aim(obj, target):
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


front = max(xs)
rear = min(xs)
wheels_on = (min(ys), max(ys))

if NIGHT:
    # moon + cool sky fill, warm headlight cones, red tail glow
    moon = add_light("moon", "SUN", (0, 0, 10), 0.95, (0.66, 0.78, 1.0))
    moon.rotation_euler = (math.radians(55), math.radians(-12), math.radians(20))
    add_light("sky", "AREA", (-6, -6, 4), 420, (0.38, 0.54, 0.9))
    add_light("rim", "AREA", (-4, 6, 2.5), 300, (0.60, 0.68, 0.95))
    for yy in (wheels_on[1] * 0.55, wheels_on[0] * 0.55):
        hl = add_light("headlight_%.2f" % yy, "SPOT", (front + 0.15, yy, 0.66), 900,
                       (1.0, 0.90, 0.72), spot_size=math.radians(38), spot_dist=28)
        aim(hl, (front + 14.0, yy * 2.2, 0.15))
    for yy in (wheels_on[1] * 0.55, wheels_on[0] * 0.55):
        tl = add_light("tail_%.2f" % yy, "SPOT", (rear - 0.15, yy, 0.72), 90,
                       (1.0, 0.18, 0.12), spot_size=math.radians(60), spot_dist=6)
        aim(tl, (rear - 4.0, yy * 2.0, 0.55))
else:
    sun = add_light("key", "SUN", (4, -3, 6), 4.0, (1.0, 0.93, 0.80))
    sun.rotation_euler = (math.radians(48), 0, math.radians(35))
    add_light("fill", "AREA", (-5, -4, 3), 320, (0.62, 0.74, 1.0))
    add_light("rim", "AREA", (1.5, 6, 2.5), 220, (1.0, 0.85, 0.7))

# ---------------------------------------------------------------- ground
if GRASS:
    bpy.ops.mesh.primitive_plane_add(size=90, location=(cx, cy, zmin))
    gnd = bpy.context.active_object
    gnd.name = "stage"
    gm = bpy.data.materials.new("stage_grass")
    gm.use_nodes = True
    nt = gm.node_tree
    bsdf = None
    for n in nt.nodes:
        if n.type == "BSDF_PRINCIPLED":
            bsdf = n
            break
    tex = nt.nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = 9.0
    tex.inputs["Detail"].default_value = 8.0
    tex.inputs["Roughness"].default_value = 0.65
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.020, 0.055, 0.022, 1.0)
    ramp.color_ramp.elements[1].color = (0.070, 0.130, 0.045, 1.0)
    nt.links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
    if bsdf:
        for key in ("Base Color", "Color"):
            if key in bsdf.inputs:
                nt.links.new(ramp.outputs["Color"], bsdf.inputs[key])
                break
        for key, val in (("Roughness", 0.92), ("Specular IOR Level", 0.15), ("Specular", 0.15)):
            if key in bsdf.inputs:
                try:
                    bsdf.inputs[key].default_value = val
                except Exception:
                    pass
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.35
    nt.links.new(tex.outputs["Fac"], bump.inputs["Height"])
    if bsdf:
        for key in ("Normal", "Bump Normal"):
            if key in bsdf.inputs:
                nt.links.new(bump.outputs["Normal"], bsdf.inputs[key])
                break
    gnd.data.materials.append(gm)

    # a dirt driving line through the scene so the stage reads as a rally road
    bpy.ops.mesh.primitive_plane_add(size=90, location=(cx, cy, zmin + 0.005))
    road = bpy.context.active_object
    road.name = "road"
    road.scale = (1.0, 0.055, 1.0)
    try:
        bpy.ops.object.transform_apply(scale=True)
    except Exception:
        pass
    rm = bpy.data.materials.new("stage_dirt")
    rm.use_nodes = True
    rb = None
    for n in rm.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            rb = n
            break
    if rb:
        for key in ("Base Color", "Color"):
            if key in rb.inputs:
                rb.inputs[key].default_value = (0.115, 0.078, 0.048, 1.0)
                break
        for key, val in (("Roughness", 0.95), ("Metallic", 0.0)):
            if key in rb.inputs:
                try:
                    rb.inputs[key].default_value = val
                except Exception:
                    pass
    road.data.materials.append(rm)

# ---------------------------------------------------------------- camera
cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = 45
try:
    cam_data.clip_end = 400
except Exception:
    pass
cam = bpy.data.objects.new("Camera", cam_data)
bpy.context.collection.objects.link(cam)
VIEW = str(A.get("view", "3q")).lower()
EYE = zmin + 0.90                      # level with the car, not looking down on it
# frame width / height in metres at a distance of 1 m for this lens
fw = cam_data.sensor_width / cam_data.lens
fh = fw * H / W
# distance that fills ~70% of the frame with the extent this view sees
seen = {"side": max(xs) - min(xs), "front": max(ys) - min(ys),
        "rear": max(ys) - min(ys)}.get(VIEW, size)
fill = 0.70 if VIEW == "side" else 0.55      # front/rear need air for the wing/mirrors
dist = max(seen / (fill * fw), (max(zs) - min(zs)) / ((fill + 0.10) * fh))
if VIEW == "side":                                  # true side view on the -Y axis
    cam.location = (cx, cy - dist, EYE)
elif VIEW == "front":                               # on the +X axis
    cam.location = (cx + dist, cy, EYE)
elif VIEW == "rear":                                # on the -X axis
    cam.location = (cx - dist, cy, EYE)
else:                                               # three quarter
    cam.location = (cx + dist * 0.62, cy - dist * 0.72, EYE + dist * 0.16)
if VIEW in ("side", "front", "rear"):
    aim(cam, (cx, cy, EYE))                         # horizontal axis: no tilt
else:
    aim(cam, (cx, cy, zmin + size * 0.30))
print("VIEW %s cam=%.2f,%.2f,%.2f eye=%.2f dist=%.2f" % (VIEW, cam.location.x,
      cam.location.y, cam.location.z, EYE, dist))
sc.camera = cam

sc.render.resolution_x = W
sc.render.resolution_y = H
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = "PNG"
try:
    sc.render.use_persistent_data = True
except Exception:
    pass
try:
    sc.view_settings.view_transform = "Filmic"
    sc.view_settings.look = "Medium High Contrast"
except Exception:
    pass
sc.render.filepath = os.path.abspath(OUT)

bpy.ops.render.render(write_still=True)
print("OK wrote %s" % OUT)
