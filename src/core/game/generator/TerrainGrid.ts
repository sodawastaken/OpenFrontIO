/**
 * Mutable terrain grid used by the procedural map generator.
 *
 * This is the in-memory working representation that sits between the land
 * mask and the packed `.bin` byte array. It mirrors the `Terrain` struct in
 * `map-generator/map_generator.go`, but stores each field in its own flat
 * typed array in **row-major** order (`index = y * width + x`) — the same
 * order the packed binary uses, so packing is a straight scan.
 *
 * (The Go generator keeps a column-major `[][]Terrain` and transposes during
 * packing. Row-major throughout is equivalent and avoids the transpose.)
 */

export const TerrainType = {
  Land: 0,
  Water: 1,
  Impassable: 2,
} as const;

export type TerrainTypeValue = (typeof TerrainType)[keyof typeof TerrainType];

export class TerrainGrid {
  /** TerrainType per tile. */
  readonly type: Uint8Array;
  /** Elevation 0-30 for land; distance-to-land for water. */
  readonly magnitude: Float32Array;
  /** 1 if the tile borders a tile of the opposite land/water class. */
  readonly shoreline: Uint8Array;
  /** 1 if the tile belongs to the largest connected water body. */
  readonly ocean: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    const n = width * height;
    this.type = new Uint8Array(n); // defaults to Land
    this.magnitude = new Float32Array(n);
    this.shoreline = new Uint8Array(n);
    this.ocean = new Uint8Array(n);
  }

  get length(): number {
    return this.width * this.height;
  }

  idx(x: number, y: number): number {
    return y * this.width + x;
  }
}

/**
 * Writes the valid orthogonal neighbours of `i` into `out` and returns the
 * count (2 at corners, 3 on edges, 4 in the interior).
 *
 * `out` is a caller-owned scratch array so the hot loops below allocate
 * nothing — these run over millions of tiles.
 */
export function neighbors(
  i: number,
  width: number,
  height: number,
  out: Int32Array,
): number {
  const x = i % width;
  const y = (i / width) | 0;
  let n = 0;
  if (x > 0) out[n++] = i - 1;
  if (x < width - 1) out[n++] = i + 1;
  if (y > 0) out[n++] = i - width;
  if (y < height - 1) out[n++] = i + width;
  return n;
}
