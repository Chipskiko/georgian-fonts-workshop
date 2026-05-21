"use client";

/**
 * Client-side perspective correction using OpenCV.js.
 *
 * Workflow:
 *   1. Lazy-load OpenCV.js (~3MB) on first use
 *   2. Detect the 4 corner markers in the photo (same connected-component
 *      logic as the server, but running here so the server stays light)
 *   3. Compute a 3×3 perspective transform from detected markers → known
 *      canonical positions
 *   4. cv.warpPerspective to produce a clean A4-aspect image
 *   5. Encode as JPEG blob and hand back
 *
 * The server-side pipeline runs against this corrected image. Its own
 * marker detection then finds the markers exactly at the canonical
 * positions and the resulting homography becomes nearly identity — so
 * cells crop cleanly without any extra work on the server.
 *
 * If anything fails (OpenCV won't load, markers can't be found, etc.) we
 * return the original file untouched and let the server pipeline try to
 * recover.
 *
 * Phase 2 (mesh warp via cv.remap for actually-bent paper, not just
 * tilted) is a layer that goes on top of this — same control point
 * detection, additional interior grid intersections, then TPS-style
 * sampling. Not implemented yet.
 */

const OPENCV_SRC = "https://docs.opencv.org/4.10.0/opencv.js";

// A4 + marker constants (must mirror lib/font-pipeline/constants.ts)
const A4_W_PT = 595.276;
const A4_H_PT = 841.89;
const PAGE_MARGIN_PT = 34;
const MARKER_SIZE_PT = 30;

// Output canvas — same canonical size the server pipeline expects
const OUT_W = 2100;
const OUT_H = Math.round(OUT_W * (A4_H_PT / A4_W_PT));
const PT_TO_PX = OUT_W / A4_W_PT;

type Centroid = { x: number; y: number };
type MarkerSet = {
  tl: Centroid;
  tr: Centroid;
  bl: Centroid;
  br: Centroid;
  mt: Centroid;
  mb: Centroid;
};

declare global {
  interface Window {
    cv?: any;
  }
}

let opencvPromise: Promise<void> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function ensureOpenCv(): Promise<void> {
  if (opencvPromise) return opencvPromise;
  opencvPromise = (async () => {
    await loadScript(OPENCV_SRC);
    await new Promise<void>((resolve, reject) => {
      const cv = window.cv;
      if (cv && cv.Mat) return resolve();
      if (cv) {
        cv.onRuntimeInitialized = () => resolve();
        return;
      }
      // Script tag added but cv not yet attached to window — poll briefly
      const t0 = Date.now();
      const poll = () => {
        const c = window.cv;
        if (c && c.Mat) return resolve();
        if (c && !c.Mat) {
          c.onRuntimeInitialized = () => resolve();
          return;
        }
        if (Date.now() - t0 > 30000) return reject(new Error("opencv load timed out"));
        setTimeout(poll, 100);
      };
      poll();
    });
  })();
  return opencvPromise;
}

/** Parse just the EXIF orientation tag (0x0112) from a JPEG. Returns 1
 * (default upright) if the file isn't a JPEG, has no EXIF block, or the
 * tag is missing. Reads only the first 64KB — the EXIF segment always
 * sits in APP1 right after the SOI marker. */
async function readExifOrientation(file: File): Promise<number> {
  if (!file.type.includes("jpeg") && !file.name.toLowerCase().match(/\.(jpe?g)$/)) {
    return 1;
  }
  try {
    const buf = await file.slice(0, 65536).arrayBuffer();
    const view = new DataView(buf);
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return 1;
    let offset = 2;
    while (offset < view.byteLength - 4) {
      const marker = view.getUint16(offset, false);
      // APP1 (EXIF) marker
      if (marker === 0xffe1) {
        const segLen = view.getUint16(offset + 2, false);
        // "Exif\0\0" signature
        if (
          offset + 10 < view.byteLength &&
          view.getUint32(offset + 4, false) === 0x45786966 &&
          view.getUint16(offset + 8, false) === 0x0000
        ) {
          const tiffStart = offset + 10;
          const bom = view.getUint16(tiffStart, false);
          const little = bom === 0x4949;
          const ifdOff = view.getUint32(tiffStart + 4, little);
          const ifd = tiffStart + ifdOff;
          if (ifd + 2 > view.byteLength) return 1;
          const count = view.getUint16(ifd, little);
          for (let i = 0; i < count; i++) {
            const eo = ifd + 2 + i * 12;
            if (eo + 12 > view.byteLength) break;
            if (view.getUint16(eo, little) === 0x0112) {
              return view.getUint16(eo + 8, little) || 1;
            }
          }
        }
        offset += 2 + segLen;
      } else if ((marker & 0xff00) === 0xff00) {
        // Other APPx marker — skip
        const segLen = view.getUint16(offset + 2, false);
        offset += 2 + segLen;
      } else {
        break;
      }
    }
  } catch {
    /* fall through to default */
  }
  return 1;
}

async function loadImageBitmap(file: File): Promise<ImageBitmap> {
  // Read what the EXIF tag says the orientation SHOULD be.
  const orientation = await readExifOrientation(file);
  const raw = await createImageBitmap(file, { imageOrientation: "none" });
  if (orientation === 1) return raw;

  // iOS Safari ignores `imageOrientation: "none"` on some versions and
  // returns a bitmap that's ALREADY been EXIF-rotated. If we then apply
  // our own rotation on top, the image gets squeezed (rotated again into
  // a canvas sized for the wrong aspect ratio).
  //
  // Detect: for orientations 5-8 the raw sensor is landscape (width >
  // height) and the displayed image is portrait (height > width). If the
  // bitmap we got back is already portrait, the browser pre-rotated, so
  // we must NOT rotate again.
  const expectsSwap = orientation >= 5 && orientation <= 8;
  if (expectsSwap && raw.height > raw.width) {
    // Browser already did the work for us.
    return raw;
  }

  // Otherwise apply the canvas rotation.
  const canvas = document.createElement("canvas");
  canvas.width = expectsSwap ? raw.height : raw.width;
  canvas.height = expectsSwap ? raw.width : raw.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, canvas.width, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, canvas.width, canvas.height); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, canvas.height); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, canvas.width, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, canvas.width, canvas.height); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, canvas.height); break;
  }
  ctx.drawImage(raw, 0, 0);
  raw.close();
  return await createImageBitmap(canvas);
}

/**
 * Detect the 4 corner markers in a freshly-loaded image. Uses OpenCV's
 * findContours rather than a hand-rolled flood fill — much faster and more
 * robust for real photographs.
 *
 * Returns the marker centroids in INPUT image pixel coords, or null if
 * detection failed.
 */
function detectMarkers(bitmap: ImageBitmap): MarkerSet | null {
  const cv = window.cv;
  if (!cv) return null;

  // Read image into a Mat via an OffscreenCanvas
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);

  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const binary = new cv.Mat();
  // THRESH_BINARY_INV: ink becomes 255, paper becomes 0. We're looking
  // for dark blobs so inverting makes findContours treat them as foreground.
  // THRESH_OTSU automatically picks the cut from the image histogram, so
  // dim photos and bright photos both threshold cleanly. A fixed value
  // (was 110) silently kills detection when overall lightness drifts.
  cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  // RETR_TREE returns the full parent/child nesting so we can verify a
  // candidate has the marker's 3-level structure:
  //   outer black frame  →  white inner cutout  →  black centre dot.
  // RETR_LIST flattened everything and let any "square-ish dark blob" pass.
  cv.findContours(binary, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

  type Candidate = { x: number; y: number; area: number; bboxArea: number };
  const candidates: Candidate[] = [];
  let rejectedNesting = 0;
  let rejectedAspect = 0;
  let rejectedDensity = 0;
  let rejectedTooSmall = 0;

  const minArea = Math.max(400, (bitmap.width * bitmap.height) * 0.0001);
  // hierarchy.data32S is a flat Int32Array; 4 ints per contour:
  //   [Next, Previous, First_Child, Parent]
  const hData: Int32Array = hierarchy.data32S;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);
    if (area < minArea) {
      rejectedTooSmall++;
      contour.delete();
      continue;
    }
    const rect = cv.boundingRect(contour);
    const aspect = rect.width / rect.height;
    if (aspect < 0.5 || aspect > 2.0) {
      rejectedAspect++;
      contour.delete();
      continue;
    }
    const bboxArea = rect.width * rect.height;
    const fillDensity = area / bboxArea;
    // Frame ≈ 0.78; QR finder ≈ 0.49; solid square ≈ 1.0.
    if (fillDensity < 0.55 || fillDensity > 0.92) {
      rejectedDensity++;
      contour.delete();
      continue;
    }
    // Topology gate via contour hierarchy: the candidate must have a child
    // contour (the white inner cutout) AND that child must itself have a
    // child (the centre dot). Without this, any random square-ish dark
    // blob — table edges, drawing ink, photo borders — sneaks through and
    // gets fed to the homography solver, producing the radiating-rays
    // distortion the user saw.
    const firstChild = hData[i * 4 + 2];
    if (firstChild < 0) {
      rejectedNesting++;
      contour.delete();
      continue;
    }
    const grandchild = hData[firstChild * 4 + 2];
    if (grandchild < 0) {
      rejectedNesting++;
      contour.delete();
      continue;
    }
    candidates.push({
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      area,
      bboxArea,
    });
    contour.delete();
  }

  src.delete();
  gray.delete();
  binary.delete();
  contours.delete();
  hierarchy.delete();

  // Size filter: real markers are 30pt; assuming the page fills 40-100% of
  // the photo's shorter side, the marker bbox should be in a known px range.
  // Without this filter, big hand-drawn letters in the cells outrank the
  // real markers when picking "top 6 by size".
  const shorter = Math.min(bitmap.width, bitmap.height);
  const expectedPx = shorter * (30 / 595.276);
  const minPx = expectedPx * 0.4;
  const maxPx = expectedPx * 1.15;
  const sized = candidates.filter((c) => {
    // c.x / c.y are bbox centres but we don't have the bbox here; compute
    // from area + the bboxArea we stashed earlier.
    const dim = Math.sqrt(c.bboxArea);
    return dim >= minPx && dim <= maxPx;
  });

  if (sized.length < 6) return null;

  // Pick the 6 LARGEST size-filtered candidates.
  sized.sort((a, b) => b.area - a.area);
  const top6 = sized.slice(0, 6);

  // Split into top row / bottom row by y; within each row sort by x →
  // [left, mid, right]. Matches MARKER_CENTERS_PT ordering in constants.ts.
  const sortedByY = [...top6].sort((a, b) => a.y - b.y);
  const topRow = [...sortedByY.slice(0, 3)].sort((a, b) => a.x - b.x);
  const bottomRow = [...sortedByY.slice(3, 6)].sort((a, b) => a.x - b.x);
  const tl = { x: topRow[0].x, y: topRow[0].y };
  const mt = { x: topRow[1].x, y: topRow[1].y };
  const tr = { x: topRow[2].x, y: topRow[2].y };
  const bl = { x: bottomRow[0].x, y: bottomRow[0].y };
  const mb = { x: bottomRow[1].x, y: bottomRow[1].y };
  const br = { x: bottomRow[2].x, y: bottomRow[2].y };

  // Basic corner ordering + size
  if (tl.y >= bl.y || tr.y >= br.y) return null;
  if (tl.x >= tr.x || bl.x >= br.x) return null;
  const w = (tr.x - tl.x + br.x - bl.x) / 2;
  const h = (bl.y - tl.y + br.y - tr.y) / 2;
  if (w < bitmap.width * 0.2 || h < bitmap.height * 0.2) return null;

  // Aspect-ratio gate on the corner quadrilateral
  const A4_INNER_W_PT = 595.276 - 2 * (34 + 15);
  const A4_INNER_H_PT = 841.89 - 2 * (34 + 15);
  const expectedRatio = A4_INNER_H_PT / A4_INNER_W_PT;
  const actualRatio = h / w;
  if (actualRatio < expectedRatio * 0.6 || actualRatio > expectedRatio * 1.4) {
    return null;
  }

  // === Collinearity check — the bulletproof gate ===
  // MT must lie on the line TL→TR. MB must lie on the line BL→BR. Under
  // perspective, three collinear 3D points project to three collinear 2D
  // points, so this is exact modulo centroid-detection noise (a few px).
  // Random ink/blobs basically never line up perfectly with 2 other things.
  const topEdgeLen = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottomEdgeLen = Math.hypot(br.x - bl.x, br.y - bl.y);
  const topTol = Math.max(8, topEdgeLen * 0.025);
  const bottomTol = Math.max(8, bottomEdgeLen * 0.025);
  const topDist = perpDistance(mt, tl, tr);
  const bottomDist = perpDistance(mb, bl, br);
  if (topDist > topTol) return null;
  if (bottomDist > bottomTol) return null;

  // Midpoint-position check: mid markers should sit roughly halfway along
  // each edge (catches the case where mt landed near a corner by coincidence)
  const tlMtAlong = projectAlong(mt, tl, tr);
  const blMbAlong = projectAlong(mb, bl, br);
  if (tlMtAlong < 0.35 || tlMtAlong > 0.65) return null;
  if (blMbAlong < 0.35 || blMbAlong > 0.65) return null;

  return { tl, tr, bl, br, mt, mb };
}

/** Perpendicular distance from point p to the infinite line through a and b. */
function perpDistance(p: Centroid, a: Centroid, b: Centroid): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 0;
  return Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len;
}

/** Parametric position of p projected onto line a→b: 0=a, 1=b, 0.5=halfway. */
function projectAlong(p: Centroid, a: Centroid, b: Centroid): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return 0;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
}

/**
 * Compute the perspective transform and warp the input image so the
 * detected markers land at their canonical positions on a 2100×~2970
 * white canvas. Returns the corrected image as a JPEG Blob.
 */
async function warpToCanonical(bitmap: ImageBitmap, markers: MarkerSet): Promise<Blob> {
  const cv = window.cv;
  if (!cv) throw new Error("opencv not loaded");

  // Canonical marker centre positions (in output px)
  const m = (PAGE_MARGIN_PT + MARKER_SIZE_PT / 2) * PT_TO_PX;
  const tlDst = [m, m];
  const trDst = [OUT_W - m, m];
  const brDst = [OUT_W - m, OUT_H - m];
  const blDst = [m, OUT_H - m];

  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    markers.tl.x, markers.tl.y,
    markers.tr.x, markers.tr.y,
    markers.br.x, markers.br.y,
    markers.bl.x, markers.bl.y,
  ]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tlDst[0], tlDst[1],
    trDst[0], trDst[1],
    brDst[0], brDst[1],
    blDst[0], blDst[1],
  ]);

  const H = cv.getPerspectiveTransform(srcPts, dstPts);

  const inputCanvas = document.createElement("canvas");
  inputCanvas.width = bitmap.width;
  inputCanvas.height = bitmap.height;
  const ictx = inputCanvas.getContext("2d");
  if (!ictx) throw new Error("no 2d context");
  ictx.drawImage(bitmap, 0, 0);

  const inputMat = cv.imread(inputCanvas);
  const outputMat = new cv.Mat();
  const dsize = new cv.Size(OUT_W, OUT_H);
  cv.warpPerspective(
    inputMat,
    outputMat,
    H,
    dsize,
    cv.INTER_LINEAR,
    cv.BORDER_CONSTANT,
    new cv.Scalar(255, 255, 255, 255),
  );

  const outCanvas = document.createElement("canvas");
  outCanvas.width = OUT_W;
  outCanvas.height = OUT_H;
  cv.imshow(outCanvas, outputMat);

  inputMat.delete();
  outputMat.delete();
  H.delete();
  srcPts.delete();
  dstPts.delete();

  return await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("blob conversion failed"))),
      "image/jpeg",
      0.92,
    );
  });
}

export async function straightenScan(file: File): Promise<Blob> {
  try {
    await ensureOpenCv();
    const bitmap = await loadImageBitmap(file);
    const markers = detectMarkers(bitmap);
    if (!markers) return file; // fallback — server pipeline will try its own detection
    return await warpToCanonical(bitmap, markers);
  } catch {
    return file;
  }
}
