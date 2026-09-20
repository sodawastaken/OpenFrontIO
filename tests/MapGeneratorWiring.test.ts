import { beforeEach, describe, expect, it, vi } from "vitest";
import { GameMapSize, GameMapType } from "../src/core/game/Game";
import type { GameMapLoader, MapData } from "../src/core/game/GameMapLoader";
import {
  CompositeGameMapLoader,
  generatedMaps,
  toPayload,
} from "../src/core/game/generator/GeneratedMapRegistry";
import { generateMap } from "../src/core/game/generator/GenerateMap";
import {
  MapArchetype,
  isGeneratedMapId,
  type MapGenParams,
} from "../src/core/game/generator/MapGenTypes";
import {
  evictGeneratedTerrainMaps,
  loadTerrainMap,
} from "../src/core/game/TerrainMapLoader";

// Generation is the slow part here; the assertions are about plumbing.
vi.setConfig({ testTimeout: 120_000 });

/**
 * End-to-end wiring for generated maps, from the registry through the loader
 * the game actually uses.
 *
 * This is the integration the design hinges on: a generated map has to be
 * indistinguishable from a shipped one to every consumer, without any of them
 * being taught about it. The pieces are individually simple, so the risk is
 * entirely in how they connect.
 */

function params(overrides: Partial<MapGenParams> = {}): MapGenParams {
  return {
    archetype: MapArchetype.Continents,
    seed: 31337,
    width: 400,
    height: 300,
    islandCount: 4,
    landCoverage: 0.4,
    mountainousness: 0.5,
    coastlineRoughness: 0.5,
    nationCount: 6,
    ...overrides,
  };
}

/** Stands in for the fetching loader, so a miss is loud rather than a network call. */
function throwingFallback(): GameMapLoader {
  return {
    getMapData(map: GameMapType): MapData {
      throw new Error(`fallback reached for ${map}`);
    },
  };
}

describe("generated map wiring", () => {
  beforeEach(() => {
    generatedMaps.clear();
    evictGeneratedTerrainMaps();
  });

  it("serves a registered generated map and delegates everything else", () => {
    const bundle = generateMap(params());
    generatedMaps.register(toPayload(bundle), "blob:fake");

    const fallback = throwingFallback();
    const loader = new CompositeGameMapLoader(fallback);

    expect(loader.getMapData(bundle.id).webpPath).toBe("blob:fake");
    expect(() => loader.getMapData(GameMapType.Australia)).toThrow(
      /fallback reached/,
    );
  });

  it("explains itself when a generated map was never registered", () => {
    const loader = new CompositeGameMapLoader(throwingFallback());
    expect(() =>
      loader.getMapData("Generated:deadbeef" as GameMapType),
    ).toThrow(/not registered/);
  });

  it("loads through the game's own terrain loader at normal size", async () => {
    const bundle = generateMap(params());
    generatedMaps.register(toPayload(bundle), "");
    const loader = new CompositeGameMapLoader(throwingFallback());

    const terrain = await loadTerrainMap(
      bundle.id,
      GameMapSize.Normal,
      loader,
      false,
    );

    expect(terrain.gameMap.width()).toBe(bundle.manifest.map.width);
    expect(terrain.gameMap.height()).toBe(bundle.manifest.map.height);
    expect(terrain.miniGameMap.width()).toBe(bundle.manifest.map4x.width);
    expect(terrain.nations.length).toBe(bundle.manifest.nations.length);
  });

  it("halves nation coordinates at compact size without corrupting the source", async () => {
    const bundle = generateMap(params());
    generatedMaps.register(toPayload(bundle), "");
    const loader = new CompositeGameMapLoader(throwingFallback());

    const compact = await loadTerrainMap(
      bundle.id,
      GameMapSize.Compact,
      loader,
      false,
    );
    expect(compact.gameMap.width()).toBe(bundle.manifest.map4x.width);

    const full = bundle.manifest.nations[0].coordinates!;
    expect(compact.nations[0].coordinates).toEqual([
      Math.floor(full[0] / 2),
      Math.floor(full[1] / 2),
    ]);

    // loadTerrainMap rewrites nation coordinates in place for compact maps.
    // The in-memory loader hands out a fresh copy of the manifest each call
    // to keep that from halving the stored one -- twice, if the same map is
    // then loaded at normal size.
    const normal = await loadTerrainMap(
      bundle.id,
      GameMapSize.Normal,
      loader,
      false,
    );
    expect(normal.nations[0].coordinates).toEqual(full);
  });

  it("keeps different generated maps apart in the terrain cache", async () => {
    const a = generateMap(params({ seed: 1 }));
    const b = generateMap(params({ seed: 2 }));
    expect(a.id).not.toBe(b.id);

    generatedMaps.register(toPayload(a), "");
    generatedMaps.register(toPayload(b), "");
    const loader = new CompositeGameMapLoader(throwingFallback());

    const loadedA = await loadTerrainMap(
      a.id,
      GameMapSize.Normal,
      loader,
      false,
    );
    const loadedB = await loadTerrainMap(
      b.id,
      GameMapSize.Normal,
      loader,
      false,
    );

    // A shared cache key would hand back the first map for both ids.
    expect(loadedA.gameMap.numLandTiles()).not.toBe(
      loadedB.gameMap.numLandTiles(),
    );
  });

  it("bounds how much terrain the registry pins", () => {
    const ids: string[] = [];
    for (let seed = 0; seed < 5; seed++) {
      const bundle = generateMap(params({ seed }));
      ids.push(bundle.id);
      generatedMaps.register(toPayload(bundle), "");
    }

    const retained = ids.filter((id) => generatedMaps.has(id));
    expect(retained.length).toBe(3);
    // The most recent survive; the oldest are dropped.
    expect(retained).toEqual(ids.slice(-3));
  });

  it("revokes a thumbnail URL when its map is evicted", () => {
    const revoked: string[] = [];
    for (let seed = 0; seed < 4; seed++) {
      const bundle = generateMap(params({ seed }));
      const url = `blob:thumb-${seed}`;
      generatedMaps.register(toPayload(bundle), url, () => revoked.push(url));
    }
    expect(revoked).toEqual(["blob:thumb-0"]);
  });

  it("hands the simulation worker the same bytes the renderer got", () => {
    const bundle = generateMap(params());
    generatedMaps.register(toPayload(bundle), "");

    const payload = generatedMaps.payload(bundle.id);
    expect(payload).toBeDefined();
    // Identity, not just equality: renderer and simulation must not be able
    // to diverge, and a copy here would hide it if they did.
    expect(payload!.mapBin).toBe(bundle.mapBin);
    expect(payload!.map4xBin).toBe(bundle.map4xBin);
    expect(payload!.manifest).toBe(bundle.manifest);
  });

  it("drops only generated entries when evicting terrain", async () => {
    const bundle = generateMap(params());
    generatedMaps.register(toPayload(bundle), "");
    const loader = new CompositeGameMapLoader(throwingFallback());
    await loadTerrainMap(bundle.id, GameMapSize.Normal, loader, false);

    evictGeneratedTerrainMaps();
    // Nothing to assert directly on a private cache, but the reload must
    // still succeed rather than serving a released entry.
    await expect(
      loadTerrainMap(bundle.id, GameMapSize.Normal, loader, false),
    ).resolves.toBeDefined();
  });

  it("recognises generated ids without matching real map names", () => {
    const bundle = generateMap(params());
    expect(isGeneratedMapId(bundle.id)).toBe(true);
    for (const real of Object.values(GameMapType)) {
      expect(isGeneratedMapId(real)).toBe(false);
    }
  });
});
