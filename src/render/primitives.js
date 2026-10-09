// Procedural block models: everything is built out of boxes with vertex colours
// (PLAN P4 "modele z boksu"). No geometry files, no loaders.
// Produces plain typed arrays the caller wraps in BufferGeometry, plus instance
// transform lists for InstancedMesh.
//
// Winding: front faces are CCW when viewed from outside (Y-up).

const FACE_SHADE = { px: 0.86, nx: 0.72, py: 1.0, ny: 0.5, pz: 0.92, nz: 0.66 };

export class GeoBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.col = [];
    this.idx = [];
  }

  /** Axis-aligned box centred at (cx,cy,cz) with half-extents (hx,hy,hz). */
  box(cx, cy, cz, hx, hy, hz, color, tint = 1) {
    const r = ((color >> 16) & 255) / 255 * tint;
    const g = ((color >> 8) & 255) / 255 * tint;
    const b = (color & 255) / 255 * tint;
    const x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;

    // [normal, corners CCW from outside, shade]
    const faces = [
      [[1, 0, 0], [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], FACE_SHADE.px],
      [[-1, 0, 0], [[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]], FACE_SHADE.nx],
      [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], FACE_SHADE.py],
      [[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], FACE_SHADE.ny],
      [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], FACE_SHADE.pz],
      [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], FACE_SHADE.nz],
    ];
    for (const [n, corners, shade] of faces) {
      const base = this.pos.length / 3;
      for (const c of corners) {
        this.pos.push(c[0], c[1], c[2]);
        this.nor.push(n[0], n[1], n[2]);
        this.col.push(r * shade, g * shade, b * shade);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /** Box rotated about Y by `yaw` (radians), then translated. */
  boxRot(cx, cy, cz, hx, hy, hz, yaw, color, tint = 1) {
    if (!yaw) return this.box(cx, cy, cz, hx, hy, hz, color, tint);
    const co = Math.cos(yaw), si = Math.sin(yaw);
    const save = this.pos.length;
    this.box(0, 0, 0, hx, hy, hz, color, tint);
    const nSave = this.pos.length - save;
    for (let i = 0; i < nSave; i += 3) {
      const k = save + i;
      const x = this.pos[k], y = this.pos[k + 1], z = this.pos[k + 2];
      this.pos[k] = x * co - z * si + cx;
      this.pos[k + 1] = y + cy;
      this.pos[k + 2] = x * si + z * co + cz;
      const nx = this.nor[k], nz = this.nor[k + 2];
      this.nor[k] = nx * co - nz * si;
      this.nor[k + 2] = nx * si + nz * co;
    }
  }

  toGeometry(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.idx.length) g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }

  get triangleCount() { return this.idx.length / 3; }
}
