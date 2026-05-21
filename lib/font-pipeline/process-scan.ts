import sharp from "sharp";
import potrace from "potrace";
import {
  ALPHABET,
  A4_W_PT,
  A4_H_PT,
  PAGE_MARGIN,
  MARKER_SIZE,
  MARKER_CENTERS_PT,
  boxBoundsPt,
} from "./constants";

export type GlyphPath = {
  index: number;
  char: string;
  svgPath: string;
  cellWidthPx: number;
  cellHeightPx: number;
};

export type CellPxRect = { index: number; char: string; x: number; y: number; w: number; h: number };

export type MarkerSet = {
  tl: { x: number; y: number };
  tr: { x: number; y: number };
  bl: { x: number; y: number };
  br: { x: number; y: number };
  mt: { x: number; y: number };
  mb: { x: number; y: number };
};

export type ScanLayout = {
  imageWidth: number;
  imageHeight: number;
  /** All 6 markers in INPUT image px coords. */
  markers: MarkerSet;
  /** Cell rects in INPUT image coords (used by the debug overlay) */
  cells: CellPxRect[];
  /** Canonical PT → input image PX warp. 4-corner perspective homography
   * (9-element flat array). Rigid 8-DOF fit — exact for flat paper and
   * doesn't bend with detection noise. The 2 mid-edge markers are used
   * only for collinearity validation, not for the warp transform. */
  warp: number[];
};

// Canonical output dimensions for the perspective-warped image.
// At 2100px wide, 1pt ≈ 3.53px, so the printed guide lines (~0.3pt) become
// ~1px in the warped buffer.
const CANONICAL_W = 2100;
const CANONICAL_H = Math.round(CANONICAL_W * (A4_H_PT / A4_W_PT));
const PT_TO_CANONICAL_PX = CANONICAL_W / A4_W_PT;

/**
 * SINGLE SOURCE OF TRUTH for cell extraction rectangles in the warped
 * canonical image. ALL three callsites use this — production processScan,
 * debug warped-view pink rects, debug cells-view extraction. If this is
 * right, every cell-related rendering is right; if it's wrong, every cell
 * rendering is wrong in exactly the same way.
 *
 * @param i 0-based alphabet index
 * @param insetPt Pixels inset from the box edge (in PT). Used to keep
 *                the printed cell-border line out of trace input. Pass 0
 *                for the full box (debug cells view); pass 3 for the
 *                production crop and the warped-view pink rect.
 */
export function cellExtractRect(i: number, insetPt = 0): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const box = boxBoundsPt(i);
  const insetPx = Math.round(insetPt * PT_TO_CANONICAL_PX);
  const x = Math.round(box.x * PT_TO_CANONICAL_PX) + insetPx;
  const y = Math.round((A4_H_PT - box.y - box.h) * PT_TO_CANONICAL_PX) + insetPx;
  const w = Math.round(box.w * PT_TO_CANONICAL_PX) - insetPx * 2;
  const h = Math.round(box.h * PT_TO_CANONICAL_PX) - insetPx * 2;
  return { x, y, w, h };
}

// Tuned for experimental type with stronger smoothing — corners become
// curves rather than sharp angles, and redundant Bezier control points
// get simplified out so the saved font reads as flowing rather than jaggy.
//   optTolerance 0.4: aggressive curve simplification (was 0.15)
//   turdSize 30: drops printed-template dotted guide marks (~13 px area
//                each) plus paper-texture specks, while keeping legitimate
//                ink (always hundreds to thousands of px in area).
//   alphaMax 1.2: strongly rounded corners (was 0.7; max 1.333 = razor-smooth)
const TRACE_OPTIONS: potrace.PotraceOptions = {
  threshold: 180,
  optTolerance: 0.4,
  turdSize: 30,
  alphaMax: 1.2,
};

// =====================================================================
//  Public entry points
// =====================================================================

export async function computeScanLayout(buffer: Buffer): Promise<ScanLayout> {
  try {
    await sharp(buffer).metadata();
  } catch (e) {
    throw new Error(
      `could not decode image — try saving as JPG or PNG. (${e instanceof Error ? e.message : "unknown"})`,
    );
  }

  // sharp().rotate().metadata() returns the SOURCE metadata, not the
  // post-rotation dimensions — so for iPhone portrait photos (landscape
  // sensor, EXIF=6) it reports 4032×3024 while .rotate() in the actual
  // pipeline produces 3024×4032 portrait pixels. If we naively use the
  // source dims, the subsequent resize() target ends up landscape and
  // jams the rotated portrait pixels in, squeezing them vertically.
  // Read source dims + EXIF orientation, swap manually.
  const srcMeta = await sharp(buffer).metadata();
  const srcW = srcMeta.width;
  const srcH = srcMeta.height;
  if (!srcW || !srcH) throw new Error("could not read image dimensions");
  const exifOri = srcMeta.orientation ?? 1;
  const swapDims = exifOri >= 5 && exifOri <= 8;
  const oriW = swapDims ? srcH : srcW;
  const oriH = swapDims ? srcW : srcH;

  // Marker detection runs on a downscaled threshold. Working at ~1500px keeps
  // the connected-component scan fast while preserving 40+px markers.
  const DETECT_W = 1500;
  const detectScale = DETECT_W / oriW;
  const detectH = Math.round(oriH * detectScale);

  // Try a sequence of thresholds. Lighting variation across photos can shift
  // the ink/paper cut by 40+ levels — a single fixed threshold is unreliable.
  // 110 is the well-lit default; 130/90 handle bright/dim; 150 is for very
  // dim photos with low contrast; 70 is for over-exposed photos where paper
  // is near-white and ink is mid-grey.
  const THRESHOLDS = [110, 130, 90, 150, 70];
  let detectMarkers: MarkerSet | null = null;
  let detectBuf: Buffer | null = null;
  let usedThreshold = 110;
  for (const t of THRESHOLDS) {
    const result = await sharp(buffer)
      .rotate()
      .resize(DETECT_W, detectH, { fit: "fill" })
      .greyscale()
      .normalize()
      .threshold(t)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const m = findMarkers(result.data, DETECT_W, detectH);
    if (m) {
      detectMarkers = m;
      detectBuf = result.data;
      usedThreshold = t;
      break;
    }
    detectBuf = result.data;
  }
  void usedThreshold;

  if (!detectMarkers) {
    const candidates = detectBuf ? findAllMarkerCandidates(detectBuf, DETECT_W, detectH) : [];
    throw new Error(
      `couldn't find the 6 registration markers (4 corners + mid-top + mid-bottom). ` +
      `found ${candidates.length} marker-shaped blobs total across ${THRESHOLDS.length} thresholds. ` +
      `if you printed an older template (only 4 corners), download the new one. ` +
      `otherwise click debug to see what the detector finds on your photo.`,
    );
  }

  // Scale all 6 marker positions from detection space → original-image px
  const m: MarkerSet = {
    tl: { x: detectMarkers.tl.x / detectScale, y: detectMarkers.tl.y / detectScale },
    tr: { x: detectMarkers.tr.x / detectScale, y: detectMarkers.tr.y / detectScale },
    bl: { x: detectMarkers.bl.x / detectScale, y: detectMarkers.bl.y / detectScale },
    br: { x: detectMarkers.br.x / detectScale, y: detectMarkers.br.y / detectScale },
    mt: { x: detectMarkers.mt.x / detectScale, y: detectMarkers.mt.y / detectScale },
    mb: { x: detectMarkers.mb.x / detectScale, y: detectMarkers.mb.y / detectScale },
  };

  // 4-corner perspective homography mapping canonical PT → INPUT IMAGE PX.
  // Rigid 8-DOF fit — exact for any flat plane under any camera angle,
  // doesn't bend with detection noise. The mid-edge markers are NOT fed
  // into the warp — they're used only for the collinearity validation
  // (sanity check that we found 6 real markers and not e.g. random ink).
  //
  // TPS was tried here but over-fits noise on flat paper: detection
  // jitter on the mid-markers creates localized warp deformation that
  // displaces upper-row cells differently from lower-row cells. For the
  // realistic workshop use case (flat printed paper, flatbed scan or
  // photo of flat paper), perspective is strictly better.
  const knownTL: [number, number] = [MARKER_CENTERS_PT.tl.x, A4_H_PT - MARKER_CENTERS_PT.tl.y];
  const knownTR: [number, number] = [MARKER_CENTERS_PT.tr.x, A4_H_PT - MARKER_CENTERS_PT.tr.y];
  const knownBR: [number, number] = [MARKER_CENTERS_PT.br.x, A4_H_PT - MARKER_CENTERS_PT.br.y];
  const knownBL: [number, number] = [MARKER_CENTERS_PT.bl.x, A4_H_PT - MARKER_CENTERS_PT.bl.y];
  const warp = computeHomography(
    [knownTL, knownTR, knownBR, knownBL],
    [[m.tl.x, m.tl.y], [m.tr.x, m.tr.y], [m.br.x, m.br.y], [m.bl.x, m.bl.y]],
  );
  if (!warp) throw new Error("could not compute perspective transform from markers");

  // For each cell, project its 4 corners (with a small inset so the
  // printed cell-border doesn't bleed into the crop) through the warp
  // to get input-image px coords. Used by the debug overlay only — the
  // real cell extraction happens on the warped canonical image.
  const cropInset = 1.5;
  const cells: CellPxRect[] = [];
  for (let i = 0; i < ALPHABET.length; i++) {
    const box = boxBoundsPt(i);
    const xL = box.x + cropInset;
    const yT = A4_H_PT - (box.y + box.h) + cropInset;
    const xR = box.x + box.w - cropInset;
    const yB = A4_H_PT - box.y - cropInset;
    const c1 = applyH(warp, xL, yT);
    const c2 = applyH(warp, xR, yT);
    const c3 = applyH(warp, xR, yB);
    const c4 = applyH(warp, xL, yB);
    const minX = Math.max(0, Math.floor(Math.min(c1[0], c2[0], c3[0], c4[0])));
    const minY = Math.max(0, Math.floor(Math.min(c1[1], c2[1], c3[1], c4[1])));
    const maxX = Math.min(oriW, Math.ceil(Math.max(c1[0], c2[0], c3[0], c4[0])));
    const maxY = Math.min(oriH, Math.ceil(Math.max(c1[1], c2[1], c3[1], c4[1])));
    cells.push({
      index: i,
      char: ALPHABET[i],
      x: minX,
      y: minY,
      w: Math.max(1, maxX - minX),
      h: Math.max(1, maxY - minY),
    });
  }

  return { imageWidth: oriW, imageHeight: oriH, markers: m, cells, warp };
}

/**
 * Warp the input image to a canonical 2100×CANONICAL_H buffer using the
 * marker-derived 4-corner perspective homography. Rigid 8-DOF transform
 * — exact for flat paper, doesn't bend with detection noise.
 *
 * Inverse-mapping per output pixel + bilinear sampling.
 */
async function warpToCanonical(
  buffer: Buffer,
  warp: number[],
): Promise<{ data: Buffer; width: number; height: number }> {
  const { data: src, info } = await sharp(buffer)
    .rotate()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const srcW = info.width;
  const srcH = info.height;
  const srcCh = info.channels;

  const dst = Buffer.alloc(CANONICAL_W * CANONICAL_H);
  const invPx = 1 / PT_TO_CANONICAL_PX;
  for (let v = 0; v < CANONICAL_H; v++) {
    const ptY = v * invPx;
    const rowStart = v * CANONICAL_W;
    for (let u = 0; u < CANONICAL_W; u++) {
      const ptX = u * invPx;
      const [sx, sy] = applyH(warp, ptX, ptY);

      // Bilinear sampling — weighted average of the 4 source pixels
      // surrounding (sx, sy). Necessary because the homography is rarely
      // exact identity even when source and destination are the same size:
      // markers are detected with sub-pixel error, so destination pixels
      // land at fractional source positions. Pure nearest-neighbor
      // (Math.round) then duplicates some rows and skips others, producing
      // horizontal scan-line aliasing that visibly degrades every cell.
      // Bilinear costs 4 lookups + 4 multiplies per output pixel; still
      // sub-100ms for the whole 2100×2970 buffer.
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      const fx = sx - x0;
      const fy = sy - y0;
      const sample = (px: number, py: number): number => {
        if (px < 0 || px >= srcW || py < 0 || py >= srcH) return 255;
        return src[(py * srcW + px) * srcCh];
      };
      const p00 = sample(x0, y0);
      const p10 = sample(x1, y0);
      const p01 = sample(x0, y1);
      const p11 = sample(x1, y1);
      const top = p00 * (1 - fx) + p10 * fx;
      const bot = p01 * (1 - fx) + p11 * fx;
      dst[rowStart + u] = Math.round(top * (1 - fy) + bot * fy);
    }
  }
  return { data: dst, width: CANONICAL_W, height: CANONICAL_H };
}

export async function processScan(buffer: Buffer): Promise<GlyphPath[]> {
  const layout = await computeScanLayout(buffer);

  // 1. Perspective-warp the GRAYSCALE input to a clean canonical-coords
  //    image. After this step, the page is axis-aligned at known pixel
  //    positions regardless of how tilted the original photo was.
  //
  //    NO GLOBAL THRESHOLD HERE — we used to threshold the whole warped
  //    page at one value, which falls apart when lighting varies across
  //    the page (one corner bright from camera flash, the other dim).
  //    Instead we keep grayscale and threshold per cell after a local
  //    lighting fix (see below).
  const warped = await warpToCanonical(buffer, layout.warp);

  // 2. Cell crop via the single-source-of-truth helper. CROP_INSET_PT keeps
  //    the printed cell-border line out of each glyph.
  const CROP_INSET_PT = 3;

  const results: GlyphPath[] = [];
  for (let i = 0; i < ALPHABET.length; i++) {
    const { x: xPx, y: yPx, w: wPx, h: hPx } = cellExtractRect(i, CROP_INSET_PT);

    // Per-cell pipeline:
    //   extract grayscale → adaptive threshold → blur → trace.
    //
    // Adaptive thresholding compares each pixel to its LOCAL background
    // (a heavily blurred copy of the cell) and marks it as ink only if
    // it's at least `ADAPTIVE_MARGIN` darker than that local average.
    // This is the standard fix for uneven lighting: a shadow gradient
    // that the old normalize-based pipeline turned into spurious ink
    // now gets correctly classified as paper because the shadow tracks
    // its own local background.
    //
    // Blur on the binary output softens the threshold staircase before
    // potrace traces. Potrace's threshold becomes irrelevant (input is
    // already binary), so we feed it 128.
    //
    // toColourspace("b-w") is CRITICAL. Without it, sharp.extract().raw()
    // returns 3-channel RGB output (280800 bytes for a 288×325 cell)
    // even when input is declared as channels:1. Downstream pixel math
    // then reads RGB-interleaved bytes as if they were grayscale,
    // creating ~3× horizontal compression that looks like wild zoom.
    const cellRaw = await sharp(warped.data, {
      raw: { width: warped.width, height: warped.height, channels: 1 },
    })
      .extract({ left: xPx, top: yPx, width: wPx, height: hPx })
      .toColourspace("b-w")
      .raw()
      .toBuffer();

    if (computeStddev(cellRaw) < 8) continue; // empty-cell guard

    const cellPng = await adaptiveThresholdCell(cellRaw, wPx, hPx, 0.7);
    const svgPath = await traceGlyph(cellPng, { threshold: 128 });
    if (!svgPath) continue;

    results.push({
      index: i,
      char: ALPHABET[i],
      svgPath,
      cellWidthPx: wPx,
      cellHeightPx: hPx,
    });
  }

  return results;
}

/** Sample standard deviation of an 8-bit grayscale buffer. */
function computeStddev(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  const mean = sum / buf.length;
  let sqSum = 0;
  for (let i = 0; i < buf.length; i++) {
    const d = buf[i] - mean;
    sqSum += d * d;
  }
  return Math.sqrt(sqSum / buf.length);
}

// =====================================================================
//  Per-cell processing pipeline, broken into individual stages so the
//  debug UI can show what each step does. The stages compose:
//
//    cellRaw → cellStageBg → cellStageNormalized → cellStageBinary →
//    cellStageSmoothed → potrace
//
//  Each stage takes a raw grayscale buffer + dimensions and returns a
//  raw grayscale buffer of the same dimensions. The debug views encode
//  these to PNG via `rawToPng` for compositing into the cells grid.
//
//  Production tracing calls `adaptiveThresholdCell` which is just
//  `cellStageSmoothed → rawToPng` (kept as a single entry point so
//  processScan / vectorized view don't need to know about stages).
// =====================================================================

// Fixed bg blur sigma. Was previously cellDim/3 (≈96 for 288-px cells)
// but sigma that large triggered libvips' large-kernel code path which
// returned a padded buffer larger than the input — silently misaligning
// the per-pixel subtraction and producing zoom/garbage in the normalized
// view. Sigma 20 has a kernel of ~120 px (well within any cell), uses
// libvips' standard same-dimension gaussblur path, and is still large
// enough to capture the slowly-varying lighting we care about.
const BG_SIGMA = 20;

// Otsu threshold safety clamp range. Otsu can pick wild values for
// low-contrast cells; clamping prevents pathological cuts.
//   180 floor: ink must be at least 75 levels darker than the normalized
//              paper (255) to count. Below this, we'd start catching
//              paper noise as ink.
//   250 ceiling: even very dark cells shouldn't classify near-paper
//              pixels as ink. 250 leaves enough room for noise above
//              "real paper" (~255) without breaking through.
const OTSU_MIN = 180;
const OTSU_MAX = 250;
// Cells where (max - min) of normalized pixel values is below this are
// treated as uniformly empty paper. Prevents Otsu from inventing a
// threshold in unimodal noise distributions.
const UNIFORM_RANGE = 30;
// Contrast boost factor applied after bg subtraction. Pushes dark pixels
// darker while keeping paper pinned at 255:
//   new = max(0, 255 − (255 − old) × CONTRAST_FACTOR)
// Makes the histogram more bimodal, which gives Otsu a sharper valley to
// find in step 4 — captures faint pencil that the un-boosted normalize
// would otherwise leave too close to paper for Otsu to split off.
const CONTRAST_FACTOR = 2.0;
// Gamma curve applied after the linear contrast stretch. Both endpoints
// (0 and 255) stay fixed; midtones get pushed darker via output =
// (input/255)^GAMMA × 255. GAMMA > 1 = darker midtones, GAMMA = 1 =
// no-op, GAMMA < 1 = brighter midtones.
const GAMMA = 2.0;
// Precompute the 256-entry gamma LUT so the per-pixel inner loop is
// just an array lookup instead of a pow() call.
const GAMMA_LUT = (() => {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.round(Math.pow(i / 255, GAMMA) * 255);
  }
  return lut;
})();

/** Sigma for the background-estimate Gaussian blur. */
function bgSigmaFor(_wPx: number, _hPx: number): number {
  return BG_SIGMA;
}

/** Stage 2: background blur (estimate of the slowly-varying lighting).
 * Forces single-channel output via toColourspace('b-w') so sharp can't
 * silently convert to sRGB during the pipeline. Logs a warning if the
 * actual output buffer's dimensions don't match what we expect. */
async function cellStageBg(cellRaw: Buffer, wPx: number, hPx: number): Promise<Buffer> {
  const { data, info } = await sharp(cellRaw, { raw: { width: wPx, height: hPx, channels: 1 } })
    .blur(bgSigmaFor(wPx, hPx))
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== wPx || info.height !== hPx || info.channels !== 1) {
    console.warn(
      `[cellStageBg] unexpected dimensions: got ${info.width}×${info.height}×${info.channels}, ` +
      `expected ${wPx}×${hPx}×1`,
    );
  }
  if (data.length !== wPx * hPx) {
    console.warn(
      `[cellStageBg] unexpected buffer length: got ${data.length}, expected ${wPx * hPx}`,
    );
  }
  return data;
}

/** Stage 3: background subtraction + linear contrast + gamma.
 *   1. Subtract bg from cell → uniformly white background, ink preserved
 *   2. Linear contrast: push dark pixels darker via CONTRAST_FACTOR while
 *      keeping paper pinned at 255
 *   3. Gamma curve via lookup table: extra darkening of midtones while
 *      keeping both 0 and 255 anchored
 *
 * Together: more bimodal histogram for Otsu in stage 4, and visibly
 * stronger ink against a clean white background. */
async function cellStageNormalized(cellRaw: Buffer, wPx: number, hPx: number): Promise<Buffer> {
  const bg = await cellStageBg(cellRaw, wPx, hPx);
  const out = Buffer.alloc(wPx * hPx);
  for (let i = 0; i < cellRaw.length; i++) {
    // Step 1: bg subtract
    const subtracted = cellRaw[i] - bg[i] + 255;
    const clamped = subtracted < 0 ? 0 : subtracted > 255 ? 255 : subtracted;
    // Step 2: linear contrast — dark stays dark (or darker), paper at 255
    const boosted = 255 - (255 - clamped) * CONTRAST_FACTOR;
    const boostedClamped = boosted < 0 ? 0 : boosted > 255 ? 255 : boosted;
    // Step 3: gamma curve (LUT lookup — no per-pixel pow() call)
    out[i] = GAMMA_LUT[Math.round(boostedClamped)];
  }
  return out;
}

/** Stage 4: per-cell Otsu threshold. Computes the optimal cut from the
 * cell's own histogram, so faint-ink cells use a low cut and dark-ink
 * cells use a higher one. Clamped to [OTSU_MIN, OTSU_MAX] to prevent
 * pathological values when contrast is borderline. Cells that are nearly
 * uniform (no real ink, just paper noise) return all-white.
 *
 * Otsu's method: for each candidate threshold T, split pixels into "below"
 * and "above" classes; pick T that maximizes the between-class variance
 *    σ² = w0·w1·(μ0 − μ1)²
 * Efficient one-pass: track cumulative weight and mean as T increases. */
async function cellStageBinary(cellRaw: Buffer, wPx: number, hPx: number): Promise<Buffer> {
  const norm = await cellStageNormalized(cellRaw, wPx, hPx);
  const N = norm.length;

  // Uniform-cell guard: if the cell has almost no contrast, there's no
  // bimodal distribution for Otsu to split. Return all paper.
  let min = 255;
  let max = 0;
  for (let i = 0; i < N; i++) {
    const v = norm[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < UNIFORM_RANGE) {
    return Buffer.alloc(N, 255);
  }

  // Histogram of normalized pixel values
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < N; i++) hist[norm[i]]++;

  // Otsu: find T maximizing between-class variance.
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let bestT = (OTSU_MIN + OTSU_MAX) >> 1; // fallback midpoint
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = N - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      bestT = t;
    }
  }
  // Clamp to safety range
  const threshold = bestT < OTSU_MIN ? OTSU_MIN : bestT > OTSU_MAX ? OTSU_MAX : bestT;

  // Apply threshold
  const out = Buffer.alloc(N);
  for (let i = 0; i < N; i++) {
    out[i] = norm[i] < threshold ? 0 : 255;
  }
  return out;
}

/** Stage 5: anti-alias the binary staircase. Potrace re-binarises this
 * ramp internally, producing smooth curves instead of staircase Beziers.
 * Same defensive grayscale/dimension checks as cellStageBg.
 *
 * Sharp requires sigma ≥ 0.3 for its gaussblur path; below that, sigma
 * is effectively a no-op anyway (kernel collapses to identity) so we
 * skip the blur entirely. */
async function cellStageSmoothed(
  cellRaw: Buffer,
  wPx: number,
  hPx: number,
  postBlurSigma: number,
): Promise<Buffer> {
  const binary = await cellStageBinary(cellRaw, wPx, hPx);
  if (postBlurSigma < 0.3) return binary;
  const { data, info } = await sharp(binary, { raw: { width: wPx, height: hPx, channels: 1 } })
    .blur(postBlurSigma)
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== wPx || info.height !== hPx || info.channels !== 1) {
    console.warn(
      `[cellStageSmoothed] unexpected dimensions: got ${info.width}×${info.height}×${info.channels}, ` +
      `expected ${wPx}×${hPx}×1`,
    );
  }
  if (data.length !== wPx * hPx) {
    console.warn(
      `[cellStageSmoothed] unexpected buffer length: got ${data.length}, expected ${wPx * hPx}`,
    );
  }
  return data;
}

/** Encode a raw grayscale buffer to PNG. */
async function rawToPng(raw: Buffer, wPx: number, hPx: number): Promise<Buffer> {
  return await sharp(raw, { raw: { width: wPx, height: hPx, channels: 1 } })
    .png()
    .toBuffer();
}

/** Production entry point: the full per-cell pipeline, returning a PNG. */
async function adaptiveThresholdCell(
  cellRaw: Buffer,
  wPx: number,
  hPx: number,
  postBlurSigma: number,
): Promise<Buffer> {
  const smoothed = await cellStageSmoothed(cellRaw, wPx, hPx, postBlurSigma);
  return await rawToPng(smoothed, wPx, hPx);
}

/**
 * Render the input image with EVERY topology-passing candidate annotated.
 * Used as a fallback when `renderDebugOverlay` throws (i.e. marker detection
 * failed and we have no homography to draw cells with). Lets the user see
 * exactly what the detector is finding so they can tell whether:
 *   - threshold is wrong (no candidates at all → too few dark blobs)
 *   - wrong things are being selected (>4 candidates, top-4-by-size picks
 *     non-marker blobs like cigarette pack edges)
 *   - markers are out of frame (only some of the 4 corners show candidates)
 *   - markers are damaged (candidates fail topology check)
 *
 * Tries every threshold in the same sequence as `computeScanLayout`, picks
 * the one with the most candidates, and renders that.
 */
export async function renderDetectionDebug(buffer: Buffer): Promise<{
  pngBase64: string;
  width: number;
  height: number;
  candidateCount: number;
  thresholdUsed: number;
}> {
  // sharp().rotate().metadata() returns the SOURCE metadata, not the
  // post-rotation dimensions — so for iPhone portrait photos (landscape
  // sensor, EXIF=6) it reports 4032×3024 while .rotate() in the actual
  // pipeline produces 3024×4032 portrait pixels. If we naively use the
  // source dims, the subsequent resize() target ends up landscape and
  // jams the rotated portrait pixels in, squeezing them vertically.
  // Read source dims + EXIF orientation, swap manually.
  const srcMeta = await sharp(buffer).metadata();
  const srcW = srcMeta.width;
  const srcH = srcMeta.height;
  if (!srcW || !srcH) throw new Error("could not read image dimensions");
  const exifOri = srcMeta.orientation ?? 1;
  const swapDims = exifOri >= 5 && exifOri <= 8;
  const oriW = swapDims ? srcH : srcW;
  const oriH = swapDims ? srcW : srcH;

  const DETECT_W = 1500;
  const detectScale = DETECT_W / oriW;
  const detectH = Math.round(oriH * detectScale);

  const THRESHOLDS = [110, 130, 90, 150, 70];
  let bestCandidates: Component[] = [];
  let bestThreshold = 110;
  let bestBuf: Buffer | null = null;
  for (const t of THRESHOLDS) {
    const { data } = await sharp(buffer)
      .rotate()
      .resize(DETECT_W, detectH, { fit: "fill" })
      .greyscale()
      .normalize()
      .threshold(t)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const cands = findAllMarkerCandidates(data, DETECT_W, detectH);
    if (cands.length > bestCandidates.length) {
      bestCandidates = cands;
      bestThreshold = t;
      bestBuf = data;
    }
    if (!bestBuf) bestBuf = data;
  }

  // Sort by size descending — the top 4 are what detection would pick
  bestCandidates.sort((a, b) => b.size - a.size);

  // Preview at 1200px wide (same as renderDebugOverlay) so the user can
  // compare side by side
  const PREVIEW_W = 1200;
  const previewScale = PREVIEW_W / DETECT_W;
  const previewH = Math.round(detectH * previewScale);
  const s = (n: number) => Math.round(n * previewScale);

  // Each candidate: green if in the top 6 (would be picked as one of the 4
  // corners + 2 mid-edge markers), yellow if it passed topology but didn't
  // make the cut.
  const candidateSvg = bestCandidates
    .map((c, i) => {
      const inTop6 = i < 6;
      const color = inTop6 ? "#00ff00" : "#ffea00";
      const bboxW = c.maxX - c.minX + 1;
      const bboxH = c.maxY - c.minY + 1;
      return (
        `<rect x="${s(c.minX)}" y="${s(c.minY)}" width="${s(bboxW)}" height="${s(bboxH)}" ` +
        `stroke="${color}" stroke-width="2" fill="none"/>` +
        `<text x="${s(c.minX)}" y="${s(c.minY) - 4}" font-family="monospace" font-size="14" fill="${color}" ` +
        `stroke="black" stroke-width="0.5">#${i + 1} ${c.size}px</text>`
      );
    })
    .join("");

  const headerSvg =
    `<rect x="0" y="0" width="${PREVIEW_W}" height="40" fill="black" fill-opacity="0.7"/>` +
    `<text x="10" y="26" font-family="monospace" font-size="16" fill="white">` +
    `${bestCandidates.length} candidates @ threshold ${bestThreshold} — green=top6 (would pick), yellow=extra` +
    `</text>`;

  const overlaySvg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_W}" height="${previewH}" viewBox="0 0 ${PREVIEW_W} ${previewH}">` +
    candidateSvg +
    headerSvg +
    `</svg>`;

  // Composite over the thresholded buffer (so user sees what the detector
  // actually sees, not the original photo)
  if (!bestBuf) throw new Error("no threshold pass produced a buffer");
  const composited = await sharp(bestBuf, {
    raw: { width: DETECT_W, height: detectH, channels: 1 },
  })
    .resize(PREVIEW_W, previewH, { fit: "fill" })
    .png()
    .composite([{ input: Buffer.from(overlaySvg) }])
    .toBuffer();

  return {
    pngBase64: composited.toString("base64"),
    width: PREVIEW_W,
    height: previewH,
    candidateCount: bestCandidates.length,
    thresholdUsed: bestThreshold,
  };
}

export async function renderDebugOverlay(buffer: Buffer): Promise<{
  pngBase64: string;
  width: number;
  height: number;
  layout: ScanLayout;
}> {
  const layout = await computeScanLayout(buffer);
  // Show the WARPED canonical image — i.e. exactly what the pipeline runs
  // tracing on. If markers are wrong, the warp looks distorted and you'll
  // see it immediately. If markers are right, you get a clean A4 with
  // pink cell rects sitting exactly on the printed cells.
  const warped = await warpToCanonical(buffer, layout.warp);

  const PREVIEW_W = 1200;
  const previewScale = PREVIEW_W / warped.width;
  const previewH = Math.round(warped.height * previewScale);

  const s = (n: number) => Math.round(n * previewScale);

  // In the warped canonical image the 6 markers sit at known PT positions.
  // Convert pdf-lib coords (origin = bottom-left) to top-down canvas coords.
  const canonicalMarkers = (["tl", "tr", "bl", "br", "mt", "mb"] as const).map((k) => ({
    key: k,
    x: MARKER_CENTERS_PT[k].x * PT_TO_CANONICAL_PX,
    y: (A4_H_PT - MARKER_CENTERS_PT[k].y) * PT_TO_CANONICAL_PX,
  }));

  const markerSvg = (mk: { x: number; y: number }, color: string) =>
    `<circle cx="${s(mk.x)}" cy="${s(mk.y)}" r="18" stroke="${color}" stroke-width="4" fill="none"/>` +
    `<circle cx="${s(mk.x)}" cy="${s(mk.y)}" r="4" fill="${color}"/>`;

  // Cells in canonical px (matches what processScan actually extracts).
  // Single-source-of-truth helper.
  const cellsSvg = ALPHABET.map((_char, i) => {
    const { x: xPx, y: yPx, w: wPx, h: hPx } = cellExtractRect(i, 3);
    return (
      `<rect x="${s(xPx)}" y="${s(yPx)}" width="${s(wPx)}" height="${s(hPx)}" stroke="#ff10b8" stroke-width="1.5" fill="none"/>` +
      `<text x="${s(xPx) + 4}" y="${s(yPx) + 12}" font-family="monospace" font-size="11" fill="#ff10b8">${i + 1}</text>`
    );
  }).join("");

  // Corner markers cyan, mid-edge markers magenta so they're visually distinct
  const overlaySvg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_W}" height="${previewH}" viewBox="0 0 ${PREVIEW_W} ${previewH}">` +
    canonicalMarkers
      .map((m) => markerSvg(m, m.key === "mt" || m.key === "mb" ? "#ff00ff" : "#00ffff"))
      .join("") +
    cellsSvg +
    `</svg>`;

  // Composite the overlay onto the WARPED image (not the raw input). This
  // way the user sees what processScan actually traces.
  const composited = await sharp(warped.data, {
    raw: { width: warped.width, height: warped.height, channels: 1 },
  })
    .resize(PREVIEW_W, previewH, { fit: "fill" })
    .png()
    .composite([{ input: Buffer.from(overlaySvg) }])
    .toBuffer();

  return {
    pngBase64: composited.toString("base64"),
    width: PREVIEW_W,
    height: previewH,
    layout,
  };
}

// =====================================================================
//  Marker detection — connected components in corner regions
// =====================================================================

type Centroid = { x: number; y: number };

/**
 * Find all 6 registration markers (4 corners + mid-top + mid-bottom).
 *
 * Strategy:
 *   1. Scan the WHOLE image for topology-passing candidate blobs (nested-
 *      square frame + centre dot).
 *   2. Take the top 6 by size — real markers are ~30pt², easily outsizing
 *      any incidental dark blob or QR finder pattern (~22pt²).
 *   3. Split top 3 / bottom 3 by y, sort by x within each row →
 *      TL · MT · TR  /  BL · MB · BR.
 *   4. Validate:
 *      - 4 corners form an A4-aspect quadrilateral (existing check)
 *      - MT lies on the line TL→TR (perpendicular distance < tolerance)
 *      - MB lies on the line BL→BR (same)
 *      - MT is roughly halfway between TL and TR (rejects mt-near-tr case)
 *      - MB is roughly halfway between BL and BR
 *
 * The collinearity check is the killer feature: three random dark blobs
 * basically never line up perfectly with two other things, so this rejects
 * ~all false positives that the old 4-marker check would accept.
 *
 * Returns null if anything fails. The homography solver still uses only the
 * 4 corners (standard 4-point DLT); the midpoints are pure validation.
 */
function findMarkers(
  data: Buffer,
  w: number,
  h: number,
): MarkerSet | null {
  const candidates = findAllMarkerCandidates(data, w, h);
  // Apply size filter: real markers are 30pt — bounded above by the photo's
  // shorter dimension (page fills 100% at most) and below by ~40% fill (we
  // tolerate the page being smaller in the photo). Without this filter the
  // top-6-by-size logic happily picks big hand-drawn letters over the actual
  // markers, especially when participants draw thick strokes.
  const sized = candidates.filter((c) => withinExpectedMarkerSize(c, w, h));
  if (sized.length < 6) return null;

  sized.sort((a, b) => b.size - a.size);
  const top6 = sized.slice(0, 6);

  // Split into top row and bottom row by y. With heavy perspective tilt
  // there's an edge case where mb has smaller y than tl — but that requires
  // tilt > ~45° which is beyond reasonable shooting conditions.
  const sortedByY = [...top6].sort((a, b) => a.cy - b.cy);
  const topRow = [...sortedByY.slice(0, 3)].sort((a, b) => a.cx - b.cx);
  const bottomRow = [...sortedByY.slice(3, 6)].sort((a, b) => a.cx - b.cx);

  const tl: Centroid = { x: topRow[0].cx, y: topRow[0].cy };
  const mt: Centroid = { x: topRow[1].cx, y: topRow[1].cy };
  const tr: Centroid = { x: topRow[2].cx, y: topRow[2].cy };
  const bl: Centroid = { x: bottomRow[0].cx, y: bottomRow[0].cy };
  const mb: Centroid = { x: bottomRow[1].cx, y: bottomRow[1].cy };
  const br: Centroid = { x: bottomRow[2].cx, y: bottomRow[2].cy };

  if (!isPlausibleMarkerLayout(tl, tr, bl, br, w, h)) return null;

  // Collinearity check. Under perspective, three collinear 3D points map
  // to three collinear 2D points, so a real MT must sit on the line TL→TR.
  // Tolerance: ~2% of edge length, generous enough for centroid detection
  // noise (±2-3px) but tight enough that misaligned blobs fail.
  const topEdgeLen = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottomEdgeLen = Math.hypot(br.x - bl.x, br.y - bl.y);
  const topTol = Math.max(8, topEdgeLen * 0.025);
  const bottomTol = Math.max(8, bottomEdgeLen * 0.025);
  if (pointLineDistance(mt, tl, tr) > topTol) return null;
  if (pointLineDistance(mb, bl, br) > bottomTol) return null;

  // Midpoint-position check: MT should be roughly halfway along TL→TR.
  // Mid markers print at A4_W/2; under any reasonable perspective the
  // along-edge fraction stays in [0.35, 0.65]. This rejects the case
  // where mt happened to be a fleck of dark ink near a corner.
  const tlMtAlong = projectAlong(mt, tl, tr);
  const blMbAlong = projectAlong(mb, bl, br);
  if (tlMtAlong < 0.35 || tlMtAlong > 0.65) return null;
  if (blMbAlong < 0.35 || blMbAlong > 0.65) return null;

  return { tl, tr, bl, br, mt, mb };
}

/**
 * Is the candidate's bounding box within the expected pixel size for a
 * 30pt marker, given the detection image dimensions?
 *
 * We don't know the page size in the photo, but we can bracket it:
 *   - Page fills ≥40% of the shorter image dimension → marker ≥ 40% of expected
 *   - Page fills ≤100% of the shorter dimension → marker ≤ 100% of expected
 * Where "expected" = shorter_dim × (30 / 595), the marker-to-A4 ratio.
 *
 * Anything outside [0.4×, 1.0×] expected is either too small to be a real
 * marker or too big (= a drawing the participant made inside a cell). Big
 * hand-drawn letters are routinely larger than the markers, which is why
 * the unfiltered top-6-by-size grab fails on real-world scans.
 */
function withinExpectedMarkerSize(c: Component, imgW: number, imgH: number): boolean {
  const shorter = Math.min(imgW, imgH);
  const expectedPx = shorter * (MARKER_SIZE / 595.276);
  const minPx = expectedPx * 0.4;
  const maxPx = expectedPx * 1.15; // small overshoot for ink-bleed printing
  const cw = c.maxX - c.minX + 1;
  const ch = c.maxY - c.minY + 1;
  const dim = Math.max(cw, ch);
  return dim >= minPx && dim <= maxPx;
}

/**
 * Perpendicular distance from point P to the infinite line through A and B.
 * Used by the collinearity check.
 */
function pointLineDistance(p: Centroid, a: Centroid, b: Centroid): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 0;
  return Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len;
}

/**
 * Project P onto the line through A→B and return the parametric position:
 * 0 means P projects onto A, 1 means onto B, 0.5 is halfway.
 */
function projectAlong(p: Centroid, a: Centroid, b: Centroid): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return 0;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
}

/**
 * Sanity-check the 4 detected markers form a reasonable A4 quadrilateral.
 * If any of these fail the marker assignment is almost certainly wrong
 * (e.g. a QR finder got picked instead of the real corner marker), so we
 * fall through to extrapolation / failure rather than silently producing
 * a wildly distorted homography.
 */
function isPlausibleMarkerLayout(
  tl: Centroid,
  tr: Centroid,
  bl: Centroid,
  br: Centroid,
  imgW: number,
  imgH: number,
): boolean {
  // Top is above bottom; left is left of right
  if (tl.y >= bl.y || tr.y >= br.y) return false;
  if (tl.x >= tr.x || bl.x >= br.x) return false;

  // Width and height should be a substantial fraction of the image —
  // markers clustered together (e.g. all 4 inside a QR code) would fail.
  const widthPx = ((tr.x - tl.x) + (br.x - bl.x)) / 2;
  const heightPx = ((bl.y - tl.y) + (br.y - tr.y)) / 2;
  if (widthPx < imgW * 0.3) return false;
  if (heightPx < imgH * 0.3) return false;

  // Aspect ratio should be close to the expected page aspect (height / width
  // measured between marker centres, NOT page edges).
  const expectedH = A4_H_PT - 2 * (PAGE_MARGIN + MARKER_SIZE / 2);
  const expectedW = A4_W_PT - 2 * (PAGE_MARGIN + MARKER_SIZE / 2);
  const expectedRatio = expectedH / expectedW; // ≈ 1.44 for A4
  const actualRatio = heightPx / widthPx;
  const tolerance = 0.4; // accommodate moderate perspective tilt
  if (actualRatio < expectedRatio * (1 - tolerance)) return false;
  if (actualRatio > expectedRatio * (1 + tolerance)) return false;

  return true;
}

type Component = {
  size: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
};

/**
 * Walk the entire image looking for marker-topology blobs. Returns ALL
 * candidates (sorted by location); caller picks the top 4 by size.
 */
function findAllMarkerCandidates(data: Buffer, imgW: number, imgH: number): Component[] {
  const visited = new Uint8Array(imgW * imgH);
  const out: Component[] = [];
  for (let y = 0; y < imgH; y++) {
    const rowStart = y * imgW;
    for (let x = 0; x < imgW; x++) {
      if (visited[rowStart + x]) continue;
      if (data[rowStart + x] >= 128) continue;
      const comp = floodFill(data, visited, imgW, imgH, x, y, 0, 0, imgW, imgH);
      if (comp.size < 200) continue;
      const cw = comp.maxX - comp.minX + 1;
      const ch = comp.maxY - comp.minY + 1;
      const aspect = cw / ch;
      if (aspect < 0.4 || aspect > 2.5) continue;
      if (!hasMarkerTopology(comp, data, imgW, imgH, cw, ch)) continue;
      out.push(comp);
    }
  }
  return out;
}

function bestMarkerInRegion(
  data: Buffer,
  imgW: number,
  imgH: number,
  left: number,
  top: number,
  regionW: number,
  regionH: number,
): Centroid | null {
  const xEnd = Math.min(imgW, left + regionW);
  const yEnd = Math.min(imgH, top + regionH);

  const visited = new Uint8Array(imgW * imgH);
  const components: Component[] = [];

  for (let y = top; y < yEnd; y++) {
    const rowStart = y * imgW;
    for (let x = left; x < xEnd; x++) {
      if (visited[rowStart + x]) continue;
      if (data[rowStart + x] >= 128) continue;
      const comp = floodFill(data, visited, imgW, imgH, x, y, left, top, xEnd, yEnd);
      if (comp.size < 200) continue; // was 500 — allow smaller / lower-res scans
      const compW = comp.maxX - comp.minX + 1;
      const compH = comp.maxY - comp.minY + 1;
      const aspect = compW / compH;
      if (aspect < 0.4 || aspect > 2.5) continue;
      if (!hasMarkerTopology(comp, data, imgW, imgH, compW, compH)) continue;
      components.push(comp);
    }
  }

  if (components.length === 0) return null;

  // Pick the LARGEST candidate that passed the topology check.
  let best: Component | null = null;
  for (const c of components) {
    if (!best || c.size > best.size) best = c;
  }
  if (!best) return null;
  return { x: best.cx, y: best.cy };
}

/**
 * Verify a candidate component has the nested-square marker topology:
 *   outer dark frame  + white inner cutout + dark center dot.
 *
 * Two checks:
 *   1. Fill density in [0.55, 0.9]. A frame (outer 22pt, inner 10pt) has
 *      density (22² - 10²) / 22² ≈ 0.79. Solid squares are ~1.0, sparse
 *      ink strokes are <0.5. Both fall outside the window.
 *   2. The geometric centre contains at least one dark pixel (= the centre
 *      dot). A frame without a centre dot or a hollow drawing fails this.
 *
 * Returns true only for things that actually look like our marker — much
 * stricter than just "square-ish dark blob".
 */
function hasMarkerTopology(
  comp: Component,
  data: Buffer,
  imgW: number,
  imgH: number,
  bboxW: number,
  bboxH: number,
): boolean {
  const fillDensity = comp.size / (bboxW * bboxH);
  // Real markers cluster around 0.78. QR-code finder patterns have density
  // ~0.49 (thinner frame, larger interior) so the lower bound of 0.55
  // rejects them. Upper bound 0.9 rejects nearly-solid squares (drawings).
  if (fillDensity < 0.55 || fillDensity > 0.9) return false;

  // Sample a small region around the centroid; for a real marker this lands
  // inside the centre dot, which IS dark even though it's a separate
  // connected component (the white inner cutout isolates it from the frame).
  const cx = Math.round(comp.cx);
  const cy = Math.round(comp.cy);
  const sampleR = Math.max(2, Math.round(Math.min(bboxW, bboxH) * 0.08));
  let darkInCenter = 0;
  for (let dy = -sampleR; dy <= sampleR; dy++) {
    for (let dx = -sampleR; dx <= sampleR; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= imgW || y < 0 || y >= imgH) continue;
      if (data[y * imgW + x] < 128) darkInCenter++;
    }
  }
  return darkInCenter >= 1;
}

function floodFill(
  data: Buffer,
  visited: Uint8Array,
  imgW: number,
  imgH: number,
  sx: number,
  sy: number,
  minX: number,
  minY: number,
  maxXExcl: number,
  maxYExcl: number,
): Component {
  const stack: number[] = [sx, sy];
  let size = 0;
  let cMinX = sx, cMinY = sy, cMaxX = sx, cMaxY = sy;
  let sumX = 0, sumY = 0;
  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    if (x < minX || x >= maxXExcl || y < minY || y >= maxYExcl) continue;
    if (x < 0 || x >= imgW || y < 0 || y >= imgH) continue;
    const idx = y * imgW + x;
    if (visited[idx]) continue;
    if (data[idx] >= 128) continue;
    visited[idx] = 1;
    size++;
    sumX += x;
    sumY += y;
    if (x < cMinX) cMinX = x;
    if (y < cMinY) cMinY = y;
    if (x > cMaxX) cMaxX = x;
    if (y > cMaxY) cMaxY = y;
    stack.push(x + 1, y);
    stack.push(x - 1, y);
    stack.push(x, y + 1);
    stack.push(x, y - 1);
  }
  // For the marker centre, use BOUNDING-BOX centre rather than pixel
  // centroid (sumX/size, sumY/size). The bbox centre is symmetric around
  // the actual geometric centre of the printed marker by design; the pixel
  // centroid drifts by a couple of pixels whenever the threshold catches
  // slightly more pixels on one side of the frame than the other (which
  // happens constantly with phone-camera lighting).
  // sumX/sumY kept available on the component in case future code wants the
  // pixel centroid for a different purpose.
  void sumX;
  void sumY;
  return {
    size,
    minX: cMinX,
    minY: cMinY,
    maxX: cMaxX,
    maxY: cMaxY,
    cx: (cMinX + cMaxX) / 2,
    cy: (cMinY + cMaxY) / 2,
  };
}

// =====================================================================
//  4-point homography (canonical → input image)
// =====================================================================

/**
 * Given 4 source points and 4 destination points, compute the 3x3 homography
 * matrix H such that for each pair: dst = H * src (after perspective divide).
 * Returns a flat 9-element array, or null if the system is singular.
 *
 * Reference: standard direct linear transform (DLT) reduced to an 8x8 system.
 */
function computeHomography(src: number[][], dst: number[][]): number[] | null {
  // Build 8x9 augmented matrix
  const M: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    M.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    M.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const h = gaussJordan(M);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function applyH(H: number[], x: number, y: number): [number, number] {
  const w = H[6] * x + H[7] * y + H[8];
  if (Math.abs(w) < 1e-12) return [0, 0];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

function gaussJordan(M: number[][]): number[] | null {
  const n = M.length;
  for (let i = 0; i < n; i++) {
    // Partial pivoting
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k][i]) > Math.abs(M[maxRow][i])) maxRow = k;
    }
    if (Math.abs(M[maxRow][i]) < 1e-10) return null;
    [M[i], M[maxRow]] = [M[maxRow], M[i]];
    // Normalise row
    const pivot = M[i][i];
    for (let j = i; j <= n; j++) M[i][j] /= pivot;
    // Eliminate column
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const factor = M[k][i];
      if (factor === 0) continue;
      for (let j = i; j <= n; j++) M[k][j] -= factor * M[i][j];
    }
  }
  return M.map((row) => row[n]);
}

// =====================================================================
//  Thin-plate spline (TPS) warp — uses ALL 6 markers including the
//  mid-edge ones, so the warp can correct slight paper bending that a
//  4-point perspective homography can't express.
//
//  TPS interpolates a 2D mapping f(x,y) → (x',y') such that f passes
//  exactly through every (control, target) pair AND minimises bending
//  energy elsewhere. Reduces to affine for flat paper; bends smoothly
//  to match curved paper everywhere between the markers.
//
//  Standard form:
//    f(x,y) = a0 + a1·x + a2·y + Σ_i wi · U(‖(x,y) − pi‖)
//    U(r) = r² · log(r²) for r > 0,   U(0) = 0
//
//  We solve for [w; a] from the linear system
//    [K  P ] [w]   [v]
//    [Pᵀ 0 ] [a] = [0]
//  where K[i][j] = U(‖pi − pj‖), P[i] = [1, xi, yi], v = target values.
//  Two separate solves (one for x targets, one for y targets) share the
//  same K matrix.
// =====================================================================

export type TPSCoeffs = {
  controlPts: [number, number][];
  /** TPS weights for the x-coordinate mapping. Length = controlPts.length. */
  wx: number[];
  /** Affine coefficients [a0, a1, a2] for x: x' = a0 + a1·x + a2·y + ...  */
  ax: number[];
  wy: number[];
  ay: number[];
};

/** U(r) = r² · log(r²), the TPS radial basis. Returns 0 for r=0. */
function tpsU(r2: number): number {
  return r2 > 1e-12 ? r2 * Math.log(r2) : 0;
}

/**
 * Solve TPS coefficients given control points (e.g. canonical marker
 * positions) and their corresponding target positions (e.g. detected
 * marker positions in the source image). Returns null if the linear
 * system is singular — typically happens when the control points are
 * collinear or near-coincident.
 */
function solveTPS(
  controlPts: [number, number][],
  targetX: number[],
  targetY: number[],
): TPSCoeffs | null {
  const n = controlPts.length;
  if (n < 3 || n !== targetX.length || n !== targetY.length) return null;
  const m = n + 3;

  // K block — symmetric, only depends on control points
  const K: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n).fill(0);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = controlPts[i][0] - controlPts[j][0];
      const dy = controlPts[i][1] - controlPts[j][1];
      row[j] = tpsU(dx * dx + dy * dy);
    }
    K.push(row);
  }

  function solve(targetVec: number[]): number[] | null {
    // Augmented matrix (m × (m+1)) — last column is the RHS
    const aug: number[][] = [];
    for (let i = 0; i < m; i++) aug.push(new Array<number>(m + 1).fill(0));
    // K block (rows 0..n-1, cols 0..n-1)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) aug[i][j] = K[i][j];
    }
    // P block on the right (rows 0..n-1, cols n..n+2)
    for (let i = 0; i < n; i++) {
      aug[i][n] = 1;
      aug[i][n + 1] = controlPts[i][0];
      aug[i][n + 2] = controlPts[i][1];
    }
    // Pᵀ block on the bottom (rows n..n+2, cols 0..n-1)
    for (let i = 0; i < n; i++) {
      aug[n][i] = 1;
      aug[n + 1][i] = controlPts[i][0];
      aug[n + 2][i] = controlPts[i][1];
    }
    // RHS — top n values are the targets, bottom 3 are zero (constraint)
    for (let i = 0; i < n; i++) aug[i][m] = targetVec[i];
    return gaussJordan(aug);
  }

  const sx = solve(targetX);
  const sy = solve(targetY);
  if (!sx || !sy) return null;

  return {
    controlPts,
    wx: sx.slice(0, n),
    ax: sx.slice(n),
    wy: sy.slice(0, n),
    ay: sy.slice(n),
  };
}

/**
 * Apply the TPS function at (x, y), returning the mapped (x', y').
 * Per-pixel cost: ~6 multiplies + 6 log/sqrt evals for N=6 controls.
 * For our 2100×2970 warp that's ~1 second total — acceptable.
 */
function applyTPS(t: TPSCoeffs, x: number, y: number): [number, number] {
  let xr = t.ax[0] + t.ax[1] * x + t.ax[2] * y;
  let yr = t.ay[0] + t.ay[1] * x + t.ay[2] * y;
  for (let i = 0; i < t.controlPts.length; i++) {
    const dx = x - t.controlPts[i][0];
    const dy = y - t.controlPts[i][1];
    const r2 = dx * dx + dy * dy;
    if (r2 > 1e-12) {
      const u = r2 * Math.log(r2);
      xr += t.wx[i] * u;
      yr += t.wy[i] * u;
    }
  }
  return [xr, yr];
}

// =====================================================================
//  Tracing
// =====================================================================

function traceGlyph(
  buffer: Buffer,
  optionsOverride?: Partial<potrace.PotraceOptions>,
): Promise<string | null> {
  const opts = { ...TRACE_OPTIONS, ...optionsOverride };
  return new Promise((resolve) => {
    potrace.trace(buffer, opts, (err, svg) => {
      if (err || !svg) {
        resolve(null);
        return;
      }
      const match = svg.match(/d="([^"]+)"/);
      resolve(match ? match[1] : null);
    });
  });
}

// =====================================================================
//  Unified debug view — powers the tuning UI in MakeFontForm
// =====================================================================

export type DebugView =
  | "thresholded"
  | "candidates"
  | "warped"
  | "cells"
  | "bg"
  | "normalized"
  | "binary"
  | "smoothed"
  | "vectorized";

export type DebugViewParams = {
  view: DebugView;
  /** Detection threshold (50–200). Default 110. */
  threshold?: number;
  /** Per-cell blur sigma before tracing (0–3). Default 0.8. */
  blur?: number;
  /** Potrace internal threshold (100–220). Default 180. */
  traceThreshold?: number;
};

export type DebugViewResult = {
  pngBase64: string;
  width: number;
  height: number;
  view: DebugView;
  threshold: number;
  blur: number;
  traceThreshold: number;
  /** Did we successfully lock onto 4 markers at this threshold? */
  detectedMarkers: boolean;
  /** How many topology-passing candidates were found at this threshold? */
  candidateCount: number;
  /** Cells successfully traced (vectorized view only) */
  cellCount?: number;
  /** Optional explanatory text (e.g. "fell back to candidates view") */
  message?: string;
};

/**
 * Single debug entry point for the tuning UI. Lets the user pick a view +
 * threshold + blur + trace-threshold, and re-renders interactively.
 *
 * Unlike `computeScanLayout` which sweeps multiple thresholds, this uses
 * exactly the user-chosen threshold — gives them full control over what
 * the detector sees. If detection fails at that threshold, the warped /
 * vectorized views silently fall back to candidates so the UI never goes
 * blank.
 */
export async function renderDebugView(
  buffer: Buffer,
  params: DebugViewParams,
): Promise<DebugViewResult> {
  const threshold = clampN(params.threshold ?? 110, 30, 230);
  const blur = clampN(params.blur ?? 0.7, 0, 5);
  const traceThreshold = clampN(params.traceThreshold ?? 180, 50, 250);

  // sharp().rotate().metadata() returns the SOURCE metadata, not the
  // post-rotation dimensions — so for iPhone portrait photos (landscape
  // sensor, EXIF=6) it reports 4032×3024 while .rotate() in the actual
  // pipeline produces 3024×4032 portrait pixels. If we naively use the
  // source dims, the subsequent resize() target ends up landscape and
  // jams the rotated portrait pixels in, squeezing them vertically.
  // Read source dims + EXIF orientation, swap manually.
  const srcMeta = await sharp(buffer).metadata();
  const srcW = srcMeta.width;
  const srcH = srcMeta.height;
  if (!srcW || !srcH) throw new Error("could not read image dimensions");
  const exifOri = srcMeta.orientation ?? 1;
  const swapDims = exifOri >= 5 && exifOri <= 8;
  const oriW = swapDims ? srcH : srcW;
  const oriH = swapDims ? srcW : srcH;

  const DETECT_W = 1500;
  const detectScale = DETECT_W / oriW;
  const detectH = Math.round(oriH * detectScale);

  // 1. Threshold once at the user's chosen value
  const { data: thresholdedBuf } = await sharp(buffer)
    .rotate()
    .resize(DETECT_W, detectH, { fit: "fill" })
    .greyscale()
    .normalize()
    .threshold(threshold)
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 2. Find candidates at this threshold
  const allCandidates = findAllMarkerCandidates(thresholdedBuf, DETECT_W, detectH);
  const sortedCandidates = [...allCandidates].sort((a, b) => b.size - a.size);

  // 3. Try to assemble markers from top 6 (4 corners + mid-top + mid-bottom).
  //    Uses the same logic as findMarkers including collinearity validation.
  const markers = findMarkers(thresholdedBuf, DETECT_W, detectH);

  const PREVIEW_W = 1200;
  const baseMeta = {
    threshold,
    blur,
    traceThreshold,
    detectedMarkers: !!markers,
    candidateCount: allCandidates.length,
  };

  // --- THRESHOLDED VIEW: just the raw thresholded buffer, no annotations.
  // Lets the user see what the detection actually receives and dial the
  // threshold until the markers are clean.
  if (params.view === "thresholded") {
    const previewScale = PREVIEW_W / DETECT_W;
    const previewH = Math.round(detectH * previewScale);
    const png = await sharp(thresholdedBuf, {
      raw: { width: DETECT_W, height: detectH, channels: 1 },
    })
      .resize(PREVIEW_W, previewH, { fit: "fill" })
      .png()
      .toBuffer();
    return {
      ...baseMeta,
      pngBase64: png.toString("base64"),
      width: PREVIEW_W,
      height: previewH,
      view: "thresholded",
    };
  }

  // --- CANDIDATES VIEW: thresholded + annotated candidate blobs.
  if (params.view === "candidates") {
    const png = await renderCandidatesImage(
      thresholdedBuf,
      DETECT_W,
      detectH,
      sortedCandidates,
      threshold,
    );
    return {
      ...baseMeta,
      pngBase64: png.base64,
      width: png.width,
      height: png.height,
      view: "candidates",
    };
  }

  // --- WARPED / VECTORIZED views need a successful detection.
  // If we don't have markers, fall back to candidates so the UI keeps
  // showing something useful (and the user can see WHY it failed).
  if (!markers) {
    const png = await renderCandidatesImage(
      thresholdedBuf,
      DETECT_W,
      detectH,
      sortedCandidates,
      threshold,
    );
    return {
      ...baseMeta,
      pngBase64: png.base64,
      width: png.width,
      height: png.height,
      view: "candidates",
      message: `detection failed at threshold ${threshold} — showing candidates instead. adjust threshold until 6 green boxes sit on the corner + mid-edge markers.`,
    };
  }

  // Scale corner markers from detection-space → input-image-px. The mid-
  // edge markers were already validated (collinearity check in findMarkers)
  // and don't feed into the warp — 4-corner perspective is rigid and
  // doesn't bend with noise the way TPS does.
  const m = {
    tl: { x: markers.tl.x / detectScale, y: markers.tl.y / detectScale },
    tr: { x: markers.tr.x / detectScale, y: markers.tr.y / detectScale },
    bl: { x: markers.bl.x / detectScale, y: markers.bl.y / detectScale },
    br: { x: markers.br.x / detectScale, y: markers.br.y / detectScale },
  };
  const warpTransform = computeHomography(
    [
      [MARKER_CENTERS_PT.tl.x, A4_H_PT - MARKER_CENTERS_PT.tl.y],
      [MARKER_CENTERS_PT.tr.x, A4_H_PT - MARKER_CENTERS_PT.tr.y],
      [MARKER_CENTERS_PT.br.x, A4_H_PT - MARKER_CENTERS_PT.br.y],
      [MARKER_CENTERS_PT.bl.x, A4_H_PT - MARKER_CENTERS_PT.bl.y],
    ],
    [[m.tl.x, m.tl.y], [m.tr.x, m.tr.y], [m.br.x, m.br.y], [m.bl.x, m.bl.y]],
  );
  if (!warpTransform) {
    const png = await renderCandidatesImage(thresholdedBuf, DETECT_W, detectH, sortedCandidates, threshold);
    return {
      ...baseMeta,
      pngBase64: png.base64,
      width: png.width,
      height: png.height,
      view: "candidates",
      message: "homography solve failed — corner markers detected but quadrilateral degenerate",
    };
  }

  // Warp once; warped + cells + vectorized views reuse it.
  const warped = await warpToCanonical(buffer, warpTransform);

  const previewScale = PREVIEW_W / warped.width;
  const previewH = Math.round(warped.height * previewScale);
  const s = (n: number) => Math.round(n * previewScale);

  // Cell rects via the single-source-of-truth helper — see cellExtractRect.

  // --- WARPED VIEW: canonical image + marker dots + cell rects.
  if (params.view === "warped") {
    // Pink rects = the production crop rect (3pt inset). Same helper
    // that processScan and cells-view use, so what you see here is
    // EXACTLY what the pipeline extracts.
    const cellsSvg = ALPHABET.map((_char, i) => {
      const { x: xPx, y: yPx, w: wPx, h: hPx } = cellExtractRect(i, 3);
      return (
        `<rect x="${s(xPx)}" y="${s(yPx)}" width="${s(wPx)}" height="${s(hPx)}" stroke="#ff10b8" stroke-width="1.5" fill="none"/>` +
        `<text x="${s(xPx) + 4}" y="${s(yPx) + 12}" font-family="monospace" font-size="11" fill="#ff10b8">${i + 1}</text>`
      );
    }).join("");

    // All 6 markers — corners cyan, mid-edges magenta. Flip y to top-down.
    const markerDots = (["tl", "tr", "bl", "br", "mt", "mb"] as const)
      .map((k) => {
        const cx = MARKER_CENTERS_PT[k].x * PT_TO_CANONICAL_PX;
        const cy = (A4_H_PT - MARKER_CENTERS_PT[k].y) * PT_TO_CANONICAL_PX;
        const color = k === "mt" || k === "mb" ? "#ff00ff" : "#00ffff";
        return (
          `<circle cx="${s(cx)}" cy="${s(cy)}" r="18" stroke="${color}" stroke-width="4" fill="none"/>` +
          `<circle cx="${s(cx)}" cy="${s(cy)}" r="4" fill="${color}"/>`
        );
      })
      .join("");

    const overlaySvg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_W}" height="${previewH}" viewBox="0 0 ${PREVIEW_W} ${previewH}">` +
      markerDots +
      cellsSvg +
      `</svg>`;

    // Two-pass: resize warped to preview, then composite SVG overlay onto
    // it. Sharp's pipeline reorders composite-after-resize internally and
    // would otherwise composite at canonical canvas size, misaligning the
    // preview-sized SVG.
    const resizedWarped = await sharp(warped.data, {
      raw: { width: warped.width, height: warped.height, channels: 1 },
    })
      .resize(PREVIEW_W, previewH, { fit: "fill" })
      .png()
      .toBuffer();

    const composited = await sharp(resizedWarped)
      .composite([{ input: Buffer.from(overlaySvg) }])
      .png()
      .toBuffer();

    return {
      ...baseMeta,
      pngBase64: composited.toString("base64"),
      width: PREVIEW_W,
      height: previewH,
      view: "warped",
    };
  }

  // --- PER-CELL STAGE VIEWS (cells, bg, normalized, binary, smoothed):
  // All five views share the same tiling — extract each cell from the warped
  // buffer via cellExtractRect (the proven-correct positions), apply a
  // per-stage transformation, then tile into a 6×6 grid via sharp.composite.
  // The only thing that changes between views is the `processCell` function.
  if (
    params.view === "cells" ||
    params.view === "bg" ||
    params.view === "normalized" ||
    params.view === "binary" ||
    params.view === "smoothed"
  ) {
    const stage = params.view;
    // null processCell = use the direct extract→png path (preserves
    // the known-working cells view behavior). Other stages need pixel
    // math so they go through the raw→process→png path.
    if (stage === "cells") {
      return await renderCellsGrid(warped, null, stage, baseMeta);
    }
    const processCell = async (raw: Buffer, w: number, h: number): Promise<Buffer> => {
      switch (stage) {
        case "bg":
          return await rawToPng(await cellStageBg(raw, w, h), w, h);
        case "normalized":
          return await rawToPng(await cellStageNormalized(raw, w, h), w, h);
        case "binary":
          return await rawToPng(await cellStageBinary(raw, w, h), w, h);
        case "smoothed":
          return await rawToPng(await cellStageSmoothed(raw, w, h, blur), w, h);
      }
    };
    return await renderCellsGrid(warped, processCell, stage, baseMeta);
  }

  // --- VECTORIZED VIEW: smoothed cells tiled in the SAME 6×6 grid as the
  // other per-cell stage views, with each cell's potrace-traced path
  // overlaid in cyan on top of the smoothed binary input. This is the
  // direct visual diagnostic: the cyan trace MUST hug the dark binary
  // pixels it was traced from; if it doesn't, potrace is misbehaving.
  if (params.view === "vectorized") {
    void traceThreshold; // not meaningful — input to potrace is binary
    const processCell = async (raw: Buffer, w: number, h: number): Promise<Buffer> => {
      // 1. Smoothed binary that potrace will receive
      const smoothed = await cellStageSmoothed(raw, w, h, blur);
      const smoothedPng = await rawToPng(smoothed, w, h);

      // 2. Trace the smoothed buffer
      const d = await traceGlyph(smoothedPng, { threshold: 128 });
      if (!d) return smoothedPng;

      // 3. Overlay the trace path on the smoothed PNG, at native cell
      //    dimensions. The path d coords are cell-local 0..w × 0..h, so
      //    the SVG viewBox matches the cell directly — no scaling needed.
      const overlaySvg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<path d="${d}" fill="#00ffff" fill-opacity="0.5" fill-rule="evenodd" stroke="#ff10b8" stroke-width="1.5"/>` +
        `</svg>`;
      return await sharp(smoothedPng)
        .composite([{ input: Buffer.from(overlaySvg) }])
        .png()
        .toBuffer();
    };
    return await renderCellsGrid(warped, processCell, "vectorized", baseMeta);
  }

  // Should be unreachable — fall back to candidates as a safety net.
  const png = await renderCandidatesImage(thresholdedBuf, DETECT_W, detectH, sortedCandidates, threshold);
  return {
    ...baseMeta,
    pngBase64: png.base64,
    width: png.width,
    height: png.height,
    view: "candidates",
  };
}

/**
 * Helper: render the thresholded buffer with candidate blobs annotated.
 * Used by both the candidates view AND as a fallback for warped/vectorized
 * when detection can't proceed.
 */
/**
 * Tile each alphabet cell into a 6×6 grid, applying `processCell` to each
 * cell's raw extracted buffer. Used by ALL per-cell stage views (cells,
 * bg, normalized, binary, smoothed) — the only thing that differs between
 * views is the `processCell` function.
 *
 * Shared layout, shared extraction, shared composite, shared Lanczos
 * downsample — so any visual difference between stages comes purely from
 * the per-cell transformation, not from layout/scale variations.
 */
async function renderCellsGrid(
  warped: { data: Buffer; width: number; height: number },
  processCell: ((raw: Buffer, wPx: number, hPx: number) => Promise<Buffer>) | null,
  viewName: DebugView,
  baseMeta: {
    threshold: number;
    blur: number;
    traceThreshold: number;
    detectedMarkers: boolean;
    candidateCount: number;
  },
): Promise<DebugViewResult> {
  const CELLS_INSET_PT = 3;
  const { w: cellWpx, h: cellHpx } = cellExtractRect(0, CELLS_INSET_PT);

  const cols = 6;
  const rows = 6;
  const gap = 8;
  const labelH = 22;
  const slotW = cellWpx + gap;
  const slotH = cellHpx + labelH + gap;
  const gridW = cols * slotW - gap;
  const gridH = rows * slotH - gap;

  const composites: sharp.OverlayOptions[] = [];
  let cellsRendered = 0;
  for (let i = 0; i < ALPHABET.length; i++) {
    const { x: xPx, y: yPx, w: wPx, h: hPx } = cellExtractRect(i, CELLS_INSET_PT);

    // When processCell is null (raw cells view), use the direct
    // extract→png path that we already proved works correctly.
    // When processCell is set, go through extract→raw→process→png so
    // the per-cell pixel math can run on the byte buffer.
    let cellPng: Buffer;
    if (processCell === null) {
      cellPng = await sharp(warped.data, {
        raw: { width: warped.width, height: warped.height, channels: 1 },
      })
        .extract({ left: xPx, top: yPx, width: wPx, height: hPx })
        .png()
        .toBuffer();
    } else {
      // toColourspace("b-w") forces 1-channel grayscale output. Without
      // it, sharp returns 3-channel RGB even for channels:1 input,
      // breaking all the per-pixel arithmetic in cellStage* functions
      // (they read 3 bytes per pixel as if they were 3 separate pixels).
      const cellRaw = await sharp(warped.data, {
        raw: { width: warped.width, height: warped.height, channels: 1 },
      })
        .extract({ left: xPx, top: yPx, width: wPx, height: hPx })
        .toColourspace("b-w")
        .raw()
        .toBuffer();
      cellPng = await processCell(cellRaw, wPx, hPx);
    }

    const col = i % cols;
    const row = Math.floor(i / cols);
    composites.push({
      input: cellPng,
      left: col * slotW,
      top: row * slotH + labelH,
    });
    cellsRendered++;
  }

  const labelsSvg = ALPHABET.map((char, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const slotX = col * slotW;
    const slotY = row * slotH;
    return (
      `<text x="${slotX + 4}" y="${slotY + 16}" font-family="monospace" font-size="14" fill="#ff10b8">` +
      `#${i + 1} ${char}` +
      `</text>`
    );
  }).join("");
  const labelOverlay =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${gridW}" height="${gridH}" viewBox="0 0 ${gridW} ${gridH}">` +
    labelsSvg +
    `</svg>`;

  // Two passes: composite at native grid size, THEN downsample. Forces
  // sharp's pipeline order so the composite lands on a same-sized canvas.
  const whiteCanvas = Buffer.alloc(gridW * gridH, 255);
  const tiledPng = await sharp(whiteCanvas, {
    raw: { width: gridW, height: gridH, channels: 1 },
  })
    .composite([...composites, { input: Buffer.from(labelOverlay) }])
    .png()
    .toBuffer();

  const PREVIEW_GRID_W = 1100;
  const previewGridH = Math.round(gridH * (PREVIEW_GRID_W / gridW));
  const png = await sharp(tiledPng)
    .resize(PREVIEW_GRID_W, previewGridH, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();

  return {
    ...baseMeta,
    pngBase64: png.toString("base64"),
    width: PREVIEW_GRID_W,
    height: previewGridH,
    view: viewName,
    cellCount: cellsRendered,
  };
}

async function renderCandidatesImage(
  thresholdedBuf: Buffer,
  detectW: number,
  detectH: number,
  sortedCandidates: Component[],
  threshold: number,
): Promise<{ base64: string; width: number; height: number }> {
  const PREVIEW_W = 1200;
  const previewScale = PREVIEW_W / detectW;
  const previewH = Math.round(detectH * previewScale);
  const s = (n: number) => Math.round(n * previewScale);

  // Apply the same size filter `findMarkers` uses, so the user can see
  // which candidates would actually be considered for marker selection.
  // The "picked top 6" come from the size-filtered subset, NOT from the
  // full topology-passing list.
  const sized = sortedCandidates.filter((c) => withinExpectedMarkerSize(c, detectW, detectH));
  const sizedIds = new Set(sized);

  const candidateSvg = sortedCandidates
    .map((c, i) => {
      // 3 colors:
      //   green  = in top 6 of size-filtered candidates → would be picked
      //   yellow = passes size filter but not in top 6  → extra
      //   red    = fails size filter (too big / too small) → drawing or noise
      let color: string;
      if (sizedIds.has(c) && sized.indexOf(c) < 6) color = "#00ff00";
      else if (sizedIds.has(c)) color = "#ffea00";
      else color = "#ff4060";
      const bboxW = c.maxX - c.minX + 1;
      const bboxH = c.maxY - c.minY + 1;
      return (
        `<rect x="${s(c.minX)}" y="${s(c.minY)}" width="${s(bboxW)}" height="${s(bboxH)}" ` +
        `stroke="${color}" stroke-width="2" fill="none"/>` +
        `<text x="${s(c.minX)}" y="${s(c.minY) - 4}" font-family="monospace" font-size="14" fill="${color}" ` +
        `stroke="black" stroke-width="0.5">#${i + 1} ${c.size}px</text>`
      );
    })
    .join("");

  const shorter = Math.min(detectW, detectH);
  const expectedPx = Math.round(shorter * (MARKER_SIZE / 595.276));
  const headerSvg =
    `<rect x="0" y="0" width="${PREVIEW_W}" height="40" fill="black" fill-opacity="0.7"/>` +
    `<text x="10" y="26" font-family="monospace" font-size="16" fill="white">` +
    `${sortedCandidates.length} candidates @ threshold ${threshold} · expected marker ~${expectedPx}px · ` +
    `green=top6 picked · yellow=extra · red=size-filtered (drawing/noise)` +
    `</text>`;

  const overlaySvg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_W}" height="${previewH}" viewBox="0 0 ${PREVIEW_W} ${previewH}">` +
    candidateSvg +
    headerSvg +
    `</svg>`;

  const composited = await sharp(thresholdedBuf, {
    raw: { width: detectW, height: detectH, channels: 1 },
  })
    .resize(PREVIEW_W, previewH, { fit: "fill" })
    .png()
    .composite([{ input: Buffer.from(overlaySvg) }])
    .toBuffer();

  return { base64: composited.toString("base64"), width: PREVIEW_W, height: previewH };
}

function clampN(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
