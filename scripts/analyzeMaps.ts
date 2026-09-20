/**
 * Derives a "style profile" from the shipped maps, for the procedural
 * generator to imitate.
 *
 * Every map under `resources/maps/` was hand-drawn by a human, so the shape of
 * its coastlines, the spread of its elevations and the balance of land to
 * water encode what an OpenFront map is supposed to feel like. Raw fBm noise
 * does not look like that. This script measures the real maps once, offline,
 * and writes the aggregate to `resources/mapStyleProfile.json`, which the
 * generator uses to set slider ranges, archetype defaults, and the target
 * elevation distribution it matches its output against.
 *
 * Run with `npm run analyze-maps`. Takes a few minutes: the coast-distance
 * pass is a BFS over every land tile of all 127 maps.
 */

import fs from "fs";
import path from "path";
import { GameMapType } from "../src/core/game/Maps.gen";
import { unpackTerrain } from "../src/core/game/generator/PackTerrain";
import { neighbors, TerrainType } from "../src/core/game/generator/TerrainGrid";

const ROOT = path.resolve(import.meta.dirname, "..");
const MAPS_DIR = path.join(ROOT, "resources", "maps");
const OUT_FILE = path.join(ROOT, "resources", "mapStyleProfile.json");

/** Land magnitudes run 0-30; bucket 31 is the impassable sentinel. */
const ELEVATION_BUCKETS = 31;
/** Coast-distance curve length. Beyond ~64 tiles inland, elevation plateaus. */
const COAST_DIST_BUCKETS = 65;
/** A land body counts as an "island" only above this share of total land. */
const SIGNIFICANT_BODY_SHARE = 0.01;

/**
 * The map families the shipped maps actually fall into.
 *
 * Deliberately three, not five. The generator also offers "inland sea" and
 * "lakes & rivers" modes, but those are *generation techniques* rather than
 * families present in the data: maps named for an inland sea (Black Sea,
 * Caspian Sea, Baikal) all measure near-zero enclosed water, because on those
 * maps the named sea is the largest water body and so is flagged as ocean.
 * Only three of 127 maps have meaningfully enclosed water. Clustering those
 * two modes out of one or two members would produce statistics with no
 * support behind them, so the generator derives their parameters from these
 * measured families instead. See `archetypeNotes` in the emitted profile.
 */
type Archetype = "continents" | "archipelago" | "pangaea";

interface MapStats {
  name: string;
  width: number;
  height: number;
  landFraction: number;
  /** Land components >= 1% of total land. See the note in classify(). */
  significantBodies: number;
  totalBodies: number;
  largestBodyShare: number;
  /** Shoreline land tiles over all land tiles: a perimeter-to-area proxy. */
  coastlineRoughness: number;
  /** Non-ocean water over all water: how much of the sea is enclosed. */
  enclosedWaterShare: number;
  impassableFraction: number;
  elevationHistogram: number[];
  elevByCoastDist: number[];
  nationCount: number;
}

interface Distribution {
  p10: number;
  p50: number;
  p90: number;
  mean: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi
    ? sorted[lo]
    : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p10: round(percentile(sorted, 0.1)),
    p50: round(percentile(sorted, 0.5)),
    p90: round(percentile(sorted, 0.9)),
    mean: round(values.reduce((a, c) => a + c, 0) / (values.length || 1)),
  };
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Normalises a histogram to sum 1, or returns zeros if it is empty. */
function normalise(counts: number[]): number[] {
  const total = counts.reduce((a, c) => a + c, 0);
  if (total === 0) return counts.map(() => 0);
  return counts.map((c) => round(c / total, 6));
}

function analyzeMap(name: string): MapStats | null {
  const dir = path.join(MAPS_DIR, name);
  const binPath = path.join(dir, "map.bin");
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(binPath) || !fs.existsSync(manifestPath)) return null;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const { width, height, num_land_tiles: numLand } = manifest.map;
  const bytes = new Uint8Array(fs.readFileSync(binPath));
  const grid = unpackTerrain(bytes, width, height);
  const n = grid.length;
  const { type, magnitude } = grid;

  let impassable = 0;
  let shorelineLand = 0;
  let water = 0;
  let ocean = 0;
  const elevationHistogram = new Array(ELEVATION_BUCKETS).fill(0);

  for (let i = 0; i < n; i++) {
    if (type[i] === TerrainType.Impassable) {
      impassable++;
      continue;
    }
    if (type[i] === TerrainType.Water) {
      water++;
      if (grid.ocean[i]) ocean++;
      continue;
    }
    if (grid.shoreline[i]) shorelineLand++;
    elevationHistogram[Math.min(magnitude[i] | 0, ELEVATION_BUCKETS - 1)]++;
  }

  const { bodies, largest } = landBodies(grid);
  const significant = bodies.filter(
    (s) => s >= numLand * SIGNIFICANT_BODY_SHARE,
  ).length;

  return {
    name,
    width,
    height,
    landFraction: round(numLand / n),
    significantBodies: significant,
    totalBodies: bodies.length,
    largestBodyShare: round(numLand === 0 ? 0 : largest / numLand),
    coastlineRoughness: round(numLand === 0 ? 0 : shorelineLand / numLand),
    enclosedWaterShare: round(water === 0 ? 0 : (water - ocean) / water),
    impassableFraction: round(impassable / n),
    elevationHistogram: normalise(elevationHistogram),
    elevByCoastDist: elevationByCoastDistance(grid),
    nationCount: manifest.nations?.length ?? 0,
  };
}

/** Sizes of every connected land component, plus the largest. */
function landBodies(grid: {
  width: number;
  height: number;
  length: number;
  type: Uint8Array;
}): { bodies: number[]; largest: number } {
  const { width, height, length, type } = grid;
  const visited = new Uint8Array(length);
  const queue = new Int32Array(length);
  const nb = new Int32Array(4);
  const bodies: number[] = [];
  let largest = 0;

  for (let i = 0; i < length; i++) {
    if (visited[i] || type[i] !== TerrainType.Land) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    visited[i] = 1;
    let size = 0;
    while (head < tail) {
      const cur = queue[head++];
      size++;
      const count = neighbors(cur, width, height, nb);
      for (let k = 0; k < count; k++) {
        const next = nb[k];
        if (visited[next] || type[next] !== TerrainType.Land) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }
    bodies.push(size);
    if (size > largest) largest = size;
  }

  return { bodies, largest };
}

/**
 * Mean land elevation as a function of distance inland from the coast.
 *
 * This is the curve that makes generated terrain read as real: on hand-drawn
 * maps mountains sit in the interior and coasts are low, whereas thresholded
 * noise scatters peaks right up to the shoreline.
 */
function elevationByCoastDistance(grid: {
  width: number;
  height: number;
  length: number;
  type: Uint8Array;
  shoreline: Uint8Array;
  magnitude: Float32Array;
}): number[] {
  const { width, height, length, type, shoreline, magnitude } = grid;
  const visited = new Uint8Array(length);
  const queue = new Int32Array(length);
  const dist = new Int32Array(length);
  const nb = new Int32Array(4);

  let head = 0;
  let tail = 0;
  for (let i = 0; i < length; i++) {
    if (type[i] === TerrainType.Land && shoreline[i]) {
      visited[i] = 1;
      dist[i] = 0;
      queue[tail++] = i;
    }
  }

  const sums = new Float64Array(COAST_DIST_BUCKETS);
  const counts = new Float64Array(COAST_DIST_BUCKETS);

  while (head < tail) {
    const cur = queue[head++];
    const bucket = Math.min(dist[cur], COAST_DIST_BUCKETS - 1);
    sums[bucket] += magnitude[cur];
    counts[bucket]++;

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

  const curve: number[] = [];
  for (let b = 0; b < COAST_DIST_BUCKETS; b++) {
    // Buckets with no tiles inherit the previous value so the curve stays
    // monotone in shape rather than dropping to zero on small maps.
    curve.push(
      counts[b] > 0 ? round(sums[b] / counts[b], 3) : (curve[b - 1] ?? 0),
    );
  }
  return curve;
}

/**
 * Assigns an archetype from the measured shape.
 *
 * Rule-based rather than clustered: the thresholds are visible in the diff and
 * a reviewer can check them against maps they know, which matters more here
 * than the tighter fit a k-means would give.
 */
function classify(s: MapStats): Archetype {
  // One dominant landmass, whatever the coastline does around it.
  if (s.largestBodyShare > 0.8) return "pangaea";
  // Genuinely fragmented: no landmass dominates *and* the land is split into
  // many pieces, or the coast is unusually ragged. Requiring both conditions
  // of the first clause keeps large multi-lobe maps (World, Yenisei) out of
  // archipelago, where a body-count test alone would wrongly put them.
  if (
    (s.largestBodyShare < 0.3 && s.significantBodies >= 8) ||
    s.coastlineRoughness > 0.1
  ) {
    return "archipelago";
  }
  return "continents";
}

function aggregate(group: MapStats[]) {
  const pooledElevation = new Array(ELEVATION_BUCKETS).fill(0);
  const coastSums = new Array(COAST_DIST_BUCKETS).fill(0);

  for (const s of group) {
    for (let i = 0; i < ELEVATION_BUCKETS; i++) {
      pooledElevation[i] += s.elevationHistogram[i];
    }
    for (let i = 0; i < COAST_DIST_BUCKETS; i++) {
      coastSums[i] += s.elevByCoastDist[i];
    }
  }

  return {
    mapCount: group.length,
    members: group.map((s) => s.name).sort(),
    landFraction: distribution(group.map((s) => s.landFraction)),
    significantBodies: distribution(group.map((s) => s.significantBodies)),
    largestBodyShare: distribution(group.map((s) => s.largestBodyShare)),
    coastlineRoughness: distribution(group.map((s) => s.coastlineRoughness)),
    enclosedWaterShare: distribution(group.map((s) => s.enclosedWaterShare)),
    nationCount: distribution(group.map((s) => s.nationCount)),
    elevationHistogram: normalise(pooledElevation),
    elevByCoastDist: coastSums.map((v) => round(v / (group.length || 1), 3)),
  };
}

function main(): void {
  const names = Object.keys(GameMapType)
    .map((k) => k.toLowerCase())
    .sort();
  const stats: MapStats[] = [];

  console.log(`Analyzing ${names.length} maps from ${MAPS_DIR}`);
  for (const name of names) {
    const s = analyzeMap(name);
    if (s === null) {
      console.warn(`  skipped ${name}: missing map.bin or manifest.json`);
      continue;
    }
    stats.push(s);
    process.stdout.write(".");
  }
  console.log(`\nAnalyzed ${stats.length} maps.\n`);

  const byArchetype = new Map<Archetype, MapStats[]>();
  for (const s of stats) {
    const a = classify(s);
    if (!byArchetype.has(a)) byArchetype.set(a, []);
    byArchetype.get(a)!.push(s);
  }

  // Print a table so the classification can be checked against known maps
  // before the profile is committed.
  console.log(
    "map".padEnd(20) +
      "archetype".padEnd(14) +
      "land".padEnd(8) +
      "bodies".padEnd(8) +
      "largest".padEnd(9) +
      "rough".padEnd(8) +
      "encl".padEnd(8) +
      "nations",
  );
  for (const s of [...stats].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(
      s.name.padEnd(20) +
        classify(s).padEnd(14) +
        s.landFraction.toFixed(3).padEnd(8) +
        String(s.significantBodies).padEnd(8) +
        s.largestBodyShare.toFixed(3).padEnd(9) +
        s.coastlineRoughness.toFixed(3).padEnd(8) +
        s.enclosedWaterShare.toFixed(3).padEnd(8) +
        String(s.nationCount),
    );
  }

  console.log("\nArchetype counts:");
  for (const [a, group] of byArchetype) {
    console.log(`  ${a.padEnd(14)} ${group.length}`);
  }

  const archetypes: Record<string, unknown> = {};
  for (const [a, group] of byArchetype) {
    archetypes[a] = aggregate(group);
  }

  const profile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    note:
      "Generated by scripts/analyzeMaps.ts from resources/maps/*/map.bin. " +
      "Do not edit by hand; run `npm run analyze-maps` to regenerate.",
    archetypeNotes:
      "Only three families are measured, because only three are present in " +
      "the data. The generator's 'inlandSea' and 'lakesRivers' modes are " +
      "generation techniques calibrated from 'pangaea' and 'continents' " +
      "respectively, not measured clusters: maps named for inland seas have " +
      "near-zero enclosed water (the sea is the largest water body, so it is " +
      "flagged as ocean), and only 3 of 127 maps have real enclosed water.",
    global: aggregate(stats),
    archetypes,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(profile, null, 2) + "\n");
  const kb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
  console.log(`\nWrote ${OUT_FILE} (${kb} KB)`);
}

main();
