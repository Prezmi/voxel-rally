// Dependency-free 3D math for the simulation (physics-tuning skill: keep the
// physics block free of renderer references so it runs headless in Node).
// Body frame: X = forward, Y = up, Z = right. World frame: Y up.

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const setV = (a, x, y, z) => { a.x = x; a.y = y; a.z = z; return a; };
export const copyV = (a, b) => { a.x = b.x; a.y = b.y; a.z = b.z; return a; };
export const addV = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const subV = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scaleV = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross3 = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
/** Allocation-free cross product (hot loop). */
export function crossInto(a, b, out) {
  out.x = a.y * b.z - a.z * b.y;
  out.y = a.z * b.x - a.x * b.z;
  out.z = a.x * b.y - a.y * b.x;
  return out;
}
export const len3 = (a) => Math.hypot(a.x, a.y, a.z);
export function addScaled(out, a, s) { out.x += a.x * s; out.y += a.y * s; out.z += a.z * s; return out; }

/** Column-major 3x3: m[0..2] = image of local X, m[3..5] = local Y, m[6..8] = local Z. */
export function quatToMat3(q, m) {
  const { x, y, z, w } = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  m[0] = 1 - 2 * (yy + zz); m[1] = 2 * (xy + wz); m[2] = 2 * (xz - wy);
  m[3] = 2 * (xy - wz); m[4] = 1 - 2 * (xx + zz); m[5] = 2 * (yz + wx);
  m[6] = 2 * (xz + wy); m[7] = 2 * (yz - wx); m[8] = 1 - 2 * (xx + yy);
  return m;
}

/** world = R * local */
export function mul3v(m, l, out) {
  out.x = m[0] * l.x + m[3] * l.y + m[6] * l.z;
  out.y = m[1] * l.x + m[4] * l.y + m[7] * l.z;
  out.z = m[2] * l.x + m[5] * l.y + m[8] * l.z;
  return out;
}
/** local = R^T * world */
export function mul3vT(m, w, out) {
  out.x = m[0] * w.x + m[1] * w.y + m[2] * w.z;
  out.y = m[3] * w.x + m[4] * w.y + m[5] * w.z;
  out.z = m[6] * w.x + m[7] * w.y + m[8] * w.z;
  return out;
}

export const q4 = (x = 0, y = 0, z = 0, w = 1) => ({ x, y, z, w });
export function normalizeQ(q) {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  q.x /= l; q.y /= l; q.z /= l; q.w /= l;
  return q;
}
export function quatFromYaw(yaw, q) {
  // Rotation about +Y: local +X turns toward -Z for positive yaw (left).
  const h = yaw * 0.5;
  q.x = 0; q.y = Math.sin(h); q.z = 0; q.w = Math.cos(h);
  return q;
}
export function quatFromEuler(pitch, yaw, roll, q) {
  const cp = Math.cos(pitch * 0.5), sp = Math.sin(pitch * 0.5);
  const cy = Math.cos(yaw * 0.5), sy = Math.sin(yaw * 0.5);
  const cr = Math.cos(roll * 0.5), sr = Math.sin(roll * 0.5);
  q.x = sr * cp * cy - cr * sp * sy;
  q.y = cr * sp * cy + sr * cp * sy;
  q.z = cr * cp * sy - sr * sp * cy;
  q.w = cr * cp * cy + sr * sp * sy;
  return normalizeQ(q);
}
export function quatMul(a, b, out) {
  const ax = a.x, ay = a.y, az = a.z, aw = a.w;
  const bx = b.x, by = b.y, bz = b.z, bw = b.w;
  out.x = aw * bx + ax * bw + ay * bz - az * by;
  out.y = aw * by - ax * bz + ay * bw + az * bx;
  out.z = aw * bz + ax * by - ay * bx + az * bw;
  out.w = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/**
 * dq/dt = 0.5 * q (0, omega_body), i.e. the quaternion product with omega on the
 * RIGHT: the cross term is q x omega. The previous signs (ox*qw + oy*qz - oz*qy)
 * computed omega x q, which is the *world*-frame kinematics, while the only caller
 * (Body.integrate, docs/02 §9) hands it the body-frame omega it just integrated in
 * Euler's equation. The attitude is then rotated about the wrong axis: the error is
 * a rotation of omega about the body axes, so it vanishes when the body is aligned
 * with the world (yaw 0) and is maximal at yaw 90 deg. A parked car on flat ground
 * was stable at yaw 0.4 and threw itself into the air at yaw 1.57 because of this
 * alone: every substep tilted the attitude without the matching change in the body
 * rates, so the suspension did work on a body whose inertia no longer matched its
 * rotation, and the pitch/roll mode rang up.
 */
export function integrateQ(q, omegaBody, dt) {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const ox = omegaBody.x * 0.5 * dt, oy = omegaBody.y * 0.5 * dt, oz = omegaBody.z * 0.5 * dt;
  q.x += ox * qw - oy * qz + oz * qy;
  q.y += oy * qw + ox * qz - oz * qx;
  q.z += oz * qw - ox * qy + oy * qx;
  q.w += -ox * qx - oy * qy - oz * qz;
  return normalizeQ(q);
}

/** Yaw angle of the body forward axis projected on the ground plane. */
export function yawOf(m) { return Math.atan2(-m[2], m[0]); }
/** Pitch of the forward axis (rad, + = nose up). */
export function pitchOf(m) { return Math.asin(Math.max(-1, Math.min(1, m[1]))); }
/** Roll: angle of the body right axis about the body forward axis. */
export function rollOf(m) {
  // right axis = m[6..8]; roll = atan2(right.y component relative to level frame)
  const rx = m[6], ry = m[7], rz = m[8];
  return Math.atan2(ry, Math.hypot(rx, rz)) * -1;
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function wrapPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
