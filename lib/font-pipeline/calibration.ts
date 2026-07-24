import sharp from "sharp";
import QRCode from "qrcode";
import {
  A4_W_PT,
  A4_H_PT,
  PAGE_MARGIN,
  MARKER_SIZE,
  MARKER_RECTS_PT,
  ALPHABET,
  BASELINE_FRAC_FROM_TOP,
  cellLayoutPt,
} from "./constants";
import { TEMPLATE_QR_URL, QR_CELL_INDEX } from "./template";

/**
 * Generate a calibration image that mirrors the workshop template + draws
 * known test shapes in each cell. Used to validate the scan pipeline end-
 * to-end WITHOUT requiring paper printing, hand-drawing, or scanning —
 * isolates the algorithmic correctness from the physical workflow.
 *
 * Each cell holds a different deliberate shape:
 *   - Most cells: a solid filled rectangle sitting on the baseline guide
 *     (the SAME shape in every cell — easy to spot misalignment)
 *   - A few "special" cells exercise specific pipeline knobs:
 *       - tiny dot     (turdSize filtering)
 *       - thin line    (optTolerance — must survive)
 *       - ring         (winding direction for nested contours)
 *       - sharp X      (alphaMax — corners must not round)
 *       - off-cell     (drawing extending past the cell — bounds test)
 *
 * The resulting PNG is at the same canonical 2100×2970 size as a perfect
 * scan would be, so the marker-detection + homography logic in
 * process-scan.ts runs against it exactly like a real upload.
 */

const TARGET_W = 2100;
const TARGET_H = Math.round(TARGET_W * (A4_H_PT / A4_W_PT));
const PT_TO_PX = TARGET_W / A4_W_PT;

const SHAPE_BLACK = "#000000";

type ShapeKind = "rect" | "dot" | "hline" | "vline" | "ring" | "x" | "overflow";

const SPECIAL_SHAPES: Record<number, ShapeKind> = {
  28: "dot",       // ჭ — tiny dot for turdSize
  29: "hline",     // ხ — thin horizontal line for optTolerance
  30: "vline",     // ჯ — thin vertical line
  31: "ring",      // ჰ — ring for winding test (last alphabet letter)
  // Cells 32, 33, 34, 35 are empty (alphabet only has 33)
};

/** SVG for the 6 registration markers — 4 corners + mid-top + mid-bottom.
 *  Must match the template exactly so marker detection finds them in the
 *  same positions. Nested squares: outer black frame + inner white cutout
 *  + center dot. Shared with the hand-drawn simulation scan. */
export function markersSvg(): string {
  const parts: string[] = [];
  const ms = MARKER_SIZE * PT_TO_PX;
  const innerCutoutPx = 14 * PT_TO_PX;
  const dotPx = 5 * PT_TO_PX;
  const drawMarker = (x: number, y: number) => {
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${ms.toFixed(1)}" height="${ms.toFixed(1)}" fill="${SHAPE_BLACK}"/>`);
    parts.push(
      `<rect x="${(x + (ms - innerCutoutPx) / 2).toFixed(1)}" y="${(y + (ms - innerCutoutPx) / 2).toFixed(1)}" ` +
      `width="${innerCutoutPx.toFixed(1)}" height="${innerCutoutPx.toFixed(1)}" fill="#ffffff"/>`,
    );
    parts.push(
      `<rect x="${(x + (ms - dotPx) / 2).toFixed(1)}" y="${(y + (ms - dotPx) / 2).toFixed(1)}" ` +
      `width="${dotPx.toFixed(1)}" height="${dotPx.toFixed(1)}" fill="${SHAPE_BLACK}"/>`,
    );
  };
  // MARKER_RECTS_PT positions are in pdf-lib coords (origin = bottom-left);
  // flip y for SVG (origin = top-left).
  for (const r of MARKER_RECTS_PT) {
    const x = r.x * PT_TO_PX;
    const y = (A4_H_PT - r.y - MARKER_SIZE) * PT_TO_PX;
    drawMarker(x, y);
  }
  return parts.join("");
}

/** SVG for the QR code in its reserved cell — same content and placement
 *  as the printed template. Shared with the hand-drawn simulation scan. */
export async function qrCellSvg(): Promise<string> {
  const parts: string[] = [];
  const qrMatrix = await QRCode.create(TEMPLATE_QR_URL, { errorCorrectionLevel: "M" });
  const qrLayout = cellLayoutPt(QR_CELL_INDEX);
  const qrCellXPx = qrLayout.cellX * PT_TO_PX;
  const qrCellYPx = (A4_H_PT - qrLayout.cellY - qrLayout.cellH) * PT_TO_PX;
  const qrCellWPx = qrLayout.cellW * PT_TO_PX;
  const qrCellHPx = qrLayout.cellH * PT_TO_PX;
  const qrInsetPx = 10 * PT_TO_PX;
  const qrSizePx = Math.min(qrCellWPx, qrCellHPx) - qrInsetPx * 2;
  const moduleSizePx = qrSizePx / qrMatrix.modules.size;
  const qrOriginX = qrCellXPx + (qrCellWPx - qrSizePx) / 2;
  const qrOriginY = qrCellYPx + (qrCellHPx - qrSizePx) / 2;
  for (let r = 0; r < qrMatrix.modules.size; r++) {
    for (let c = 0; c < qrMatrix.modules.size; c++) {
      if (!qrMatrix.modules.get(r, c)) continue;
      parts.push(
        `<rect x="${(qrOriginX + c * moduleSizePx).toFixed(2)}" y="${(qrOriginY + r * moduleSizePx).toFixed(2)}" ` +
        `width="${moduleSizePx.toFixed(2)}" height="${moduleSizePx.toFixed(2)}" fill="${SHAPE_BLACK}"/>`,
      );
    }
  }
  return parts.join("");
}

export async function generateCalibrationSvg(): Promise<string> {
  const w = TARGET_W;
  const h = TARGET_H;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`);
  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff"/>`);

  parts.push(markersSvg());

  // For each alphabet cell, draw a DIAGNOSTIC pattern designed to make
  // pipeline bugs immediately visible in the cells debug view:
  //
  //   • Inset border that fills the BOX exactly — if the cells view crop
  //     captures the right area, the user sees a thin black rectangle
  //     hugging all 4 edges of each grid slot. If the crop is
  //     mis-positioned or wrong-sized, the border is offset / partial.
  //
  //   • Large numeric label of the 1-based cell index in the centre —
  //     reading "5" in grid slot #5 confirms the cell is at the right
  //     position; reading a different number confirms a position bug.
  //
  //   • Corner crosshairs at exact box corners — if the crop captures
  //     the box, all 4 crosshairs are visible at the corners of the grid
  //     slot. Missing or shifted corners reveal extraction errors.
  //
  //   • Horizontal scale bar at the bottom (50pt wide with 10pt ticks) —
  //     scale errors make the bar the wrong length in the cells view.
  for (let i = 0; i < ALPHABET.length; i++) {
    const layout = cellLayoutPt(i);
    const cellX = layout.cellX * PT_TO_PX;
    const cellY_topDown = (A4_H_PT - layout.cellY - layout.cellH) * PT_TO_PX;
    const cellW = layout.cellW * PT_TO_PX;
    const cellH = layout.cellH * PT_TO_PX;
    const boxX = layout.boxX * PT_TO_PX;
    const boxY_topDown = (A4_H_PT - layout.boxY - layout.boxH) * PT_TO_PX;
    const boxW = layout.boxW * PT_TO_PX;
    const boxH = layout.boxH * PT_TO_PX;

    // Faint cell outline to match printed-template look
    parts.push(
      `<rect x="${cellX}" y="${cellY_topDown}" width="${cellW}" height="${cellH}" fill="none" stroke="#dddddd" stroke-width="1"/>`,
    );

    // Diagnostic pattern (overrides the old test-shape system)
    parts.push(drawDiagnostic(i, boxX, boxY_topDown, boxW, boxH));
  }
  // Suppress dead-code warning for the legacy test-shape system kept
  // around for reference.
  void SPECIAL_SHAPES;
  void drawShape;

  // QR code in the same empty cell as the template — keeps the calibration
  // image equivalent to a freshly-printed template.
  parts.push(await qrCellSvg());

  parts.push(`</svg>`);
  return parts.join("");
}

function drawShape(
  kind: ShapeKind,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  baselineY: number,
  _cellW: number,
  _cellH: number,
): string {
  switch (kind) {
    case "rect": {
      // Solid filled rectangle sitting on the baseline.
      // Width = 60% of box width, height = 70% of (box top → baseline).
      const ww = bw * 0.6;
      const hh = (baselineY - by) * 0.7;
      const x = bx + (bw - ww) / 2;
      const y = baselineY - hh;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${ww.toFixed(1)}" height="${hh.toFixed(1)}" fill="${SHAPE_BLACK}"/>`;
    }
    case "dot": {
      // Small dot on the baseline — tests turdSize filtering
      const r = bw * 0.04;
      const cx = bx + bw / 2;
      const cy = baselineY - r;
      return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${SHAPE_BLACK}"/>`;
    }
    case "hline": {
      // Thin horizontal line on the baseline
      const ww = bw * 0.7;
      const hh = 2;
      const x = bx + (bw - ww) / 2;
      const y = baselineY - hh;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${ww.toFixed(1)}" height="${hh.toFixed(1)}" fill="${SHAPE_BLACK}"/>`;
    }
    case "vline": {
      // Thin vertical line spanning baseline-to-ascender area
      const ww = 2;
      const hh = (baselineY - by) * 0.7;
      const x = bx + (bw - ww) / 2;
      const y = baselineY - hh;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${ww.toFixed(1)}" height="${hh.toFixed(1)}" fill="${SHAPE_BLACK}"/>`;
    }
    case "ring": {
      // Ring (donut) — outer filled circle with an inner hole
      const cx = bx + bw / 2;
      const outerR = (baselineY - by) * 0.32;
      const innerR = outerR * 0.5;
      const cy = baselineY - outerR;
      return (
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${outerR.toFixed(1)}" fill="${SHAPE_BLACK}"/>` +
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${innerR.toFixed(1)}" fill="#ffffff"/>`
      );
    }
    case "x": {
      const ww = bw * 0.5;
      const cx = bx + bw / 2;
      const cyMid = baselineY - ww / 2;
      const half = ww / 2;
      return (
        `<line x1="${(cx - half).toFixed(1)}" y1="${(cyMid - half).toFixed(1)}" x2="${(cx + half).toFixed(1)}" y2="${(cyMid + half).toFixed(1)}" stroke="${SHAPE_BLACK}" stroke-width="3"/>` +
        `<line x1="${(cx + half).toFixed(1)}" y1="${(cyMid - half).toFixed(1)}" x2="${(cx - half).toFixed(1)}" y2="${(cyMid + half).toFixed(1)}" stroke="${SHAPE_BLACK}" stroke-width="3"/>`
      );
    }
    case "overflow": {
      // Rectangle extending past the cell bottom — tests overflow handling
      const ww = bw * 0.6;
      const hh = bh * 1.1;
      const x = bx + (bw - ww) / 2;
      const y = by;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${ww.toFixed(1)}" height="${hh.toFixed(1)}" fill="${SHAPE_BLACK}"/>`;
    }
  }
}

/**
 * Diagnostic pattern for cell `index`, drawn into the box rectangle
 * (bx, by, bw, bh) in PX. See generateCalibrationSvg for what each
 * element verifies.
 */
function drawDiagnostic(index: number, bx: number, by: number, bw: number, bh: number): string {
  const out: string[] = [];

  // 1. Inset border that fills the box exactly. Stroke is INSIDE the
  //    box (we draw at bx+1, by+1 with bw-2, bh-2 so the stroke center
  //    sits at bx+1.5; with stroke-width 2 the visible edge is at
  //    bx+0.5..bx+2.5 — i.e. inside the box).
  out.push(
    `<rect x="${(bx + 1).toFixed(1)}" y="${(by + 1).toFixed(1)}" ` +
    `width="${(bw - 2).toFixed(1)}" height="${(bh - 2).toFixed(1)}" ` +
    `fill="none" stroke="${SHAPE_BLACK}" stroke-width="2"/>`,
  );

  // 2. Big numeric label of the 1-based index, centered.
  const label = String(index + 1);
  const labelSize = Math.min(bw, bh) * 0.45;
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  out.push(
    `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" ` +
    `font-family="Arial, sans-serif" font-size="${labelSize.toFixed(1)}" ` +
    `font-weight="bold" fill="${SHAPE_BLACK}" ` +
    `text-anchor="middle" dominant-baseline="central">${label}</text>`,
  );

  // 3. Corner crosshairs (10px arms) at exact box corners. These ALWAYS
  //    sit at (bx, by), (bx+bw, by), (bx, by+bh), (bx+bw, by+bh) so
  //    any crop misalignment removes them.
  const arm = 10;
  const corners = [
    [bx, by],
    [bx + bw, by],
    [bx, by + bh],
    [bx + bw, by + bh],
  ];
  for (const [x, y] of corners) {
    out.push(
      `<line x1="${(x - arm).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + arm).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${SHAPE_BLACK}" stroke-width="2"/>` +
      `<line x1="${x.toFixed(1)}" y1="${(y - arm).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(y + arm).toFixed(1)}" stroke="${SHAPE_BLACK}" stroke-width="2"/>`,
    );
  }

  // 4. Scale bar: 50pt wide horizontal line at the bottom of the box,
  //    with 10pt tick marks. In PX: 50pt = 50 × PT_TO_PX, etc.
  const scaleY = by + bh - 18;
  const scaleStartX = bx + 12;
  const scaleEndX = scaleStartX + 50 * PT_TO_PX;
  out.push(
    `<line x1="${scaleStartX.toFixed(1)}" y1="${scaleY.toFixed(1)}" x2="${scaleEndX.toFixed(1)}" y2="${scaleY.toFixed(1)}" stroke="${SHAPE_BLACK}" stroke-width="1"/>`,
  );
  for (let t = 0; t <= 5; t++) {
    const tx = scaleStartX + t * 10 * PT_TO_PX;
    out.push(
      `<line x1="${tx.toFixed(1)}" y1="${(scaleY - 4).toFixed(1)}" x2="${tx.toFixed(1)}" y2="${(scaleY + 4).toFixed(1)}" stroke="${SHAPE_BLACK}" stroke-width="1"/>`,
    );
  }
  return out.join("");
}

export async function generateCalibrationPng(): Promise<Buffer> {
  const svg = await generateCalibrationSvg();
  return await sharp(Buffer.from(svg)).png().toBuffer();
}
