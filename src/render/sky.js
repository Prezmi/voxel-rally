// Sky dome with a gradient shader + sun glow, and drifting voxel clouds.

import { BoxBuilder } from './voxel.js';
import { TILE } from '../world/tiles.js';

export function buildSky(THREE, skyCfg) {
  const group = new THREE.Group();

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(skyCfg.top) },
      horizonColor: { value: new THREE.Color(skyCfg.horizon) },
      sunDir: { value: new THREE.Vector3(0.45, 0.62, 0.35).normalize() },
      sunColor: { value: new THREE.Color(skyCfg.sun) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 topColor; uniform vec3 horizonColor;
      uniform vec3 sunDir; uniform vec3 sunColor;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 col = mix(horizonColor, topColor, pow(h, 0.62));
        float sun = pow(max(dot(normalize(vDir), normalize(sunDir)), 0.0), 220.0);
        float glow = pow(max(dot(normalize(vDir), normalize(sunDir)), 0.0), 7.0);
        col += sunColor * (sun * 1.2 + glow * 0.16);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(720, 24, 14), skyMat);
  dome.renderOrder = -10;
  group.add(dome);

  // Voxel clouds: chunky white slabs drifting slowly.
  const cb = new BoxBuilder();
  const crng = (i) => {
    const x = Math.sin(i * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  for (let i = 0; i < 16; i++) {
    const cx = (crng(i) - 0.5) * 620;
    const cz = (crng(i + 40) - 0.5) * 620;
    const cy = 58 + crng(i + 80) * 26;
    const w = 14 + crng(i + 120) * 26;
    cb.addBox(cx, cy, cz, w, 2.6, w * 0.55, TILE.WHITE, { tint: 1.05, skipBottom: false });
    cb.addBox(cx + w * 0.18, cy + 2.2, cz, w * 0.55, 2.2, w * 0.36, TILE.WHITE, { tint: 1.08, skipBottom: false });
  }
  const cloudTexMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, transparent: true, opacity: 0.92 });
  const clouds = new THREE.Mesh(cb.build(THREE), cloudTexMat);
  clouds.renderOrder = -9;
  group.add(clouds);

  return {
    group,
    sunDir: skyMat.uniforms.sunDir.value,
    update(dt, t) {
      clouds.position.x = Math.sin(t * 0.004) * 14;
      clouds.position.z = Math.cos(t * 0.0031) * 10;
      void dt;
    },
    setCenter(x, z) {
      dome.position.set(x, 0, z);
    },
  };
}
