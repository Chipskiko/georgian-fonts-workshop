// A4 dimensions in points (1 pt = 1/72 inch). pdf-lib uses points.
// 210 mm × 297 mm
export const A4_W_PT = 595.276;
export const A4_H_PT = 841.890;

// Layout in points (12mm margin = ~34pt)
export const PAGE_MARGIN = 34;
export const COLS = 6;
export const ROWS = 6;
export const TOTAL_CELLS = COLS * ROWS; // 36; 33 used for the alphabet

// Registration markers — 30pt (~10.6mm) nested-square fiducials.
// Deliberately larger than a QR code's finder patterns (which are
// structurally similar nested squares) so the marker detector can
// reliably tell the two apart by size alone.
//
// 6 markers total: 4 corners + mid-top + mid-bottom. The mid-edge markers
// turn a fragile "4 dark blobs in a quadrilateral" check into a strong
// 3-point-collinearity check on each edge — random ink/objects almost
// never line up with two other things.
export const MARKER_SIZE = 30;
// Buffer between corner markers and the cell grid (top + bottom)
export const MARKER_BUFFER = 14;

/**
 * Centre positions (in pdf-lib PT, origin = bottom-left of page) of all
 * 6 registration markers. Ordering is FIXED — detection code keys off it.
 *
 *   tl  mt  tr
 *   ┌───┬───┐
 *   │   │   │
 *   ├───┼───┤   (grid)
 *   │   │   │
 *   └───┴───┘
 *   bl  mb  br
 */
export type MarkerKey = "tl" | "tr" | "bl" | "br" | "mt" | "mb";
export const MARKER_CENTERS_PT: Record<MarkerKey, { x: number; y: number }> = {
  tl: { x: PAGE_MARGIN + MARKER_SIZE / 2, y: A4_H_PT - PAGE_MARGIN - MARKER_SIZE / 2 },
  tr: { x: A4_W_PT - PAGE_MARGIN - MARKER_SIZE / 2, y: A4_H_PT - PAGE_MARGIN - MARKER_SIZE / 2 },
  bl: { x: PAGE_MARGIN + MARKER_SIZE / 2, y: PAGE_MARGIN + MARKER_SIZE / 2 },
  br: { x: A4_W_PT - PAGE_MARGIN - MARKER_SIZE / 2, y: PAGE_MARGIN + MARKER_SIZE / 2 },
  mt: { x: A4_W_PT / 2, y: A4_H_PT - PAGE_MARGIN - MARKER_SIZE / 2 },
  mb: { x: A4_W_PT / 2, y: PAGE_MARGIN + MARKER_SIZE / 2 },
};
/** All 6 markers' top-left corner positions (for pdf-lib drawRectangle). */
export const MARKER_RECTS_PT: { key: MarkerKey; x: number; y: number }[] = (
  ["tl", "tr", "bl", "br", "mt", "mb"] as const
).map((key) => ({
  key,
  x: MARKER_CENTERS_PT[key].x - MARKER_SIZE / 2,
  y: MARKER_CENTERS_PT[key].y - MARKER_SIZE / 2,
}));

// Top-of-cell zone reserved for the small Mkhedruli label
// (Calligraphr-style — label sits inside the cell, drawing area is below it)
export const LABEL_ZONE_HEIGHT = 16;

// Where the baseline guide sits inside the drawing box, measured as a fraction
// from the top of the box. Used by template.ts to draw the line AND by
// build-font.ts to align the printed baseline with the font's baseline (y=0).
export const BASELINE_FRAC_FROM_TOP = 0.75;

// The Georgian Mkhedruli alphabet, in canonical order
export const ALPHABET = [
  "ა", "ბ", "გ", "დ", "ე", "ვ", "ზ", "თ", "ი", "კ",
  "ლ", "მ", "ნ", "ო", "პ", "ჟ", "რ", "ს", "ტ", "უ",
  "ფ", "ქ", "ღ", "ყ", "შ", "ჩ", "ც", "ძ", "წ", "ჭ",
  "ხ", "ჯ", "ჰ",
];

// Unicode code points for the alphabet (matches ALPHABET above)
export const ALPHABET_CODES = ALPHABET.map((c) => c.codePointAt(0)!);

// The grid sits between the top and bottom marker rows with a small buffer
function gridBoundsPt() {
  const top = A4_H_PT - PAGE_MARGIN - MARKER_SIZE - MARKER_BUFFER;
  const bottom = PAGE_MARGIN + MARKER_SIZE + MARKER_BUFFER;
  const left = PAGE_MARGIN;
  const right = A4_W_PT - PAGE_MARGIN;
  return { top, bottom, left, right };
}

// Returns 0-indexed cell coordinates for a given alphabet index
export function cellRect(index: number): { col: number; row: number } {
  return { col: index % COLS, row: Math.floor(index / COLS) };
}

/**
 * Per-cell layout. Cells are flush against each other (shared borders) — the
 * label sits INSIDE the cell at the top-left, and the drawing box is the
 * remainder of the cell below the label zone.
 *
 * Returns coordinates in pdf-lib points (origin = bottom-left of the page).
 */
export function cellLayoutPt(index: number) {
  const { top, bottom, left, right } = gridBoundsPt();
  const gridW = right - left;
  const gridH = top - bottom;
  const cellW = gridW / COLS;
  const cellH = gridH / ROWS;
  const { col, row } = cellRect(index);

  // Cell rectangle (full size, flush with neighbours)
  const cellX = left + col * cellW;
  const cellTopY = top - row * cellH;
  const cellBottomY = cellTopY - cellH;

  // Label baseline inside the cell, top-left corner
  const labelX = cellX + 3;
  const labelY = cellTopY - LABEL_ZONE_HEIGHT * 0.75;

  // Drawing box = full cell width, cell height minus label zone at the top
  const boxX = cellX;
  const boxY = cellBottomY;
  const boxW = cellW;
  const boxH = cellH - LABEL_ZONE_HEIGHT;

  return { cellX, cellY: cellBottomY, cellW, cellH, labelX, labelY, boxX, boxY, boxW, boxH };
}

/** Used by process-scan.ts to know where each drawing box sits on the page. */
export function boxBoundsPt(index: number) {
  const l = cellLayoutPt(index);
  return { x: l.boxX, y: l.boxY, w: l.boxW, h: l.boxH };
}

// =====================================================================
//  Canonical warped-image geometry. Lives here (not process-scan.ts)
//  because BOTH pipelines need it — the server pipeline (sharp+potrace)
//  and the browser pipeline (canvas+wasm-potrace). This module is pure
//  (no node deps) so it bundles into the client without dragging sharp
//  along.
// =====================================================================

// Canonical output dimensions for the perspective-warped image.
// At 2100px wide, 1pt ≈ 3.53px, so the printed guide lines (~0.3pt)
// become ~1px in the warped buffer.
export const CANONICAL_W = 2100;
export const CANONICAL_H = Math.round(CANONICAL_W * (A4_H_PT / A4_W_PT));
export const PT_TO_CANONICAL_PX = CANONICAL_W / A4_W_PT;

/**
 * SINGLE SOURCE OF TRUTH for cell extraction rectangles in the warped
 * canonical image. ALL callsites use this — server processScan, browser
 * processScan, debug warped-view pink rects, debug cells-view extraction.
 * If this is right, every cell-related rendering is right; if it's
 * wrong, every cell rendering is wrong in exactly the same way.
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

// ---------------------------------------------------------------------
//  Upside-down (180°-rotated) scan detection — shared by both pipelines
// ---------------------------------------------------------------------

/** Georgian: "The scan looks upside down — rotate it and try again." */
export const UPSIDE_DOWN_MESSAGE =
  "სკანი თავდაყირა ჩანს — გადააბრუნე და სცადე თავიდან";

const QR_CANONICAL_CELL = 33; // the printed QR lives here (see template.ts)
const QR_MIRROR_CELL = 2; // 180°-opposite of cell 33 in the 6×6 grid
// Horizontal black/white transitions per 1000px of cell area. Measured
// on the real template: the QR cell scores ~33, any drawn letter ≤12,
// empty cells ~3. A threshold of 20 sits with an ~8-point margin on
// both sides, so a busy letter can't read as a QR (no false positive)
// and a dim photo that dulls the QR just fails to detect (no regression).
const QR_TRANSITION_MIN = 20;

/** Horizontal-transition density of one canonical cell — high for the
 *  dense QR pattern, low for sparse letterforms. */
function cellTransitionScore(gray: Uint8Array, width: number, idx: number): number {
  const { x, y, w, h } = cellExtractRect(idx, 0);
  let trans = 0;
  for (let row = 0; row < h; row++) {
    const base = (y + row) * width + x;
    let prev = gray[base] < 128 ? 1 : 0;
    for (let col = 1; col < w; col++) {
      const b = gray[base + col] < 128 ? 1 : 0;
      if (b !== prev) trans++;
      prev = b;
    }
  }
  return (trans / (w * h)) * 1000;
}

/**
 * Detect a 180°-rotated scan. The 6-marker registration layout (4
 * corners + mid-top/mid-bottom) is exactly 180°-symmetric, so marker
 * detection, collinearity, midpoint and aspect checks, and the
 * homography all accept an upside-down photo — then every cell receives
 * a DIFFERENT cell's content rotated 180° and the pipeline silently
 * emits a garbage font with no error. The QR code is the one asymmetric
 * landmark: detect it by transition density and, if it sits in the
 * mirror position (cell 2) instead of its home (cell 33), the page is
 * flipped. Runs on the canonical-size grayscale buffer both pipelines
 * produce after warp, so server and client decide identically.
 *
 * Deliberately conservative — only fires when the mirror cell is
 * unambiguously QR-dense AND the home cell is not — because a false
 * positive would reject a perfectly good upright scan.
 */
export function isScanUpsideDown(gray: Uint8Array, width: number): boolean {
  const atHome = cellTransitionScore(gray, width, QR_CANONICAL_CELL);
  const atMirror = cellTransitionScore(gray, width, QR_MIRROR_CELL);
  return (
    atMirror > QR_TRANSITION_MIN &&
    atHome < QR_TRANSITION_MIN &&
    atMirror > atHome * 2
  );
}
