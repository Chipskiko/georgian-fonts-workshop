// Run a scan through the pipeline's tuner views (cells / binary /
// vectorized) so we can SEE what the algorithm produces, instead of
// tuning blindly.
//
// Usage:
//   npx tsx scripts/test-cell.mts <scan.jpg>

import fs from "node:fs";
import path from "node:path";
import { renderDebugView } from "../lib/font-pipeline/process-scan.ts";

const input = process.argv[2];
if (!input) {
  console.error("usage: tsx scripts/test-cell.mts <scan.jpg>");
  process.exit(1);
}
const outDir = "/tmp/scan-cell";
fs.mkdirSync(outDir, { recursive: true });

const buf = fs.readFileSync(input);

for (const view of ["cells", "bg", "normalized", "binary", "smoothed", "vectorized"] as const) {
  console.log(`Rendering ${view}...`);
  const result = await renderDebugView(buf, { view });
  if (result.pngBase64) {
    const out = path.join(outDir, `${view}.jpg`);
    fs.writeFileSync(out, Buffer.from(result.pngBase64, "base64"));
    console.log(`  → ${out}  (${result.width}x${result.height}, ${result.cellCount ?? "n/a"} cells)`);
  }
}
console.log("\n✓ done. Compare with `open /tmp/scan-cell/*.jpg`");
