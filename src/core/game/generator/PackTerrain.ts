/**
 * Packing and downscaling — ports of `packTerrain` and `createMiniMap` in
 * `map-generator/map_generator.go`.
 *
 * The packed byte layout is the game's on-disk map format, decoded by
 * `GameMapImpl` (src/core/game/GameMap.ts):
 *
 *   bit 7 (0x80)  land (0 = water)
 *   bit 6 (0x40)  shoreline
 *   bit 5 (0x20)  ocean — the largest connected water body only
 *   bits 0-4      magnitude: land elevation 0-30, or water depth
 *
 * `0x9F` (land bit + magnitude 31) is the reserved Impassable value and is
 * deliberately excluded from `numLandTiles`, because impassable tiles cannot
 * be owned, attacked or nuked.
 */

import { neighbors, TerrainGrid, TerrainType } from "./TerrainGrid";

/** Reserved byte for impassable terrain: land bit set, magnitude 31. */
export const IMPASSABLE_BYTE = 0b10011111;

export interface PackedTerrain {
  data: Uint8Array;
  numLandTiles: number;
}

/**
 * Serialises a grid into the one-byte-per-tile map format.
 *
 * Magnitude is halved for water because water depth spans a far wider range
 * than the five bits allow, and the renderer only shades ten depth steps.
 */
export function packTerrain(grid: TerrainGrid): PackedTerrain {
  const { type, magnitude, shoreline, ocean } = grid;
  const n = grid.length;
  const data = new Uint8Array(n);
  let numLandTiles = 0;

  for (let i = 0; i < n; i++) {
    const t = type[i];

    if (t === TerrainType.Impassable) {
      data[i] = IMPASSABLE_BYTE;
      continue;
    }

    let b = 0;
    const isLand = t === TerrainType.Land;

    if (isLand) {
      b |= 0b10000000;
      numLandTiles++;
    }
    if (shoreline[i]) b |= 0b01000000;
    if (ocean[i]) b |= 0b00100000;

    const mag = isLand ? Math.ceil(magnitude[i]) : Math.ceil(magnitude[i] / 2);
    b |= Math.min(Math.max(mag, 0), 31);

    data[i] = b;
  }

  return { data, numLandTiles };
}

/**
 * Halves a grid's dimensions, mapping each 2x2 block to one tile.
 *
 * Water wins over everything so that narrow rivers and straits survive the
 * downscale — the boat pathfinder runs on the minimap and needs water bodies
 * to stay connected.
 *
 * The tie-breaks reproduce the Go original exactly, which matters because the
 * two generators' output must be interchangeable: the *first* water tile in
 * the block wins, the *first* impassable wins, but among four land tiles the
 * *last* one scanned supplies the magnitude and shoreline flag. (In Go this
 * falls out of a zero-valued destination struct defaulting to Land.)
 */
export function createMiniMap(grid: TerrainGrid): TerrainGrid {
  const miniWidth = Math.floor(grid.width / 2);
  const miniHeight = Math.floor(grid.height / 2);
  const mini = new TerrainGrid(miniWidth, miniHeight);

  // Tracks whether the destination has been claimed by water or impassable,
  // standing in for Go's inspection of the partially-written destination.
  const claimed = new Uint8Array(miniWidth * miniHeight);
  const CLAIMED_WATER = 1;
  const CLAIMED_IMPASSABLE = 2;

  for (let y = 0; y < grid.height; y++) {
    const my = y >> 1;
    if (my >= miniHeight) continue;
    for (let x = 0; x < grid.width; x++) {
      const mx = x >> 1;
      if (mx >= miniWidth) continue;

      const src = y * grid.width + x;
      const dst = my * miniWidth + mx;

      if (claimed[dst] === CLAIMED_WATER) continue;

      const t = grid.type[src];
      if (t === TerrainType.Water) {
        copyTile(grid, src, mini, dst);
        claimed[dst] = CLAIMED_WATER;
        continue;
      }
      if (claimed[dst] === CLAIMED_IMPASSABLE) continue;
      if (t === TerrainType.Impassable) {
        copyTile(grid, src, mini, dst);
        claimed[dst] = CLAIMED_IMPASSABLE;
        continue;
      }
      copyTile(grid, src, mini, dst);
    }
  }

  return mini;
}

function copyTile(
  from: TerrainGrid,
  fromIdx: number,
  to: TerrainGrid,
  toIdx: number,
): void {
  to.type[toIdx] = from.type[fromIdx];
  to.magnitude[toIdx] = from.magnitude[fromIdx];
  to.shoreline[toIdx] = from.shoreline[fromIdx];
  to.ocean[toIdx] = from.ocean[fromIdx];
}

/**
 * Rebuilds a grid from packed bytes.
 *
 * Used by the parity tests to round-trip the shipped maps back through this
 * pipeline. Water magnitude is lossy (it was halved on the way out), so
 * callers that need true depths must recompute them with `processWater`.
 */
export function unpackTerrain(
  data: Uint8Array,
  width: number,
  height: number,
): TerrainGrid {
  if (data.length !== width * height) {
    throw new Error(
      `Packed terrain is ${data.length} bytes, expected ${width * height} for ${width}x${height}`,
    );
  }

  const grid = new TerrainGrid(width, height);
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === IMPASSABLE_BYTE) {
      grid.type[i] = TerrainType.Impassable;
      continue;
    }
    const isLand = (b & 0b10000000) !== 0;
    grid.type[i] = isLand ? TerrainType.Land : TerrainType.Water;
    grid.shoreline[i] = (b & 0b01000000) !== 0 ? 1 : 0;
    grid.ocean[i] = (b & 0b00100000) !== 0 ? 1 : 0;
    // Water depth was halved when packed; the caller recomputes it.
    grid.magnitude[i] = isLand ? b & 0b00011111 : (b & 0b00011111) * 2;
  }
  return grid;
}

/**
 * Counts the land tiles in a packed buffer, excluding impassable terrain.
 * Mirrors what `packTerrain` reports, for verification against a manifest.
 */
export function countLandTiles(data: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== IMPASSABLE_BYTE && (data[i] & 0b10000000) !== 0) count++;
  }
  return count;
}

/** Re-exported so callers do not need to import `neighbors` separately. */
export { neighbors };
