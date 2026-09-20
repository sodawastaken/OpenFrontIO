/**
 * Main-thread API for the map generation worker.
 *
 * Keeps one worker alive across generations so repeated tries from the menu
 * do not pay worker startup each time, and lets an in-flight generation be
 * abandoned when the user changes a slider and asks for another.
 */

import type { MapGenRequest, MapGenResponse } from "./MapGen.worker";
import type {
  GeneratedMapBundle,
  MapGenParams,
  MapGenProgress,
} from "./MapGenTypes";

// Inlined as a same-origin blob, matching how the game worker is created
// (see WorkerClient): a plain `new Worker(url)` breaks when the bundle is
// served from the CDN.
async function createMapGenWorker(): Promise<Worker> {
  const { default: MapGenWorker } =
    await import("./MapGen.worker.ts?worker&inline");
  return new MapGenWorker();
}

interface PendingJob {
  resolve: (bundle: GeneratedMapBundle) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: MapGenProgress) => void;
}

export class MapGenClient {
  private worker: Worker | null = null;
  private workerLoad: Promise<Worker> | null = null;
  private readonly jobs = new Map<string, PendingJob>();
  private nextId = 0;

  private async ensureWorker(): Promise<Worker> {
    if (this.worker !== null) return this.worker;
    this.workerLoad ??= createMapGenWorker().then((worker) => {
      worker.addEventListener("message", (e: MessageEvent<MapGenResponse>) =>
        this.onMessage(e.data),
      );
      worker.addEventListener("error", (e) => {
        this.failAll(new Error(`Map generator worker failed: ${e.message}`));
      });
      this.worker = worker;
      return worker;
    });
    return this.workerLoad;
  }

  private onMessage(response: MapGenResponse): void {
    const job = this.jobs.get(response.id);
    // A job the caller cancelled still reports back; drop it quietly.
    if (job === undefined) return;

    switch (response.type) {
      case "progress":
        job.onProgress?.(response.progress);
        break;
      case "done":
        this.jobs.delete(response.id);
        job.resolve(response.bundle);
        break;
      case "error":
        this.jobs.delete(response.id);
        job.reject(new Error(response.message));
        break;
    }
  }

  private failAll(error: Error): void {
    for (const job of this.jobs.values()) job.reject(error);
    this.jobs.clear();
  }

  /**
   * Generates a map, reporting progress as it goes.
   *
   * Cancelling only detaches the caller: the worker finishes the job it is
   * on, because the generator is a tight synchronous loop with nowhere to
   * check a cancellation flag. The result is simply discarded.
   */
  async generate(
    params: MapGenParams,
    onProgress?: (progress: MapGenProgress) => void,
  ): Promise<GeneratedMapBundle> {
    const worker = await this.ensureWorker();
    const id = `mapgen-${this.nextId++}`;

    return new Promise<GeneratedMapBundle>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, onProgress });
      worker.postMessage({
        type: "generate",
        id,
        params,
      } satisfies MapGenRequest);
    });
  }

  /** Abandons a pending generation's result without stopping the worker. */
  cancel(): void {
    this.failAll(new Error("Map generation cancelled"));
  }

  /** Releases the worker. Safe to call repeatedly. */
  dispose(): void {
    this.failAll(new Error("Map generator disposed"));
    this.worker?.terminate();
    this.worker = null;
    this.workerLoad = null;
  }
}

export const mapGenClient = new MapGenClient();
