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
  B(-0.99, 0.9, 0.85, 0.1, 0.07, 0.34, liv.accent);            // mirror arms
  B(0.99, 0.9, 0.85, 0.1, 0.07, 0.34, liv.accent);
  B(-0.7, 0.3, -1.75, 0.3, 0.34, 0.06, TILE.BLACK);            // mudflaps
  B(0.7, 0.3, -1.75, 0.3, 0.34, 0.06, TILE.BLACK);
  B(-0.7, 0.3, 1.78, 0.3, 0.34, 0.06, TILE.BLACK);             // front mudflaps
  B(0.7, 0.3, 1.78, 0.3, 0.34, 0.06, TILE.BLACK);
  B(0, 1.33, 0.3, 0.52, 0.13, 0.72, liv.accent);               // roof vent
  B(-0.8, 1.08, 0.78, 0.07, 0.34, 0.07, TILE.BLACK);           // A pillars
  B(0.8, 1.08, 0.78, 0.07, 0.34, 0.07, TILE.BLACK);
  B(-0.93, 0.3, 0, 0.05, 0.2, 2.7, liv.accent);                // sills
  B(0.93, 0.3, 0, 0.05, 0.2, 2.7, liv.accent);
  B(0.55, 0.34, -2.32, 0.17, 0.17, 0.14, TILE.METAL);          // exhaust

  const bodyMat = new THREE.MeshStandardMaterial({ map: atlasTex, vertexColors: true, roughness: 0.6, metalness: 0.08 });
  const body = new THREE.Mesh(b.build(THREE), bodyMat);
  body.castShadow = true;

  const group = new THREE.Group();
  group.add(body);

  // Dirt build up: a transparent mud shell over the lower body whose
  // opacity the game raises as the car runs off road / on dirt.
  const db = new BoxBuilder();
  const D = (cx, cy, cz, sx, sy, sz) => db.addBox(cx, cy, cz, sx, sy, sz, TILE.MUD, { skipBottom: false });
  D(-0.935, 0.34, 0, 0.04, 0.44, 4.25);
  D(0.935, 0.34, 0, 0.04, 0.44, 4.25);
  D(0, 0.4, -2.27, 1.82, 0.55, 0.04);
  D(0, 0.3, 2.24, 1.72, 0.38, 0.04);
  D(-0.935, 0.32, 1.38, 0.04, 0.5, 1.0);
  D(0.935, 0.32, 1.38, 0.04, 0.5, 1.0);
  D(-0.935, 0.32, -1.38, 0.04, 0.5, 1.0);
  D(0.935, 0.32, -1.38, 0.04, 0.5, 1.0);
  const dirtMat = new THREE.MeshStandardMaterial({ map: atlasTex, vertexColors: true, roughness: 1, transparent: true, opacity: 0 });
  const dirt = new THREE.Mesh(db.build(THREE), dirtMat);
  group.add(dirt);

  // Wheels: dark tyres with a spoked hub cross each.
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.95 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.35, metalness: 0.6 });
  const discMat = new THREE.MeshStandardMaterial({ color: 0x555a60, roughness: 0.5, metalness: 0.5 });
  const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.27, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  const discGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.29, 10);
  discGeo.rotateZ(Math.PI / 2);
  const spokeGeoA = new THREE.BoxGeometry(0.3, 0.34, 0.1);
  const spokeGeoB = new THREE.BoxGeometry(0.3, 0.1, 0.34);
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
    const disc = new THREE.Mesh(discGeo, discMat);
    const spokeA = new THREE.Mesh(spokeGeoA, hubMat);
    const spokeB = new THREE.Mesh(spokeGeoB, hubMat);
    spin.add(tyre, disc, spokeA, spokeB);
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

  // Light glow sprites (headlights + pod + brake bloom).
  const glowTex = (() => {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    const cx2 = cv.getContext('2d');
    const grad = cx2.createRadialGradient(64, 64, 2, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    cx2.fillStyle = grad;
    cx2.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  })();
  const glowSprite = (color, x, y, z, scale) => {
    const m = new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9 });
    const s = new THREE.Sprite(m);
    s.position.set(x, y, z);
    s.scale.set(scale, scale, 1);
    s.visible = false;
    group.add(s);
    return s;
  };
  const headGlows = [
    glowSprite(0xffe9b8, -0.62, 0.82, 2.42, 1.15),
    glowSprite(0xffe9b8, 0.62, 0.82, 2.42, 1.15),
    glowSprite(0xfff3cf, 0, 1.07, 1.42, 1.45),
  ];
  const brakeGlow = glowSprite(0xff2a1a, 0, 0.66, -2.52, 1.6);
  let lightsOn = false;

  return {
    group, wheels, brakeMat,
    setBraking(on) {
      brakeMat.emissiveIntensity = on ? 2.6 : 0.25;
      brakeGlow.visible = on || lightsOn;
      brakeGlow.material.opacity = on ? 0.95 : 0.3;
    },
    setLights(on) {
      lightsOn = on;
      for (const s of headGlows) s.visible = on;
      if (!on) brakeGlow.visible = false;
    },
    setDirt(v) { dirtMat.opacity = Math.min(0.88, Math.max(0, v) * 0.88); },
    update(dt, speedF, steerVis) {
      const spinA = (speedF * dt) / 0.35;
      for (const w of wheels) {
        w.spin.rotation.x += spinA;
        if (w.front) w.pivot.rotation.y = -steerVis * 0.9;
      }
    },
  };
}
