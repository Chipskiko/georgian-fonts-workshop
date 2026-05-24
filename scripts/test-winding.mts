// Build a font from a scan + verify the resulting glyphs have correct
// CFF winding (outer one direction, inner contours opposite). Used to
// confirm the fix in build-font.ts before deploying.
//
// Usage:
//   npx tsx scripts/test-winding.mts <scan.jpg>

import fs from "node:fs";
import opentypeMod from "opentype.js";
import { processScan } from "../lib/font-pipeline/process-scan.ts";
import { buildFont } from "../lib/font-pipeline/build-font.ts";

const opentype = opentypeMod.default ?? opentypeMod;

const input = process.argv[2];
if (!input) {
  console.error("usage: tsx scripts/test-winding.mts <scan.jpg>");
  process.exit(1);
}
const buf = fs.readFileSync(input);

console.log("running processScan...");
const paths = await processScan(buf);
console.log(`got ${paths.length} glyph paths`);

console.log("building font...");
const bytes = buildFont(paths, { familyName: "windingtest", designerName: "test" });
fs.writeFileSync("/tmp/winding-test.otf", bytes);
console.log(`wrote /tmp/winding-test.otf (${bytes.length} bytes)`);

const font = opentype.parse(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
);

// Check several hole-containing glyphs
let pass = 0, fail = 0;
for (const ch of ["ი", "ბ", "ხ", "ე", "ო", "დ", "ფ"]) {
  const idx = font.charToGlyphIndex(ch);
  if (idx <= 0) continue;
  const g = font.glyphs.get(idx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const path = g.getPath(0, 0, 1000) as any;
  const cmds = path.commands;

  const subpaths: typeof cmds[] = [];
  let current: typeof cmds = [];
  for (const c of cmds) {
    if (c.type === "M" && current.length > 0) {
      subpaths.push(current);
      current = [];
    }
    current.push(c);
  }
  if (current.length > 0) subpaths.push(current);

  if (subpaths.length < 2) continue; // no holes, skip

  // Compute signed area for each subpath
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const areas = subpaths.map((sp: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pts: [number, number][] = sp.filter((c: any) => c.type !== "Z").map((c: any) => [c.x, c.y]);
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      a += x1 * y2 - x2 * y1;
    }
    return a / 2;
  });

  // outer = largest absolute area
  let outerIdx = 0;
  for (let i = 1; i < areas.length; i++) {
    if (Math.abs(areas[i]) > Math.abs(areas[outerIdx])) outerIdx = i;
  }
  const outerSign = Math.sign(areas[outerIdx]);
  const allInnerCorrect = areas.every((a, i) => i === outerIdx || Math.sign(a) !== outerSign);

  const result = allInnerCorrect ? "PASS" : "FAIL";
  if (allInnerCorrect) pass++; else fail++;
  console.log(`  '${ch}' ${result}: outer area=${areas[outerIdx].toFixed(0).padStart(8)} ${outerSign>0?'CCW':'CW'}, inners=[${areas.filter((_, i) => i !== outerIdx).map(a => a.toFixed(0)).join(", ")}]`);
}

console.log(`\n${pass} pass / ${fail} fail`);
