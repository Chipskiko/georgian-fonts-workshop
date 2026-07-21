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
