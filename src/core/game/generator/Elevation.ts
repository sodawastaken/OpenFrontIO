/**
 * Assigns land elevations (magnitude 0-30) to a finished land mask.
 *
 * Two ideas do the work here. First, elevation is correlated with distance
 * from the coast, because that is what the shipped maps measurably do — mean
 * magnitude climbs from 4.7 at the shoreline to 9.8 twenty tiles inland. Pure
 * noise scatters mountains right up to the beach and looks wrong.
 *
 * Second, the final magnitudes are produced by *histogram matching* against
 * the real elevation distribution rather than by scaling noise into a range.
 * Rank every land tile by its raw score, then hand out magnitudes so the
 * output histogram equals the target. This gets the distribution exactly
 * right by construction, with no magic constants to tune, and lets the
 * mountainousness slider be expressed as a reshaping of the target histogram.
 */

import { exp as detExp } from "../../DetMath";
import { PseudoRandom } from "../../PseudoRandom";
import type { MapGenParams } from "./MapGenTypes";
import type { ArchetypeProfile } from "./MapStyleProfile";
import { domainWarp, fbm2, type FbmOptions } from "./Noise";
import { neighbors, TerrainGrid, TerrainType } from "./TerrainGrid";

const SEED_ELEVATION = 0x3f5a7c19;
/** Magnitudes 0-30; 31 is reserved for the impassable sentinel. */
const MAX_MAGNITUDE = 30;
/** Quantisation for the rank sort. Fine enough that ties are irrelevant. */
const RANK_BUCKETS = 4096;
/** How strongly distance-from-coast contributes, against local noise. */
const COAST_WEIGHT = 0.45;

/**
 * Distance in tiles from each land tile to the nearest coast, by BFS inward
 * from the shoreline. Water tiles are left at 0.
 */
export function landDistanceToCoast(grid: TerrainGrid): Int32Array {
  const { width, height, type, shoreline } = grid;
  const n = grid.length;
  const dist = new Int32Array(n);
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  const nb = new Int32Array(4);

  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (type[i] === TerrainType.Land && shoreline[i]) {
      visited[i] = 1;
      queue[tail++] = i;
    }
  }

  // An island with no coast cannot exist, but a map with no water can: seed
  // from the map border so the curve still has somewhere to start.
  if (tail === 0) {
    for (let i = 0; i < n; i++) {
      const x = i % width;
      const y = (i / width) | 0;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        if (type[i] === TerrainType.Land) {
          visited[i] = 1;
          queue[tail++] = i;
        }
      }
    }
  }

  while (head < tail) {
    const cur = queue[head++];
    const d = dist[cur] + 1;
    const count = neighbors(cur, width, height, nb);
    for (let k = 0; k < count; k++) {
      const next = nb[k];
      if (visited[next] || type[next] !== TerrainType.Land) continue;
      visited[next] = 1;
      dist[next] = d;
      queue[tail++] = next;
    }
  }

  return dist;
}

/**
 * Reshapes the measured elevation histogram by the mountainousness slider.
 *
 * At 0.5 the target is the real distribution unchanged. Away from that, an
 * exponential tilt moves mass toward the high or low end while keeping the
 * histogram's overall shape, rather than simply shifting or rescaling it —
 * which would flatten the characteristic spike of low-lying land at 0.
 */
export function buildTargetHistogram(
  profile: ArchetypeProfile,
  mountainousness: number,
): Float64Array {
  const source = profile.elevationHistogram;
  const target = new Float64Array(MAX_MAGNITUDE + 1);
  // Maps [0,1] to a tilt of about [-1.6, +1.6] around neutral at 0.5.
  const tilt = (mountainousness - 0.5) * 3.2;
  const mid = MAX_MAGNITUDE / 2;

  let total = 0;
  for (let m = 0; m <= MAX_MAGNITUDE; m++) {
    const base = source[m] ?? 0;
    // DetMath.exp, not Math.exp: engines differ in the last bit, and a
    // seed must reproduce the same map everywhere.
    const weight = detExp((tilt * (m - mid)) / mid);
    target[m] = base * weight;
    total += target[m];
  }

  if (total <= 0) {
    target.fill(1 / (MAX_MAGNITUDE + 1));
    return target;
  }
  for (let m = 0; m <= MAX_MAGNITUDE; m++) target[m] /= total;
  return target;
}

/**
 * Computes and writes land magnitudes into the grid.
 *
 * Water magnitudes are untouched; `processWater` owns those.
 */
export function assignElevation(
  grid: TerrainGrid,
  params: MapGenParams,
  profile: ArchetypeProfile,
  fbmOptions: FbmOptions,
): void {
  const { width, height, type, magnitude } = grid;
  const n = grid.length;
  const seed = (params.seed ^ SEED_ELEVATION) | 0;

  const dist = landDistanceToCoast(grid);
  const coastCurve = normalisedCoastCurve(profile);

  const invW = 1 / width;
  const invH = 1 / height;
  const aspect = width / height;
  // Finer than the land mask's noise: this is texture within a landmass, not
  // the shape of the landmass itself.
  const scale = 6.5;

  // Raw score per land tile, and a bucketed histogram of those scores so the
  // rank mapping below is a counting sort rather than a comparison sort.
  const raw = new Float32Array(n);
  const bucketCounts = new Int32Array(RANK_BUCKETS);
  let landCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (type[i] !== TerrainType.Land) continue;

      const nx = x * invW * scale * aspect;
      const ny = y * invH * scale;
      const w = domainWarp(nx, ny, seed, 0.4, fbmOptions);
      const noise = fbm2(w.x, w.y, seed, fbmOptions);

      const inland = coastCurve[Math.min(dist[i], coastCurve.length - 1)];
      const score = noise * (1 - COAST_WEIGHT) + inland * COAST_WEIGHT;

      raw[i] = score;
      const bucket = Math.min(
        RANK_BUCKETS - 1,
        Math.max(0, (score * RANK_BUCKETS) | 0),
      );
      bucketCounts[bucket]++;
      landCount++;
    }
  }

  if (landCount === 0) return;

  const target = buildTargetHistogram(profile, params.mountainousness);

  // Walk the score buckets from low to high, handing each one the next
  // magnitude whose cumulative share of land it falls into.
  const bucketMagnitude = new Uint8Array(RANK_BUCKETS);
  let cumulativeLand = 0;
  let mag = 0;
  let magCeiling = target[0] * landCount;

  for (let b = 0; b < RANK_BUCKETS; b++) {
    while (mag < MAX_MAGNITUDE && cumulativeLand >= magCeiling) {
      mag++;
      magCeiling += target[mag] * landCount;
    }
    bucketMagnitude[b] = mag;
    cumulativeLand += bucketCounts[b];
  }

  for (let i = 0; i < n; i++) {
    if (type[i] !== TerrainType.Land) continue;
    const bucket = Math.min(
      RANK_BUCKETS - 1,
      Math.max(0, (raw[i] * RANK_BUCKETS) | 0),
    );
    magnitude[i] = bucketMagnitude[bucket];
  }
}

/**
 * The measured elevation-by-coast-distance curve, rescaled to [0, 1].
 *
 * Only the curve's shape matters — the absolute magnitudes it came from are
 * re-imposed later by the histogram match — so normalising lets it act purely
 * as a spatial prior.
 */
function normalisedCoastCurve(profile: ArchetypeProfile): Float64Array {
  const src = profile.elevByCoastDist;
  const out = new Float64Array(src.length);
  let min = Infinity;
  let max = -Infinity;
  for (const v of src) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  for (let i = 0; i < src.length; i++) {
    out[i] = span > 0 ? (src[i] - min) / span : 0.5;
  }
  return out;
}

/**
 * Scatters impassable terrain across the highest ground.
 *
 * Kept out of `assignElevation` so it can be skipped entirely: impassable
 * tiles block movement permanently and a generated map peppered with them is
 * frustrating, so this is used sparingly and only well inland.
 */
export function addImpassablePeaks(
  grid: TerrainGrid,
  params: MapGenParams,
  fraction: number,
): void {
  if (fraction <= 0) return;
  const rand = new PseudoRandom((params.seed ^ 0x6d8f2e41) | 0);
  const { type, magnitude } = grid;
  const n = grid.length;

  for (let i = 0; i < n; i++) {
    if (type[i] !== TerrainType.Land) continue;
    if (magnitude[i] < MAX_MAGNITUDE - 2) continue;
    if (rand.next() >= fraction) continue;
    type[i] = TerrainType.Impassable;
  }
}
