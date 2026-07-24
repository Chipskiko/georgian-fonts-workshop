import { generateCalibrationPng, generateCalibrationSvg } from "@/lib/font-pipeline/calibration";
import { generateHandDrawnJpeg, generateHandDrawnSvg } from "@/lib/font-pipeline/handdrawn-scan";

export const dynamic = "force-dynamic";

/**
 * Returns a synthetic test scan:
 *   /api/calibration                        → PNG, crisp diagnostic sheet (geometry checks)
 *   /api/calibration?format=svg             → the SVG source of the above
 *   /api/calibration?style=hand             → JPEG, simulated hand-drawn sheet
 *                                             (greyscale wobbly letters, noise, blur,
 *                                             JPEG artifacts — realistic pipeline test)
 *   /api/calibration?style=hand&seed=7      → different hand-drawn variant (deterministic per seed)
 *   /api/calibration?style=hand&format=svg  → the SVG source (pre blur/JPEG)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const format = url.searchParams.get("format");
  const style = url.searchParams.get("style");

  if (style === "hand") {
    const seed = Number(url.searchParams.get("seed")) || 42;
    if (format === "svg") {
      return new Response(await generateHandDrawnSvg(seed), {
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" },
      });
    }
    const jpeg = await generateHandDrawnJpeg(seed);
    return new Response(new Uint8Array(jpeg).buffer as ArrayBuffer, {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
    });
  }

  if (format === "svg") {
    return new Response(await generateCalibrationSvg(), {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "no-store",
      },
    });
  }
  const png = await generateCalibrationPng();
  return new Response(new Uint8Array(png).buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    },
  });
}
