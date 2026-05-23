// One-off script: run the production scan pipeline against a local
// image file and write each per-cell stage to /tmp/ so we can SEE what
// the algorithm thinks the ink is. Goal: tune BG_SIGMA / OTSU_MIN /
// CONTRAST_FACTOR against the real user image instead of guessing.
//
// Usage:
//   npx tsx scripts/test-scan.mts <path-to-scan.jpg>

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  computeScanLayout,
  renderDebugOverlay,
  renderDetectionDebug,
} from "../lib/font-pipeline/process-scan.ts";

const input = process.argv[2];
if (!input) {
  console.error("usage: tsx scripts/test-scan.mts <scan.jpg>");
  process.exit(1);
}
const outDir = "/tmp/scan-debug";
fs.mkdirSync(outDir, { recursive: true });

const buf = fs.readFileSync(input);
console.log(`Input: ${input} (${buf.length} bytes)`);

// First try computeScanLayout to see if markers detect
try {
  console.log("\n=== computeScanLayout ===");
  const layout = await computeScanLayout(buf);
  console.log("Markers:", JSON.stringify(layout.markers, null, 2));
  console.log("Warp:", layout.warp);
  console.log("Cells:", layout.cells.length);
  console.log("✓ marker detection OK");

  const overlay = await renderDebugOverlay(buf);
  fs.writeFileSync(
    path.join(outDir, "overlay.jpg"),
    Buffer.from(overlay.pngBase64, "base64"),
  );
  console.log(`✓ wrote ${outDir}/overlay.jpg`);

} catch (e) {
  console.error("✗ computeScanLayout failed:", e instanceof Error ? e.message : e);
  // Fall through to detection-debug
  try {
    const det = await renderDetectionDebug(buf);
    fs.writeFileSync(
      path.join(outDir, "detection.jpg"),
      Buffer.from(det.pngBase64, "base64"),
    );
    console.log(`Wrote ${outDir}/detection.jpg (${det.candidateCount} candidates at threshold ${det.thresholdUsed})`);
  } catch (e2) {
    console.error("✗ renderDetectionDebug also failed:", e2 instanceof Error ? e2.message : e2);
  }
}
