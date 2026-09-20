import { assetUrl } from "../core/AssetUrls";
import { FetchGameMapLoader } from "../core/game/FetchGameMapLoader";
import { CompositeGameMapLoader } from "../core/game/generator/GeneratedMapRegistry";

const fetchMapLoader = new FetchGameMapLoader((path) =>
  assetUrl(`maps/${path}`),
);

/**
 * The main thread's map loader.
 *
 * Wrapped in a composite so procedurally generated maps resolve from memory
 * while everything else is fetched as before. Every main-thread consumer —
 * the map picker's thumbnails, the nation-count readout, the renderer's
 * terrain load — goes through this one instance, so wrapping it here is what
 * makes generated maps work across all of them without touching each.
 *
 * Note that a generated map's `webpPath` is a blob URL and must not be passed
 * through `assetUrl`: `isAbsoluteUrl` requires a `://`, which `blob:` lacks,
 * so the path would be mangled into a relative asset path. The composite
 * returns such entries directly, never via the fetch loader's resolver.
 */
export const terrainMapFileLoader = new CompositeGameMapLoader(fetchMapLoader);
