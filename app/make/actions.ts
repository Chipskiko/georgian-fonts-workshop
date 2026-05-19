"use server";

import { revalidatePath } from "next/cache";
import {
  processScan,
  renderDebugOverlay,
  renderDetectionDebug,
  renderDebugView,
  type DebugView,
  type DebugViewResult,
} from "@/lib/font-pipeline/process-scan";
import { buildFont } from "@/lib/font-pipeline/build-font";
import { saveFont, dedupeFontFilename } from "@/lib/font-storage";
import { generateCalibrationPng } from "@/lib/font-pipeline/calibration";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB upload cap

function safeSegment(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[/\\?%*:|"<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type PreviewResult =
  | { ok: false; message: string }
  | {
      ok: true;
      message: string;
      glyphCount: number;
      ttfBase64: string;
      requestedName: string;
      detectedChars: string[];
    };

/**
 * Process scan and build the TTF, but DO NOT save it.
 * Returns the bytes as base64 so the client can inject a temporary @font-face
 * for the user to preview before committing to disk.
 */
export async function previewFontFromScan(formData: FormData): Promise<PreviewResult> {
  const file = formData.get("scan");
  const fontName = (formData.get("fontName") as string | null)?.trim() ?? "";
  const designer = (formData.get("designer") as string | null)?.trim() ?? "";

  if (!(file instanceof File)) return { ok: false, message: "no file" };
  if (file.size === 0) return { ok: false, message: "empty file" };
  if (file.size > MAX_BYTES) return { ok: false, message: `too large (max ${MAX_BYTES / 1024 / 1024}MB)` };

  const cleanName = safeSegment(fontName);
  if (!cleanName) return { ok: false, message: "name required" };
  const cleanDesigner = safeSegment(designer);

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return { ok: false, message: "could not read upload" };
  }

  let glyphPaths;
  try {
    glyphPaths = await processScan(buffer);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `process failed: ${e.message}` : "process failed" };
  }

  if (glyphPaths.length === 0) {
    return { ok: false, message: "no glyphs detected — check the scan and try again" };
  }

  let ttf: Uint8Array;
  try {
    ttf = buildFont(glyphPaths, { familyName: cleanName, designerName: cleanDesigner || undefined });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `font build failed: ${e.message}` : "font build failed" };
  }

  const requested = cleanDesigner ? `${cleanName}__${cleanDesigner}.ttf` : `${cleanName}.ttf`;
  const ttfBase64 = Buffer.from(ttf).toString("base64");

  return {
    ok: true,
    message: "preview ready",
    glyphCount: glyphPaths.length,
    ttfBase64,
    requestedName: requested,
    detectedChars: glyphPaths.map((g) => g.char),
  };
}

export type DebugResult =
  | { ok: false; message: string; fallback?: { pngBase64: string; width: number; height: number; candidateCount: number; thresholdUsed: number } }
  | {
      ok: true;
      pngBase64: string;
      width: number;
      height: number;
      cellCount: number;
    };

/**
 * Run the marker-detection + cell-mapping steps and return an annotated
 * preview image. Lets the user SEE where my pipeline thinks each cell is
 * before any tracing happens — invaluable for figuring out alignment bugs.
 *
 * If marker detection fails (homography can't be built), fall through to
 * `renderDetectionDebug` which shows the thresholded image with every
 * candidate blob annotated. That way the user can see WHY detection failed
 * (no candidates? wrong ones picked? markers out of frame?) rather than
 * just a generic error.
 */
export async function debugScan(formData: FormData): Promise<DebugResult> {
  const file = formData.get("scan");
  if (!(file instanceof File)) return { ok: false, message: "no file" };
  if (file.size === 0) return { ok: false, message: "empty file" };

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return { ok: false, message: "could not read upload" };
  }

  try {
    const overlay = await renderDebugOverlay(buffer);
    return {
      ok: true,
      pngBase64: overlay.pngBase64,
      width: overlay.width,
      height: overlay.height,
      cellCount: overlay.layout.cells.length,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "debug failed";
    // Try the detection-debug fallback. Render an annotated image showing
    // every candidate component the detector found, even though the full
    // pipeline couldn't complete.
    try {
      const fallback = await renderDetectionDebug(buffer);
      return { ok: false, message, fallback };
    } catch {
      return { ok: false, message };
    }
  }
}

export type TunableDebugResult =
  | { ok: false; message: string }
  | { ok: true; debug: DebugViewResult };

/**
 * Return the synthetic calibration image as base64, so the tuner can load
 * it as a known-good source and inspect every view (thresholded /
 * candidates / warped / cells / vectorized) against unambiguous content.
 * Isolates pipeline bugs from source-image variables.
 */
export async function getCalibrationImage(): Promise<{ ok: true; base64: string } | { ok: false; message: string }> {
  try {
    const png = await generateCalibrationPng();
    return { ok: true, base64: Buffer.from(png).toString("base64") };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "failed to render calibration" };
  }
}

/**
 * Tunable debug view for the interactive tuning UI.
 *
 * The form lets the user scrub threshold/blur/trace-threshold sliders and
 * switch between four view modes (thresholded, candidates, warped,
 * vectorized). Each slider change re-calls this action with the new
 * params, so the user can see the effect live without re-uploading.
 *
 * The form sends the file once (as a base64-encoded blob) and caches it
 * client-side; subsequent re-renders are pure server-side recompute.
 */
export async function tunableDebugScan(
  fileBase64: string,
  view: DebugView,
  threshold: number,
  blur: number,
  traceThreshold: number,
): Promise<TunableDebugResult> {
  if (!fileBase64) return { ok: false, message: "no file" };
  let buffer: Buffer;
  try {
    buffer = Buffer.from(fileBase64, "base64");
  } catch {
    return { ok: false, message: "could not decode file" };
  }
  if (buffer.length === 0) return { ok: false, message: "empty file" };
  if (buffer.length > MAX_BYTES) {
    return { ok: false, message: `too large (max ${MAX_BYTES / 1024 / 1024}MB)` };
  }
  try {
    const debug = await renderDebugView(buffer, {
      view,
      threshold,
      blur,
      traceThreshold,
    });
    return { ok: true, debug };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "debug failed" };
  }
}

/**
 * Run the synthetic calibration image through the same debug + preview
 * pipeline as a real upload. Lets us validate marker detection, cell
 * mapping, threshold, trace, and font assembly WITHOUT any scanning.
 */
export async function runCalibration(): Promise<{
  ok: true;
  debug: { pngBase64: string; width: number; height: number; cellCount: number };
  preview: Extract<PreviewResult, { ok: true }>;
} | { ok: false; message: string }> {
  let calibrationPng: Buffer;
  try {
    calibrationPng = await generateCalibrationPng();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `calibration generation failed: ${e.message}` : "calibration generation failed" };
  }

  let overlay;
  try {
    overlay = await renderDebugOverlay(calibrationPng);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `debug overlay failed: ${e.message}` : "debug overlay failed" };
  }

  // Reuse the existing preview pipeline by stuffing the calibration PNG into a FormData
  const fd = new FormData();
  const pngArray = new Uint8Array(calibrationPng);
  fd.set("scan", new File([pngArray], "calibration.png", { type: "image/png" }));
  fd.set("fontName", "calibration");
  fd.set("designer", "synthetic");
  const preview = await previewFontFromScan(fd);
  if (!preview.ok) {
    return { ok: false, message: `preview failed: ${preview.message}` };
  }

  return {
    ok: true,
    debug: {
      pngBase64: overlay.pngBase64,
      width: overlay.width,
      height: overlay.height,
      cellCount: overlay.layout.cells.length,
    },
    preview,
  };
}

/**
 * Commit a previously-previewed TTF to storage.
 */
export async function saveFontFromPreview(
  ttfBase64: string,
  requestedName: string,
): Promise<{ ok: boolean; message: string }> {
  if (!ttfBase64 || !requestedName) return { ok: false, message: "missing data" };
  if (!requestedName.endsWith(".ttf")) return { ok: false, message: "invalid name" };

  let bytes: Buffer;
  try {
    bytes = Buffer.from(ttfBase64, "base64");
  } catch {
    return { ok: false, message: "could not decode font" };
  }
  if (bytes.length === 0) return { ok: false, message: "empty font" };
  if (bytes.length > 5 * 1024 * 1024) return { ok: false, message: "font too large" };

  const finalName = await dedupeFontFilename(requestedName);
  await saveFont(finalName, bytes);

  revalidatePath("/");
  revalidatePath("/cascade");
  revalidatePath("/add");
  revalidatePath("/posterizer");
  revalidatePath("/make");

  return { ok: true, message: `saved ${finalName}` };
}
