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

  // opentype.js's TypeScript declarations are incomplete: weightClass
  // is typed as string but the OS/2 writer reads it as a number, and
  // panose is not declared at all but IS read at runtime (see
  // opentype.js dist line ~15363). Cast through `any` once so we can
  // pass the runtime-correct shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fontOptions: any = {
    familyName: meta.familyName,
    styleName: "Regular",
    designer: meta.designerName ?? "Workshop",
    unitsPerEm: UNITS_PER_EM,
    ascender: ASCENDER,
    descender: DESCENDER,
    glyphs,
    // weightClass 400 = CSS "Regular". opentype.js default is 500
    // (Medium). Most browsers tolerate the mismatch but Android Chrome's
    // font matcher prefers exact weights.
    weightClass: 400,
    // PANOSE classification (10 bytes): bFamilyType=Latin Text (2),
    // bWeight=Book (5), bProportion=Modern (3), rest zeros. All-zero
    // panose is technically valid but Android FreeType prefers fonts
    // with declared classes — a real cross-platform rendering bug.
    panose: [2, 0, 5, 3, 0, 0, 0, 0, 0, 0],
  };
  const font = new opentype.Font(fontOptions);

  // Android FreeType strictness fixes. opentype.js's default OS/2 fields
  // are minimal placeholders (usWeightClass=500 Medium, panose all-zero,
  // achVendID="XXXX", fsSelection=Regular bit only). These pass on iOS
  // Safari + macOS Chrome (which use CoreText), but Android Chrome + some
  // older FreeType-based renderers reject or render fallback for fonts
  // missing OS/2 fields they consider meaningful. Pin sensible values:
  //
  //   fsSelection bit 7 (USE_TYPO_METRICS, 0x80) — tells layout engines
  //     to use sTypoAscender/Descender for line metrics instead of the
  //     legacy usWinAscent/Descent. Without it, Android Chrome can clip
  //     glyph extents or use buggy fallback line heights.
  //
  //   panose [2,0,5,3,...] — bFamilyType=Latin Text, bWeight=Book,
  //     bProportion=Modern. All-zero panose ("any") is technically valid
  //     but FreeType's font matcher prefers fonts with declared classes.
  //
  //   achVendID = "WKSH" — workshop vendor tag (4 chars per spec).
  //     "XXXX" placeholder is technically allowed but some validators
  //     warn on it, which can cascade into font registration failures.
  //
  // We monkey-patch font.tables.os2 directly because opentype.js doesn't
  // expose constructor options for these fields. tables.os2 is read at
  // toArrayBuffer time, so the patches make it into the binary.
  // (panose is set via constructor option above; weightClass too.) The
  // remaining 2 OS/2 fields aren't reachable through opentype.js's
  // constructor — patch tables.os2 directly. Verified to stick in the
  // output binary via post-build validation (validateFontBytes below).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = (font as any).tables;
  if (tables) {
    tables.os2 = tables.os2 ?? {};
    tables.os2.fsSelection = 0x40 | 0x80; // REGULAR | USE_TYPO_METRICS
    tables.os2.achVendID = "WKSH";
  }

  // CRITICAL: backfill the Macintosh name table with ASCII-safe entries.
  //
  // opentype.js writes name records for three platforms — Unicode,
  // Windows (UTF-16), Macintosh (Mac Roman). Mac Roman is a 256-char
  // Latin set with NO Georgian (or anything outside Latin-1 + a few
  // extras). When the family name can't be encoded in Mac Roman,
  // opentype.js silently OMITS the entry rather than transliterating.
  //
  // CoreText (the font loader on macOS + iOS Safari + Chrome on Mac)
  // reads the Macintosh table during font registration. With no
  // fontFamily / fullName / postScriptName there, it refuses to register
  // the font — the @font-face declaration looks valid, the URL responds
  // 200 with the right Content-Type, but the browser falls back to
  // Times. Latin-named fonts (like "Xara1") work because their Mac
  // table is complete; Georgian-named fonts silently fail.
  //
  // Fix: populate Mac entries with an ASCII transliteration. The Unicode
  // + Windows tables keep the Georgian name (what the OS shows when the
  // font is installed); Mac entries just need to exist so CoreText
  // accepts the font for web use.
  //
  // CRITICAL: append a short random tag to the Mac names so multiple
  // Georgian-named fonts don't collide on the same fallback name. The
  // PostScript name field is REQUIRED to be globally unique per the
  // OpenType spec — when two installed fonts share one, CoreText
  // registers only the first and the second silently fails to render.
  // This is the bug that caused the second Georgian-named upload to
  // fall back to Times on Safari/Chrome even after the c9d55df fix.
  const asciiBase = stripToAscii(meta.familyName) || "GeorgianWorkshopFont";
  // 6 chars from Math.random's base-36 string. 36^6 ≈ 2.1 billion, so
  // the probability of two builds in the lifetime of the workshop
  // generating the same tag is vanishingly small. This tag is internal-
  // only — never displayed in the picker (the random suffix in the
  // filename is stripped by toName() in lib/fonts.ts).
  const macUnique = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  const macFamily = `${asciiBase}-${macUnique}`;
  // opentype.js's .names.macintosh is built lazily and may be missing
  // entirely if no Mac-Roman-safe entries were generated. Ensure the
  // object exists before assigning.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const names = font.names as any;
  names.macintosh = names.macintosh ?? {};
  names.macintosh.fontFamily = { en: macFamily };
  names.macintosh.fullName = { en: `${macFamily} Regular` };
  names.macintosh.postScriptName = { en: `${macFamily}-Regular` };
  names.macintosh.uniqueID = { en: `: ${macFamily} Regular` };

  const bytes = new Uint8Array(font.toArrayBuffer());

  // Post-build validation. Re-parse the bytes and check that the
  // critical cross-platform fields actually made it into the binary.
  // If anything's wrong it's a build-time bug (not user-facing) so
  // we log to stderr — Vercel function logs surface it; production
  // requests still succeed with the built bytes. Catches regressions
  // when opentype.js silently drops a monkey-patched field.
  try {
    validateFontBytes(bytes, meta.familyName);
  } catch (e) {
    console.warn("[buildFont] post-build validation warning:", e);
  }

  return bytes;
}

/** Re-parse the just-built font and verify all the cross-platform-
 *  critical fields are present and sane. Throws on hard problems
 *  (missing tables, broken cmap); warns on soft problems
 *  (suboptimal OS/2 values). The caller swallows the throw and just
 *  logs — we don't want validation regressions to block user uploads. */
function validateFontBytes(bytes: Uint8Array, familyName: string): void {
  const parsed = opentype.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );

  // 1. Required tables present
  const requiredTables = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = (parsed as any).tables ?? {};
  for (const t of requiredTables) {
    const key = t.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!tables[key]) {
      throw new Error(`missing required table: ${t} (familyName=${familyName})`);
    }
  }

  // 2. cmap must map at least one Georgian character. If the alphabet
  // didn't make it into the cmap, the font can't render anything
  // useful — better to fail loudly at build than render blanks at
  // workshop time.
  if (parsed.charToGlyphIndex("ა") <= 0) {
    throw new Error(`cmap missing Georgian U+10D0 (familyName=${familyName})`);
  }

  // 3. Mac name table must have fontFamily — re-checking the c9d55df
  // fix from earlier. If this regresses, Georgian-named fonts fall
  // back to Times on Safari + Chrome-on-Mac/iOS.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const macName = (parsed.names as any).macintosh;
  if (!macName?.fontFamily?.en) {
    throw new Error(`Mac name table missing fontFamily (familyName=${familyName})`);
  }

  // 4. OS/2 sanity. Soft warnings — won't block.
  const os2 = tables.os2;
  if (os2.usWeightClass !== 400) {
    console.warn(`[buildFont] usWeightClass=${os2.usWeightClass} expected 400 (${familyName})`);
  }
  if (!(os2.fsSelection & 0x80)) {
    console.warn(`[buildFont] USE_TYPO_METRICS bit not set in fsSelection (${familyName})`);
  }
}

/** Strip every character that Mac Roman can't represent. We use the
 *  Basic ASCII printable range (0x20–0x7E) as the safe subset — Mac
 *  Roman actually has more, but ASCII is universally safe and any
 *  surviving characters become an unambiguous fallback name. */
function stripToAscii(s: string): string {
  return s
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\w-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
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
