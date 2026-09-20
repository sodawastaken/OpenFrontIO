/**
 * Parameter and result types for the procedural map generator, plus the
 * synthetic map ids generated maps are addressed by.
 */

import type { GameMapType } from "../Game";
import type { MapManifest } from "../TerrainMapLoader";

/**
 * The generator's map shapes.
 *
 * `Continents`, `Archipelago` and `Pangaea` correspond to families actually
 * measured in the shipped maps (see `resources/mapStyleProfile.json`).
 * `InlandSea` and `LakesRivers` are generation techniques layered on top of
 * the measured families — the data has no cluster for them, because on maps
 * named for an inland sea the sea is the largest water body and so reads as
 * ocean. They are calibrated from `pangaea` and `continents` respectively.
 */
export enum MapArchetype {
  Continents = "continents",
  Archipelago = "archipelago",
  Pangaea = "pangaea",
  InlandSea = "inlandSea",
  LakesRivers = "lakesRivers",
}

/** Which measured family supplies an archetype's baseline statistics. */
export const ARCHETYPE_BASIS: Record<
  MapArchetype,
  "continents" | "archipelago" | "pangaea"
> = {
  [MapArchetype.Continents]: "continents",
  [MapArchetype.Archipelago]: "archipelago",
  [MapArchetype.Pangaea]: "pangaea",
  [MapArchetype.InlandSea]: "pangaea",
  [MapArchetype.LakesRivers]: "continents",
};

export interface MapSizePreset {
  id: "small" | "medium" | "large";
  width: number;
  height: number;
}

/**
 * Selectable map sizes. All dimensions are multiples of 4, because the format
 * needs two successive halvings for `map4x` and `map16x`.
 */
export const MAP_SIZES: readonly MapSizePreset[] = [
  { id: "small", width: 1000, height: 752 },
  { id: "medium", width: 1500, height: 1128 },
  { id: "large", width: 2000, height: 1500 },
] as const;

export interface MapGenParams {
  archetype: MapArchetype;
  /** 32-bit seed. The same seed and params always give the same map. */
  seed: number;
  width: number;
  height: number;
  /** Target number of significant landmasses (components >= 1% of land). */
  islandCount: number;
  /** Target share of the map that is land, 0-1. */
  landCoverage: number;
  /** 0-1. Shifts the elevation distribution toward mountains. */
  mountainousness: number;
  /** 0-1. Domain-warp strength; how ragged coastlines are. */
  coastlineRoughness: number;
  /** How many nation spawn points to place. */
  nationCount: number;
}

/** What the generator achieved, as against what was asked for. */
export interface MapGenStats {
  landFraction: number;
  islandCount: number;
  totalLandTiles: number;
  generationMs: number;
}

export interface GeneratedMapBundle {
  id: GameMapType;
  params: MapGenParams;
  manifest: MapManifest;
  mapBin: Uint8Array;
  map4xBin: Uint8Array;
  map16xBin: Uint8Array;
  /** RGBA pixels for the preview thumbnail, at map16x dimensions. */
  thumbnail: {
    data: Uint8ClampedArray<ArrayBuffer>;
    width: number;
    height: number;
  };
  stats: MapGenStats;
}

export type MapGenPhase =
  | "layout"
  | "landmask"
  | "elevation"
  | "postprocess"
  | "minimaps"
  | "nations"
  | "packing";

export interface MapGenProgress {
  phase: MapGenPhase;
  /** Overall completion, 0-1. */
  fraction: number;
}

/**
 * Prefix marking a synthetic map id.
 *
 * Generated maps are not in `GameMapType` — that enum is generated from
 * `map-generator/assets/maps/*` and must not be hand-edited. Instead the id
 * carries a hash of the parameters that produced it, which keeps two
 * different generated maps from colliding in `TerrainMapLoader`'s cache while
 * letting an identical regeneration reuse it.
 */
export const GENERATED_MAP_PREFIX = "Generated:";

export function isGeneratedMapId(map: string | undefined): boolean {
  return map !== undefined && map.startsWith(GENERATED_MAP_PREFIX);
}

/**
 * A stable 32-bit hash of the parameters, as eight hex digits.
 *
 * FNV-1a over the canonical parameter string. Collisions only cost a wrongly
 * reused cache entry between two different maps, and at eight hex digits over
 * the handful of maps one session generates that is not a practical concern.
 */
function hashParams(params: MapGenParams): string {
  const canonical = [
    params.archetype,
    params.seed,
    params.width,
    params.height,
    params.islandCount,
    params.landCoverage.toFixed(4),
    params.mountainousness.toFixed(4),
    params.coastlineRoughness.toFixed(4),
    params.nationCount,
  ].join("|");

  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The map id for a set of parameters.
 *
 * The cast is the one place the codebase treats a non-enum string as a
 * `GameMapType`. It is safe because every consumer either looks the id up in
 * `maps` (and tolerates a miss) or routes it through the generated-map
 * loader; see `CompositeGameMapLoader`.
 */
export function generatedMapId(params: MapGenParams): GameMapType {
  return `${GENERATED_MAP_PREFIX}${hashParams(params)}` as GameMapType;
}

/** A human-readable name for the map picker and the in-game map label. */
export function generatedMapName(params: MapGenParams): string {
  return `Generated ${hashParams(params).slice(0, 6).toUpperCase()}`;
}
