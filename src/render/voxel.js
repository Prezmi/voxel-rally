// Voxel box builder: accumulates axis-aligned boxes (optionally yawed)
// into one merged geometry using the shared texture atlas. Used for all
// props and for the car body, so the whole static world is a few draws.

import { tileUV } from '../world/tiles.js';

// Face corner tables in box-local space (half extents hx, hy, hz).
// Order per face: a, b, c, d with CCW winding seen from outside.
const FACES = [
  { n: [0, 1, 0], c: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]], key: 'top' },
  { n: [0, -1, 0], c: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]], key: 'bottom' },
  { n: [1, 0, 0], c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], key: 'side' },
  { n: [-1, 0, 0], c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], key: 'side' },
  { n: [0, 0, 1], c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], key: 'side' },
  { n: [0, 0, -1], c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], key: 'side' },
];

export class BoxBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.colors = [];
    this.indices = [];
  }

  // tiles: a tile id, or { top, side, bottom }.
  addBox(cx, cy, cz, sx, sy, sz, tiles, { tint = 1, yaw = 0, skipBottom = true } = {}) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const tileFor = (key) => (typeof tiles === 'number' ? tiles : (tiles[key] ?? tiles.side));
    for (const face of FACES) {
      if (skipBottom && face.key === 'bottom') continue;
      const uv = tileUV(tileFor(face.key));
      const base = this.positions.length / 3;
      for (const [lx, ly, lz] of face.c) {
        let x = lx * hx, y = ly * hy, z = lz * hz;
        if (yaw !== 0) {
          const rx = x * cos + z * sin;
          const rz = -x * sin + z * cos;
          x = rx; z = rz;
        }
        this.positions.push(cx + x, cy + y, cz + z);
      }
      let [nx, ny, nz] = face.n;
      if (yaw !== 0) {
        const rnx = nx * cos + nz * sin;
        const rnz = -nx * sin + nz * cos;
        nx = rnx; nz = rnz;
      }
      for (let i = 0; i < 4; i++) {
        this.normals.push(nx, ny, nz);
        this.colors.push(tint, tint, tint);
      }
      this.uvs.push(uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]);
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return this;
  }

  build(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.setIndex(this.indices);
    g.computeBoundingSphere();
    return g;
  }
}

// Shared material for everything atlas textured.
export function atlasMaterial(THREE, atlasTex) {
  return new THREE.MeshStandardMaterial({
    map: atlasTex,
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.0,
  });
}
