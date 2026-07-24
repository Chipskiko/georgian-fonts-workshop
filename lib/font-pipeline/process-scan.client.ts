/**
 * Browser twin of process-scan.ts — the scan → GlyphPath[] pipeline
 * running entirely on the user's device.
 *
 * Motivation: the server version needs sharp + potrace (native deps)
 * inside a serverless function, where a detailed scan can blow past
 * the Vercel Hobby ~10s wall-clock cap. In the browser there is no
 * cap, the tooling is lighter, and the server's job shrinks to
 * "receive the finished .otf bytes and store them".
 *
 * The pixel MATH is ported verbatim from process-scan.ts (marker
 * detection, homography, bilinear warp, bg-subtract, Otsu, flood
 * fill, contrast/gamma) — only sharp's primitives are replaced:
 *
 *   sharp op                          browser replacement
 *   ────────────────────────────────  ─────────────────────────────
 *   decode + EXIF rotate              <img> decode (browsers apply
 *                                     EXIF orientation natively)
 *   toColourspace('srgb')             canvas 2D is sRGB by contract
 *   resize (detection downscale)      canvas drawImage w/ smoothing
 *   greyscale()                       Rec.709 luma on RGBA
 *   normalize()                       1%/99% percentile stretch
 *   blur(sigma)                       separable JS Gaussian
 *   png() + potrace.trace             esm-potrace-wasm on ImageData
 *
 * Parameter values (thresholds, sigmas, clamps, fractions) are kept
 * IDENTICAL to the server pipeline so the two produce matching fonts.
 * If you tune a constant here, tune process-scan.ts to match.
 */

import {
  ALPHABET,
  A4_W_PT,
  A4_H_PT,
  PAGE_MARGIN,
  MARKER_SIZE,
  MARKER_CENTERS_PT,
  CANONICAL_W,
  CANONICAL_H,
  PT_TO_CANONICAL_PX,
  cellExtractRect,
  isScanUpsideDown,
  UPSIDE_DOWN_MESSAGE,
} from "./constants";
import type { GlyphPath, MarkerSet } from "./process-scan";
import { parseSvgPath } from "./build-font";

// ---------------------------------------------------------------------
//  Tunables — MUST MATCH process-scan.ts
// ---------------------------------------------------------------------

const DETECT_W = 1500;
const THRESHOLDS = [110, 130, 90, 150, 70];
const CROP_INSET_PT = 3;
const BG_SIGMA = 20;
const OTSU_MIN = 180;
const OTSU_MAX = 250;
const UNIFORM_RANGE = 30;
const CONTRAST_FACTOR = 1.5;
const HIGH_FILL_DARK_PIXEL_THRESHOLD = 50;
const HIGH_FILL_DARK_PIXEL_FRACTION = 0.2;
const GAMMA = 2.0;
const ENCLOSED_FILL_MIN_PIXELS = 200;
const ENCLOSED_FILL_MIN_INK_FRACTION = 0.15;
const POST_BLUR_SIGMA = 0.7;
/** Binary cut applied after the smoothing blur, matching the server's
 *  potrace `threshold: 128` on the smoothed grayscale PNG. */
const SMOOTHED_BINARY_CUT = 128;

const GAMMA_LUT = (() => {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.round(Math.pow(i / 255, GAMMA) * 255);
  }
  return lut;
})();

// ---------------------------------------------------------------------
//  esm-potrace-wasm — lazy singleton init (76KB module, WASM embedded)
// ---------------------------------------------------------------------

type PotraceModule = typeof import("esm-potrace-wasm");
let potracePromise: Promise<PotraceModule> | null = null;
function loadPotrace(): Promise<PotraceModule> {
  if (!potracePromise) {
    potracePromise = import("esm-potrace-wasm").then(async (m) => {
      await m.init();
      return m;
    });
  }
  return potracePromise;
}

/** Vectorize a BINARY (0/255) grayscale cell via wasm potrace, returning
 *  a single SVG path string — same content the server pipeline gets from
 *  node-potrace's single-<path> output. Options map 1:1 to the server's
 *  TRACE_OPTIONS (threshold is irrelevant: input is already binary). */
async function traceGlyphClient(
  binary: Uint8Array,
  w: number,
  h: number,
): Promise<string | null> {
  const { potrace } = await loadPotrace();
  // Pack binary gray into RGBA ImageData (black ink / white paper).
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = binary[i];
    const o = i * 4;
    rgba[o] = v;
    rgba[o + 1] = v;
    rgba[o + 2] = v;
    rgba[o + 3] = 255;
  }
  const imageData = new ImageData(rgba, w, h);
  const result = await potrace(imageData, {
    turdsize: 30,
    turnpolicy: 4, // minority — node-potrace default
    alphamax: 1.2,
    opticurve: 1,
    opttolerance: 0.4,
    pathonly: true,
    extractcolors: false,
    posterizelevel: 1,
    posterizationalgorithm: 0,
  });
  // pathonly:true → array of "M..." subpath strings (the wrapper splits
  // the combined path at M commands).
  const paths = Array.isArray(result) ? result : [result];
  const joined = paths.join("").trim();
  if (joined.length <= 3) return null;
  // CRITICAL: pathonly strips the SVG group transform native potrace
  // wraps its paths in — `translate(0,H) scale(0.1,-0.1)` — so the raw
  // coordinates are 10× the bitmap size with y measured UP from the
  // bitmap bottom. node-potrace (server) emits top-left-origin pixel
  // coordinates directly. Without re-applying the transform every glyph
  // came out ~10× larger than its advance width and vertically mirrored
  // — the preview grid showed giant strips painting across whole rows.
  // Re-apply it here so the client path is numerically identical to the
  // server's for the same bitmap. (Verified against the server build on
  // the calibration scan: advance, ink box, and baseline offsets match.)
  return potraceRawToPixelSpace(joined, h);
}

/** Re-apply potrace's stripped `translate(0,H) scale(0.1,-0.1)` group
 *  transform: x → x/10, y → H − y/10. Emits absolute M/L/C/Q/Z — the
 *  same dialect node-potrace produces server-side — so parseSvgPath
 *  sees identical input on both pipelines. */
function potraceRawToPixelSpace(d: string, heightPx: number): string {
  const cmds = parseSvgPath(d);
  const tx = (x: number) => Math.round(x * 0.1 * 100) / 100;
  const ty = (y: number) => Math.round((heightPx - y * 0.1) * 100) / 100;
  let out = "";
  for (const c of cmds) {
    if (c.type === "Z") {
      out += "Z ";
      continue;
    }
    out += `${c.type} ${c.points.map(([x, y]) => `${tx(x)} ${ty(y)}`).join(" ")} `;
  }
  return out.trim();
}

// ---------------------------------------------------------------------
//  Decode + rasterize helpers
// ---------------------------------------------------------------------

/** A decoded image ready for canvas drawing, with post-EXIF dimensions. */
type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
};

/** Decode an image Blob for canvas drawing. Primary path is
 *  createImageBitmap (applies EXIF orientation by default — the
 *  browser equivalent of sharp's .rotate() — and decodes off the main
 *  thread). Falls back to <img> + decode() for older Safari. */
/** iOS Safari has historically zeroed out getImageData on canvases
 *  larger than 16,777,216 px² (4096²) — a 24 MP iPhone photo (5712×4284
 *  ≈ 24.5 M px) would silently produce an all-black grayscale and fail
 *  marker detection on-device while the same file works server-side.
 *  Cap with margin; the canonical working size is only 2100 px wide, so
 *  downscaling the source this early costs nothing. */
const MAX_CANVAS_AREA = 15_500_000;

async function decodeImage(blob: Blob): Promise<DecodedImage> {
  const decoded = await decodeImageRaw(blob);
  const area = decoded.width * decoded.height;
  if (area <= MAX_CANVAS_AREA) return decoded;
  const s = Math.sqrt(MAX_CANVAS_AREA / area);
  const w = Math.max(1, Math.floor(decoded.width * s));
  const h = Math.max(1, Math.floor(decoded.height * s));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return decoded; // fall through — better to try than to fail here
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(decoded.source, 0, 0, w, h);
  return { source: canvas, width: w, height: h };
}

async function decodeImageRaw(blob: Blob): Promise<DecodedImage> {
  try {
    const bmp = await createImageBitmap(blob);
    return { source: bmp, width: bmp.width, height: bmp.height };
  } catch {
    // Older Safari (no createImageBitmap(Blob)) — <img> path. EXIF is
    // applied by the browser when rasterizing (image-orientation:
    // from-image default), and naturalWidth/Height are post-EXIF.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// sRGB decode LUT (0..255 → linear 0..1) for the grayscale conversion.
const SRGB_TO_LINEAR = new Float32Array(256);
for (let v = 0; v < 256; v++) {
  const c = v / 255;
  SRGB_TO_LINEAR[v] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb255(y: number): number {
  const c = y <= 0.0031308 ? y * 12.92 : 1.055 * Math.pow(y, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/** Draw the image at the given target size and return Rec.709 LUMINANCE
 *  (computed on LINEAR RGB, then re-encoded to gamma) as a single-channel
 *  Uint8Array. This matches sharp's greyscale() — measured: rgb(255,0,0)
 *  → 127 on both. Computing luma on gamma-encoded values instead (the
 *  old code) diverged by up to 73 levels on saturated colors, which
 *  could flip the high-fill detection for colored-marker drawings
 *  between the device and server pipelines. Neutral ink (r=g=b) is
 *  bit-identical either way. Canvas 2D contexts are sRGB by spec, so P3
 *  iPhone photos are color-managed during draw — the browser equivalent
 *  of sharp's toColourspace('srgb'). */
function rasterizeGray(
  img: DecodedImage,
  targetW: number,
  targetH: number,
): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img.source, 0, 0, targetW, targetH);
  const { data } = ctx.getImageData(0, 0, targetW, targetH);
  const gray = new Uint8Array(targetW * targetH);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const y =
      0.2126 * SRGB_TO_LINEAR[data[p]] +
      0.7152 * SRGB_TO_LINEAR[data[p + 1]] +
      0.0722 * SRGB_TO_LINEAR[data[p + 2]];
    gray[i] = linearToSrgb255(y);
  }
  return gray;
}

/** Percentile contrast stretch — browser stand-in for sharp.normalize()
 *  (whose default stretches the 1st..99th luminance percentiles to the
 *  full 0..255 range). */
function normalizeStretch(gray: Uint8Array): Uint8Array {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  const loCount = total * 0.01;
  const hiCount = total * 0.99;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= loCount) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= hiCount) {
      hi = v;
      break;
    }
  }
  if (hi <= lo) return gray;
  const out = new Uint8Array(gray.length);
  const scale = 255 / (hi - lo);
  for (let i = 0; i < gray.length; i++) {
    const v = (gray[i] - lo) * scale;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return out;
}

/** Separable Gaussian blur on a single-channel buffer, clamp-to-edge.
 *  Browser stand-in for sharp.blur(sigma). */
function gaussianBlurGray(
  src: Uint8Array,
  w: number,
  h: number,
  sigma: number,
): Uint8Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float32Array(w * h);
  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let sx = x + k;
        if (sx < 0) sx = 0;
        else if (sx >= w) sx = w - 1;
        acc += src[row + sx] * kernel[k + radius];
      }
      tmp[row + x] = acc;
    }
  }
  // Vertical pass
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let sy = y + k;
        if (sy < 0) sy = 0;
        else if (sy >= h) sy = h - 1;
        acc += tmp[sy * w + x] * kernel[k + radius];
      }
      const v = Math.round(acc);
      out[y * w + x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------
//  Marker detection — ported VERBATIM from process-scan.ts
//  (Buffer → Uint8Array; logic identical)
// ---------------------------------------------------------------------

type Centroid = { x: number; y: number };

type Component = {
  size: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
};

function floodFill(
  data: Uint8Array,
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
  let cMinX = sx,
    cMinY = sy,
    cMaxX = sx,
    cMaxY = sy;
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
    if (x < cMinX) cMinX = x;
    if (y < cMinY) cMinY = y;
    if (x > cMaxX) cMaxX = x;
    if (y > cMaxY) cMaxY = y;
    stack.push(x + 1, y);
    stack.push(x - 1, y);
    stack.push(x, y + 1);
    stack.push(x, y - 1);
  }
  // Bounding-box centre (matches server: symmetric around the printed
  // marker's geometric centre; pixel centroid drifts with lighting).
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

function hasMarkerTopology(
  comp: Component,
  data: Uint8Array,
  imgW: number,
  imgH: number,
  bboxW: number,
  bboxH: number,
): boolean {
  const fillDensity = comp.size / (bboxW * bboxH);
  if (fillDensity < 0.55 || fillDensity > 0.9) return false;
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

function findAllMarkerCandidates(
  data: Uint8Array,
  imgW: number,
  imgH: number,
): Component[] {
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

function withinExpectedMarkerSize(
  c: Component,
  imgW: number,
  imgH: number,
): boolean {
  const shorter = Math.min(imgW, imgH);
  const expectedPx = shorter * (MARKER_SIZE / 595.276);
  const minPx = expectedPx * 0.4;
  const maxPx = expectedPx * 1.15;
  const cw = c.maxX - c.minX + 1;
  const ch = c.maxY - c.minY + 1;
  const dim = Math.max(cw, ch);
  return dim >= minPx && dim <= maxPx;
}

function pointLineDistance(p: Centroid, a: Centroid, b: Centroid): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 0;
  return Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len;
}

function projectAlong(p: Centroid, a: Centroid, b: Centroid): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return 0;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
}

function isPlausibleMarkerLayout(
  tl: Centroid,
  tr: Centroid,
  bl: Centroid,
  br: Centroid,
  imgW: number,
  imgH: number,
): boolean {
  if (tl.y >= bl.y || tr.y >= br.y) return false;
  if (tl.x >= tr.x || bl.x >= br.x) return false;
  const widthPx = (tr.x - tl.x + (br.x - bl.x)) / 2;
  const heightPx = (bl.y - tl.y + (br.y - tr.y)) / 2;
  if (widthPx < imgW * 0.3) return false;
  if (heightPx < imgH * 0.3) return false;
  const expectedH = A4_H_PT - 2 * (PAGE_MARGIN + MARKER_SIZE / 2);
  const expectedW = A4_W_PT - 2 * (PAGE_MARGIN + MARKER_SIZE / 2);
  const expectedRatio = expectedH / expectedW;
  const actualRatio = heightPx / widthPx;
  const tolerance = 0.4;
  if (actualRatio < expectedRatio * (1 - tolerance)) return false;
  if (actualRatio > expectedRatio * (1 + tolerance)) return false;
  return true;
}

function findMarkers(
  data: Uint8Array,
  w: number,
  h: number,
): MarkerSet | null {
  const candidates = findAllMarkerCandidates(data, w, h);
  const sized = candidates.filter((c) => withinExpectedMarkerSize(c, w, h));
  if (sized.length < 6) return null;

  sized.sort((a, b) => b.size - a.size);
  const top6 = sized.slice(0, 6);

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

  const topEdgeLen = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottomEdgeLen = Math.hypot(br.x - bl.x, br.y - bl.y);
  const topTol = Math.max(8, topEdgeLen * 0.025);
  const bottomTol = Math.max(8, bottomEdgeLen * 0.025);
  if (pointLineDistance(mt, tl, tr) > topTol) return null;
  if (pointLineDistance(mb, bl, br) > bottomTol) return null;

  const tlMtAlong = projectAlong(mt, tl, tr);
  const blMbAlong = projectAlong(mb, bl, br);
  if (tlMtAlong < 0.35 || tlMtAlong > 0.65) return null;
  if (blMbAlong < 0.35 || blMbAlong > 0.65) return null;

  return { tl, tr, bl, br, mt, mb };
}

// ---------------------------------------------------------------------
//  Homography — ported verbatim
// ---------------------------------------------------------------------

function gaussJordan(M: number[][]): number[] | null {
  const n = M.length;
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k][i]) > Math.abs(M[maxRow][i])) maxRow = k;
    }
    if (Math.abs(M[maxRow][i]) < 1e-10) return null;
    [M[i], M[maxRow]] = [M[maxRow], M[i]];
    const pivot = M[i][i];
    for (let j = i; j <= n; j++) M[i][j] /= pivot;
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const factor = M[k][i];
      if (factor === 0) continue;
      for (let j = i; j <= n; j++) M[k][j] -= factor * M[i][j];
    }
  }
  return M.map((row) => row[n]);
}

function computeHomography(src: number[][], dst: number[][]): number[] | null {
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

// ---------------------------------------------------------------------
//  Per-cell pipeline — ported verbatim (sharp blur → JS Gaussian)
// ---------------------------------------------------------------------

function computeStddev(buf: Uint8Array): number {
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

function cellStageNormalized(
  cellRaw: Uint8Array,
  wPx: number,
  hPx: number,
): Uint8Array {
  let darkPixels = 0;
  for (let i = 0; i < cellRaw.length; i++) {
    if (cellRaw[i] < HIGH_FILL_DARK_PIXEL_THRESHOLD) darkPixels++;
  }
  const highFill =
    darkPixels / cellRaw.length >= HIGH_FILL_DARK_PIXEL_FRACTION;

  if (highFill) {
    const out = new Uint8Array(wPx * hPx);
    for (let i = 0; i < cellRaw.length; i++) {
      const boosted = 255 - (255 - cellRaw[i]) * CONTRAST_FACTOR;
      const boostedClamped = boosted < 0 ? 0 : boosted > 255 ? 255 : boosted;
      out[i] = GAMMA_LUT[Math.round(boostedClamped)];
    }
    return out;
  }

  const bg = gaussianBlurGray(cellRaw, wPx, hPx, BG_SIGMA);
  const out = new Uint8Array(wPx * hPx);
  for (let i = 0; i < cellRaw.length; i++) {
    const subtracted = cellRaw[i] - bg[i] + 255;
    const clamped = subtracted < 0 ? 0 : subtracted > 255 ? 255 : subtracted;
    const boosted = 255 - (255 - clamped) * CONTRAST_FACTOR;
    const boostedClamped = boosted < 0 ? 0 : boosted > 255 ? 255 : boosted;
    out[i] = GAMMA_LUT[Math.round(boostedClamped)];
  }
  return out;
}

function fillLargeEnclosedInteriors(
  buf: Uint8Array,
  w: number,
  h: number,
  minPixels: number,
  minInkFraction: number,
): void {
  const N = w * h;
  const visited = new Uint8Array(N);
  let inkCount = 0;
  for (let i = 0; i < N; i++) {
    if (buf[i] === 0) {
      visited[i] = 1;
      inkCount++;
    }
  }
  if (inkCount === 0 || inkCount === N) return;
  if (inkCount / N < minInkFraction) return;

  const stack = new Int32Array(N);
  for (let start = 0; start < N; start++) {
    if (visited[start]) continue;
    let top = 0;
    stack[top++] = start;
    visited[start] = 1;
    const component: number[] = [start];
    let touchesBorder = false;
    while (top > 0) {
      const p = stack[--top];
      const x = p % w;
      const y = (p - x) / w;
      if (x === 0 || x === w - 1 || y === 0 || y === h - 1) {
        touchesBorder = true;
      }
      if (x > 0 && !visited[p - 1]) {
        visited[p - 1] = 1;
        stack[top++] = p - 1;
        component.push(p - 1);
      }
      if (x < w - 1 && !visited[p + 1]) {
        visited[p + 1] = 1;
        stack[top++] = p + 1;
        component.push(p + 1);
      }
      if (y > 0 && !visited[p - w]) {
        visited[p - w] = 1;
        stack[top++] = p - w;
        component.push(p - w);
      }
      if (y < h - 1 && !visited[p + w]) {
        visited[p + w] = 1;
        stack[top++] = p + w;
        component.push(p + w);
      }
    }
    if (touchesBorder) continue;
    if (component.length >= minPixels) {
      for (const p of component) buf[p] = 0;
    }
  }
}

/** Stage 4: Otsu binarization with the server's clamps + uniform guard,
 *  then the enclosed-interior fill. */
function cellStageBinary(
  cellRaw: Uint8Array,
  wPx: number,
  hPx: number,
): Uint8Array {
  const norm = cellStageNormalized(cellRaw, wPx, hPx);
  const N = norm.length;

  let min = 255;
  let max = 0;
  for (let i = 0; i < N; i++) {
    const v = norm[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < UNIFORM_RANGE) {
    return new Uint8Array(N).fill(255);
  }

  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < N; i++) hist[norm[i]]++;

  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let bestT = (OTSU_MIN + OTSU_MAX) >> 1;
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
  const threshold = bestT < OTSU_MIN ? OTSU_MIN : bestT > OTSU_MAX ? OTSU_MAX : bestT;

  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = norm[i] < threshold ? 0 : 255;
  }
  fillLargeEnclosedInteriors(
    out,
    wPx,
    hPx,
    ENCLOSED_FILL_MIN_PIXELS,
    ENCLOSED_FILL_MIN_INK_FRACTION,
  );
  return out;
}

/** Stage 5 + trace prep: blur the binary staircase, then re-binarize at
 *  128 — the exact effective input node-potrace saw server-side (it
 *  thresholded the smoothed grayscale internally at 128). */
function cellSmoothedBinary(
  cellRaw: Uint8Array,
  wPx: number,
  hPx: number,
): Uint8Array {
  const binary = cellStageBinary(cellRaw, wPx, hPx);
  if (POST_BLUR_SIGMA < 0.3) return binary;
  const smoothed = gaussianBlurGray(binary, wPx, hPx, POST_BLUR_SIGMA);
  const out = new Uint8Array(wPx * hPx);
  for (let i = 0; i < out.length; i++) {
    out[i] = smoothed[i] < SMOOTHED_BINARY_CUT ? 0 : 255;
  }
  return out;
}

// ---------------------------------------------------------------------
//  Layout detection + warp
// ---------------------------------------------------------------------

type ClientLayout = {
  oriW: number;
  oriH: number;
  markers: MarkerSet;
  warp: number[];
};

function computeLayoutFromImage(img: DecodedImage): ClientLayout {
  // Dimensions are post-EXIF-orientation (createImageBitmap and <img>
  // both apply orientation in modern browsers).
  const oriW = img.width;
  const oriH = img.height;
  if (!oriW || !oriH) throw new Error("could not read image dimensions");

  const detectScale = DETECT_W / oriW;
  const detectH = Math.round(oriH * detectScale);

  const grayDetect = rasterizeGray(img, DETECT_W, detectH);
  const normDetect = normalizeStretch(grayDetect);

  let detectMarkers: MarkerSet | null = null;
  for (const t of THRESHOLDS) {
    const bin = new Uint8Array(normDetect.length);
    for (let i = 0; i < bin.length; i++) {
      bin[i] = normDetect[i] >= t ? 255 : 0;
    }
    const m = findMarkers(bin, DETECT_W, detectH);
    if (m) {
      detectMarkers = m;
      break;
    }
  }

  if (!detectMarkers) {
    throw new Error(
      `couldn't find the 6 registration markers (4 corners + mid-top + mid-bottom). ` +
        `if you printed an older template (only 4 corners), download the new one. ` +
        `otherwise click debug to see what the detector finds on your photo.`,
    );
  }

  const markers: MarkerSet = {
    tl: { x: detectMarkers.tl.x / detectScale, y: detectMarkers.tl.y / detectScale },
    tr: { x: detectMarkers.tr.x / detectScale, y: detectMarkers.tr.y / detectScale },
    bl: { x: detectMarkers.bl.x / detectScale, y: detectMarkers.bl.y / detectScale },
    br: { x: detectMarkers.br.x / detectScale, y: detectMarkers.br.y / detectScale },
    mt: { x: detectMarkers.mt.x / detectScale, y: detectMarkers.mt.y / detectScale },
    mb: { x: detectMarkers.mb.x / detectScale, y: detectMarkers.mb.y / detectScale },
  };

  const knownTL: [number, number] = [MARKER_CENTERS_PT.tl.x, A4_H_PT - MARKER_CENTERS_PT.tl.y];
  const knownTR: [number, number] = [MARKER_CENTERS_PT.tr.x, A4_H_PT - MARKER_CENTERS_PT.tr.y];
  const knownBR: [number, number] = [MARKER_CENTERS_PT.br.x, A4_H_PT - MARKER_CENTERS_PT.br.y];
  const knownBL: [number, number] = [MARKER_CENTERS_PT.bl.x, A4_H_PT - MARKER_CENTERS_PT.bl.y];
  const warp = computeHomography(
    [knownTL, knownTR, knownBR, knownBL],
    [
      [markers.tl.x, markers.tl.y],
      [markers.tr.x, markers.tr.y],
      [markers.br.x, markers.br.y],
      [markers.bl.x, markers.bl.y],
    ],
  );
  if (!warp) throw new Error("could not compute perspective transform from markers");

  return { oriW, oriH, markers, warp };
}

/** Inverse-map + bilinear-sample the full-res grayscale into the
 *  canonical page buffer. Verbatim port of the server's warpToCanonical
 *  inner loop. */
function warpToCanonical(
  srcGray: Uint8Array,
  srcW: number,
  srcH: number,
  warp: number[],
): Uint8Array {
  const dst = new Uint8Array(CANONICAL_W * CANONICAL_H);
  const invPx = 1 / PT_TO_CANONICAL_PX;
  for (let v = 0; v < CANONICAL_H; v++) {
    const ptY = v * invPx;
    const rowStart = v * CANONICAL_W;
    for (let u = 0; u < CANONICAL_W; u++) {
      const ptX = u * invPx;
      const [sx, sy] = applyH(warp, ptX, ptY);
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      const fx = sx - x0;
      const fy = sy - y0;
      const p00 =
        x0 < 0 || x0 >= srcW || y0 < 0 || y0 >= srcH ? 255 : srcGray[y0 * srcW + x0];
      const p10 =
        x1 < 0 || x1 >= srcW || y0 < 0 || y0 >= srcH ? 255 : srcGray[y0 * srcW + x1];
      const p01 =
        x0 < 0 || x0 >= srcW || y1 < 0 || y1 >= srcH ? 255 : srcGray[y1 * srcW + x0];
      const p11 =
        x1 < 0 || x1 >= srcW || y1 < 0 || y1 >= srcH ? 255 : srcGray[y1 * srcW + x1];
      const top = p00 * (1 - fx) + p10 * fx;
      const bot = p01 * (1 - fx) + p11 * fx;
      dst[rowStart + u] = Math.round(top * (1 - fy) + bot * fy);
    }
  }
  return dst;
}

// ---------------------------------------------------------------------
//  Public entry point
// ---------------------------------------------------------------------

// Dev escape hatch: expose the pipeline pieces for direct console
// probing (used by E2E tooling; harmless in production, tiny).
declare global {
  interface Window {
    __clientScan?: {
      clientProcessScan: typeof clientProcessScan;
      loadPotrace: typeof loadPotrace;
    };
  }
}

/**
 * Browser scan → GlyphPath[] pipeline. Throws with the same
 * user-facing messages the server pipeline uses (marker failures
 * etc.) so callers can surface them or fall back to the server path.
 *
 * @param blob The scan photo (already perspective-straightened by
 *             jscanify upstream, same as the server flow receives).
 * @param onProgress Optional 0..1 progress callback for UI.
 */
export async function clientProcessScan(
  blob: Blob,
  onProgress?: (fraction: number) => void,
): Promise<GlyphPath[]> {
  // Kick off the wasm load early — overlaps with image decode + warp.
  void loadPotrace();

  const img = await decodeImage(blob);
  onProgress?.(0.05);

  const layout = computeLayoutFromImage(img);
  onProgress?.(0.15);

  const srcGray = rasterizeGray(img, layout.oriW, layout.oriH);
  onProgress?.(0.25);

  const warped = warpToCanonical(srcGray, layout.oriW, layout.oriH, layout.warp);
  // Reject upside-down scans (markers are 180°-symmetric so warp accepts
  // a flipped photo; the QR landmark disambiguates). Same check + message
  // as the server pipeline. On throw, MakeFontForm falls back to the
  // server action, which re-detects and surfaces the same message.
  if (isScanUpsideDown(warped, CANONICAL_W)) {
    throw new Error(UPSIDE_DOWN_MESSAGE);
  }
  onProgress?.(0.4);

  const results: GlyphPath[] = [];
  for (let i = 0; i < ALPHABET.length; i++) {
    const { x: xPx, y: yPx, w: wPx, h: hPx } = cellExtractRect(i, CROP_INSET_PT);

    // Extract the cell subrect from the warped single-channel buffer.
    const cellRaw = new Uint8Array(wPx * hPx);
    for (let row = 0; row < hPx; row++) {
      const srcOff = (yPx + row) * CANONICAL_W + xPx;
      cellRaw.set(warped.subarray(srcOff, srcOff + wPx), row * wPx);
    }

    if (computeStddev(cellRaw) < 8) {
      onProgress?.(0.4 + 0.6 * ((i + 1) / ALPHABET.length));
      continue; // empty-cell guard
    }

    const smoothedBinary = cellSmoothedBinary(cellRaw, wPx, hPx);
    const svgPath = await traceGlyphClient(smoothedBinary, wPx, hPx);
    onProgress?.(0.4 + 0.6 * ((i + 1) / ALPHABET.length));
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

if (typeof window !== "undefined") {
  window.__clientScan = { clientProcessScan, loadPotrace };
}
