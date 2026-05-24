"use server";

import { revalidatePath, updateTag } from "next/cache";
import { FONTS_LIST_TAG } from "@/lib/fonts";
import {
  processScan,
  renderDebugOverlay,
  renderDetectionDebug,
  renderDebugView,
  type DebugView,
  type DebugViewResult,
} from "@/lib/font-pipeline/process-scan";
import { buildFont } from "@/lib/font-pipeline/build-font";
import { saveFont } from "@/lib/font-storage";
import { generateCalibrationPng } from "@/lib/font-pipeline/calibration";
import {
  deleteDebugImageByUrl,
  newDebugFilename,
  saveDebugImage,
  sweepOldDebugImages,
} from "@/lib/debug-storage";

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

  if (!(file instanceof File)) return { ok: false, message: "ფაილი არ არის" };
  if (file.size === 0) return { ok: false, message: "ცარიელი ფაილი" };
  if (file.size > MAX_BYTES) return { ok: false, message: `ძალიან დიდია (მაქს ${MAX_BYTES / 1024 / 1024}MB)` };

  const cleanName = safeSegment(fontName);
  if (!cleanName) return { ok: false, message: "სახელი სავალდებულოა" };
  const cleanDesigner = safeSegment(designer);

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return { ok: false, message: "ფაილის წაკითხვა ვერ მოხერხდა" };
  }

  let glyphPaths;
  try {
    glyphPaths = await processScan(buffer);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `დამუშავება ვერ შესრულდა: ${e.message}` : "დამუშავება ვერ შესრულდა" };
  }

  if (glyphPaths.length === 0) {
    return { ok: false, message: "ასოები ვერ მოიძებნა — შეამოწმე სკანი და სცადე თავიდან" };
  }

  let ttf: Uint8Array;
  try {
    ttf = buildFont(glyphPaths, { familyName: cleanName, designerName: cleanDesigner || undefined });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `შრიფტის შექმნა ვერ მოხერხდა: ${e.message}` : "შრიფტის შექმნა ვერ მოხერხდა" };
  }

  // .otf — opentype.js produces CFF-outline fonts (magic "OTTO"), which is
  // the OpenType format. Saving them as .ttf was a 3-way lie (filename,
  // CSS format hint, Content-Type all said TTF while bytes were OTF), and
  // browsers' nosniff + cross-origin font loading rejected the mismatch.
  const requested = cleanDesigner ? `${cleanName}__${cleanDesigner}.otf` : `${cleanName}.otf`;
  const ttfBase64 = Buffer.from(ttf).toString("base64");

  return {
    ok: true,
    message: "გადახედვა მზადაა",
    glyphCount: glyphPaths.length,
    ttfBase64,
    requestedName: requested,
    detectedChars: glyphPaths.map((g) => g.char),
  };
}

export type DebugResult =
  | { ok: false; message: string; fallback?: { url: string; width: number; height: number; candidateCount: number; thresholdUsed: number } }
  | {
      ok: true;
      /** URL of the debug image stored in Blob (or /debug/ on local FS). The
       *  client should call `deleteDebugImage(url)` once the <img> loads to
       *  free the storage immediately; an opportunistic sweep also collects
       *  anything older than 5 min on the next debug invocation. */
      url: string;
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
/**
 * Save a debug image (returned by the renderer as a base64 JPEG) to
 * Blob storage and return its public URL. The renderer's pngBase64
 * field is the JPEG bytes already encoded — we just decode and stash.
 *
 * Centralized helper so both the success and fallback paths take the
 * same well-tested route. Wraps storage failures into a thrown error
 * so the action's outer try/catch surfaces a friendly message rather
 * than leaving the client with a half-broken response.
 */
async function persistDebugImage(pngBase64: string): Promise<string> {
  const bytes = Buffer.from(pngBase64, "base64");
  return saveDebugImage(newDebugFilename(), bytes);
}

export async function debugScan(formData: FormData): Promise<DebugResult> {
  // Heavily traced because production hits "Server Components render"
  // errors that should be impossible given the outer try/catch — the
  // stage markers narrow down WHERE the throw bypasses our handlers
  // when reading Vercel function logs.
  console.log("[debugScan] START");
  // Outermost try wraps the ENTIRE action body. Any uncaught throw past
  // this point — OOM in sharp, decode failure, response too large — gets
  // converted into a structured response so the client sees a real
  // Georgian error message instead of Next's generic "Server Components
  // render" wrapper. Also logs to stderr so Vercel function logs capture
  // the underlying stack trace (the digest hash shown to the user maps
  // to that log entry).
  try {
    // Opportunistic GC: reap any debug images older than the TTL before
    // creating a new one. Cheap (one list call) and keeps Blob storage
    // bounded without a separate cron. Failures here are non-fatal —
    // we'd rather generate a debug image than abort because cleanup
    // tripped, so swallow + log.
    try {
      const deleted = await sweepOldDebugImages();
      console.log(`[debugScan] sweep ok (deleted=${deleted})`);
    } catch (e) {
      console.warn("[debugScan] sweep failed (non-fatal):", e);
    }

    const file = formData.get("scan");
    if (!(file instanceof File)) {
      console.log("[debugScan] EARLY-EXIT no file");
      return { ok: false, message: "ფაილი არ არის" };
    }
    if (file.size === 0) {
      console.log("[debugScan] EARLY-EXIT empty file");
      return { ok: false, message: "ცარიელი ფაილი" };
    }
    if (file.size > MAX_BYTES) {
      console.log(`[debugScan] EARLY-EXIT file too big: ${file.size}`);
      return { ok: false, message: `ფაილი ძალიან დიდია (მაქს ${MAX_BYTES / 1024 / 1024}MB)` };
    }
    console.log(`[debugScan] file ok: ${file.size}b`);

    let buffer: Buffer;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
      console.log(`[debugScan] buffer ok: ${buffer.length}b`);
    } catch (e) {
      console.error("[debugScan] arrayBuffer failed:", e);
      return { ok: false, message: "ფაილის წაკითხვა ვერ მოხერხდა" };
    }

    try {
      console.log("[debugScan] calling renderDebugOverlay");
      const overlay = await renderDebugOverlay(buffer);
      console.log(`[debugScan] overlay ok: ${overlay.width}x${overlay.height} cells=${overlay.layout.cells.length} b64len=${overlay.pngBase64.length}`);
      // Push the rendered JPEG out-of-band so the RSC response carries
      // only a short URL string. Avoids the ~1MB streaming-payload
      // limit that surfaced as the generic "Server Components render"
      // error on high-res phone scans.
      console.log("[debugScan] calling persistDebugImage");
      const url = await persistDebugImage(overlay.pngBase64);
      console.log(`[debugScan] persist ok: ${url}`);
      const result = {
        ok: true as const,
        url,
        width: overlay.width,
        height: overlay.height,
        cellCount: overlay.layout.cells.length,
      };
      console.log("[debugScan] DONE ok");
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : "დებაგი ვერ შესრულდა";
      console.error("[debugScan] renderDebugOverlay path failed:", e);
      // Try the detection-debug fallback. Render an annotated image
      // showing every candidate component the detector found, even
      // though the full pipeline couldn't complete.
      try {
        console.log("[debugScan] calling renderDetectionDebug (fallback)");
        const fallback = await renderDetectionDebug(buffer);
        console.log(`[debugScan] fallback ok: ${fallback.width}x${fallback.height} b64len=${fallback.pngBase64.length}`);
        console.log("[debugScan] persisting fallback image");
        const fallbackUrl = await persistDebugImage(fallback.pngBase64);
        console.log(`[debugScan] fallback persist ok: ${fallbackUrl}`);
        const result = {
          ok: false as const,
          message,
          fallback: {
            url: fallbackUrl,
            width: fallback.width,
            height: fallback.height,
            candidateCount: fallback.candidateCount,
            thresholdUsed: fallback.thresholdUsed,
          },
        };
        console.log("[debugScan] DONE fallback");
        return result;
      } catch (fbErr) {
        console.error("[debugScan] renderDetectionDebug failed:", fbErr);
        console.log("[debugScan] DONE message-only");
        return { ok: false, message };
      }
    }
  } catch (top) {
    // The catch-all. Anything past here means something threw that we
    // weren't expecting (likely OOM, function timeout, or a sharp
    // libvips abort). Surface a structured response so the client
    // doesn't see Next's generic error wrapper.
    console.error("[debugScan] TOP-LEVEL CATCH:", top);
    const msg = top instanceof Error ? top.message : "უცნობი შეცდომა";
    return { ok: false, message: `დებაგი ჩავარდა: ${msg}` };
  }
}

/**
 * Client-side cleanup hook. The MakeFontForm img's onLoad/onError fires
 * this so the blob is freed within a second or two of being created in
 * the typical happy path. Best-effort — failures are swallowed because
 * the opportunistic sweep in debugScan covers any leaks.
 */
export async function deleteDebugImage(url: string): Promise<void> {
  if (!url) return;
  try {
    await deleteDebugImageByUrl(url);
  } catch (e) {
    console.warn("[deleteDebugImage] failed (non-fatal):", e);
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
    return { ok: false, message: e instanceof Error ? e.message : "კალიბრაცია ვერ შესრულდა" };
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
/**
 * RSC payload safety margin for the tuner. Each tunableDebugScan
 * response carries the rendered view's base64 — same ~1MB hard limit
 * as debugScan. Unlike debugScan (which writes out-of-band to Blob),
 * the tuner stays inline because slider drags re-fire on every value
 * change and we don't want one blob write+delete per drag. Instead
 * we re-encode the JPEG at lower quality until it fits.
 */
const MAX_TUNER_B64_BYTES = 900_000;

/**
 * If `b64` is over the RSC limit, re-encode the underlying JPEG at
 * progressively lower quality until it fits. Returns the resized
 * base64 or null if even q15 won't fit (caller should drop the image
 * and surface a textual message instead of risking the "Server
 * Components render" wrapper).
 *
 * No-op fast path when the input is already under the limit, so the
 * common case pays nothing.
 */
async function fitTunerImage(b64: string): Promise<string | null> {
  if (b64.length <= MAX_TUNER_B64_BYTES) return b64;
  const sharp = (await import("sharp")).default;
  const buf = Buffer.from(b64, "base64");
  for (const quality of [60, 40, 25, 15]) {
    const out = (await sharp(buf).jpeg({ quality }).toBuffer()).toString("base64");
    if (out.length <= MAX_TUNER_B64_BYTES) {
      console.log(`[tunableDebugScan] recompressed to q${quality} (${out.length}b)`);
      return out;
    }
  }
  return null;
}

export async function tunableDebugScan(
  fileBase64: string,
  view: DebugView,
  threshold: number,
  blur: number,
  traceThreshold: number,
): Promise<TunableDebugResult> {
  try {
    if (!fileBase64) return { ok: false, message: "ფაილი არ არის" };
    let buffer: Buffer;
    try {
      buffer = Buffer.from(fileBase64, "base64");
    } catch (e) {
      console.error("[tunableDebugScan] base64 decode failed:", e);
      return { ok: false, message: "ფაილის გაშიფვრა ვერ მოხერხდა" };
    }
    if (buffer.length === 0) return { ok: false, message: "ცარიელი ფაილი" };
    if (buffer.length > MAX_BYTES) {
      return { ok: false, message: `ძალიან დიდია (მაქს ${MAX_BYTES / 1024 / 1024}MB)` };
    }
    try {
      const debug = await renderDebugView(buffer, {
        view,
        threshold,
        blur,
        traceThreshold,
      });
      const fitted = await fitTunerImage(debug.pngBase64);
      if (fitted === null) {
        console.warn(
          `[tunableDebugScan] view '${view}' too large even at q15, dropping`,
        );
        return {
          ok: false,
          message: "სურათი ძალიან დიდია გადასაცემად — სცადე სხვა ხედი ან შეამცირე სკანი",
        };
      }
      debug.pngBase64 = fitted;
      return { ok: true, debug };
    } catch (e) {
      console.error("[tunableDebugScan] renderDebugView failed:", e);
      return { ok: false, message: e instanceof Error ? e.message : "დებაგი ვერ შესრულდა" };
    }
  } catch (top) {
    // Same outermost wrapper as debugScan — catches OOM / timeout /
    // anything we didn't anticipate so the client sees a real message
    // instead of Next's generic "Server Components render" wrapper.
    console.error("[tunableDebugScan] top-level catch:", top);
    const msg = top instanceof Error ? top.message : "უცნობი შეცდომა";
    return { ok: false, message: `დებაგი ჩავარდა: ${msg}` };
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
    return { ok: false, message: e instanceof Error ? `კალიბრაციის შექმნა ვერ შესრულდა: ${e.message}` : "კალიბრაციის შექმნა ვერ შესრულდა" };
  }

  let overlay;
  try {
    overlay = await renderDebugOverlay(calibrationPng);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `დებაგი ვერ შესრულდა: ${e.message}` : "დებაგი ვერ შესრულდა" };
  }

  // Reuse the existing preview pipeline by stuffing the calibration PNG into a FormData
  const fd = new FormData();
  const pngArray = new Uint8Array(calibrationPng);
  fd.set("scan", new File([pngArray], "calibration.png", { type: "image/png" }));
  fd.set("fontName", "calibration");
  fd.set("designer", "synthetic");
  const preview = await previewFontFromScan(fd);
  if (!preview.ok) {
    return { ok: false, message: `გადახედვა ვერ შესრულდა: ${preview.message}` };
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
  if (!ttfBase64 || !requestedName) return { ok: false, message: "მონაცემები აკლია" };
  if (!requestedName.endsWith(".otf")) return { ok: false, message: "არასწორი სახელი" };

  let bytes: Buffer;
  try {
    bytes = Buffer.from(ttfBase64, "base64");
  } catch {
    return { ok: false, message: "შრიფტის გაშიფვრა ვერ მოხერხდა" };
  }
  if (bytes.length === 0) return { ok: false, message: "ცარიელი შრიფტი" };
  if (bytes.length > 5 * 1024 * 1024) return { ok: false, message: "შრიფტი ძალიან დიდია" };

  // saveFont appends its own collision-safe random suffix.
  const saved = await saveFont(requestedName, bytes);
  const finalName = saved.filename;

  // Single tag-based invalidation drops the cached font list across
  // every consumer (layout + every page that calls getFonts). Layout-
  // level revalidatePath ensures the root layout's tree gets rebuilt
  // even if a route handler somewhere bypasses the tag system.
  updateTag(FONTS_LIST_TAG);
  revalidatePath("/", "layout");

  return { ok: true, message: `შენახულია ${finalName}` };
}
