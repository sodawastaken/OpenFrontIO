/**
 * Runs map generation off the main thread.
 *
 * A full-size map takes roughly three seconds to build, which would freeze
 * the menu — including the progress bar meant to show it working. The
 * generator itself is pure, so the worker is a thin shell around it.
 */

import { generateMap } from "./GenerateMap";
import type {
  GeneratedMapBundle,
  MapGenParams,
  MapGenProgress,
} from "./MapGenTypes";

export interface MapGenRequest {
  type: "generate";
  id: string;
  params: MapGenParams;
}

export type MapGenResponse =
  | { type: "progress"; id: string; progress: MapGenProgress }
  | { type: "done"; id: string; bundle: GeneratedMapBundle }
  | { type: "error"; id: string; message: string };

const ctx: Worker = self as unknown as Worker;

ctx.addEventListener("message", (e: MessageEvent<MapGenRequest>) => {
  const message = e.data;
  if (message.type !== "generate") return;

  try {
    const bundle = generateMap(message.params, (progress) => {
      ctx.postMessage({
        type: "progress",
        id: message.id,
        progress,
      } satisfies MapGenResponse);
    });

    // Transfer the terrain buffers: unlike the handoff to the simulation
    // worker, nothing here retains them after the post, so moving rather
    // than copying three megabytes is free.
    ctx.postMessage(
      { type: "done", id: message.id, bundle } satisfies MapGenResponse,
      [
        bundle.mapBin.buffer,
        bundle.map4xBin.buffer,
        bundle.map16xBin.buffer,
        bundle.thumbnail.data.buffer,
      ],
    );
  } catch (error) {
    ctx.postMessage({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    } satisfies MapGenResponse);
  }
});
