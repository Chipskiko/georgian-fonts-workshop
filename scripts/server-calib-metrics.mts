// Server-pipeline ground truth for the calibration scan: per-glyph
// advance + ink bbox at em=1000. Compared against browser-side canvas
// metrics of the device-built font for the same input.
import opentype from "opentype.js";
import { generateCalibrationPng } from "../lib/font-pipeline/calibration";
import { processScan } from "../lib/font-pipeline/process-scan";
import { buildFont } from "../lib/font-pipeline/build-font";

const png = await generateCalibrationPng();
const glyphs = await processScan(png);
console.log(`processScan: ${glyphs.length} glyphs`);
const bytes = buildFont(glyphs, { familyName: "servertest" });
const font = opentype.parse(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
);
console.log(`built font: upem=${font.unitsPerEm} glyphs=${font.glyphs.length}`);
const cmap = (font.tables as any).cmap;
const entries = Object.entries(cmap.glyphIndexMap as Record<string, number>)
  .map(([cp, gi]) => [Number(cp), gi] as const)
  .filter(([cp]) => cp >= 0x10d0 && cp <= 0x10f0)
  .sort((a, b) => a[0] - b[0]);
for (const [cp, gi] of entries.slice(0, 8)) {
  const g = font.glyphs.get(gi);
  const p = g.getPath(0, 0, 1000);
  const b = p.getBoundingBox();
  console.log(
    `  ${String.fromCodePoint(cp)}  adv=${Math.round((g.advanceWidth ?? 0) * (1000 / font.unitsPerEm))}  ink=${Math.round(b.x2 - b.x1)}×${Math.round(b.y2 - b.y1)} @${Math.round(b.x1)},${Math.round(b.y1)}`,
  );
}
