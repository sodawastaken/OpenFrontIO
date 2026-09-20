/**
 * Deterministic 2D value noise for the map generator.
 *
 * Hand-rolled rather than pulled in as a dependency, for two reasons: the
 * project has no noise library, and the generated map must be bit-identical
 * on every machine. Every operation here is a 32-bit integer op or a plain
 * float multiply-add, so there is no engine-dependent behaviour to drift.
 *
 * Value noise (interpolating hashed lattice values) is used in preference to
 * simplex or Perlin. At the feature scales a map needs, and with the domain
 * warp below applied, the visual difference is negligible, and value noise
 * needs no permutation table to seed or shuffle.
 */

/**
 * Hashes an integer lattice point to a float in [0, 1).
 *
 * This is splitmix32's finaliser applied to a mixed coordinate pair. It has
 * to be avalanching in both x and y independently, otherwise the noise shows
 * visible axis-aligned banding.
 */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ seed) | 0;
  h = (h + 0x9e3779b9) | 0;
  let t = h ^ (h >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t = t ^ (t >>> 15);
  t = Math.imul(t, 0x735a2d97);
  t = (t ^ (t >>> 15)) >>> 0;
  return t / 4294967296;
}

/**
 * Quintic smoothstep, 6t^5 - 15t^4 + 10t^3.
 *
 * Its first and second derivatives vanish at 0 and 1, so lattice cell edges
 * leave no visible creases in the coastline. Cubic smoothstep is not enough:
 * its second derivative is discontinuous and shows up as faint grid lines
 * once the field is thresholded into land and water.
 */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Value noise in [0, 1) at a point in lattice space. */
export function valueNoise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);

  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x0 + 1, y0, seed);
  const v01 = hash2(x0, y0 + 1, seed);
  const v11 = hash2(x0 + 1, y0 + 1, seed);

  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

export interface FbmOptions {
  /** Number of summed octaves. 4-6 is the useful range. */
  octaves: number;
  /** Frequency multiplier per octave. ~2 gives classic fractal detail. */
  lacunarity: number;
  /** Amplitude multiplier per octave. <1; lower means smoother. */
  gain: number;
}

export const DEFAULT_FBM: FbmOptions = {
  octaves: 5,
  lacunarity: 2.03,
  gain: 0.5,
};

/**
 * Fractional Brownian motion: octaves of value noise summed at rising
 * frequency and falling amplitude. Returns a value normalised to [0, 1).
 *
 * The lacunarity default is 2.03 rather than exactly 2 so successive octaves'
 * lattices do not stay in phase, which would otherwise concentrate detail on
 * the same grid lines at every scale.
 */
export function fbm2(
  x: number,
  y: number,
  seed: number,
  opts: FbmOptions = DEFAULT_FBM,
): number {
  let sum = 0;
  let amplitude = 1;
  let totalAmplitude = 0;
  let frequency = 1;

  for (let o = 0; o < opts.octaves; o++) {
    // Offset each octave's seed so they are independent fields rather than
    // the same field sampled at different zooms.
    sum +=
      valueNoise2(x * frequency, y * frequency, (seed + o * 0x9e37) | 0) *
      amplitude;
    totalAmplitude += amplitude;
    amplitude *= opts.gain;
    frequency *= opts.lacunarity;
  }

  return totalAmplitude === 0 ? 0 : sum / totalAmplitude;
}

/** A point displaced by domain warping. */
export interface WarpedPoint {
  x: number;
  y: number;
}

/**
 * Displaces a sample point by a second noise field.
 *
 * This is what turns smooth blobby coastlines into the ragged, fjorded,
 * peninsula-bearing outlines that real maps have. `strength` is in lattice
 * units, so it scales with the same frequency as the field being warped.
 */
export function domainWarp(
  x: number,
  y: number,
  seed: number,
  strength: number,
  opts: FbmOptions = DEFAULT_FBM,
): WarpedPoint {
  if (strength === 0) return { x, y };
  const wx = fbm2(x, y, (seed ^ 0x5f356495) | 0, opts);
  const wy = fbm2(x, y, (seed ^ 0x1b873593) | 0, opts);
  return {
    x: x + (wx - 0.5) * 2 * strength,
    y: y + (wy - 0.5) * 2 * strength,
  };
}

/**
 * Ridged noise: `1 - |2n - 1|`, peaking along the zero-crossings of the
 * underlying field.
 *
 * Used to carve river channels, whose branching filaments are exactly the
 * ridge lines of a noise field.
 */
export function ridged2(
  x: number,
  y: number,
  seed: number,
  opts: FbmOptions = DEFAULT_FBM,
): number {
  return 1 - Math.abs(fbm2(x, y, seed, opts) * 2 - 1);
}
