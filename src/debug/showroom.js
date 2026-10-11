// Debug showroom (?showroom=1): the in-game car on a flat pad, framed exactly like
// the Blender design sheets in tools/blender/preview_model.py, so a game PNG and a
// sheet PNG can be compared honestly. Flag-gated: src/main.js only reaches this file
// when the URL carries the flag, so a normal boot never touches it.
//
// Axis mapping (the GLB is authored X forward / Z lateral / Y up, Blender shows it as
// X forward / Y lateral / Z up, the game is X forward / Z lateral / Y up):
//   sheet X -> game x (car forward at yaw 0)
//   sheet Y -> game -z
//   sheet Z -> game y
// Pure maths + plain objects: importable from node (src/debug/tests.js) with no DOM.

export const SHEET_LENS = 45;        // preview_model.py: cam_data.lens
export const SHEET_SENSOR = 36;      // Blender's default sensor_width (mm)
export const SHEET_EYE = 0.90;       // preview_model.py: EYE = zmin + 0.90
export const SHEET_PAD = 60;         // ground plane the sheet renders (size=90 -> 60 here)

// The per-view camera offsets, verbatim from preview_model.py:
//   side  cam.location = (cx, cy - dist, EYE)
//   front cam.location = (cx + dist, cy, EYE)
//   rear  cam.location = (cx - dist, cy, EYE)
//   3q    cam.location = (cx + dist*0.62, cy - dist*0.72, EYE + dist*0.16)
export const SHEET_VIEWS = {
  side: { dx: 0, dy: -1, dz: 0, eyeAdd: 0, fill: 0.70, seen: 'len', tilt: false },
  front: { dx: 1, dy: 0, dz: 0, eyeAdd: 0, fill: 0.55, seen: 'wide', tilt: false },
  rear: { dx: -1, dy: 0, dz: 0, eyeAdd: 0, fill: 0.55, seen: 'wide', tilt: false },
  'three-quarter': { dx: 0.62, dy: -0.72, dz: 0, eyeAdd: 0.16, fill: 0.55, seen: 'size', tilt: true },
  '3q': { dx: 0.62, dy: -0.72, dz: 0, eyeAdd: 0.16, fill: 0.55, seen: 'size', tilt: true },
};

/** Parse the showroom URL. Only ?showroom=1 turns anything on. */
export function showroomConfig(search) {
  const q = new URLSearchParams(typeof search === 'string' ? search : '');
  const raw = (q.get('view') || 'three-quarter').toLowerCase();
  return {
    active: q.get('showroom') === '1',
    view: SHEET_VIEWS[raw] ? raw : 'three-quarter',
  };
}

/**
 * What the showroom route does to the rest of the game (src/main.js applies these).
 * The whole point of the table: the world is never streamed, never pre-generated and
 * never drawn, the HUD is off and the sim is frozen, so the frame is the car alone.
 */
export function showroomRoute() {
  return {
    streamWorld: false, pregen: false, stageCache: false, props: false,
    hudMode: 'OFF', menu: false, driveIn: false, simFrozen: true,
  };
}

/**
 * Camera pose for `view`, from the placed car's world bbox, with the sheet's own
 * distance maths: fw = sensor/lens, fh = fw * H/W, and dist chosen so the extent this
 * view sees fills 70% (side) / 55% (the rest) of the frame.
 * bbox: {min:{x,y,z},max:{x,y,z}} in game coords; aspect = W/H.
 */
export function showroomPose(view, bbox, aspect = 16 / 9) {
  const v = SHEET_VIEWS[view] || SHEET_VIEWS['three-quarter'];
  const fw = SHEET_SENSOR / SHEET_LENS;
  const fh = fw / (aspect || 16 / 9);
  const lenX = bbox.max.x - bbox.min.x;     // car length  (sheet X)
  const wide = bbox.max.z - bbox.min.z;     // car width   (sheet Y)
  const tall = bbox.max.y - bbox.min.y;     // car height  (sheet Z)
  const size = Math.max(lenX, wide, tall);
  const seen = v.seen === 'len' ? lenX : v.seen === 'wide' ? wide : size;
  const dist = Math.max(seen / (v.fill * fw), tall / ((v.fill + 0.10) * fh));
  const cx = (bbox.min.x + bbox.max.x) / 2;
  const cz = (bbox.min.z + bbox.max.z) / 2;
  const eye = bbox.min.y + SHEET_EYE;
  const target = v.tilt
    ? { x: cx, y: bbox.min.y + size * 0.30, z: cz }
    : { x: cx, y: eye, z: cz };
  return {
    view: v === SHEET_VIEWS['3q'] ? 'three-quarter' : view,
    dist, eye, size,
    pos: {
      x: cx + v.dx * dist,
      y: eye + v.eyeAdd * dist,
      // sheet -Y is the game's +Z flank, so the side shot shows the same door
      z: cz - v.dy * dist,
    },
    look: target,
    // three's PerspectiveCamera.fov is the *vertical* angle; the sheet's lens gives
    // sensor_height = sensor_width * H/W, so convert instead of re-tuning the lens.
    fovDeg: 2 * Math.atan((SHEET_SENSOR / (aspect || 16 / 9)) / (2 * SHEET_LENS)) * 180 / Math.PI,
  };
}

/** Corner points of the flat pad the car sits on (a quad the game draws as one mesh). */
export function showroomPad(y) {
  const h = SHEET_PAD / 2;
  return { y, half: h, corners: [[-h, -h], [h, -h], [h, h], [-h, h]] };
}
