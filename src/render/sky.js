// Sky: gradient dome shader with sun disc, warm glow and a horizon
// haze band, plus drifting voxel clouds. Driven by time of day
// presets (TOD): each stage has a default, the player can override.

import { BoxBuilder } from './voxel.js';
import { TILE } from '../world/tiles.js';

// sunDir: direction TO the sun (x east, y up, z south-ish).
// fogFarMul multiplies the quality view distance for fog far.
// lights: car headlights / light pod glow on.
export const TOD = {
  day: {
    name: 'Day',
    top: 0x2f6fd8, horizon: 0xcfe4f5, haze: 0xdfeaf2,
    sunColor: 0xfff3da, sunDir: [0.48, 0.78, 0.34], sunInt: 2.1,
    hemiSky: 0xbfd8ff, hemiGround: 0x54503c, hemiInt: 0.85,
    fog: 0xd4e4ef, exposure: 1.1, cloud: 0xffffff, cloudOpacity: 0.94,
    lights: false,
  },
  golden: {
    name: 'Golden Hour',
    top: 0x35549e, horizon: 0xffc98a, haze: 0xffd9a3,
    sunColor: 0xffb45e, sunDir: [0.86, 0.27, 0.30], sunInt: 2.35,
    hemiSky: 0x93a7d8, hemiGround: 0x5c4a33, hemiInt: 0.8,
    fog: 0xf2c491, exposure: 1.21, cloud: 0xffd9ae, cloudOpacity: 0.92,
    lights: true,
  },
  dusk: {
    name: 'Dusk',
    top: 0x1d2a52, horizon: 0xe8795a, haze: 0xc96a55,
    sunColor: 0xff8a4d, sunDir: [-0.78, 0.07, 0.42], sunInt: 1.5,
    hemiSky: 0x5a6ba8, hemiGround: 0x3c3230, hemiInt: 0.5,
    fog: 0x8a5a58, exposure: 1.05, cloud: 0xb08aa5, cloudOpacity: 0.88,
    lights: true,
  },
  overcast: {
    name: 'Overcast',
    top: 0x5d6d7e, horizon: 0xb9c2c9, haze: 0xc3ccd2,
    sunColor: 0xd8dde2, sunDir: [0.30, 0.85, 0.20], sunInt: 1.15,
    hemiSky: 0xaebac4, hemiGround: 0x4a4c44, hemiInt: 1.05,
    fog: 0xb4bec6, exposure: 1.0, cloud: 0xd4dade, cloudOpacity: 0.97,
    lights: true,
  },
};

export function todPreset(key) {
  return TOD[key] ?? TOD.day;
}

export function buildSky(THREE, todKey) {
  const cfg = todPreset(todKey);
  const group = new THREE.Group();
  const sunDirV = new THREE.Vector3(...cfg.sunDir).normalize();

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(cfg.top) },
      horizonColor: { value: new THREE.Color(cfg.horizon) },
      hazeColor: { value: new THREE.Color(cfg.haze) },
      sunDir: { value: sunDirV },
      sunColor: { value: new THREE.Color(cfg.sunColor) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 topColor; uniform vec3 horizonColor; uniform vec3 hazeColor;
      uniform vec3 sunDir; uniform vec3 sunColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 col = mix(horizonColor, topColor, pow(h, 0.58));
        // Horizon haze band.
        col = mix(hazeColor, col, smoothstep(0.0, 0.16, h));
        float sd = max(dot(d, normalize(sunDir)), 0.0);
        // Sun disc + corona + wide warm scatter.
        col += sunColor * pow(sd, 900.0) * 2.4;
        col += sunColor * pow(sd, 90.0) * 0.55;
        col += sunColor * pow(sd, 6.0) * 0.17;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1500, 24, 14), skyMat);
  dome.renderOrder = -10;
  group.add(dome);

  // Voxel clouds: chunky slabs in two layers, tinted by the light.
  const cb = new BoxBuilder();
  const crng = (i) => {
    const x = Math.sin(i * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  for (let i = 0; i < 30; i++) {
    const cx = (crng(i) - 0.5) * 1500;
    const cz = (crng(i + 40) - 0.5) * 1500;
    const cy = 90 + crng(i + 80) * 60 + (i % 3) * 26;
    const w = 22 + crng(i + 120) * 46;
    cb.addBox(cx, cy, cz, w, 3.2, w * 0.55, TILE.WHITE, { tint: 1.05, skipBottom: false });
    cb.addBox(cx + w * 0.18, cy + 2.6, cz, w * 0.55, 2.6, w * 0.36, TILE.WHITE, { tint: 1.1, skipBottom: false });
    cb.addBox(cx - w * 0.3, cy + 1.2, cz + w * 0.1, w * 0.4, 2.0, w * 0.3, TILE.WHITE, { tint: 0.98, skipBottom: false });
  }
  const cloudMat = new THREE.MeshBasicMaterial({ color: cfg.cloud, fog: false, transparent: true, opacity: cfg.cloudOpacity });
  const clouds = new THREE.Mesh(cb.build(THREE), cloudMat);
  clouds.renderOrder = -9;
  group.add(clouds);

  const centre = { x: 0, z: 0 };
  return {
    group,
    sunDir: sunDirV,
    cfg,
    update(dt, t) {
      clouds.position.x = centre.x + Math.sin(t * 0.004) * 22;
      clouds.position.z = centre.z + Math.cos(t * 0.0031) * 16;
      void dt;
    },
    setCenter(x, z) {
      centre.x = x; centre.z = z;
      dome.position.set(x, 0, z);
    },
  };
}
