// Wheel <-> voxel terrain contact (docs/02 §7).
// Heightfield first (cheap); the per-block lookup only runs when the column
// height actually steps (a block edge / kerb) or on a hard impact.
export const EDGE_STEP = 0.12;      // m: a block edge that kicks the wheel

export function raycastContact(w, world) {
  const gx = w.hub.x, gz = w.hub.z;      // vertical arm: the contact column is the mount column
  const groundY = world.groundHeight(gx, gz);
  const contactY = w.y - w.rGeo;

  w.groundY = groundY;
  w.compression = groundY - contactY;
  w.contactOn = w.compression > -0.015;
  w.contact.x = gx; w.contact.y = contactY; w.contact.z = gz;

  const step = groundY - w.lastGroundY;
  w.edgeStep = step;
  // surfaceAt is O(1) on the chunk's cached surface array, so read it every step;
  // the expensive per-block lookup is what docs/02 §7 gates on the height step.
  w.surfaceId = world.surfaceAt(gx, gz);
  w.lastGroundY = groundY;
  return w.contactOn;
}

/** Block-edge impulse (docs/02 §7): the wheel "hops" up a kerb. */
export function edgeImpulse(w) {
  if (Math.abs(w.edgeStep) <= EDGE_STEP) return 0;
  const approach = w.vy - 0;             // wheel vertical velocity relative to ground
  if (w.edgeStep > 0 && approach > -1.0) return 0;   // climbing a step slowly: no kick
  return Math.min(3.5, Math.abs(w.edgeStep) * 6.0);
}
