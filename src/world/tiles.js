// Tile ids for the texture atlas + surface physics table.
// The atlas is an 8x8 grid of tiles drawn on a canvas at boot
// (src/world/textures.js paints exactly this layout).

export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 8;

export const TILE = {
  GRASS: 0,
  GRASS_SIDE: 1,
  DIRT: 2,
  GRAVEL: 3,
  MUD: 4,
  ROCK: 5,
  SAND: 6,
  SAND_SIDE: 7,
  SNOW: 8,
  SNOW_SIDE: 9,
  TARMAC: 10,
  TARMAC_LINE: 11,
  SNOW_ROAD: 12,
  WOOD: 13,
  LEAF_PINE: 14,
  LEAF_ROUND: 15,
  BARK: 16,
  STONE: 17,
  HAY: 18,
  ROOF_RED: 19,
  ROOF_GREY: 20,
  WALL_CREAM: 21,
  GLASS: 22,
  WHITE: 23,
  RED: 24,
  BLUE: 25,
  YELLOW: 26,
  BLACK: 27,
  TYRE: 28,
  CACTUS: 29,
  CHEVRON_R: 30,
  CHEVRON_L: 31,
  BANNER: 32,
  ORANGE: 33,
  LEAF_AUTUMN: 34,
  METAL: 35,
  SNOW_TREE: 36,
};

// UV rect for a tile. Canvas row 0 is the TOP of the image; with the
// default CanvasTexture flipY, v=1 is the image top.
export function tileUV(tile) {
  const col = tile % ATLAS_COLS;
  const row = Math.floor(tile / ATLAS_COLS);
  const pad = 0.6 / 1024; // half-texel-ish inset avoids bleeding
  const u0 = col / ATLAS_COLS + pad;
  const u1 = (col + 1) / ATLAS_COLS - pad;
  const v1 = 1 - row / ATLAS_ROWS - pad;
  const v0 = 1 - (row + 1) / ATLAS_ROWS + pad;
  return [u0, v0, u1, v1];
}

// --- Physics surfaces (stored per terrain cell) ---------------------------

export const SURFACE = {
  TARMAC: 0,
  TARMAC_LINE: 1,
  GRAVEL: 2,
  DIRT: 3,
  GRASS: 4,
  MUD: 5,
  SAND: 6,
  SNOW: 7,
  PACKED_SNOW: 8,
  ROCK: 9,
};

// Lateral grip multiplier per surface.
export const SURFACE_GRIP = [1.0, 1.0, 0.8, 0.72, 0.6, 0.5, 0.52, 0.4, 0.62, 0.78];
// Extra rolling drag (1/s velocity damping) per surface.
export const SURFACE_DRAG = [0.12, 0.12, 0.3, 0.42, 0.65, 0.85, 0.95, 0.8, 0.4, 0.35];
// Dust/spray tint per surface for the particle system.
export const SURFACE_DUST = [
  0x8a8d90, 0x8a8d90, 0xa79a83, 0x8a6f4d, 0x6f9e4a, 0x6e5136,
  0xd9bd8a, 0xffffff, 0xeef2f5, 0x9a958c,
];

export const isRoadSurface = (s) =>
  s === SURFACE.TARMAC || s === SURFACE.TARMAC_LINE ||
  s === SURFACE.GRAVEL || s === SURFACE.DIRT || s === SURFACE.PACKED_SNOW;
