/**
 * Places nation spawn points on a generated map and names them.
 *
 * Spawns want three things: to be on land the player can actually expand
 * from, to be far enough inland that the nation is not a single coastal
 * strip, and to be spread out so the early game is not a scrum. The greedy
 * farthest-point pass below gets all three without any tuning constants
 * beyond the coast inset.
 */

import { PseudoRandom } from "../../PseudoRandom";
import { resolveTribeNameData } from "../../execution/utils/TribeNames";
import type { Nation } from "../TerrainMapLoader";
import type { MapGenParams } from "./MapGenTypes";
import { neighbors, TerrainGrid, TerrainType } from "./TerrainGrid";

const SEED_NATIONS = 0x4b7d9e21;
/**
 * Preferred minimum distance from the coast, in tiles. Relaxed automatically
 * on archipelago maps, where no tile may be this far inland.
 */
const COAST_INSET_PREFERENCE = [6, 3, 1, 0];
/** Sample every Nth candidate; keeps the O(N x pool) pass bounded. */
const CANDIDATE_STRIDE = 11;

export interface LandComponents {
  /** Component id per tile, or -1 for non-land. */
  id: Int32Array;
  /** Tile count per component id. */
  sizes: number[];
}

/** Labels every connected land component and records its size. */
export function findLandComponents(grid: TerrainGrid): LandComponents {
  const { width, height, type } = grid;
  const n = grid.length;
  const id = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const nb = new Int32Array(4);
  const sizes: number[] = [];

  for (let i = 0; i < n; i++) {
    if (id[i] !== -1 || type[i] !== TerrainType.Land) continue;
    const componentId = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    id[i] = componentId;
    let size = 0;

    while (head < tail) {
      const cur = queue[head++];
      size++;
      const count = neighbors(cur, width, height, nb);
      for (let k = 0; k < count; k++) {
        const next = nb[k];
        if (id[next] !== -1 || type[next] !== TerrainType.Land) continue;
        id[next] = componentId;
        queue[tail++] = next;
      }
    }
    sizes.push(size);
  }

  return { id, sizes };
}

/**
 * Counts land components large enough to read as islands.
 *
 * This is what the UI reports and what the island-count correction loop aims
 * at. Raw component count is the wrong measure: Australia has twenty land
 * components but 98.5% of its land in one, and nobody would call it a
 * twenty-island map.
 */
export function countSignificantIslands(
  components: LandComponents,
  totalLandTiles: number,
  shareThreshold = 0.01,
): number {
  if (totalLandTiles === 0) return 0;
  const minSize = totalLandTiles * shareThreshold;
  return components.sizes.filter((s) => s >= minSize).length;
}

/**
 * Chooses spawn tiles and builds the manifest's nation list.
 *
 * Coordinates are in full-scale tile space, which is what `TerrainMapLoader`
 * expects — it halves them itself for compact maps.
 */
export function placeNations(
  grid: TerrainGrid,
  params: MapGenParams,
  distToCoast: Int32Array,
  components: LandComponents,
): Nation[] {
  if (params.nationCount <= 0) return [];

  const { width, type } = grid;
  const n = grid.length;
  const totalLand = components.sizes.reduce((a, c) => a + c, 0);
  // Avoid stranding a nation alone on a speck it can never expand off.
  const minComponentSize = Math.max(200, totalLand * 0.005);

  let candidates: number[] = [];
  for (const inset of COAST_INSET_PREFERENCE) {
    candidates = [];
    for (let i = 0; i < n; i += CANDIDATE_STRIDE) {
      if (type[i] !== TerrainType.Land) continue;
      if (distToCoast[i] < inset) continue;
      const comp = components.id[i];
      if (comp < 0 || components.sizes[comp] < minComponentSize) continue;
      candidates.push(i);
    }
    // Needing several candidates per nation keeps the spread meaningful;
    // with barely more candidates than nations the farthest-point pass has
    // no freedom and the result is effectively arbitrary.
    if (candidates.length >= params.nationCount * 4) break;
  }

  if (candidates.length === 0) return [];

  const chosen = farthestPointSample(
    candidates,
    Math.min(params.nationCount, candidates.length),
    width,
    distToCoast,
  );

  const names = generateNationNames(params, chosen.length);
  return chosen.map((tile, i) => ({
    name: names[i],
    coordinates: [tile % width, (tile / width) | 0] as [number, number],
  }));
}

/**
 * Greedy farthest-point sampling: repeatedly take the candidate whose nearest
 * already-chosen neighbour is furthest away.
 *
 * Seeded with the most inland tile rather than a random one, so the result is
 * deterministic and the first nation lands somewhere defensible.
 */
function farthestPointSample(
  candidates: number[],
  count: number,
  width: number,
  distToCoast: Int32Array,
): number[] {
  let seedIdx = 0;
  for (let i = 1; i < candidates.length; i++) {
    if (distToCoast[candidates[i]] > distToCoast[candidates[seedIdx]]) {
      seedIdx = i;
    }
  }

  const chosen = [candidates[seedIdx]];
  // Running nearest-chosen distance per candidate, updated incrementally so
  // the whole pass is O(count x candidates) rather than O(count^2 x ...).
  const nearest = new Float64Array(candidates.length).fill(Infinity);

  for (let picked = 1; picked < count; picked++) {
    const last = chosen[chosen.length - 1];
    const lx = last % width;
    const ly = (last / width) | 0;

    let bestIdx = -1;
    let bestDist = -1;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const dx = (c % width) - lx;
      const dy = ((c / width) | 0) - ly;
      const d = dx * dx + dy * dy;
      if (d < nearest[i]) nearest[i] = d;
      if (nearest[i] > bestDist) {
        bestDist = nearest[i];
        bestIdx = i;
      }
    }
    if (bestIdx < 0 || bestDist <= 0) break;
    chosen.push(candidates[bestIdx]);
    nearest[bestIdx] = -1;
  }

  return chosen;
}

/**
 * Draws distinct nation names from the default tribe-name theme.
 *
 * Reuses the game's own name pool (`resources/tribeNameThemes.json`) rather
 * than shipping a second one, so generated maps name their nations the same
 * way procedurally-named tribes are named elsewhere.
 */
export function generateNationNames(
  params: MapGenParams,
  count: number,
): string[] {
  const { prefixes, suffixes } = resolveTribeNameData();
  const rand = new PseudoRandom((params.seed ^ SEED_NATIONS) | 0);
  const used = new Set<string>();
  const names: string[] = [];

  const maxCombinations = prefixes.length * suffixes.length;
  for (let i = 0; i < count; i++) {
    let name = "";
    // Bounded retry: once the pool is nearly exhausted, fall through to a
    // numeric suffix rather than spinning.
    for (let attempt = 0; attempt < 32; attempt++) {
      const p = prefixes[Math.floor(rand.next() * prefixes.length)];
      const s = suffixes[Math.floor(rand.next() * suffixes.length)];
      name = `${p} ${s}`;
      if (!used.has(name)) break;
    }
    if (used.has(name)) {
      name = `${name} ${used.size - maxCombinations + 2}`;
    }
    used.add(name);
    names.push(name);
  }

  return names;
}
