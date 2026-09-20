/**
 * Port of the terrain post-processing pipeline in
 * `map-generator/map_generator.go`.
 *
 * The offline Go generator and this module must agree exactly, because the
 * game reads both through the same `GameMap` decoder: the flags this pipeline
 * sets (ocean, shoreline, water depth) are what the renderer shades and what
 * the boat pathfinder walks. The Go functions ported here are
 * `removeSmallIslands`, `processWater`, `processShore`, `processDistToLand`
 * and `setImpassableNeighborWaterDepth`.
 *
 * Differences from the Go original, both behaviour-preserving:
 *   - flat row-major arrays instead of `[][]Terrain` (see TerrainGrid)
 *   - flood fill expands only same-type tiles and uses an index-based queue,
 *     rather than enqueueing every neighbour and dequeueing with a shift
 */

import {
  neighbors,
  TerrainGrid,
  TerrainType,
  type TerrainTypeValue,
} from "./TerrainGrid";

/** Smallest surviving land body, in tiles. Matches Go's `minIslandSize`. */
export const MIN_ISLAND_SIZE = 30;
/** Smallest surviving lake, in tiles. Matches Go's `minLakeSize`. */
export const MIN_LAKE_SIZE = 200;
/**
 * Magnitude forced on water bordering impassable terrain. Packs to 10 (half
 * of 20), the deepest shade the renderer draws.
 */
const DEEP_MAGNITUDE = 20;

/**
 * Collects the connected component of same-type tiles containing `start`.
 *
 * Returns the number of tiles written to `outBuf`. `visited` is shared across
 * calls so a full sweep visits each tile once.
 */
function floodFill(
  grid: TerrainGrid,
  start: number,
  visited: Uint8Array,
  outBuf: Int32Array,
  queue: Int32Array,
): number {
  const { width, height, type } = grid;
  const target = type[start];
  const nb = new Int32Array(4);

  let head = 0;
  let tail = 0;
  let count = 0;

  queue[tail++] = start;
  visited[start] = 1;

  while (head < tail) {
    const cur = queue[head++];
    outBuf[count++] = cur;

    const n = neighbors(cur, width, height, nb);
    for (let k = 0; k < n; k++) {
      const next = nb[k];
      if (visited[next] || type[next] !== target) continue;
      visited[next] = 1;
      queue[tail++] = next;
    }
  }

  return count;
}

/**
 * Returns the terrain type that most of the body's external neighbours have,
 * so a removed body blends into whatever surrounds it.
 *
 * Each distinct neighbouring tile votes once. Ties break Water > Impassable >
 * Land, matching Go's `majorityNeighborType`.
 */
function majorityNeighborType(
  grid: TerrainGrid,
  body: Int32Array,
  bodySize: number,
  scratchSeen: Uint8Array,
): TerrainTypeValue {
  const { width, height, type } = grid;
  const nb = new Int32Array(4);
  const counts = [0, 0, 0];
  const touched: number[] = [];

  // Mark body members so they are skipped as voters.
  for (let b = 0; b < bodySize; b++) {
    scratchSeen[body[b]] = 1;
    touched.push(body[b]);
  }

  for (let b = 0; b < bodySize; b++) {
    const n = neighbors(body[b], width, height, nb);
    for (let k = 0; k < n; k++) {
      const next = nb[k];
      if (scratchSeen[next]) continue;
      scratchSeen[next] = 1;
      touched.push(next);
      counts[type[next]]++;
    }
  }

  // Leave the scratch buffer clean for the next caller. Clearing only the
  // tiles touched keeps this proportional to the body, not to the map.
  for (const t of touched) scratchSeen[t] = 0;

  let best: TerrainTypeValue = TerrainType.Water;
  let bestCount = counts[TerrainType.Water];
  if (counts[TerrainType.Impassable] > bestCount) {
    best = TerrainType.Impassable;
    bestCount = counts[TerrainType.Impassable];
  }
  if (counts[TerrainType.Land] > bestCount) {
    best = TerrainType.Land;
  }
  return best;
}

/**
 * Replaces land bodies smaller than `minSize` with whatever surrounds them.
 *
 * Speck islands are unplayable — too small to spawn on or defend — and they
 * inflate the island count the UI reports, so they go before anything else.
 */
export function removeSmallIslands(grid: TerrainGrid, minSize: number): void {
  const n = grid.length;
  const visited = new Uint8Array(n);
  const body = new Int32Array(n);
  const queue = new Int32Array(n);
  const seen = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    if (visited[i] || grid.type[i] !== TerrainType.Land) continue;
    const size = floodFill(grid, i, visited, body, queue);
    if (size >= minSize) continue;

    const replacement = majorityNeighborType(grid, body, size, seen);
    for (let b = 0; b < size; b++) {
      grid.type[body[b]] = replacement;
      grid.magnitude[body[b]] = 0;
    }
  }
}

/**
 * Flags the largest connected water body as ocean, optionally drops small
 * lakes, then recomputes shorelines and water depth.
 *
 * The ocean flag is what separates open sea from inland lakes for boats and
 * ports, so it is recomputed at every scale rather than inherited.
 */
export function processWater(
  grid: TerrainGrid,
  removeSmallLakes: boolean,
): void {
  const n = grid.length;
  grid.ocean.fill(0);

  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  const body = new Int32Array(n);

  // Record each water body as a (start tile, size) pair and re-fill the ones
  // we act on. Holding every body's tile list at once would cost another four
  // bytes per water tile for no benefit.
  const starts: number[] = [];
  const sizes: number[] = [];

  for (let i = 0; i < n; i++) {
    if (visited[i] || grid.type[i] !== TerrainType.Water) continue;
    const size = floodFill(grid, i, visited, body, queue);
    starts.push(i);
    sizes.push(size);
  }

  if (starts.length === 0) return;

  let largest = 0;
  for (let b = 1; b < starts.length; b++) {
    if (sizes[b] > sizes[largest]) largest = b;
  }

  const refill = new Uint8Array(n);
  const oceanSize = floodFill(grid, starts[largest], refill, body, queue);
  for (let b = 0; b < oceanSize; b++) grid.ocean[body[b]] = 1;

  if (removeSmallLakes) {
    const seen = new Uint8Array(n);
    const lakeVisited = new Uint8Array(n);
    for (let b = 0; b < starts.length; b++) {
      if (b === largest || sizes[b] >= MIN_LAKE_SIZE) continue;
      const size = floodFill(grid, starts[b], lakeVisited, body, queue);
      const replacement = majorityNeighborType(grid, body, size, seen);
      for (let k = 0; k < size; k++) {
        grid.type[body[k]] = replacement;
        grid.magnitude[body[k]] = 0;
      }
    }
  }

  const shorelineWaters = processShore(grid);
  processDistToLand(grid, shorelineWaters);
}

/**
 * Marks every tile that borders a tile of the opposite land/water class.
 *
 * Returns the shoreline water tiles, which seed the depth BFS. Impassable
 * tiles are never shoreline — they render as background, with no outline.
 */
export function processShore(grid: TerrainGrid): Int32Array {
  const { width, height, type, shoreline } = grid;
  const n = grid.length;
  shoreline.fill(0);

  const nb = new Int32Array(4);
  const waters = new Int32Array(n);
  let waterCount = 0;

  for (let i = 0; i < n; i++) {
    const t = type[i];
    if (t === TerrainType.Impassable) continue;

    const want = t === TerrainType.Land ? TerrainType.Water : TerrainType.Land;
    const count = neighbors(i, width, height, nb);
    for (let k = 0; k < count; k++) {
      if (type[nb[k]] !== want) continue;
      shoreline[i] = 1;
      if (t === TerrainType.Water) waters[waterCount++] = i;
      break;
    }
  }

  return waters.subarray(0, waterCount);
}

/**
 * Sets each water tile's magnitude to its Manhattan distance from the nearest
 * land, by BFS outward from the shoreline. The renderer shades water depth
 * from this.
 */
export function processDistToLand(
  grid: TerrainGrid,
  shorelineWaters: Int32Array,
): void {
  const { width, height, type, magnitude } = grid;
  const n = grid.length;

  const visited = new Uint8Array(n);
  // One slot per tile is always enough: each tile is enqueued at most once.
  const queue = new Int32Array(n);
  const dist = new Int32Array(n);
  const nb = new Int32Array(4);

  let head = 0;
  let tail = 0;
  for (let k = 0; k < shorelineWaters.length; k++) {
    const i = shorelineWaters[k];
    visited[i] = 1;
    dist[i] = 0;
    magnitude[i] = 0;
    queue[tail++] = i;
  }

  while (head < tail) {
    const cur = queue[head++];
    const d = dist[cur] + 1;
    const count = neighbors(cur, width, height, nb);
    for (let k = 0; k < count; k++) {
      const next = nb[k];
      if (visited[next] || type[next] !== TerrainType.Water) continue;
      visited[next] = 1;
      dist[next] = d;
      magnitude[next] = d;
      queue[tail++] = next;
    }
  }
}

/**
 * Forces water bordering impassable terrain to full depth.
 *
 * The distance BFS would otherwise shade it as shallow, drawing a depth
 * gradient around what is meant to read as void, like the map edge.
 */
export function setImpassableNeighborWaterDepth(grid: TerrainGrid): void {
  const { width, height, type, magnitude } = grid;
  const n = grid.length;
  const nb = new Int32Array(4);

  for (let i = 0; i < n; i++) {
    if (type[i] !== TerrainType.Water) continue;
    const count = neighbors(i, width, height, nb);
    for (let k = 0; k < count; k++) {
      if (type[nb[k]] !== TerrainType.Impassable) continue;
      magnitude[i] = DEEP_MAGNITUDE;
      break;
    }
  }
}
