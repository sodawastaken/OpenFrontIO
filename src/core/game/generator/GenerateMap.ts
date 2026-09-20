/**
 * Orchestrates procedural map generation.
 *
 * The stage order mirrors `GenerateMap` in `map-generator/map_generator.go`,
 * including its per-scale differences — small islands are removed at 1x and
 * 4x but not 16x, and lakes only at 1x — because the game's renderer and
 * pathfinder are tuned to maps built that way.
 *
 * Everything here is deterministic: the same params and seed always produce
 * byte-identical output, on any machine. That is what lets the caller
 * generate once and hand the bytes to the simulation worker without worrying
 * about the two halves of the game disagreeing about the terrain.
 */

import type { MapManifest } from "../TerrainMapLoader";
import { assignElevation, landDistanceToCoast } from "./Elevation";
import {
  baseFieldConfig,
  buildLandField,
  carveInlandSea,
  carveRivers,
  placeIslandCentres,
  solveThreshold,
  type LandFieldConfig,
} from "./LandMask";
import {
  generatedMapId,
  generatedMapName,
  MapArchetype,
  type GeneratedMapBundle,
  type MapGenParams,
  type MapGenProgress,
} from "./MapGenTypes";
import { profileFor } from "./MapStyleProfile";
import {
  countSignificantIslands,
  findLandComponents,
  placeNations,
} from "./Nations";
import { createMiniMap, packTerrain } from "./PackTerrain";
import { TerrainGrid, TerrainType } from "./TerrainGrid";
import {
  MIN_ISLAND_SIZE,
  processWater,
  removeSmallIslands,
  setImpassableNeighborWaterDepth,
} from "./TerrainPostProcess";
import { renderThumbnail } from "./Thumbnail";

/** How far off the requested island count is acceptable. */
const ISLAND_COUNT_TOLERANCE = 0.2;
/** Attempts at hitting the island count before accepting what we have. */
const MAX_LAYOUT_ATTEMPTS = 6;
/**
 * Longest edge, in tiles, of the reduced-resolution grid the layout search
 * runs on. The search only needs to know how many landmasses a parameter set
 * produces, which survives downscaling, and at 1/5 linear scale an attempt
 * costs about 4% of a full-resolution one — which is what makes six attempts
 * affordable.
 */
const SEARCH_MAX_EDGE = 420;

type ProgressFn = (p: MapGenProgress) => void;

const PHASE_FRACTIONS: Array<[MapGenProgress["phase"], number]> = [
  ["layout", 0.05],
  ["landmask", 0.35],
  ["elevation", 0.55],
  ["postprocess", 0.75],
  ["minimaps", 0.88],
  ["nations", 0.94],
  ["packing", 1.0],
];

function report(
  onProgress: ProgressFn | undefined,
  phase: MapGenProgress["phase"],
): void {
  if (!onProgress) return;
  const entry = PHASE_FRACTIONS.find(([p]) => p === phase);
  onProgress({ phase, fraction: entry ? entry[1] : 0 });
}

/**
 * Clamps parameters to what the format and the pipeline can actually take.
 *
 * Dimensions must be multiples of four, because the format needs two clean
 * halvings for `map4x` and `map16x`.
 */
export function normaliseParams(params: MapGenParams): MapGenParams {
  const width = Math.max(64, params.width - (params.width % 4));
  const height = Math.max(64, params.height - (params.height % 4));
  const singleIsland =
    params.archetype === MapArchetype.Pangaea ||
    params.archetype === MapArchetype.InlandSea;

  return {
    ...params,
    width,
    height,
    seed: params.seed | 0,
    islandCount: singleIsland
      ? 1
      : Math.max(1, Math.min(60, Math.round(params.islandCount))),
    landCoverage: Math.min(0.85, Math.max(0.05, params.landCoverage)),
    mountainousness: Math.min(1, Math.max(0, params.mountainousness)),
    coastlineRoughness: Math.min(1, Math.max(0, params.coastlineRoughness)),
    nationCount: Math.max(0, Math.min(128, Math.round(params.nationCount))),
  };
}

/**
 * Builds a land mask that hits both the coverage and the island count.
 *
 * Coverage is solved for exactly by bisecting the threshold. The island count
 * cannot be solved that way — it is an emergent property of the field — so it
 * is measured and the field nudged: more noise fragments landmasses, less
 * noise fuses them. Three rounds is enough to land inside tolerance almost
 * always, and the achieved count is reported either way rather than being
 * quietly misrepresented.
 */
/**
 * Rasterises the field for one parameter set into a land/water grid.
 *
 * Shared by the reduced-resolution search and the final full-resolution pass
 * so the two cannot drift apart. Because the noise is sampled in
 * map-relative coordinates and the island geometry scales with the map
 * dimensions, the same parameters describe the same shape at either scale.
 */
function rasteriseLandMask(
  params: MapGenParams,
  config: LandFieldConfig,
  radiusScale: number,
): TerrainGrid {
  const centres = placeIslandCentres(params, params.islandCount, radiusScale);
  const field = buildLandField(params, centres, config);

  if (params.archetype === MapArchetype.InlandSea) {
    carveInlandSea(params, field, config);
  }
  if (params.archetype === MapArchetype.LakesRivers) {
    carveRivers(params, field, config, 1.2);
  }

  const targetLand = Math.round(
    params.width * params.height * params.landCoverage,
  );
  const threshold = solveThreshold(field, targetLand);

  const grid = new TerrainGrid(params.width, params.height);
  for (let i = 0; i < field.length; i++) {
    grid.type[i] = field[i] > threshold ? TerrainType.Land : TerrainType.Water;
  }
  return grid;
}

/** Counts landmasses large enough to be worth calling islands. */
function measureIslands(grid: TerrainGrid, minIslandSize: number): number {
  removeSmallIslands(grid, minIslandSize);
  const components = findLandComponents(grid);
  const totalLand = components.sizes.reduce((a, c) => a + c, 0);
  return countSignificantIslands(components, totalLand);
}

interface LayoutSolution {
  config: LandFieldConfig;
  radiusScale: number;
}

/**
 * Searches for field parameters that produce the requested island count.
 *
 * Land coverage is solved exactly by bisecting the threshold, but island
 * count is emergent — it depends on whether neighbouring falloffs overlap
 * enough to fuse — so it has to be measured and corrected. Two levers move
 * it: island radius (the dominant one, since overlapping discs fuse whatever
 * else is set) and noise amplitude (which breaks up or bridges coastlines at
 * the margin).
 *
 * The search runs on a small grid, which is what makes several attempts
 * affordable; the winning parameters are then applied at full resolution.
 */
function searchLayout(
  params: MapGenParams,
  config: LandFieldConfig,
): LayoutSolution {
  const scale = Math.min(
    1,
    SEARCH_MAX_EDGE / Math.max(params.width, params.height),
  );
  const searchParams: MapGenParams = {
    ...params,
    width: Math.max(64, Math.round((params.width * scale) / 4) * 4),
    height: Math.max(64, Math.round((params.height * scale) / 4) * 4),
  };
  // Speck removal has to scale with area, or the search would discard
  // islands that are perfectly visible at full resolution.
  const searchMinIsland = Math.max(
    4,
    Math.round(MIN_ISLAND_SIZE * scale * scale),
  );

  let working = { ...config };
  let radiusScale = 1;
  let best: LayoutSolution = { config: working, radiusScale };
  let bestDrift = Infinity;

  for (let attempt = 0; attempt < MAX_LAYOUT_ATTEMPTS; attempt++) {
    const grid = rasteriseLandMask(searchParams, working, radiusScale);
    const achieved = measureIslands(grid, searchMinIsland);

    const drift =
      Math.abs(achieved - params.islandCount) / Math.max(1, params.islandCount);
    if (drift < bestDrift) {
      bestDrift = drift;
      best = { config: working, radiusScale };
    }
    if (drift <= ISLAND_COUNT_TOLERANCE) break;

    // Noise amplitude is the effective lever in both directions, and the
    // asymmetry below is deliberate. Too many landmasses means noise is
    // shattering coastlines into satellites, so damp it and grow the islands
    // until the satellites rejoin. Too few means noise is bridging the
    // channels between neighbours, so damp it harder still -- measured
    // sweeps show radius barely moves the count once spacing is even, while
    // cutting noise to a third of base turns eight islands into twelve.
    //
    // Damping costs coastline roughness, which the user also asked for. The
    // island count wins that conflict: it is a number shown in the UI, where
    // roughness is a matter of degree.
    if (achieved > params.islandCount) {
      radiusScale *= 1.15;
      working = {
        ...working,
        noiseAmplitude: working.noiseAmplitude * 0.8,
        mergeHardness: Math.max(0, working.mergeHardness - 0.15),
      };
    } else {
      radiusScale *= 0.96;
      working = {
        ...working,
        noiseAmplitude: working.noiseAmplitude * 0.6,
        mergeHardness: Math.min(1, working.mergeHardness + 0.2),
      };
    }
  }

  return best;
}

/**
 * Generates a complete, playable map.
 *
 * `onProgress` is optional and synchronous; the worker wrapper uses it to
 * post updates, and tests pass nothing.
 */
export function generateMap(
  rawParams: MapGenParams,
  onProgress?: ProgressFn,
): GeneratedMapBundle {
  const startedAt = Date.now();
  const params = normaliseParams(rawParams);
  const profile = profileFor(params.archetype);
  const config = baseFieldConfig(params.archetype, params.coastlineRoughness);

  report(onProgress, "layout");
  const layout = searchLayout(params, config);
  const grid = rasteriseLandMask(params, layout.config, layout.radiusScale);
  removeSmallIslands(grid, MIN_ISLAND_SIZE);

  report(onProgress, "landmask");
  // Shorelines must exist before elevation, because the coast-distance prior
  // is measured from them.
  processWater(grid, true);
  setImpassableNeighborWaterDepth(grid);

  report(onProgress, "elevation");
  assignElevation(grid, params, profile, config.fbm);

  report(onProgress, "postprocess");
  // Elevation does not move any coastlines, so the water pass above still
  // holds; this second one only exists for archetypes that carve water after
  // the fact. Running it unconditionally keeps the invariant simple.
  removeSmallIslands(grid, MIN_ISLAND_SIZE);
  processWater(grid, true);
  setImpassableNeighborWaterDepth(grid);

  report(onProgress, "minimaps");
  // Mirrors map_generator.go:175-186: half the island threshold at 4x, no
  // lake removal below full scale, and no island removal at all at 16x.
  const grid4x = createMiniMap(grid);
  removeSmallIslands(grid4x, Math.floor(MIN_ISLAND_SIZE / 2));
  processWater(grid4x, false);
  setImpassableNeighborWaterDepth(grid4x);

  const grid16x = createMiniMap(grid4x);
  processWater(grid16x, false);
  setImpassableNeighborWaterDepth(grid16x);

  report(onProgress, "nations");
  const distToCoast = landDistanceToCoast(grid);
  const components = findLandComponents(grid);
  const totalLand = components.sizes.reduce((a, c) => a + c, 0);
  const nations = placeNations(grid, params, distToCoast, components);
  const islandCount = countSignificantIslands(components, totalLand);

  report(onProgress, "packing");
  const packed = packTerrain(grid);
  const packed4x = packTerrain(grid4x);
  const packed16x = packTerrain(grid16x);
  const thumbnail = renderThumbnail(grid16x);

  const manifest: MapManifest = {
    name: generatedMapName(params),
    map: {
      width: grid.width,
      height: grid.height,
      num_land_tiles: packed.numLandTiles,
    },
    map4x: {
      width: grid4x.width,
      height: grid4x.height,
      num_land_tiles: packed4x.numLandTiles,
    },
    map16x: {
      width: grid16x.width,
      height: grid16x.height,
      num_land_tiles: packed16x.numLandTiles,
    },
    nations,
  };

  return {
    id: generatedMapId(params),
    params,
    manifest,
    mapBin: packed.data,
    map4xBin: packed4x.data,
    map16xBin: packed16x.data,
    thumbnail,
    stats: {
      landFraction: packed.numLandTiles / (grid.width * grid.height),
      islandCount,
      totalLandTiles: packed.numLandTiles,
      generationMs: Date.now() - startedAt,
    },
  };
}
