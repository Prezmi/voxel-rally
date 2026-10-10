// Terrain generator (docs/03 §2). Analytic height field + per-chunk fill.
// The height field is analytic so the road profile (road-spline) can be decided
// before any chunk exists, and so physics can pre-query terrain anywhere.
import { makeStreams } from '../core/rng.js';
import { fbm2, ridge2, warp2, smoothstep, noise3, hash01, voronoi2 } from './noise.js';
import { BLOCK } from './palette.js';
import { SURF } from './surfaces.js';
import { CHUNK, WORLD_HEIGHT } from './chunk.js';

export const BIOMES = ['FOREST', 'MOUNTAIN', 'SWAMP', 'PLATEAU', 'CANYON'];

export const BIOME_INFO = {
  FOREST: { trees: 0.9, species: ['oak', 'pine', 'dead'], road: [SURF.GRAVEL, SURF.DIRT, SURF.MUD], sky: 0x8fb4cc, fog: 0x9db4c4 },
  MOUNTAIN: { trees: 0.25, species: ['pine', 'dead'], road: [SURF.GRAVEL, SURF.STONE, SURF.SNOW], sky: 0xa9c6dd, fog: 0xbcd0de },
  SWAMP: { trees: 0.55, species: ['dead', 'oak'], road: [SURF.MUD, SURF.PEAT, SURF.GRAVEL], sky: 0x8a9a92, fog: 0x93a49b },
  PLATEAU: { trees: 0.15, species: ['oak', 'dead'], road: [SURF.ASPHALT, SURF.GRAVEL, SURF.SAND], sky: 0x9fc0d8, fog: 0xb2cbd9 },
  CANYON: { trees: 0.2, species: ['dead', 'pine'], road: [SURF.STONE, SURF.GRAVEL, SURF.MUD], sky: 0xc0b39c, fog: 0xc9bda6 },
};

/**
 * Create a terrain field for a stage seed. Returns analytic queries plus the
 * per-chunk generator. All randomness comes from `streams.world` / hashed noise,
 * never Math.random (procedural-gen skill: own your randomness).
 */
export function makeTerrain(seed, biome = 'FOREST') {
  const streams = makeStreams(seed);
  const info = BIOME_INFO[biome] || BIOME_INFO.FOREST;
  const S = seed >>> 0;

  /** docs/03 §2 height formula, in metres. */
  function heightAt(x, z) {
    const [wx, wz] = warp2(x, z, S, 12);
    const base = fbm2(wx, wz, { octaves: 4, lacunarity: 2.0, gain: 0.5, seed: S, freq: 1 / 220 });
    const warpScalar = fbm2(wx * 0.6 + 411, wz * 0.6 - 233, { octaves: 2, lacunarity: 2.0, gain: 0.5, seed: S + 7717, freq: 1 / 380 });
    const ridge = ridge2(wx, wz, { octaves: 4, lacunarity: 2.0, gain: 0.5, seed: S + 10427, freq: 1 / 300 });
    const mountainMix = smoothstep(0.45, 0.85, warpScalar) * ridge;
    let h = 12 + 26 * base + 48 * mountainMix;
    // Flatten a valley corridor so stages have room to breathe.
    h = 12 + (h - 12) * (0.55 + 0.45 * smoothstep(0, 22, h - 12));
    return h;
  }

  /** Decorrelated moisture field (procedural-gen pitfall: correlated fields band the biomes). */
  function moistureAt(x, z) {
    return fbm2(x + 9120, z - 4409, { octaves: 3, lacunarity: 2.1, gain: 0.55, seed: S + 33071, freq: 1 / 260 });
  }

  /** Slope estimate (metres per metre). */
  function slopeAt(x, z) {
    const d = 2.0;
    const hx = heightAt(x + d, z) - heightAt(x - d, z);
    const hz = heightAt(x, z + d) - heightAt(x, z - d);
    return Math.hypot(hx, hz) / (2 * d);
  }

  function blockAt(x, z, h, slope) {
    const m = moistureAt(x, z);
    // Rock only breaks out where the ground is actually steep. The old field was a
    // ~14 m value-noise with no slope term, so grey stone slabs littered the flat
    // forest floor as pale near-white plates (review frame shots/pregen-check.png,
    // FAULT 2). Under a forest canopy the floor is leaf litter and earth, not rock.
    const rocky = slope > 0.45 && noise3(x * 0.07, 3.3, z * 0.07, S + 555) > 0.62;
    switch (biome) {
      case 'MOUNTAIN':
        if (h > 58) return BLOCK.SNOW;
        if (h > 49) return m > 0.62 ? BLOCK.ICE : BLOCK.STONE;
        if (slope > 0.62) return BLOCK.STONE;
        return hash01(x, z, S + 91) < 0.35 ? BLOCK.STONE : BLOCK.GRASS;
      case 'SWAMP':
        if (h < 24) return m > 0.52 ? BLOCK.MUD : BLOCK.PEAT;
        if (slope > 0.5) return BLOCK.DIRT;
        return hash01(x, z, S + 137) < 0.3 ? BLOCK.GRAVEL : BLOCK.GRASS;
      case 'PLATEAU':
        if (slope > 0.5) return BLOCK.STONE;
        if (m < 0.36) return BLOCK.SAND;
        return voronoi2(x * 0.08, z * 0.08, S + 211, 1) < 0.18 ? BLOCK.GRAVEL : BLOCK.GRASS;
      case 'CANYON':
        if (h < 26) return BLOCK.MUD;
        if (slope > 0.42) return BLOCK.STONE;
        return hash01(x, z, S + 179) < 0.55 ? BLOCK.STONE : BLOCK.DIRT;
      case 'FOREST':
      default:
        if (h < 18) return m > 0.6 ? BLOCK.MUD : BLOCK.DIRT;
        if (slope > 0.58) return BLOCK.DIRT;
        // Forest floor: one grass base tone with small patches of dark disturbed earth
        // (fallen branches / leaf litter reads). The old 12 % pale GRAVEL scatter is
        // what read as snow/litter between the trees.
        return voronoi2(x * 0.07, z * 0.07, S + 307, 1) < 0.06 ? BLOCK.DIRT : BLOCK.GRASS;
    }
  }

  /** Fill one chunk of the VoxelWorld with this terrain. */
  function generateChunk(world, cx, cz) {
    const chunk = world.ensureChunk(cx, cz);
    if (chunk.generated) return chunk;
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const wx = x0 + lx, wz = z0 + lz;
        const h = heightAt(wx + 0.5, wz + 0.5);
        const top = Math.max(0, Math.min(WORLD_HEIGHT - 1, Math.floor(h)));
        const slope = slopeAt(wx + 0.5, wz + 0.5);
        const surf = blockAt(wx, wz, h, slope);
        const col = lz * CHUNK + lx;
        const base = col * WORLD_HEIGHT;
        const rockDepth = top - 4;
        for (let y = 0; y <= top; y++) {
          chunk.blocks[base + y] = (y < rockDepth) ? BLOCK.STONE : (y === top ? surf : BLOCK.DIRT);
        }
        for (let y = top + 1; y < WORLD_HEIGHT; y++) chunk.blocks[base + y] = BLOCK.AIR;
        chunk.height[col] = top;
        chunk.surface[col] = 0; // resolved by refreshColumn
      }
    }
    chunk.refreshAll();
    chunk.generated = true;
    chunk.dirty = true;
    return chunk;
  }

  return { seed: S, biome, info, streams, heightAt, moistureAt, slopeAt, blockAt, generateChunk };
}
