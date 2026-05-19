import { generateCalibrationPng, generateCalibrationSvg } from "@/lib/font-pipeline/calibration";

export const dynamic = "force-dynamic";

/**
 * Returns the calibration image:
 *   /api/calibration            → PNG (synthetic perfect "scan" for pipeline testing)
 *   /api/calibration?format=svg → SVG (inspect the test shapes directly)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const format = url.searchParams.get("format");
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
