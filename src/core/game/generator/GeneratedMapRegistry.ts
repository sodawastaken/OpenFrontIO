/**
 * Makes a generated map loadable through the same interface as a shipped one.
 *
 * Every consumer of map data — the renderer, the simulation, the map picker's
 * thumbnail, the nation-count readout — goes through `GameMapLoader`. Rather
 * than teach each of them about generated maps, a composite loader answers
 * for the synthetic ids out of memory and delegates everything else to the
 * normal fetching loader. The rest of the codebase does not need to know the
 * difference.
 */

import type { GameMapType } from "../Game";
import type { GameMapLoader, MapData } from "../GameMapLoader";
import type { MapManifest } from "../TerrainMapLoader";
import type { GeneratedMapBundle } from "./MapGenTypes";
import { isGeneratedMapId } from "./MapGenTypes";

/**
 * The part of a generated map that can cross a `postMessage` boundary.
 *
 * Deliberately excludes the thumbnail: it is only ever shown in the menu, and
 * the game worker would just be paying to copy it.
 */
export interface GeneratedMapPayload {
  id: string;
  manifest: MapManifest;
  mapBin: Uint8Array;
  map4xBin: Uint8Array;
  map16xBin: Uint8Array;
}

export function toPayload(bundle: GeneratedMapBundle): GeneratedMapPayload {
  return {
    id: bundle.id,
    manifest: bundle.manifest,
    mapBin: bundle.mapBin,
    map4xBin: bundle.map4xBin,
    map16xBin: bundle.map16xBin,
  };
}

/** Serves one already-generated map. */
export function inMemoryMapData(
  payload: GeneratedMapPayload,
  webpPath: string,
): MapData {
  return {
    mapBin: () => Promise.resolve(payload.mapBin),
    map4xBin: () => Promise.resolve(payload.map4xBin),
    map16xBin: () => Promise.resolve(payload.map16xBin),
    // Cloned per call: `loadTerrainMap` mutates nation coordinates in place
    // for compact maps, and the payload may be loaded again at normal size.
    manifest: () =>
      Promise.resolve(JSON.parse(JSON.stringify(payload.manifest))),
    webpPath,
    layerPng: () =>
      Promise.reject(new Error("Generated maps have no layers to load")),
  };
}

/**
 * Holds the generated maps this session can load.
 *
 * Bounded, because each entry pins several megabytes of terrain and the menu
 * can generate freely. Eviction is least-recently-registered; the map being
 * played is re-registered on use, so it cannot be evicted out from under a
 * running game.
 */
class GeneratedMapRegistry {
  private readonly entries = new Map<string, MapData>();
  private readonly payloads = new Map<string, GeneratedMapPayload>();
  private readonly revokers = new Map<string, () => void>();
  private readonly maxEntries: number;

  constructor(maxEntries = 3) {
    this.maxEntries = maxEntries;
  }

  register(
    payload: GeneratedMapPayload,
    webpPath: string,
    onEvict?: () => void,
  ): void {
    this.release(payload.id);
    this.entries.set(payload.id, inMemoryMapData(payload, webpPath));
    this.payloads.set(payload.id, payload);
    if (onEvict) this.revokers.set(payload.id, onEvict);

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.release(oldest.value);
    }
  }

  get(id: string): MapData | undefined {
    return this.entries.get(id);
  }

  /** The cloneable terrain for `id`, for sending to the simulation worker. */
  payload(id: string): GeneratedMapPayload | undefined {
    return this.payloads.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  release(id: string): void {
    this.revokers.get(id)?.();
    this.revokers.delete(id);
    this.entries.delete(id);
    this.payloads.delete(id);
  }

  clear(): void {
    for (const id of [...this.entries.keys()]) this.release(id);
  }
}

export const generatedMaps = new GeneratedMapRegistry();

/**
 * Answers for generated map ids from memory, and delegates the rest.
 *
 * Wrapping the existing loader rather than replacing it means every existing
 * call site keeps working unchanged, including the ones that pass a real
 * `GameMapType` through.
 */
export class CompositeGameMapLoader implements GameMapLoader {
  constructor(
    private readonly fallback: GameMapLoader,
    private readonly registry: GeneratedMapRegistry = generatedMaps,
  ) {}

  getMapData(map: GameMapType): MapData {
    if (isGeneratedMapId(map)) {
      const data = this.registry.get(map);
      if (data === undefined) {
        throw new Error(
          `Generated map ${map} is not registered. It was either never ` +
            `generated in this session or has been evicted from the cache.`,
        );
      }
      return data;
    }
    return this.fallback.getMapData(map);
  }
}

/**
 * The generated terrain for a map id, or undefined for a shipped map.
 *
 * Used when starting a game to decide whether the simulation worker needs the
 * terrain sent to it.
 */
export function generatedMapPayloadFor(
  map: GameMapType,
): GeneratedMapPayload | undefined {
  return isGeneratedMapId(map) ? generatedMaps.payload(map) : undefined;
}
