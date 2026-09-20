/**
 * Typed access to the statistics measured from the shipped maps.
 *
 * `resources/mapStyleProfile.json` is produced by `scripts/analyzeMaps.ts`
 * (`npm run analyze-maps`) from each map.bin under `resources/maps`. It is what
 * keeps generated terrain in the same visual family as the hand-drawn maps:
 * slider ranges come from the real percentiles, and the elevation
 * distribution is matched to the real one rather than invented.
 */

import profileData from "resources/mapStyleProfile.json";
import { ARCHETYPE_BASIS, type MapArchetype } from "./MapGenTypes";

export interface Distribution {
  p10: number;
  p50: number;
  p90: number;
  mean: number;
}

export interface ArchetypeProfile {
  mapCount: number;
  members: string[];
  landFraction: Distribution;
  significantBodies: Distribution;
  largestBodyShare: Distribution;
  coastlineRoughness: Distribution;
  enclosedWaterShare: Distribution;
  nationCount: Distribution;
  /** Share of land tiles at each magnitude 0-30, summing to 1. */
  elevationHistogram: number[];
  /** Mean land magnitude by distance inland from the coast, in tiles. */
  elevByCoastDist: number[];
}

export interface StyleProfile {
  version: number;
  generatedAt: string;
  global: ArchetypeProfile;
  archetypes: Record<string, ArchetypeProfile>;
}

export const styleProfile = profileData as unknown as StyleProfile;

/**
 * The measured family an archetype draws its statistics from.
 *
 * Inland Sea and Lakes & Rivers have no measured cluster of their own (see
 * MapGenTypes), so they borrow from Pangaea and Continents.
 */
export function profileFor(archetype: MapArchetype): ArchetypeProfile {
  return (
    styleProfile.archetypes[ARCHETYPE_BASIS[archetype]] ?? styleProfile.global
  );
}
