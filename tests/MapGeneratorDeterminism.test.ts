import { describe, expect, it, vi } from "vitest";
import { generateMap } from "../src/core/game/generator/GenerateMap";
import {
  MapArchetype,
  type MapGenParams,
} from "../src/core/game/generator/MapGenTypes";

// These suites process whole maps -- millions of tiles each, and the parity
// cases run against the largest shipped binaries. That comfortably exceeds
// vitest's 5s default once the full suite is competing for CPU, so the budget
// is raised here rather than shrinking the data and testing less of it.
vi.setConfig({ testTimeout: 120_000 });

/**
 * Determinism is a correctness requirement here, not a nicety.
 *
 * A generated map is rendered from buffers held on the main thread and
 * simulated from buffers handed to the game worker. Those must describe the
 * same world. The design keeps them identical by generating once and copying,
 * but any hidden nondeterminism — module-level mutable state, iteration over
 * an unordered collection, a stray Math.random — would also break seed
 * sharing and make a reported seed useless for reproducing a map.
 */

function params(overrides: Partial<MapGenParams> = {}): MapGenParams {
  return {
    archetype: MapArchetype.Continents,
    seed: 987654,
    width: 400,
    height: 300,
    islandCount: 4,
    landCoverage: 0.4,
    mountainousness: 0.5,
    coastlineRoughness: 0.5,
    nationCount: 8,
    ...overrides,
  };
}

const ARCHETYPES = [
  MapArchetype.Continents,
  MapArchetype.Archipelago,
  MapArchetype.Pangaea,
  MapArchetype.InlandSea,
  MapArchetype.LakesRivers,
];

describe("map generation determinism", () => {
  it.each(ARCHETYPES)("is byte-identical across runs: %s", (archetype) => {
    const a = generateMap(params({ archetype }));
    const b = generateMap(params({ archetype }));

    expect(a.id).toBe(b.id);
    expect(Array.from(a.mapBin)).toEqual(Array.from(b.mapBin));
    expect(Array.from(a.map4xBin)).toEqual(Array.from(b.map4xBin));
    expect(Array.from(a.map16xBin)).toEqual(Array.from(b.map16xBin));
    expect(a.manifest).toEqual(b.manifest);
  });

  it("is unaffected by what was generated before it", () => {
    const direct = generateMap(params({ seed: 555 }));

    // Interleave other generations to flush out state held between calls.
    generateMap(params({ seed: 111, archetype: MapArchetype.Archipelago }));
    generateMap(params({ seed: 222, landCoverage: 0.7 }));
    const afterOthers = generateMap(params({ seed: 555 }));

    expect(Array.from(afterOthers.mapBin)).toEqual(Array.from(direct.mapBin));
  });

  it("produces a different map for a different seed", () => {
    const a = generateMap(params({ seed: 1 }));
    const b = generateMap(params({ seed: 2 }));
    expect(a.id).not.toBe(b.id);
    expect(Array.from(a.mapBin)).not.toEqual(Array.from(b.mapBin));
  });

  it("treats seeds as 32-bit, matching PseudoRandom", () => {
    // PseudoRandom truncates to 32 bits, so a caller passing a larger seed
    // must not be surprised by two "different" seeds giving one map.
    const a = generateMap(params({ seed: 7 }));
    const b = generateMap(params({ seed: 7 + 2 ** 32 }));
    expect(Array.from(a.mapBin)).toEqual(Array.from(b.mapBin));
  });

  it("names nations identically across runs", () => {
    const a = generateMap(params({ nationCount: 12 }));
    const b = generateMap(params({ nationCount: 12 }));
    expect(a.manifest.nations.map((n) => n.name)).toEqual(
      b.manifest.nations.map((n) => n.name),
    );
    expect(a.manifest.nations.map((n) => n.coordinates)).toEqual(
      b.manifest.nations.map((n) => n.coordinates),
    );
  });

  it("gives every nation a distinct name and position", () => {
    const bundle = generateMap(
      params({ nationCount: 24, width: 600, height: 452 }),
    );
    const names = new Set(bundle.manifest.nations.map((n) => n.name));
    const positions = new Set(
      bundle.manifest.nations.map((n) => n.coordinates!.join(",")),
    );
    expect(names.size).toBe(bundle.manifest.nations.length);
    expect(positions.size).toBe(bundle.manifest.nations.length);
  });
});
