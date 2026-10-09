// Livery generated in code (PLAN §10.2 "Auto z numerem i barwami zespołu"):
// one 128x128 nearest-neighbour canvas texture per car id, baked once at boot.
// No assets, no fetch. The body shader samples it with a triplanar UV baked per
// vertex (side / top / front), so a single map reads as flanks + roof + nose.
const TEAM = {
  A: { primary: '#c0181f', secondary: '#f2efe6', accent: '#191b1f', stripe: '#f2efe6', num: 7, name: 'KORVETT' },
  B: { primary: '#1c3f8c', secondary: '#f2efe6', accent: '#f0c018', stripe: '#f0c018', num: 3, name: 'FJORD' },
  C: { primary: '#2c6a34', secondary: '#e7dfc7', accent: '#191b1f', stripe: '#e7dfc7', num: 12, name: 'TERRA' },
  D: { primary: '#e8b01c', secondary: '#f2efe6', accent: '#24487f', stripe: '#24487f', num: 5, name: 'SVALA' },
};

const S = 128;

export function liveryFor(carId) {
  return TEAM[carId] || TEAM.A;
}

/** Canvas y for a v in 0..1 (CanvasTexture is flipY: v=1 is the top row). */
const vy = (v) => (1 - v) * S;

export function drawLivery(ctx, carId) {
  const t = liveryFor(carId);
  ctx.fillStyle = t.primary;
  ctx.fillRect(0, 0, S, S);

  // Door / lower-body panel: a readable white field for the number, not a
  // full-length pale band (that is what made the flank read as one plate).
  ctx.fillStyle = t.secondary;
  ctx.fillRect(28, vy(0.44), 62, vy(0.14) - vy(0.44));
  // Belt-line stripe.
  ctx.fillStyle = t.accent;
  ctx.fillRect(0, vy(0.56), S, vy(0.49) - vy(0.56));
  // Two lengthwise stripes up high: roof stripes seen from above.
  ctx.fillStyle = t.stripe;
  ctx.fillRect(0, vy(0.80), S, vy(0.74) - vy(0.80));
  ctx.fillStyle = t.accent;
  ctx.fillRect(0, vy(0.92), S, vy(0.86) - vy(0.92));

  // Id variants so the four cars are not the same sticker.
  if (carId === 'B') {
    ctx.fillStyle = t.accent;
    for (let i = 0; i < 4; i++) ctx.fillRect(18 + i * 26, vy(0.44) - 10, 14, 26);
  } else if (carId === 'C') {
    ctx.fillStyle = t.accent;
    ctx.fillRect(12, vy(0.42), 42, 20);
    ctx.fillStyle = t.primary;
    ctx.fillRect(16, vy(0.42) + 4, 34, 12);
  } else if (carId === 'D') {
    ctx.fillStyle = t.accent;
    for (let i = 0; i < S; i += 2) {
      ctx.fillRect(i, vy(0.30 + i / S * 0.18), 3, 12);
    }
  } else {
    ctx.fillStyle = t.primary;
    ctx.fillRect(28, vy(0.34), 62, 10);
  }

  // Nose + tail darken so the ends read as separate volumes.
  ctx.fillStyle = t.accent;
  ctx.fillRect(S - 12, 0, 12, S);
  ctx.fillRect(0, 0, 10, S);

  // Sponsor blocks (CMR: "nicely detailed with all the sponsorship").
  ctx.fillStyle = t.accent;
  ctx.fillRect(78, vy(0.40), 34, 13);
  ctx.fillRect(30, vy(0.66), 26, 11);
  ctx.fillStyle = t.secondary;
  ctx.font = 'bold 11px monospace';
  ctx.fillText(t.name, 79, vy(0.40) + 10);
  ctx.fillText('SZUTER', 31, vy(0.66) + 9);
  ctx.fillStyle = t.accent;
  ctx.font = 'bold 10px monospace';
  ctx.fillText('RALLY', 44, vy(0.88) + 9);

  // Start-number roundel: white circle + black number, on the door and on the
  // roof at once (the same map, projected from the side and from above).
  const cx = 56, cy = vy(0.30);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, 19, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#141414';
  ctx.font = 'bold 25px monospace';
  const label = String(t.num);
  const w = ctx.measureText(label).width;
  ctx.fillText(label, cx - w / 2, cy + 8);
}

export function buildLiveryTexture(carId, THREE) {
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  drawLivery(ctx, carId);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
