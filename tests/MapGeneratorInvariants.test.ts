import { describe, expect, it, vi } from "vitest";
import { generateMap } from "../src/core/game/generator/GenerateMap";
import {
  MapArchetype,
  generatedMapId,
  isGeneratedMapId,
  type MapGenParams,
} from "../src/core/game/generator/MapGenTypes";
import { findLandComponents } from "../src/core/game/generator/Nations";
import {
  IMPASSABLE_BYTE,
  countLandTiles,
  unpackTerrain,
} from "../src/core/game/generator/PackTerrain";
import { TerrainType, neighbors } from "../src/core/game/generator/TerrainGrid";
import { genTerrainFromBin } from "../src/core/game/TerrainMapLoader";

// These suites process whole maps -- millions of tiles each, and the parity
// cases run against the largest shipped binaries. That comfortably exceeds
// vitest's 5s default once the full suite is competing for CPU, so the budget
// is raised here rather than shrinking the data and testing less of it.
vi.setConfig({ testTimeout: 120_000 });

/**
 * Structural guarantees the generated maps must meet for the game to load and
 * play them. These are the properties `map-generator` gives the shipped maps;
 * the parity suite proves the port reproduces them on real data, and this
 * suite proves the generator produces them from scratch.
 *
 * Small maps are used throughout: the invariants are scale-independent and a
 * 400x300 map exercises every code path in a fraction of the time.
 */

const ARCHETYPES = [
  MapArchetype.Continents,
  MapArchetype.Archipelago,
  MapArchetype.Pangaea,
  MapArchetype.InlandSea,
  MapArchetype.LakesRivers,
];

function params(overrides: Partial<MapGenParams> = {}): MapGenParams {
  return {
    archetype: MapArchetype.Continents,
    seed: 4242,
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

describe.each(ARCHETYPES)("generated map invariants: %s", (archetype) => {
  const bundle = generateMap(params({ archetype }));

  it("packs buffers the game's terrain loader accepts", async () => {
    const { map, map4x, map16x } = bundle.manifest;
    expect(bundle.mapBin.length).toBe(map.width * map.height);
    expect(bundle.map4xBin.length).toBe(map4x.width * map4x.height);
    expect(bundle.map16xBin.length).toBe(map16x.width * map16x.height);

    // The real decoder, not a reimplementation of it.
    await expect(genTerrainFromBin(map, bundle.mapBin)).resolves.toBeDefined();
    await expect(
      genTerrainFromBin(map4x, bundle.map4xBin),
    ).resolves.toBeDefined();
    await expect(
      genTerrainFromBin(map16x, bundle.map16xBin),
    ).resolves.toBeDefined();
  });

  it("halves dimensions cleanly at each scale", () => {
    const { map, map4x, map16x } = bundle.manifest;
    expect(map.width % 4).toBe(0);
    expect(map.height % 4).toBe(0);
    expect(map4x.width).toBe(map.width / 2);
    expect(map4x.height).toBe(map.height / 2);
    expect(map16x.width).toBe(map.width / 4);
    expect(map16x.height).toBe(map.height / 4);
  });

  it("reports land tile counts matching the bytes", () => {
    expect(countLandTiles(bundle.mapBin)).toBe(
      bundle.manifest.map.num_land_tiles,
    );
    expect(countLandTiles(bundle.map4xBin)).toBe(
      bundle.manifest.map4x.num_land_tiles,
    );
    expect(countLandTiles(bundle.map16xBin)).toBe(
      bundle.manifest.map16x.num_land_tiles,
    );
    expect(bundle.manifest.map.num_land_tiles).toBeGreaterThan(0);
  });

  it("never puts the impassable magnitude on ordinary land", () => {
    // `GameMap.isImpassable` is `isLand(ref) && magnitude === 31`, so a land
    // tile that reached magnitude 31 any other way would be silently
    // unplayable. Water is unaffected -- magnitude 31 there is just deep
    // ocean, and the shipped maps are full of it.
    for (const b of bundle.mapBin) {
      if (b === IMPASSABLE_BYTE) continue;
      const isLand = (b & 0x80) !== 0;
      if (!isLand) continue;
      expect(b & 0x1f).toBeLessThan(31);
    }
  });

  it("marks shoreline exactly on tiles bordering the opposite class", () => {
    const { width, height } = bundle.manifest.map;
    const grid = unpackTerrain(bundle.mapBin, width, height);
    const nb = new Int32Array(4);

    for (let i = 0; i < grid.length; i++) {
      if (grid.type[i] === TerrainType.Impassable) {
        expect(grid.shoreline[i]).toBe(0);
        continue;
      }
      const want =
        grid.type[i] === TerrainType.Land
          ? TerrainType.Water
          : TerrainType.Land;
      let borders = false;
      const count = neighbors(i, width, height, nb);
      for (let k = 0; k < count; k++) {
        if (grid.type[nb[k]] === want) {
          borders = true;
          break;
        }
      }
      expect(grid.shoreline[i] === 1).toBe(borders);
    }
  });

  it("flags exactly one connected ocean, the largest water body", () => {
    const { width, height } = bundle.manifest.map;
    const grid = unpackTerrain(bundle.mapBin, width, height);
    const n = grid.length;

    const visited = new Uint8Array(n);
    const queue = new Int32Array(n);
    const nb = new Int32Array(4);
    let largest = 0;
    let oceanComponents = 0;
    let oceanSize = 0;

    for (let i = 0; i < n; i++) {
      if (visited[i] || grid.type[i] !== TerrainType.Water) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = i;
      visited[i] = 1;
      let size = 0;
      let flagged = 0;
      while (head < tail) {
        const cur = queue[head++];
        size++;
        if (grid.ocean[cur]) flagged++;
        const count = neighbors(cur, width, height, nb);
        for (let k = 0; k < count; k++) {
          const next = nb[k];
          if (visited[next] || grid.type[next] !== TerrainType.Water) continue;
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
      if (size > largest) largest = size;
      if (flagged > 0) {
        // A water body is either wholly ocean or wholly not.
        expect(flagged).toBe(size);
        oceanComponents++;
        oceanSize = size;
      }
    }

    expect(oceanComponents).toBe(1);
    expect(oceanSize).toBe(largest);
  });

  it("leaves no islands or lakes below the minimum playable size", () => {
    const { width, height } = bundle.manifest.map;
    const grid = unpackTerrain(bundle.mapBin, width, height);
    const components = findLandComponents(grid);
    for (const size of components.sizes) {
      expect(size).toBeGreaterThanOrEqual(30);
    }
  });

  it("places every nation on a land tile", () => {
    const { width, height } = bundle.manifest.map;
    const grid = unpackTerrain(bundle.mapBin, width, height);

    expect(bundle.manifest.nations.length).toBeGreaterThan(0);
    for (const nation of bundle.manifest.nations) {
      const [x, y] = nation.coordinates!;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(height);
      expect(grid.type[y * width + x]).toBe(TerrainType.Land);
      expect(nation.name.length).toBeGreaterThan(0);
    }
  });
});

describe("generated map parameters", () => {
  it("hits the requested land coverage closely", () => {
    for (const coverage of [0.2, 0.35, 0.5, 0.65]) {
      const bundle = generateMap(params({ landCoverage: coverage }));
      expect(Math.abs(bundle.stats.landFraction - coverage)).toBeLessThan(0.02);
    }
  });

  it("increases land monotonically with the coverage slider", () => {
    const low = generateMap(params({ landCoverage: 0.2 }));
    const mid = generateMap(params({ landCoverage: 0.4 }));
    const high = generateMap(params({ landCoverage: 0.6 }));
    expect(low.stats.landFraction).toBeLessThan(mid.stats.landFraction);
    expect(mid.stats.landFraction).toBeLessThan(high.stats.landFraction);
  });

  it("produces one dominant landmass for the single-island archetypes", () => {
    for (const archetype of [MapArchetype.Pangaea, MapArchetype.InlandSea]) {
      const bundle = generateMap(params({ archetype, islandCount: 5 }));
      // normaliseParams forces these to one island whatever the slider says.
      expect(bundle.params.islandCount).toBe(1);

      // "One landmass" means one that dominates, not literally one component.
      // The measured profile puts real Pangaea maps at a median of two
      // significant bodies and a largest-body share above 0.8, so a single
      // outlying island alongside the mainland is faithful, not a defect.
      const grid = unpackTerrain(
        bundle.mapBin,
        bundle.manifest.map.width,
        bundle.manifest.map.height,
      );
      const components = findLandComponents(grid);
      const total = components.sizes.reduce((a, c) => a + c, 0);
      const largest = Math.max(...components.sizes);
      expect(largest / total).toBeGreaterThan(0.8);
    }
  });

  it("tracks the island count slider within tolerance", () => {
    for (const want of [3, 6, 12]) {
      const bundle = generateMap(
        params({
          archetype: MapArchetype.Archipelago,
          islandCount: want,
          width: 600,
          height: 452,
        }),
      );
      const drift = Math.abs(bundle.stats.islandCount - want) / want;
      expect(drift).toBeLessThanOrEqual(0.35);
    }
  });

  it("shifts elevation upward with the mountainousness slider", () => {
    const flat = generateMap(params({ mountainousness: 0.1 }));
    const alpine = generateMap(params({ mountainousness: 0.9 }));

    const meanMagnitude = (bin: Uint8Array): number => {
      let total = 0;
      let count = 0;
      for (const b of bin) {
        if (b === IMPASSABLE_BYTE || !(b & 0x80)) continue;
        total += b & 0x1f;
        count++;
      }
      return count === 0 ? 0 : total / count;
    };

    expect(meanMagnitude(alpine.mapBin)).toBeGreaterThan(
      meanMagnitude(flat.mapBin) + 3,
    );
  });

  it("clamps dimensions to multiples of four", () => {
    const bundle = generateMap(params({ width: 401, height: 303 }));
    expect(bundle.manifest.map.width).toBe(400);
    expect(bundle.manifest.map.height).toBe(300);
  });

  it("omits nations when none are requested", () => {
    const bundle = generateMap(params({ nationCount: 0 }));
    expect(bundle.manifest.nations).toEqual([]);
  });
});

describe("generated map ids", () => {
  it("is recognised as generated", () => {
    expect(isGeneratedMapId(generatedMapId(params()))).toBe(true);
  });

  it("is not confused with a real map name", () => {
    expect(isGeneratedMapId("Australia")).toBe(false);
    expect(isGeneratedMapId(undefined)).toBe(false);
  });

  it("differs whenever any parameter differs", () => {
    const base = params();
    const ids = new Set([
      generatedMapId(base),
      generatedMapId({ ...base, seed: base.seed + 1 }),
      generatedMapId({ ...base, islandCount: base.islandCount + 1 }),
      generatedMapId({ ...base, landCoverage: base.landCoverage + 0.01 }),
      generatedMapId({ ...base, archetype: MapArchetype.Pangaea }),
      generatedMapId({ ...base, width: base.width + 4 }),
    ]);
    expect(ids.size).toBe(6);
  });

  it("is stable for identical parameters", () => {
    expect(generatedMapId(params())).toBe(generatedMapId(params()));
  });
});
