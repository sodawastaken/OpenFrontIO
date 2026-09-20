import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  countLandTiles,
  createMiniMap,
  packTerrain,
  unpackTerrain,
} from "../src/core/game/generator/PackTerrain";
import {
  processWater,
  removeSmallIslands,
  setImpassableNeighborWaterDepth,
} from "../src/core/game/generator/TerrainPostProcess";

// These suites process whole maps -- millions of tiles each, and the parity
// cases run against the largest shipped binaries. That comfortably exceeds
// vitest's 5s default once the full suite is competing for CPU, so the budget
// is raised here rather than shrinking the data and testing less of it.
vi.setConfig({ testTimeout: 120_000 });

/**
 * Parity between the TypeScript terrain pipeline and the Go map-generator.
 *
 * The procedural generator reuses the post-processing stages that the offline
 * Go tool applies to every shipped map. Rather than check that port against a
 * reading of the Go source, this drives it with real data: decode a shipped
 * `map.bin`, re-run the pipeline over it, and require the bytes back out to be
 * identical. Any drift in shoreline detection, ocean selection, water-depth
 * BFS, downscaling or bit packing shows up here immediately.
 *
 * `RemoveSmall` is true for production maps (map-generator/main.go:125), so
 * small islands and lakes are already gone from the shipped bytes; re-running
 * those removals would be a no-op and is skipped.
 */

const ROOT = path.resolve(__dirname, "..");
const MAPS_DIR = path.join(ROOT, "resources", "maps");

/** A spread of shapes: one landmass, fragmented, dense, and impassable terrain. */
const SAMPLE_MAPS = [
  "australia", // 98.5% of land in one body, very smooth coast
  "europe", // many medium bodies, moderate coast
  "caribbean", // sparse land, and 214k impassable tiles
  "archipelagosea", // 1308 bodies, the roughest coastline shipped
];

interface Manifest {
  map: { width: number; height: number; num_land_tiles: number };
  map4x: { width: number; height: number; num_land_tiles: number };
}

function loadMap(name: string) {
  const dir = path.join(MAPS_DIR, name);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
  ) as Manifest;
  return {
    manifest,
    mapBin: new Uint8Array(fs.readFileSync(path.join(dir, "map.bin"))),
    map4xBin: new Uint8Array(fs.readFileSync(path.join(dir, "map4x.bin"))),
  };
}

/** Index of the first differing byte, or -1. Keeps failure output readable. */
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function describeDiff(
  actual: Uint8Array,
  expected: Uint8Array,
  width: number,
): string {
  const i = firstDiff(actual, expected);
  if (i === -1) return "identical";
  return (
    `first difference at index ${i} (x=${i % width}, y=${Math.floor(i / width)}): ` +
    `got 0b${actual[i].toString(2).padStart(8, "0")}, ` +
    `expected 0b${expected[i].toString(2).padStart(8, "0")}`
  );
}

describe.each(SAMPLE_MAPS)("terrain pipeline parity: %s", (name) => {
  const { manifest, mapBin, map4xBin } = loadMap(name);

  it("re-packs the shipped map.bin to identical bytes", () => {
    const { width, height } = manifest.map;
    expect(mapBin.length).toBe(width * height);

    const grid = unpackTerrain(mapBin, width, height);
    // Recomputes ocean flags, shorelines and the water-depth BFS from scratch.
    processWater(grid, false);
    setImpassableNeighborWaterDepth(grid);

    const packed = packTerrain(grid);
    expect(describeDiff(packed.data, mapBin, width)).toBe("identical");
    expect(packed.numLandTiles).toBe(manifest.map.num_land_tiles);
  });

  it("downscales the shipped map.bin to the shipped map4x.bin", () => {
    const { width, height } = manifest.map;
    const grid = unpackTerrain(mapBin, width, height);
    processWater(grid, false);
    setImpassableNeighborWaterDepth(grid);

    // Mirrors map_generator.go:175-178 — half the island threshold at 4x,
    // and no lake removal at reduced scales.
    const mini = createMiniMap(grid);
    removeSmallIslands(mini, 15);
    processWater(mini, false);
    setImpassableNeighborWaterDepth(mini);

    expect(mini.width).toBe(manifest.map4x.width);
    expect(mini.height).toBe(manifest.map4x.height);

    const packed = packTerrain(mini);
    expect(describeDiff(packed.data, map4xBin, mini.width)).toBe("identical");
    expect(packed.numLandTiles).toBe(manifest.map4x.num_land_tiles);
  });

  it("counts land tiles the way the manifest does", () => {
    expect(countLandTiles(mapBin)).toBe(manifest.map.num_land_tiles);
    expect(countLandTiles(map4xBin)).toBe(manifest.map4x.num_land_tiles);
  });
});
