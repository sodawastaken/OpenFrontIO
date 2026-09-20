/**
 * Renders a terrain grid to RGBA pixels for the map picker's preview.
 *
 * The colour table is a port of `getThumbnailColor` in
 * `map-generator/map_generator.go`, so a generated map's card looks like the
 * shipped maps' cards sitting next to it. Note that water is fully
 * transparent there, including shoreline water — the cards show water as
 * whatever the page background is, and matching that matters more than the
 * colours being individually sensible.
 *
 * Kept free of DOM APIs so it can run in a worker and be unit-tested; turning
 * the pixels into an image is the caller's job.
 */

import { TerrainGrid, TerrainType } from "./TerrainGrid";

export interface ThumbnailImage {
  // Pinned to a plain ArrayBuffer (not ArrayBufferLike) so the pixels can be
  // handed straight to ImageData, which rejects SharedArrayBuffer-backed views.
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** Colour for one tile, matching the Go generator exactly. */
export function thumbnailColor(
  type: number,
  magnitude: number,
  shoreline: boolean,
): [number, number, number, number] {
  if (type === TerrainType.Impassable) return [0, 0, 0, 0];

  if (type === TerrainType.Water) {
    if (shoreline) return [100, 143, 255, 0];
    const adj = 11 - Math.min(magnitude / 2, 10) - 10;
    return [
      Math.max(70 + adj, 0),
      Math.max(132 + adj, 0),
      Math.max(180 + adj, 0),
      0,
    ];
  }

  if (shoreline) return [204, 203, 158, 255];

  if (magnitude < 10) {
    // Plains: green, darkening with elevation.
    return [190, 220 - 2 * magnitude, 138, 255];
  }
  if (magnitude < 20) {
    // Highland: tan, brightening with elevation.
    return [200 + 2 * magnitude, 183 + 2 * magnitude, 138 + 2 * magnitude, 255];
  }
  // Mountain: grey, brightening with elevation.
  const v = 230 + magnitude;
  return [v, v, v, 255];
}

/** Renders the whole grid at 1:1 into an RGBA buffer. */
export function renderThumbnail(grid: TerrainGrid): ThumbnailImage {
  const { width, height, type, magnitude, shoreline } = grid;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const [r, g, b, a] = thumbnailColor(
      type[i],
      magnitude[i],
      shoreline[i] === 1,
    );
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = a;
  }

  return { data, width, height };
}

/**
 * Renders with water drawn opaque instead of transparent.
 *
 * The in-menu preview canvas has no map-card background behind it, so fully
 * transparent water would leave the land floating on whatever is underneath.
 */
export function renderPreview(grid: TerrainGrid): ThumbnailImage {
  const image = renderThumbnail(grid);
  const { data } = image;
  for (let i = 0; i < grid.length; i++) {
    if (grid.type[i] !== TerrainType.Water) continue;
    const o = i * 4;
    data[o + 3] = 255;
  }
  return image;
}
