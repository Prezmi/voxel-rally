// Voxel rally car: box-built body in a livery, separate wheel meshes so
// they can spin and steer, emissive brake lights, roof light pod.
// Model faces +z; main sets group.rotation.y = PI - heading.

import { BoxBuilder } from './voxel.js';
import { TILE } from '../world/tiles.js';

export const LIVERIES = [
  {
    name: 'Sunset Works',
    body: TILE.ORANGE, accent: TILE.BLACK, roof: TILE.WHITE,
    stats: { speed: 72, grip: 74, drift: 68 },
    params: { grip: 1.0, accel: 1.0 },
    swatch: '#e8710c',
  },
  {
    name: 'Azure Racing',
    body: TILE.BLUE, accent: TILE.WHITE, roof: TILE.WHITE,
    stats: { speed: 68, grip: 86, drift: 55 },
    params: { grip: 1.1, accel: 0.98 },
    swatch: '#2456c4',
  },
  {
    name: 'Volt GP',
    body: TILE.YELLOW, accent: TILE.BLACK, roof: TILE.BLACK,
    stats: { speed: 78, grip: 62, drift: 88 },
    params: { grip: 0.93, accel: 1.05 },
    swatch: '#f2b61c',
  },
];

export function buildCar(THREE, atlasTex, liveryIdx = 0) {
  const liv = LIVERIES[liveryIdx % LIVERIES.length];
  const b = new BoxBuilder();
  const B = (cx, cy, cz, sx, sy, sz, tiles, opts) => b.addBox(cx, cy, cz, sx, sy, sz, tiles, { skipBottom: false, ...opts });

  // Chassis and body.
  B(0, 0.52, 0, 1.82, 0.6, 4.35, liv.body);                    // main shell
  B(0, 0.42, 1.95, 1.7, 0.42, 0.75, liv.body);                 // nose
  B(0, 0.3, 2.28, 1.86, 0.18, 0.22, TILE.BLACK);               // splitter
  B(0, 0.78, 2.14, 1.5, 0.14, 0.1, TILE.BLACK);                // grille
  B(-0.62, 0.82, 2.16, 0.36, 0.17, 0.08, TILE.WHITE);          // headlights
  B(0.62, 0.82, 2.16, 0.36, 0.17, 0.08, TILE.WHITE);
  B(0, 0.98, -0.25, 1.62, 0.42, 2.05, TILE.GLASS);             // glasshouse
  B(0, 1.24, -0.25, 1.74, 0.12, 2.2, liv.roof);                // roof
  B(0, 1.05, 1.02, 1.0, 0.16, 0.34, liv.accent);               // roof light pod base
  for (const lx of [-0.32, 0, 0.32]) B(lx, 1.06, 1.21, 0.24, 0.13, 0.05, TILE.WHITE); // pod lamps
  B(0, 0.6, -2.2, 1.84, 0.34, 0.16, liv.accent);               // rear panel
  B(-0.64, 0.66, -2.3, 0.4, 0.15, 0.06, TILE.RED);             // tail lights (mesh mats below too)
  B(0.64, 0.66, -2.3, 0.4, 0.15, 0.06, TILE.RED);
  B(-0.55, 1.02, -2.02, 0.1, 0.3, 0.34, liv.accent);           // wing supports
  B(0.55, 1.02, -2.02, 0.1, 0.3, 0.34, liv.accent);
  B(0, 1.2, -2.05, 1.95, 0.09, 0.5, liv.accent);               // rear wing
  B(-0.93, 0.62, -0.25, 0.05, 0.5, 1.15, TILE.WHITE);          // door number plates
  B(0.93, 0.62, -0.25, 0.05, 0.5, 1.15, TILE.WHITE);
  B(-0.94, 0.86, 0.85, 0.06, 0.2, 0.3, liv.accent);            // mirrors
  B(0.94, 0.86, 0.85, 0.06, 0.2, 0.3, liv.accent);
  B(-0.7, 0.3, -1.75, 0.3, 0.34, 0.06, TILE.BLACK);            // mudflaps
  B(0.7, 0.3, -1.75, 0.3, 0.34, 0.06, TILE.BLACK);
  B(0.55, 0.34, -2.32, 0.17, 0.17, 0.14, TILE.METAL);          // exhaust

  const bodyMat = new THREE.MeshStandardMaterial({ map: atlasTex, vertexColors: true, roughness: 0.6, metalness: 0.08 });
  const body = new THREE.Mesh(b.build(THREE), bodyMat);
  body.castShadow = true;

  const group = new THREE.Group();
  group.add(body);

  // Wheels: dark cylinders with a lighter hub box each.
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.95 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.35, metalness: 0.6 });
  const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.27, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.BoxGeometry(0.29, 0.3, 0.3);
  const wheels = [];
  const wheelPos = [
    { x: -0.84, z: 1.38, front: true }, { x: 0.84, z: 1.38, front: true },
    { x: -0.84, z: -1.38, front: false }, { x: 0.84, z: -1.38, front: false },
  ];
  for (const wp of wheelPos) {
    const pivot = new THREE.Group();
    pivot.position.set(wp.x, 0.35, wp.z);
    const spin = new THREE.Group();
    const tyre = new THREE.Mesh(wheelGeo, tyreMat);
    tyre.castShadow = true;
    const hub = new THREE.Mesh(hubGeo, hubMat);
    spin.add(tyre, hub);
    pivot.add(spin);
    group.add(pivot);
    wheels.push({ pivot, spin, front: wp.front });
  }

  // Brake lights: emissive boxes at the rear.
  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a1a, emissiveIntensity: 0.25 });
  const bl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.05), brakeMat);
  bl.position.set(-0.64, 0.66, -2.34);
  const br = bl.clone();
  br.position.x = 0.64;
  group.add(bl, br);

  return {
    group, wheels, brakeMat,
    setBraking(on) { brakeMat.emissiveIntensity = on ? 2.6 : 0.25; },
    update(dt, speedF, steerVis) {
      const spinA = (speedF * dt) / 0.35;
      for (const w of wheels) {
        w.spin.rotation.x += spinA;
        if (w.front) w.pivot.rotation.y = -steerVis * 0.9;
      }
    },
  };
}
