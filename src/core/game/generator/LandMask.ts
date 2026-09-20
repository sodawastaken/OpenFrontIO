/**
 * Builds the land/water mask: where the continents actually are.
 *
 * The naive approach — threshold a noise field — gives no control over how
 * many landmasses come out, which is the one thing the UI promises. So the
 * field here is built from explicit island centres with radial falloffs, and
 * noise is added on top to break up the outlines rather than to create them.
 * The threshold is then solved for numerically to hit the requested land
 * coverage, and the resulting island count is measured and corrected.
 */

import { PseudoRandom } from "../../PseudoRandom";
import { MapArchetype, type MapGenParams } from "./MapGenTypes";
import { domainWarp, fbm2, ridged2, type FbmOptions } from "./Noise";

/** Independent PRNG streams, so adding a stage cannot shift earlier output. */
const SEED_CENTRES = 0x1a2b3c4d;
const SEED_SHAPE = 0x5e6f7a8b;
const SEED_FIELD = 0x2c3d4e5f;
const SEED_RIVERS = 0x7a8b9c0d;

export interface IslandCentre {
  x: number;
  y: number;
  /** Radius in tiles along the island's major axis. */
  radius: number;
  /** Minor/major axis ratio. */
  aspect: number;
  /**
   * Orientation of the major axis, stored as its cosine and sine rather than
   * as an angle.
   *
   * `Math.sin`/`Math.cos` are only "implementation approximated" by the spec
   * and differ between engines in the last bit, which would make a seed
   * reproduce a different map on a different browser. Sampling a random unit
   * vector gives the same uniform orientation using only arithmetic and
   * `Math.sqrt`, which IEEE 754 requires to be correctly rounded.
   */
  cosRotation: number;
  sinRotation: number;
}

export interface LandFieldConfig {
  /**
   * How sharply nearby islands merge. 0 blends them into one continuous
   * landmass; 1 keeps them strictly separate. Continents sit in between,
   * which is what gives them lobed, irregular outlines.
   */
  mergeHardness: number;
  /** Weight of the noise term relative to the falloff term. */
  noiseAmplitude: number;
  /** Noise features per map width. Higher means finer detail. */
  featureScale: number;
  /** Domain warp strength, in the same units as featureScale. */
  warpStrength: number;
  /**
   * How far island outlines are displaced by noise, as a fraction of island
   * radius.
   *
   * This is what makes coastlines ragged, and it is deliberately separate
   * from `noiseAmplitude`. Adding noise to the field raises it everywhere,
   * including the channels between islands, so turning coastlines ragged
   * that way also fuses neighbours. Displacing the *shape* instead moves
   * land around without creating any, so islands stay separate however
   * ragged they get — which lets the layout search damp `noiseAmplitude` to
   * hit the island count without flattening every coast into a circle.
   */
  shapeWarp: number;
  /** Fraction of the half-diagonal over which land fades out at the edges. */
  borderFalloff: number;
  fbm: FbmOptions;
}

/**
 * A uniformly random orientation, as a unit vector.
 *
 * Rejection-samples the unit disc rather than taking the sine and cosine of a
 * random angle, so the generator stays free of engine-dependent trig. Points
 * outside the disc are rejected because keeping them would bias orientations
 * toward the square's diagonals.
 */
function randomOrientation(rand: PseudoRandom): {
  cosRotation: number;
  sinRotation: number;
} {
  for (let attempt = 0; attempt < 64; attempt++) {
    const ux = rand.next() * 2 - 1;
    const uy = rand.next() * 2 - 1;
    const lenSq = ux * ux + uy * uy;
    if (lenSq < 1e-6 || lenSq > 1) continue;
    const len = Math.sqrt(lenSq);
    return { cosRotation: ux / len, sinRotation: uy / len };
  }
  // Astronomically unlikely; fall back to axis-aligned rather than loop.
  return { cosRotation: 1, sinRotation: 0 };
}

/**
 * Places island centres with Mitchell's best-candidate sampling.
 *
 * Each new centre is the best of a batch of random candidates, judged by
 * distance to the centres already placed. That gives blue-noise spacing —
 * islands spread across the map rather than clumping — deterministically and
 * without the retry loop a Poisson-disk sampler needs when the requested
 * count does not fit the radius.
 */
export function placeIslandCentres(
  params: MapGenParams,
  count: number,
  radiusScale = 1,
): IslandCentre[] {
  const { width, height } = params;
  const rand = new PseudoRandom((params.seed ^ SEED_CENTRES) | 0);
  const shapeRand = new PseudoRandom((params.seed ^ SEED_SHAPE) | 0);

  // Inset so islands are not born half off the edge; the border falloff
  // would clip them into unnatural straight coastlines.
  const insetX = width * 0.12;
  const insetY = height * 0.12;
  const spanX = width - insetX * 2;
  const spanY = height - insetY * 2;

  const centres: IslandCentre[] = [];
  const CANDIDATES = 24;

  // A single landmass goes in the middle. Placed randomly it sits off to one
  // side, where the map edge clips it into a straight coastline -- and for
  // Inland Sea it also drags the carved sea off the landmass, leaving a bay
  // open to the ocean instead of an enclosed sea.
  if (count === 1) {
    centres.push({
      x: width / 2,
      y: height / 2,
      radius: 0,
      aspect: 0.8 + shapeRand.next() * 0.4,
      ...randomOrientation(shapeRand),
    });
    assignRadii(params, centres, shapeRand, radiusScale);
    return centres;
  }

  for (let i = 0; i < count; i++) {
    let bestX = 0;
    let bestY = 0;
    let bestScore = -1;

    for (let c = 0; c < CANDIDATES; c++) {
      const cx = insetX + rand.next() * spanX;
      const cy = insetY + rand.next() * spanY;
      if (centres.length === 0) {
        bestX = cx;
        bestY = cy;
        break;
      }
      let nearest = Infinity;
      for (const other of centres) {
        const dx = cx - other.x;
        const dy = cy - other.y;
        const d = dx * dx + dy * dy;
        if (d < nearest) nearest = d;
      }
      if (nearest > bestScore) {
        bestScore = nearest;
        bestX = cx;
        bestY = cy;
      }
    }

    centres.push({
      x: bestX,
      y: bestY,
      radius: 0, // assigned below, once the area split is known
      aspect: 0.6 + shapeRand.next() * 0.7,
      ...randomOrientation(shapeRand),
    });
  }

  relaxSpacing(centres, insetX, insetY, spanX, spanY);
  assignRadii(params, centres, shapeRand, radiusScale);
  return centres;
}

/**
 * Evens out island spacing by pushing close pairs apart.
 *
 * Best-candidate sampling alone leaves some pairs far closer than the mean,
 * and those pairs are exactly the ones that fuse into a single landmass —
 * which is how a fourteen-island request ends up producing four. Since any
 * radius large enough for the closest pair to stay separate is too small for
 * the rest to reach their area, the spacing has to be fixed rather than
 * worked around.
 *
 * This is a few rounds of pairwise repulsion rather than true Lloyd
 * relaxation: it needs no Voronoi construction, converges in a handful of
 * iterations at these point counts, and is deterministic.
 */
function relaxSpacing(
  centres: IslandCentre[],
  insetX: number,
  insetY: number,
  spanX: number,
  spanY: number,
): void {
  if (centres.length < 2) return;

  const target = Math.sqrt((spanX * spanY) / centres.length) * 1.05;
  const ITERATIONS = 24;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const dxs = new Float64Array(centres.length);
    const dys = new Float64Array(centres.length);

    for (let i = 0; i < centres.length; i++) {
      for (let j = i + 1; j < centres.length; j++) {
        let dx = centres[i].x - centres[j].x;
        let dy = centres[i].y - centres[j].y;
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d >= target) continue;
        // Coincident points have no defined direction; nudge along x so the
        // next iteration has something to work with.
        if (d < 1e-6) {
          dx = 1;
          dy = 0;
          d = 1;
        }
        const push = ((target - d) / d) * 0.5;
        dxs[i] += dx * push;
        dys[i] += dy * push;
        dxs[j] -= dx * push;
        dys[j] -= dy * push;
      }
    }

    for (let i = 0; i < centres.length; i++) {
      centres[i].x = Math.min(
        insetX + spanX,
        Math.max(insetX, centres[i].x + dxs[i] * 0.5),
      );
      centres[i].y = Math.min(
        insetY + spanY,
        Math.max(insetY, centres[i].y + dys[i] * 0.5),
      );
    }
  }
}

/**
 * Mean distance from each centre to its nearest neighbour.
 *
 * Used to cap island radii against the spacing actually available, which is
 * what decides whether islands come out separate or fused.
 */
function meanNearestNeighbour(centres: IslandCentre[]): number {
  if (centres.length < 2) return Infinity;
  let total = 0;
  for (let i = 0; i < centres.length; i++) {
    let nearest = Infinity;
    for (let j = 0; j < centres.length; j++) {
      if (i === j) continue;
      const dx = centres[i].x - centres[j].x;
      const dy = centres[i].y - centres[j].y;
      const d = dx * dx + dy * dy;
      if (d < nearest) nearest = d;
    }
    total += Math.sqrt(nearest);
  }
  return total / centres.length;
}

/**
 * Splits the land budget across the islands and converts each share into a
 * radius.
 *
 * Real archipelagos are not uniform: a few large islands carry most of the
 * land and the rest trail off. The weights below reproduce that skew, so an
 * 8-island map reads as a big island with satellites rather than eight
 * identical discs.
 */
function assignRadii(
  params: MapGenParams,
  centres: IslandCentre[],
  rand: PseudoRandom,
  radiusScale: number,
): void {
  const totalLand = params.width * params.height * params.landCoverage;

  const weights = centres.map(() => {
    // Skewed toward small values, with a long upper tail.
    const u = rand.next();
    return 0.25 + u * u * 2.5;
  });
  const weightSum = weights.reduce((a, c) => a + c, 0);

  for (let i = 0; i < centres.length; i++) {
    const area = (totalLand * weights[i]) / weightSum;
    // Overshoot the bare area-equivalent circle, because the falloff only
    // reaches full strength near the centre and the threshold cuts the
    // island well inside its nominal radius.
    centres[i].radius = Math.sqrt(area / Math.PI) * 2.0;
  }

  // Cap against the spacing that actually exists. Without this, a high
  // island count at high coverage asks for discs wider than the gaps between
  // their centres, and every island fuses with its neighbours no matter what
  // the merge hardness says. Capping trades exact per-island area — which
  // the threshold solve restores globally anyway — for the separation the
  // requested island count depends on.
  const spacing = meanNearestNeighbour(centres);
  const maxRadius = Number.isFinite(spacing) ? spacing * 0.62 : Infinity;

  // radiusScale is applied last, after the cap, so the layout search can
  // always move the radius. Folding it in before the cap would silently do
  // nothing whenever the cap was the binding constraint -- which is exactly
  // the crowded, high-island-count case the search most needs to fix.
  for (const c of centres) {
    c.radius = Math.min(c.radius, maxRadius) * radiusScale;
  }
}

/** Smootherstep, zero-slope at both ends, so islands have no visible rim. */
function smootherstep(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Evaluates the continuous land field over the whole map.
 *
 * Land is where this exceeds a threshold; the threshold itself is solved for
 * separately so that coverage can be hit exactly.
 */
export function buildLandField(
  params: MapGenParams,
  centres: IslandCentre[],
  config: LandFieldConfig,
): Float32Array {
  const { width, height } = params;
  const field = new Float32Array(width * height);
  const seed = (params.seed ^ SEED_FIELD) | 0;

  // Noise is sampled in map-relative units so the same parameters produce the
  // same shapes at preview resolution and at full resolution.
  const invW = 1 / width;
  const invH = 1 / height;
  const aspect = width / height;

  const cosR = centres.map((c) => c.cosRotation);
  const sinR = centres.map((c) => c.sinRotation);

  const halfW = width / 2;
  const halfH = height / 2;
  const borderScale = 1 / Math.max(config.borderFalloff, 1e-6);

  // Coastline displacement is scaled by the mean island radius so that the
  // raggedness reads the same on a small island as on a large one.
  const meanRadius =
    centres.length > 0
      ? centres.reduce((a, c) => a + c.radius, 0) / centres.length
      : 0;
  const shapeWarpTiles = meanRadius * config.shapeWarp;
  const shapeSeed = (seed ^ 0x3c6ef372) | 0;
  // Coarser than the terrain noise: this carves bays and peninsulas, not
  // tile-level fringe.
  const shapeScale = config.featureScale * 1.6;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;

      // Displace the point at which island shapes are sampled. Because this
      // moves land rather than adding it, the channels between islands stay
      // open no matter how strong it is.
      let sx = x;
      let sy = y;
      if (shapeWarpTiles > 0) {
        const wx = x * invW * shapeScale * aspect;
        const wy = y * invH * shapeScale;
        sx =
          x + (fbm2(wx, wy, shapeSeed, config.fbm) - 0.5) * 2 * shapeWarpTiles;
        sy =
          y +
          (fbm2(wx, wy, (shapeSeed ^ 0x51ed270b) | 0, config.fbm) - 0.5) *
            2 *
            shapeWarpTiles;
      }

      let blended = 0;
      if (config.mergeHardness >= 0.999) {
        // Strict max: islands never merge, however close they are.
        for (let c = 0; c < centres.length; c++) {
          const v = islandFalloff(sx, sy, centres[c], cosR[c], sinR[c]);
          if (v > blended) blended = v;
        }
      } else {
        // Soft accumulation: overlapping falloffs add up and cross the
        // threshold in the gap between them, fusing into one landmass.
        let sum = 0;
        let max = 0;
        for (let c = 0; c < centres.length; c++) {
          const v = islandFalloff(sx, sy, centres[c], cosR[c], sinR[c]);
          sum += v;
          if (v > max) max = v;
        }
        blended = max + (sum - max) * (1 - config.mergeHardness);
      }

      const nx = x * invW * config.featureScale * aspect;
      const ny = y * invH * config.featureScale;
      const w = domainWarp(nx, ny, seed, config.warpStrength, config.fbm);
      const noise = fbm2(w.x, w.y, seed, config.fbm) - 0.5;

      // Fade toward the edges so maps are framed by open water, the way
      // every hand-drawn map in the set is.
      const dx = Math.abs(x - halfW) / halfW;
      const dy = Math.abs(y - halfH) / halfH;
      const edge = Math.max(dx, dy);
      const border = smootherstep((1 - edge) * borderScale);

      field[i] = (blended + noise * config.noiseAmplitude) * border;
    }
  }

  return field;
}

/** Elliptical radial falloff for one island. */
function islandFalloff(
  x: number,
  y: number,
  c: IslandCentre,
  cosR: number,
  sinR: number,
): number {
  const dx = x - c.x;
  const dy = y - c.y;
  // Rotate into the island's frame, then squash the minor axis.
  const rx = dx * cosR + dy * sinR;
  const ry = (-dx * sinR + dy * cosR) / c.aspect;
  const d = Math.sqrt(rx * rx + ry * ry) / c.radius;
  return smootherstep(1 - d);
}

/**
 * Subtracts a sea from the middle of the landmass.
 *
 * Used by the Inland Sea archetype. The result is water fully enclosed by
 * land, which `processWater` will correctly leave unflagged as ocean — so
 * boats can cross it but it is not open sea.
 */
export function carveInlandSea(
  params: MapGenParams,
  field: Float32Array,
  config: LandFieldConfig,
): void {
  const { width, height } = params;
  const cx = width / 2;
  const cy = height / 2;
  // Large enough to read as a sea rather than a lake, small enough to leave a
  // continuous ring of land around it.
  const radius = Math.min(width, height) * 0.26;
  const seed = (params.seed ^ SEED_RIVERS) | 0;
  const invW = 1 / width;
  const invH = 1 / height;
  const aspect = width / height;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const dx = (x - cx) / radius;
      const dy = (y - cy) / radius;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= 1.25) continue;

      // Perturb the shoreline of the sea so it is not a circle.
      const nx = x * invW * config.featureScale * aspect;
      const ny = y * invH * config.featureScale;
      const wobble = (fbm2(nx, ny, seed, config.fbm) - 0.5) * 0.35;
      field[i] -= smootherstep(1 - (d + wobble)) * 1.6;
    }
  }
}

/**
 * Carves branching water channels through the land.
 *
 * Rivers follow the ridge lines of a noise field, which is where ridged noise
 * peaks. The channel is widened deliberately: anything under about two tiles
 * at full scale vanishes in the 2x minimap downscale, and the pathfinder runs
 * on the minimap, so a river the player can see but boats cannot use would be
 * worse than no river at all.
 */
export function carveRivers(
  params: MapGenParams,
  field: Float32Array,
  config: LandFieldConfig,
  strength: number,
  riverCoverage = 0.05,
): void {
  const { width, height } = params;
  const seed = (params.seed ^ SEED_RIVERS) | 0;
  const invW = 1 / width;
  const invH = 1 / height;
  const aspect = width / height;
  // Coarser than the terrain noise, and with few octaves, so ridges form
  // long coherent lines instead of a fractal spray of short segments.
  const scale = config.featureScale * 0.45;
  const riverFbm = { octaves: 2, lacunarity: 2.03, gain: 0.5 };

  const ridge = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = x * invW * scale * aspect;
      const ny = y * invH * scale;
      ridge[y * width + x] = ridged2(nx, ny, seed, riverFbm);
    }
  }

  // Pick the cutoff by quantile rather than by a fixed ridge value. Ridged
  // noise piles up near its maximum, so a hand-picked constant selects a
  // broad swathe of the map instead of a channel -- and the land-coverage
  // solve then cancels it out, which is why a fixed cutoff produced maps
  // with no visible rivers at all. Solving for the area keeps channels
  // channel-width whatever the noise happens to do.
  const cutoff = quantile(ridge, 1 - riverCoverage);
  const span = Math.max(1e-6, 1 - cutoff);

  for (let i = 0; i < ridge.length; i++) {
    if (ridge[i] <= cutoff) continue;
    field[i] -= ((ridge[i] - cutoff) / span) * strength;
  }
}

/**
 * Value below which the given fraction of the array falls.
 *
 * Bisects on value rather than sorting: the arrays here run to millions of
 * entries, and only about twenty counting passes are needed.
 */
function quantile(values: Float32Array, fraction: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < lo) lo = values[i];
    if (values[i] > hi) hi = values[i];
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;

  const target = values.length * fraction;
  let mid = lo;
  for (let iter = 0; iter < 20; iter++) {
    mid = (lo + hi) / 2;
    let below = 0;
    for (let i = 0; i < values.length; i++) {
      if (values[i] <= mid) below++;
    }
    if (below < target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return mid;
}

/**
 * Finds the threshold at which the field yields the requested land coverage.
 *
 * Land count is monotone decreasing in the threshold, so a bisection always
 * converges. Twenty iterations over a cheap counting pass is far more
 * reliable than trying to predict the right cutoff analytically, which the
 * noise term makes impossible anyway.
 */
export function solveThreshold(
  field: Float32Array,
  targetLandTiles: number,
): number {
  let lo = -Infinity;
  let hi = -Infinity;
  for (let i = 0; i < field.length; i++) {
    if (field[i] > hi) hi = field[i];
    if (lo === -Infinity || field[i] < lo) lo = field[i];
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;

  let best = lo;
  for (let iter = 0; iter < 20; iter++) {
    const mid = (lo + hi) / 2;
    let count = 0;
    for (let i = 0; i < field.length; i++) {
      if (field[i] > mid) count++;
    }
    best = mid;
    if (count > targetLandTiles) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

/** Per-archetype field configuration, before the sliders modulate it. */
export function baseFieldConfig(
  archetype: MapArchetype,
  roughness: number,
): LandFieldConfig {
  const fbm = { octaves: 5, lacunarity: 2.03, gain: 0.5 };
  // Coastline displacement carries the roughness slider, because unlike
  // noise amplitude it cannot fuse neighbouring islands.
  const shapeWarp = 0.1 + roughness * 0.45;
  // Roughness drives both how far the domain warp displaces samples and how
  // much of the field the noise term contributes; raising only one of the two
  // gives either wobbly-but-smooth or jagged-but-round coastlines.
  const warpStrength = 0.15 + roughness * 0.85;

  switch (archetype) {
    case MapArchetype.Pangaea:
      return {
        mergeHardness: 0,
        noiseAmplitude: 0.18 + roughness * 0.22,
        featureScale: 3.2,
        warpStrength: warpStrength * 0.7,
        shapeWarp,
        borderFalloff: 0.32,
        fbm,
      };
    case MapArchetype.Archipelago:
      return {
        mergeHardness: 1,
        noiseAmplitude: 0.3 + roughness * 0.45,
        featureScale: 7.5,
        warpStrength,
        shapeWarp,
        borderFalloff: 0.2,
        fbm,
      };
    case MapArchetype.InlandSea:
      return {
        mergeHardness: 0,
        noiseAmplitude: 0.16 + roughness * 0.2,
        featureScale: 3.0,
        warpStrength: warpStrength * 0.7,
        shapeWarp,
        borderFalloff: 0.3,
        fbm,
      };
    case MapArchetype.LakesRivers:
      return {
        mergeHardness: 0.15,
        noiseAmplitude: 0.2 + roughness * 0.25,
        featureScale: 4.0,
        warpStrength: warpStrength * 0.8,
        shapeWarp,
        borderFalloff: 0.28,
        fbm,
      };
    case MapArchetype.Continents:
    default:
      return {
        mergeHardness: 0.35,
        noiseAmplitude: 0.26 + roughness * 0.34,
        featureScale: 5.0,
        warpStrength,
        shapeWarp,
        borderFalloff: 0.24,
        fbm,
      };
  }
}
