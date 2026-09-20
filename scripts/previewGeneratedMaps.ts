/**
 * Development harness: generates one map per archetype and writes each as a
 * PNG, so generator changes can be judged by eye.
 *
 * Not part of the build or the test suite. Run with
 * `npx tsx scripts/previewGeneratedMaps.ts [outDir]`.
 */

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { generateMap } from "../src/core/game/generator/GenerateMap";
import { MapArchetype } from "../src/core/game/generator/MapGenTypes";
import { unpackTerrain } from "../src/core/game/generator/PackTerrain";
import { renderPreview } from "../src/core/game/generator/Thumbnail";

const outDir =
  process.argv[2] ?? path.join(import.meta.dirname, "..", ".mapgen-preview");
fs.mkdirSync(outDir, { recursive: true });

/** Minimal PNG encoder — avoids pulling a dependency in for a dev script. */
function writePng(
  file: string,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): void {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter type 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData) >>> 0);
    return Buffer.concat([len, typeAndData, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

let crcTable: number[] | null = null;
function crc32(buf: Buffer): number {
  if (crcTable === null) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return c ^ 0xffffffff;
}

const archetypes = [
  MapArchetype.Continents,
  MapArchetype.Archipelago,
  MapArchetype.Pangaea,
  MapArchetype.InlandSea,
  MapArchetype.LakesRivers,
];

console.log(`Writing previews to ${outDir}\n`);
console.log(
  "archetype".padEnd(14) +
    "want".padEnd(14) +
    "got".padEnd(20) +
    "nations".padEnd(9) +
    "ms",
);

for (const archetype of archetypes) {
  const params = {
    archetype,
    seed: 12345,
    width: 1000,
    height: 752,
    islandCount: archetype === MapArchetype.Archipelago ? 14 : 4,
    landCoverage: 0.4,
    mountainousness: 0.5,
    coastlineRoughness: 0.5,
    nationCount: 12,
  };

  const bundle = generateMap(params);
  // Render from the packed bytes, not the working grid, so the preview shows
  // exactly what the game will load.
  const grid = unpackTerrain(
    bundle.map4xBin,
    bundle.manifest.map4x.width,
    bundle.manifest.map4x.height,
  );
  const img = renderPreview(grid);
  writePng(
    path.join(outDir, `${archetype}.png`),
    img.data,
    img.width,
    img.height,
  );

  console.log(
    archetype.padEnd(14) +
      `${params.islandCount} isl / ${(params.landCoverage * 100).toFixed(0)}%`.padEnd(
        14,
      ) +
      `${bundle.stats.islandCount} isl / ${(bundle.stats.landFraction * 100).toFixed(1)}%`.padEnd(
        20,
      ) +
      String(bundle.manifest.nations.length).padEnd(9) +
      bundle.stats.generationMs,
  );
}

console.log("\nDone.");
