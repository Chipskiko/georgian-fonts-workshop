import * as opentype from "opentype.js";
import type { GlyphPath } from "./process-scan";
import { ALPHABET, ALPHABET_CODES, BASELINE_FRAC_FROM_TOP } from "./constants";

const UNITS_PER_EM = 1000;
// Ascender / descender are derived from where the baseline guide sits on the
// printed template. With BASELINE_FRAC_FROM_TOP = 0.75:
//   ASCENDER = 0.75 * 1000 = 750  (space above baseline inside the cell)
//   DESCENDER = -0.25 * 1000 = -250  (space below baseline)
//   Total em = 1000
// This way, when we map cell-top → ASCENDER and cell-bottom → DESCENDER, the
// printed baseline guide naturally falls at font y=0.
const ASCENDER = Math.round(BASELINE_FRAC_FROM_TOP * UNITS_PER_EM);
const DESCENDER = -Math.round((1 - BASELINE_FRAC_FROM_TOP) * UNITS_PER_EM);
const SAFE_LEFT_BEARING = 60;

/**
 * Box-aligned scaling: the CELL (not the ink) defines the em.
 *
 * This is the right choice for an experimental-type workshop. Any mark drawn
 * inside a cell — a tiny dot, a sprawling figurine, a scribble, a texture —
 * is preserved at the size it was drawn relative to other cells. A dot stays
 * a dot when typed; a figurine stays huge. Nothing gets stretched to a
 * common "glyph height".
 *
 * Vertical mapping (pixel y → font y):
 *   cell top    (y=0)          → ASCENDER  (750)
 *   cell bottom (y=cellH)      → DESCENDER (-250)
 *   baseline guide (y=0.75H)   → 0 (font baseline)  ← this is the alignment fix
 * So the entire cell maps to one full em vertically.
 *
 * Horizontal scale: same factor as Y, preserves aspect (a circle stays a circle).
 *
 * Advance width: a function of cell aspect, NOT ink width — predictable spacing.
 */
function advanceWidthFromCell(cellWidthPx: number, cellHeightPx: number): number {
  const aspect = cellWidthPx / cellHeightPx;
  return Math.round(UNITS_PER_EM * aspect);
}

export function buildFont(
  paths: GlyphPath[],
  meta: { familyName: string; designerName?: string },
): Uint8Array {
  // .notdef must be the first glyph
  const notdef = new opentype.Glyph({
    name: ".notdef",
    unicode: 0,
    advanceWidth: 600,
    path: new opentype.Path(),
  });

  // Always include space (U+0020)
  const space = new opentype.Glyph({
    name: "space",
    unicode: 0x0020,
    advanceWidth: 350,
    path: new opentype.Path(),
  });

  const glyphs: opentype.Glyph[] = [notdef, space];

  // Map alphabet → drawn paths
  const byIndex = new Map<number, GlyphPath>();
  for (const p of paths) byIndex.set(p.index, p);

  for (let i = 0; i < ALPHABET.length; i++) {
    const drawn = byIndex.get(i);
    const codePoint = ALPHABET_CODES[i];
    const ch = ALPHABET[i];

    if (!drawn) {
      // empty glyph for missing letters — keeps font set complete
      glyphs.push(
        new opentype.Glyph({
          name: `u${codePoint.toString(16).toUpperCase()}`,
          unicode: codePoint,
          advanceWidth: 500,
          path: new opentype.Path(),
        }),
      );
      continue;
    }

    const opentypePath = svgPathToOpentype(drawn.svgPath, drawn.cellWidthPx, drawn.cellHeightPx);
    // Advance width derived from cell aspect, not ink — keeps spacing predictable
    // across wildly different drawn shapes (dot vs figurine).
    const advanceWidth = Math.max(
      300,
      advanceWidthFromCell(drawn.cellWidthPx, drawn.cellHeightPx),
    );

    glyphs.push(
      new opentype.Glyph({
        name: `u${codePoint.toString(16).toUpperCase()}_${ch}`,
        unicode: codePoint,
        advanceWidth,
        path: opentypePath,
      }),
    );
  }

  const font = new opentype.Font({
    familyName: meta.familyName,
    styleName: "Regular",
    designer: meta.designerName ?? "Workshop",
    unitsPerEm: UNITS_PER_EM,
    ascender: ASCENDER,
    descender: DESCENDER,
    glyphs,
  });

  return new Uint8Array(font.toArrayBuffer());
}

/**
 * Convert an SVG path-data string from a cell-sized image (pixels)
 * into an opentype.js Path in font units, using box-aligned scaling.
 *
 * The CELL defines the em, NOT the ink. So every glyph uses the same
 * pixel→font scale factor: a tiny dot stays a tiny dot, a sprawling figurine
 * stays sprawling. Nothing is normalised to a target height.
 *
 *   pixel x → font x = px * scale + SAFE_LEFT_BEARING
 *   pixel y → font y = ASCENDER - py * scale     (raster y-down → font y-up)
 *
 * cell top    (py=0)                       → ASCENDER (750)
 * baseline guide (py=BASELINE_FRAC*cellH)  → 0 (font baseline)
 * cell bottom (py=cellH)                   → ASCENDER - UNITS_PER_EM = DESCENDER (-250)
 */
function svgPathToOpentype(d: string, _cellW: number, cellH: number): opentype.Path {
  const cmds = parseSvgPath(d);
  if (cmds.length === 0) return new opentype.Path();

  const scale = UNITS_PER_EM / cellH;
  const offsetX = SAFE_LEFT_BEARING;
  const offsetY = ASCENDER;

  const tx = (x: number) => Math.round(x * scale + offsetX);
  const ty = (y: number) => Math.round(offsetY - y * scale);

  const path = new opentype.Path();
  for (const cmd of cmds) {
    if (cmd.type === "M") {
      const [x, y] = cmd.points[0];
      path.moveTo(tx(x), ty(y));
    } else if (cmd.type === "L") {
      const [x, y] = cmd.points[0];
      path.lineTo(tx(x), ty(y));
    } else if (cmd.type === "C") {
      const [[x1, y1], [x2, y2], [x, y]] = cmd.points;
      path.curveTo(tx(x1), ty(y1), tx(x2), ty(y2), tx(x), ty(y));
    } else if (cmd.type === "Q") {
      const [[x1, y1], [x, y]] = cmd.points;
      path.quadraticCurveTo(tx(x1), ty(y1), tx(x), ty(y));
    } else if (cmd.type === "Z") {
      path.close();
    }
  }
  return path;
}

type ParsedCmd =
  | { type: "M"; points: [[number, number]] }
  | { type: "L"; points: [[number, number]] }
  | { type: "C"; points: [[number, number], [number, number], [number, number]] }
  | { type: "Q"; points: [[number, number], [number, number]] }
  | { type: "Z"; points: [] };

/**
 * Parse SVG path data into a normalized command list.
 * Handles potrace's output which is M, m, L, l, C, c, Q, q, T, t, S, s, V, v, H, h, Z.
 */
function parseSvgPath(d: string): ParsedCmd[] {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  const cmds: ParsedCmd[] = [];
  let i = 0;
  let cx = 0, cy = 0;
  let startX = 0, startY = 0;
  let lastCtrlX = 0, lastCtrlY = 0;
  let lastCmd = "";

  function readNum() { return Number(tokens[i++]); }

  while (i < tokens.length) {
    const tok = tokens[i];
    let cmd = "";
    if (/[A-Za-z]/.test(tok)) {
      cmd = tok;
      i++;
    } else {
      // Implicit repeat of previous command (M→L, m→l)
      cmd = lastCmd === "M" ? "L" : lastCmd === "m" ? "l" : lastCmd;
    }
    lastCmd = cmd;

    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;

    switch (upper) {
      case "M": {
        const x = readNum() + (rel ? cx : 0);
        const y = readNum() + (rel ? cy : 0);
        cx = x; cy = y; startX = x; startY = y;
        cmds.push({ type: "M", points: [[x, y]] });
        break;
      }
      case "L": {
        const x = readNum() + (rel ? cx : 0);
        const y = readNum() + (rel ? cy : 0);
        cx = x; cy = y;
        cmds.push({ type: "L", points: [[x, y]] });
        break;
      }
      case "H": {
        const x = readNum() + (rel ? cx : 0);
        cx = x;
        cmds.push({ type: "L", points: [[x, cy]] });
        break;
      }
      case "V": {
        const y = readNum() + (rel ? cy : 0);
        cy = y;
        cmds.push({ type: "L", points: [[cx, y]] });
        break;
      }
      case "C": {
        const x1 = readNum() + (rel ? cx : 0);
        const y1 = readNum() + (rel ? cy : 0);
        const x2 = readNum() + (rel ? cx : 0);
        const y2 = readNum() + (rel ? cy : 0);
        const x = readNum() + (rel ? cx : 0);
        const y = readNum() + (rel ? cy : 0);
        cx = x; cy = y; lastCtrlX = x2; lastCtrlY = y2;
        cmds.push({ type: "C", points: [[x1, y1], [x2, y2], [x, y]] });
        break;
      }
      case "S": {
        const x1 = 2 * cx - lastCtrlX;
        const y1 = 2 * cy - lastCtrlY;
        const x2 = readNum() + (rel ? cx : 0);
        const y2 = readNum() + (rel ? cy : 0);
        const x = readNum() + (rel ? cx : 0);
        const y = readNum() + (rel ? cy : 0);
        cx = x; cy = y; lastCtrlX = x2; lastCtrlY = y2;
        cmds.push({ type: "C", points: [[x1, y1], [x2, y2], [x, y]] });
        break;
      }
      case "Q": {
        const x1 = readNum() + (rel ? cx : 0);
        const y1 = readNum() + (rel ? cy : 0);
        const x = readNum() + (rel ? cx : 0);
        const y = readNum() + (rel ? cy : 0);
        cx = x; cy = y; lastCtrlX = x1; lastCtrlY = y1;
        cmds.push({ type: "Q", points: [[x1, y1], [x, y]] });
        break;
      }
      case "T": {
        const x1 = 2 * cx - lastCtrlX;
        const y1 = 2 * cy - lastCtrlY;
        const x = readNum() + (rel ? cx : 0);
        const y = readNum() + (rel ? cy : 0);
        cx = x; cy = y; lastCtrlX = x1; lastCtrlY = y1;
        cmds.push({ type: "Q", points: [[x1, y1], [x, y]] });
        break;
      }
      case "Z": {
        cx = startX; cy = startY;
        cmds.push({ type: "Z", points: [] });
        break;
      }
      default:
        // unsupported (e.g., A — arc); skip its args. Potrace doesn't emit arcs so this is rare.
        break;
    }
  }
  return cmds;
}
