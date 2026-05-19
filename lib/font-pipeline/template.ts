import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import QRCode from "qrcode";
import fs from "node:fs";
import path from "node:path";
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

// Placeholder URL the QR encodes. Update to the real deploy URL when the
// site is hosted — participants scanning the QR will be taken straight
// to the upload page.
export const TEMPLATE_QR_URL = "https://georgian-fonts.app/make";
// Index of the cell that hosts the QR (first cell after the alphabet ends).
// 33 corresponds to row 5, col 3 in the 6×6 grid — the first empty slot.
export const QR_CELL_INDEX = 33;

const HINT_FONT_PATH = path.join(process.cwd(), "lib", "template-assets", "NotoSansGeorgian-Regular.ttf");

export async function generateTemplatePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const fontBytes = fs.readFileSync(HINT_FONT_PATH);
  const georgianFont = await pdf.embedFont(fontBytes);

  // Pre-compute QR matrix once. Use a medium error correction level so the
  // QR still scans if the print is slightly damaged or one of the cells
  // overlaps a corner of it.
  const qrMatrix = await QRCode.create(TEMPLATE_QR_URL, { errorCorrectionLevel: "M" });

  const page = pdf.addPage([A4_W_PT, A4_H_PT]);
  const black = rgb(0, 0, 0);
  const grey = rgb(0.55, 0.55, 0.55);

  // 6 registration markers — 4 corners + mid-top + mid-bottom. Nested-squares
  // design: outer black frame + inner white cutout + small black center dot.
  // Detection uses 3-point collinearity on each edge (TL-MT-TR, BL-MB-BR) for
  // bulletproof validation: a random dark blob basically never lines up
  // perfectly with two other things.
  const white = rgb(1, 1, 1);
  // Inner cutout and centre dot scale with MARKER_SIZE so the visual
  // proportion stays the same (cutout ≈ 47% of outer, dot ≈ 17% of outer).
  const innerCutout = 14;            // pt — white square carved out of the centre
  const centerDot = 5;               // pt — black square dot in the very middle
  for (const c of MARKER_RECTS_PT) {
    page.drawRectangle({ x: c.x, y: c.y, width: MARKER_SIZE, height: MARKER_SIZE, color: black });
    page.drawRectangle({
      x: c.x + (MARKER_SIZE - innerCutout) / 2,
      y: c.y + (MARKER_SIZE - innerCutout) / 2,
      width: innerCutout,
      height: innerCutout,
      color: white,
    });
    page.drawRectangle({
      x: c.x + (MARKER_SIZE - centerDot) / 2,
      y: c.y + (MARKER_SIZE - centerDot) / 2,
      width: centerDot,
      height: centerDot,
      color: black,
    });
  }

  // (Header text removed — keeps the top strip clean and removes any chance
  // of the printed text being mis-detected as a marker candidate.)

  // Calligraphr-style grid: cells share borders (no gap between them), each
  // cell has its label in the top-left corner and 4 horizontal guide lines
  // (ascender / cap / x-height / baseline / descender zones) inside the
  // drawing box below the label.
  //
  // All guide colours must be LIGHTER than the scan-pipeline threshold
  // (170/255) so they get classified as white (paper) when binarised — if a
  // guide line ends up darker, potrace will trace it as ink and every glyph
  // ships with a stray horizontal stroke.
  const labelSize = 10;
  // Guide DOTS sit inside the cell drawing crop so their colour must stay
  // above the scan threshold (170/255). Pushed lighter per request — still
  // visible on paper but very subtle visually.
  const guideGrey = rgb(0.9, 0.9, 0.9);        // 230/255 — clearly above threshold
  const baselineGrey = rgb(0.86, 0.86, 0.86);  // 219/255 — a touch lighter than before, still emphasised vs guides
  // Label-divider line sits BETWEEN the label and the drawing crop. It is
  // outside the crop region so colour can be arbitrarily dark for emphasis.
  const labelDividerGrey = rgb(0.4, 0.4, 0.4); // 102/255 — softened from 0.25 for a less heavy line
  for (let i = 0; i < ALPHABET.length; i++) {
    const layout = cellLayoutPt(i);

    // Full cell border — thin + light grey so the printed grid reads as a
    // faint scaffold, not a heavy print. Still visible enough to align by.
    // (Lightness > scan threshold so it's also filtered if accidentally
    // captured by an oversized crop.)
    page.drawRectangle({
      x: layout.cellX,
      y: layout.cellY,
      width: layout.cellW,
      height: layout.cellH,
      borderColor: rgb(0.78, 0.78, 0.78),
      borderWidth: 0.2,
    });

    // Horizontal divider between the label zone and the drawing box —
    // solid darker line so the printed letter sits clearly above the
    // drawing area.
    const labelDividerY = layout.boxY + layout.boxH;
    page.drawLine({
      start: { x: layout.cellX, y: labelDividerY },
      end: { x: layout.cellX + layout.cellW, y: labelDividerY },
      color: labelDividerGrey,
      thickness: 0.3,
    });

    // 4 horizontal guide lines inside the drawing box, drawn as DOTS for a
    // lighter visual weight. The baseline (75% from top) gets denser/larger
    // dots for emphasis since BASELINE_FRAC_FROM_TOP is the source of truth
    // for font-baseline alignment in build-font.ts.
    const guides: Array<{ fracFromTop: number; emphasised?: boolean }> = [
      { fracFromTop: 0.25 },
      { fracFromTop: 0.5 },
      { fracFromTop: BASELINE_FRAC_FROM_TOP, emphasised: true }, // baseline
      { fracFromTop: 0.9 },                                       // descender
    ];
    const boxTop = layout.boxY + layout.boxH;
    for (const g of guides) {
      const y = boxTop - layout.boxH * g.fracFromTop;
      drawDottedHLine(
        page,
        layout.boxX + 1.5,
        layout.boxX + layout.boxW - 1.5,
        y,
        g.emphasised ? baselineGrey : guideGrey,
        g.emphasised ? 0.6 : 0.4,
        g.emphasised ? 2 : 2.5,
      );
    }

    // Label in the top-left corner, inside the label zone
    const ch = ALPHABET[i];
    page.drawText(ch, {
      x: layout.labelX,
      y: layout.labelY,
      size: labelSize,
      color: grey,
      font: georgianFont,
    });
  }

  // QR code in the first empty cell (index 33) — links to the upload URL.
  // Sits inside the bottom row, leftmost of the 3 empty slots.
  drawQrInCell(page, qrMatrix, QR_CELL_INDEX, black);

  return await pdf.save();
}

/**
 * Draw a QR matrix centered inside a specific cell in the grid. Each QR
 * module becomes a small filled rectangle in pdf-lib. Sized to fill most
 * of the cell with a small margin.
 */
function drawQrInCell(
  page: ReturnType<PDFDocument["addPage"]>,
  qrMatrix: QRCode.QRCode,
  cellIndex: number,
  color: ReturnType<typeof rgb>,
) {
  const layout = cellLayoutPt(cellIndex);
  const inset = 10; // pt — keep some breathing room inside the cell
  const availW = layout.cellW - inset * 2;
  const availH = layout.cellH - inset * 2;
  const qrSize = Math.min(availW, availH);
  const moduleSize = qrSize / qrMatrix.modules.size;
  const originX = layout.cellX + (layout.cellW - qrSize) / 2;
  const originY = layout.cellY + (layout.cellH - qrSize) / 2;

  for (let r = 0; r < qrMatrix.modules.size; r++) {
    for (let c = 0; c < qrMatrix.modules.size; c++) {
      if (!qrMatrix.modules.get(r, c)) continue;
      page.drawRectangle({
        // PDF y increases upward, but QR row 0 is at the TOP visually,
        // so flip the row index when computing y.
        x: originX + c * moduleSize,
        y: originY + (qrMatrix.modules.size - 1 - r) * moduleSize,
        width: moduleSize,
        height: moduleSize,
        color,
      });
    }
  }
}

/**
 * Draw a horizontal dotted line as a series of small filled circles.
 * Lighter visual weight than a thin solid line at the same colour.
 */
function drawDottedHLine(
  page: ReturnType<PDFDocument["addPage"]>,
  x1: number,
  x2: number,
  y: number,
  color: ReturnType<typeof rgb>,
  dotRadius: number,
  gap: number,
) {
  if (x2 <= x1) return;
  for (let x = x1; x <= x2; x += gap) {
    page.drawCircle({ x, y, size: dotRadius, color });
  }
}
