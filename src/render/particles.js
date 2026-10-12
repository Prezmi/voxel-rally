// Dust / spray particle pool (THREE.Points). One draw call, CPU updated.
// Colour comes from the surface being driven on.

export class DustSystem {
  constructor(THREE, max = 800) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max); // remaining
    this.span = new Float32Array(max); // total
    this.head = 0;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.38)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(cv);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.mat = new THREE.PointsMaterial({
      size: 0.7, map: tex, vertexColors: true, transparent: true,
      opacity: 0.55, depthWrite: false, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.geo = geo;
    // Park everything far underground.
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -100;
    this.rate = 1;
  }

  spawn(x, y, z, colorHex, spread = 1, up = 1.6, count = 1) {
    const c = { r: ((colorHex >> 16) & 255) / 255, g: ((colorHex >> 8) & 255) / 255, b: (colorHex & 255) / 255 };
    for (let n = 0; n < count; n++) {
      const i = this.head;
      this.head = (this.head + 1) % this.max;
      const j = i * 3;
      this.pos[j] = x + (Math.random() - 0.5) * 0.5;
      this.pos[j + 1] = y + Math.random() * 0.25;
      this.pos[j + 2] = z + (Math.random() - 0.5) * 0.5;
      this.vel[j] = (Math.random() - 0.5) * 1.6 * spread;
      this.vel[j + 1] = (0.6 + Math.random() * 1.4) * up;
      this.vel[j + 2] = (Math.random() - 0.5) * 1.6 * spread;
      const shade = 0.85 + Math.random() * 0.3;
      this.col[j] = c.r * shade;
      this.col[j + 1] = c.g * shade;
      this.col[j + 2] = c.b * shade;
      this.life[i] = this.span[i] = 0.55 + Math.random() * 0.75;
    }
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      if (this.life[i] <= 0) { this.pos[j + 1] = -100; continue; }
      this.vel[j + 1] += 0.7 * dt; // dust billows up slightly then settles
      this.vel[j] *= (1 - 1.6 * dt);
      this.vel[j + 2] *= (1 - 1.6 * dt);
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}
