// Distant terrain shell: one coarse vertex coloured mesh covering the
// whole stage area, so the horizon shows rolling hills (with a rim
// lift far from the road) instead of empty sky. The detailed voxel
// chunks stream in on top of it near the car; the shell sits 0.35 m
// lower so the two never z-fight.

import { clamp, lerp, smoothstep, hash2 } from '../core/rng.js';

const STEP = 14;

export function buildFarGeometry(stage, THREE) {
  const b = stage.bounds;
  const minX = b.minX - 500, maxX = b.maxX + 500;
  const minZ = b.minZ - 500, maxZ = b.maxZ + 500;
  const nx = Math.max(2, Math.ceil((maxX - minX) / STEP));
  const nz = Math.max(2, Math.ceil((maxZ - minZ) / STEP));
  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  const base = new THREE.Color(stage.env.groundTint);
  const rock = new THREE.Color(0x8d8d90);
  const tmp = new THREE.Color();

  const heights = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = minX + i * STEP, z = minZ + j * STEP;
      const d = stage.distToRoad(x, z);
      const lift = smoothstep(240, 850, d) * stage.env.rimH;
      heights[j * nx + i] = stage.heightAt(x, z) + lift - 0.35;
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = minX + i * STEP, z = minZ + j * STEP;
      const vi = j * nx + i;
      const h = heights[vi];
      positions[vi * 3] = x; positions[vi * 3 + 1] = h; positions[vi * 3 + 2] = z;
      const hx = heights[j * nx + Math.min(i + 1, nx - 1)];
      const hz = heights[Math.min(j + 1, nz - 1) * nx + i];
      const slope = Math.abs(hx - h) / STEP + Math.abs(hz - h) / STEP;
      const rockMix = clamp((slope - 0.55) * 1.1, 0, 0.75);
      tmp.copy(base).lerp(rock, rockMix);
      const jitter = 0.9 + hash2(i, j, 777) * 0.2;
      const high = clamp((h - 14) / 90, 0, 0.25);
      colors[vi * 3] = clamp(tmp.r * jitter + high, 0, 1);
      colors[vi * 3 + 1] = clamp(tmp.g * jitter + high, 0, 1);
      colors[vi * 3 + 2] = clamp(tmp.b * jitter + high * 0.9, 0, 1);
    }
  }
  const indices = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, bIdx = a + 1, c = a + nx, d = c + 1;
      indices.push(a, c, bIdx, bIdx, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

export function farMaterial(THREE) {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: true });
}

export { lerp };
