/**
 * Main-thread bookkeeping for procedurally generated maps.
 *
 * Bridges a freshly generated bundle into the shared registry the map loaders
 * read from, and turns its thumbnail pixels into something an `<img>` can
 * show. Kept out of the core registry because it touches canvas and object
 * URLs, which the simulation worker has no use for.
 */

import {
  generatedMaps,
  toPayload,
} from "../../../core/game/generator/GeneratedMapRegistry";
import type { GeneratedMapBundle } from "../../../core/game/generator/MapGenTypes";
import { evictGeneratedTerrainMaps } from "../../../core/game/TerrainMapLoader";

/** Paints thumbnail pixels onto a canvas and returns a blob URL for it. */
async function thumbnailUrl(bundle: GeneratedMapBundle): Promise<string> {
  const { data, width, height } = bundle.thumbnail;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return "";
  ctx.putImageData(new ImageData(data, width, height), 0, 0);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp"),
  );
  return blob === null ? "" : URL.createObjectURL(blob);
}

/**
 * Makes a generated map loadable, and returns its id.
 *
 * Terrain cached under other generated ids is dropped at the same time: each
 * cached map pins several megabytes, and the menu can produce a new one on
 * every click.
 */
export async function registerGeneratedMap(
  bundle: GeneratedMapBundle,
): Promise<string> {
  const url = await thumbnailUrl(bundle);
  generatedMaps.register(toPayload(bundle), url, () => {
    // Runs when this entry is evicted, so the blob does not outlive its map.
    if (url !== "") URL.revokeObjectURL(url);
  });
  evictGeneratedTerrainMaps(bundle.id);
  return bundle.id;
}
