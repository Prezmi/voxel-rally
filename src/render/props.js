// Voxel props: every stage prop type is a small stack of atlas textured
// boxes. All props for a stage merge into ONE geometry (one draw call).

import { BoxBuilder } from './voxel.js';
import { TILE } from '../world/tiles.js';

export const yawForHeading = (h) => Math.PI - h;

class Placer {
  constructor(builder) { this.b = builder; }
  at(x, y, z, heading) {
    this.x = x; this.y = y; this.z = z;
    this.yaw = yawForHeading(heading);
    this.cos = Math.cos(this.yaw); this.sin = Math.sin(this.yaw);
  }
  box(cx, cy, cz, sx, sy, sz, tiles, opts = {}) {
    const rx = cx * this.cos + cz * this.sin;
    const rz = -cx * this.sin + cz * this.cos;
    this.b.addBox(this.x + rx, this.y + cy, this.z + rz, sx, sy, sz, tiles,
      { ...opts, yaw: this.yaw + (opts.yaw || 0) });
  }
}

const PERSON_TILES = [TILE.RED, TILE.BLUE, TILE.YELLOW, TILE.ORANGE, TILE.WHITE, TILE.BLUE];

const DEFS = {
  pine(p, v) {
    const s = 1;
    p.box(0, 0.8 * s, 0, 0.36, 1.6, 0.36, TILE.BARK);
    p.box(0, 2.1, 0, 2.3, 1.15, 2.3, TILE.LEAF_PINE);
    p.box(0, 3.0, 0, 1.75, 1.0, 1.75, TILE.LEAF_PINE);
    p.box(0, 3.85, 0, 1.15, 1.0, 1.15, TILE.LEAF_PINE);
    void v;
  },
  snowPine(p) {
    p.box(0, 0.8, 0, 0.36, 1.6, 0.36, TILE.BARK);
    p.box(0, 2.1, 0, 2.3, 1.15, 2.3, TILE.SNOW_TREE);
    p.box(0, 3.0, 0, 1.75, 1.0, 1.75, TILE.SNOW_TREE);
    p.box(0, 3.85, 0, 1.15, 1.0, 1.15, { top: TILE.SNOW, side: TILE.SNOW_TREE });
  },
  round(p, v) {
    p.box(0, 0.7, 0, 0.32, 1.4, 0.32, TILE.BARK);
    const leaf = v === 3 ? TILE.LEAF_AUTUMN : TILE.LEAF_ROUND;
    p.box(0, 2.5, 0, 2.5, 2.0, 2.5, leaf);
    p.box(0.5, 3.6, 0.3, 1.6, 1.3, 1.6, leaf);
    p.box(-0.7, 3.3, -0.4, 1.2, 1.1, 1.2, leaf);
  },
  deadTree(p) {
    p.box(0, 1.5, 0, 0.3, 3.0, 0.3, TILE.BARK);
    p.box(0.7, 2.7, 0, 1.5, 0.22, 0.22, TILE.BARK);
    p.box(-0.6, 3.2, 0.2, 1.2, 0.2, 0.2, TILE.BARK);
  },
  cactus(p, v) {
    p.box(0, 1.2, 0, 0.58, 2.4, 0.58, TILE.CACTUS);
    if (v % 2 === 0) {
      p.box(0.52, 1.45, 0, 0.34, 0.34, 0.34, TILE.CACTUS);
      p.box(0.72, 1.85, 0, 0.36, 1.1, 0.36, TILE.CACTUS);
    } else {
      p.box(-0.52, 1.3, 0, 0.34, 0.34, 0.34, TILE.CACTUS);
      p.box(-0.72, 1.65, 0, 0.36, 0.95, 0.36, TILE.CACTUS);
    }
  },
  rock(p, v) {
    p.box(0, 0.42, 0, 1.5, 0.85, 1.25, TILE.ROCK);
    if (v % 2 === 0) p.box(0.45, 0.95, 0.2, 0.85, 0.6, 0.8, TILE.ROCK);
    if (v % 3 === 0) p.box(-0.8, 0.3, 0.4, 0.8, 0.6, 0.7, TILE.ROCK);
  },
  hay(p) {
    p.box(0, 0.65, 0, 1.3, 1.3, 1.3, TILE.HAY);
  },
  house(p, v) {
    const roofT = v === 1 ? TILE.ROOF_GREY : TILE.ROOF_RED;
    p.box(0, 1.3, 0, 5.0, 2.6, 4.4, TILE.WALL_CREAM);
    p.box(0, 2.85, 0, 5.5, 0.5, 4.9, roofT);
    p.box(0, 3.3, 0, 4.2, 0.45, 3.6, roofT);
    p.box(0, 3.72, 0, 2.6, 0.45, 2.2, roofT);
    p.box(0, 0.95, 2.21, 0.95, 1.9, 0.08, TILE.WOOD);
    p.box(-1.6, 1.55, 2.21, 0.85, 0.85, 0.08, TILE.GLASS);
    p.box(1.6, 1.55, 2.21, 0.85, 0.85, 0.08, TILE.GLASS);
    p.box(1.9, 3.4, -1.2, 0.6, 1.4, 0.6, TILE.STONE);
  },
  barn(p) {
    p.box(0, 1.7, 0, 6.6, 3.4, 5.2, TILE.RED);
    p.box(0, 3.65, 0, 7.1, 0.5, 5.7, TILE.ROOF_GREY);
    p.box(0, 4.05, 0, 5.2, 0.45, 4.0, TILE.ROOF_GREY);
    p.box(0, 4.42, 0, 3.0, 0.4, 2.2, TILE.ROOF_GREY);
    p.box(0, 1.25, 2.61, 2.0, 2.5, 0.08, TILE.WOOD);
    p.box(0, 2.9, 2.61, 1.1, 1.1, 0.08, TILE.WALL_CREAM);
  },
  cabin(p) {
    p.box(0, 1.25, 0, 4.6, 2.5, 4.0, TILE.WOOD);
    p.box(0, 2.7, 0, 5.1, 0.45, 4.5, TILE.ROOF_GREY);
    p.box(0, 3.1, 0, 3.6, 0.4, 3.0, TILE.ROOF_GREY);
    p.box(0, 3.42, 0, 2.0, 0.35, 1.6, { top: TILE.SNOW, side: TILE.ROOF_GREY });
    p.box(0, 3.3, 0, 3.7, 0.18, 3.1, TILE.SNOW);
    p.box(0, 0.9, 2.01, 0.9, 1.8, 0.08, TILE.BLACK);
    p.box(-1.4, 1.5, 2.01, 0.8, 0.8, 0.08, TILE.GLASS);
    p.box(1.4, 1.5, 2.01, 0.8, 0.8, 0.08, TILE.GLASS);
  },
  gantry(p, v) {
    p.box(-5.4, 2.3, 0, 0.55, 4.6, 0.55, TILE.METAL);
    p.box(5.4, 2.3, 0, 0.55, 4.6, 0.55, TILE.METAL);
    p.box(0, 4.75, 0, 11.6, 0.65, 0.7, TILE.METAL);
    p.box(0, 4.0, 0, 7.2, 1.05, 0.3, TILE.BANNER);
    if (v === 1) {
      for (let i = 0; i < 8; i++)
        p.box(-3.15 + i * 0.9, 3.35, 0, 0.9, 0.3, 0.3, i % 2 ? TILE.BLACK : TILE.WHITE);
    } else {
      p.box(-5.4, 3.4, 0.29, 0.57, 0.9, 0.05, TILE.RED);
      p.box(5.4, 3.4, 0.29, 0.57, 0.9, 0.05, TILE.RED);
    }
  },
  banner(p) {
    p.box(-5.0, 1.7, 0, 0.2, 3.4, 0.2, TILE.METAL);
    p.box(5.0, 1.7, 0, 0.2, 3.4, 0.2, TILE.METAL);
    p.box(0, 3.3, 0, 10.4, 0.55, 0.3, TILE.BLUE);
    for (let i = 0; i < 5; i++)
      p.box(-3.6 + i * 1.8, 2.85, 0, 0.55, 0.42, 0.1, i % 2 ? TILE.RED : TILE.WHITE);
  },
  tent(p, v) {
    const t = [TILE.ORANGE, TILE.BLUE, TILE.RED][v % 3];
    p.box(0, 0.65, 0, 2.7, 1.3, 2.7, t);
    p.box(0, 1.5, 0, 2.0, 0.45, 2.0, t);
    p.box(0, 1.85, 0, 1.15, 0.35, 1.15, t);
    p.box(0, 0.7, 1.36, 0.95, 1.4, 0.06, TILE.BLACK);
  },
  van(p, v) {
    const t = v === 1 ? TILE.BLUE : TILE.WHITE;
    p.box(0, 1.3, 0, 2.0, 1.75, 4.6, t);
    p.box(0, 1.62, 1.2, 1.9, 0.62, 2.0, TILE.GLASS);
    p.box(0, 0.95, 2.36, 1.96, 0.5, 0.1, TILE.BLACK);
    for (const [sx, sz] of [[-0.95, 1.55], [0.95, 1.55], [-0.95, -1.55], [0.95, -1.55]])
      p.box(sx, 0.36, sz, 0.18, 0.72, 0.72, TILE.TYRE);
    p.box(0, 0.62, 0, 2.04, 0.3, 4.64, TILE.ORANGE);
  },
  signR(p) {
    p.box(0, 0.85, 0, 0.18, 1.7, 0.18, TILE.METAL);
    p.box(0, 1.95, 0, 1.6, 1.05, 0.14, TILE.CHEVRON_R);
  },
  signL(p) {
    p.box(0, 0.85, 0, 0.18, 1.7, 0.18, TILE.METAL);
    p.box(0, 1.95, 0, 1.6, 1.05, 0.14, TILE.CHEVRON_L);
  },
  person(p, v) {
    const body = PERSON_TILES[v % PERSON_TILES.length];
    p.box(-0.11, 0.28, 0, 0.17, 0.56, 0.2, TILE.BLACK);
    p.box(0.11, 0.28, 0, 0.17, 0.56, 0.2, TILE.BLACK);
    p.box(0, 0.92, 0, 0.56, 0.72, 0.3, body);
    p.box(0, 1.5, 0, 0.44, 0.44, 0.44, TILE.WALL_CREAM);
    if (v % 3 === 0) p.box(0, 1.78, 0, 0.5, 0.14, 0.5, TILE.RED);
  },
  fence(p) {
    for (const fx of [-3.4, 0, 3.4]) p.box(fx, 0.5, 0, 0.15, 1.0, 0.15, TILE.WOOD);
    p.box(0, 0.82, 0, 7.2, 0.13, 0.06, TILE.WOOD);
    p.box(0, 0.45, 0, 7.2, 0.13, 0.06, TILE.WOOD);
  },
};

export function buildPropsGeometry(stage, THREE) {
  const builder = new BoxBuilder();
  const placer = new Placer(builder);
  for (const prop of stage.props) {
    const def = DEFS[prop.type];
    if (!def) continue;
    const gy = stage.groundHeight(prop.x, prop.z) - 0.14;
    placer.at(prop.x, gy, prop.z, prop.rot);
    // Apply scale by temporarily wrapping: defs are unit sized; scale via
    // a second builder pass is overkill — scale is baked by scaling box
    // calls through the placer origin trick below.
    const tint = 0.93 + (prop.variant % 3) * 0.045;
    const origBox = placer.box.bind(placer);
    placer.box = (cx, cy, cz, sx, sy, sz, tiles, opts = {}) =>
      origBox(cx * prop.scale, cy * prop.scale, cz * prop.scale,
        sx * prop.scale, sy * prop.scale, sz * prop.scale, tiles, { tint, ...opts });
    def(placer, prop.variant);
    placer.box = origBox;
  }
  return builder.build(THREE);
}
