import sharp from "sharp";
import { generateCalibrationPng } from "../lib/font-pipeline/calibration";
import { generateHandDrawnJpeg } from "../lib/font-pipeline/handdrawn-scan";
import { processScan } from "../lib/font-pipeline/process-scan";
import { UPSIDE_DOWN_MESSAGE } from "../lib/font-pipeline/constants";

async function run(label: string, img: Buffer) {
  try {
    const glyphs = await processScan(img);
    return `${label}: OK (${glyphs.length} glyphs)`;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return `${label}: THROW "${m}"${m === UPSIDE_DOWN_MESSAGE ? " ✓upside-down" : ""}`;
  }
}

for (const [name, gen] of [
  ["calibration", () => generateCalibrationPng()],
  ["handdrawn seed1", () => generateHandDrawnJpeg(1)],
  ["handdrawn seed7", () => generateHandDrawnJpeg(7)],
] as const) {
  const upright = await gen();
  const flipped = await sharp(upright).rotate(180).png().toBuffer();
  console.log(await run(`${name} UPRIGHT`, upright), "| EXPECT OK");
  console.log(await run(`${name} FLIPPED`, flipped), "| EXPECT upside-down reject");
}
