import * as opentype from "opentype.js";
import type { GlyphPath } from "./process-scan";
import { ALPHABET, ALPHABET_CODES, BASELINE_FRAC_FROM_TOP } from "./constants";
import { computeOpticalKerning, attachKerning } from "./optical-kerning";

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

  // Always include space (U+0020). Same explicit moveTo+close as the
  // missing-letter glyphs below — empty Path() alone can render as
  // .notdef on some FreeType configurations.
  const spacePath = new opentype.Path();
  spacePath.moveTo(0, 0);
  spacePath.close();
  const space = new opentype.Glyph({
    name: "space",
    unicode: 0x0020,
    advanceWidth: 350,
    path: spacePath,
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
      // Empty glyph for missing letters — keeps the cmap complete so a
      // participant who fills only 10 of 33 cells still gets a font
      // they can type all alphabet keys into without hitting .notdef
      // (which renders as a tofu box □ on Android Chrome / FreeType).
      //
      // We use the same "blank visible-area" pattern as the space
      // glyph: a single moveTo at the origin so the CFF charstring
      // has explicit operators (not just `endchar`). Empty Path()
      // alone produces a bare-endchar charstring which SOME stricter
      // renderers (notably older Android FreeType) treat as a missing
      // glyph and substitute .notdef. moveTo+close yields a
      // zero-ink-but-positively-defined charstring that every
      // renderer accepts as a valid blank glyph.
      const blank = new opentype.Path();
      blank.moveTo(0, 0);
      blank.close();
      glyphs.push(
        new opentype.Glyph({
          name: `u${codePoint.toString(16).toUpperCase()}`,
          unicode: codePoint,
          advanceWidth: 500,
          path: blank,
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

  // Derive an ASCII-safe internal name BEFORE constructing the font.
  // opentype.js bakes whatever we pass as `familyName` into BOTH the
  // CFF Name INDEX FontName AND the name table's Name ID 6
  // (postScriptName) — and the OpenType spec requires both to be ASCII.
  // If we passed the raw Georgian familyName, Chrome/Edge's OTS
  // sanitizer would reject the font (CoreText is lenient and accepts
  // it, which is why iPhone worked but Chrome silently fell back to a
  // system font).
  //
  // Transliteration order:
  //   1. transliterateGeorgian — readable BGN-style ASCII for Georgian.
  //      "ორნამენტიკა" → "ornamenTika".
  //   2. stripToAscii fallback — for mixed scripts that have at least
  //      some plain-ASCII letters in them.
  //   3. "GeorgianWorkshopFont" — last-resort generic name; never
  //      hits this path with the transliterator covering all Mkhedruli.
  //
  // The user-visible display name (Name ID 1 / Name ID 4) is restored
  // to the original Georgian string further down, so the font picker
  // still shows what the participant typed.
  const asciiBase = transliterateGeorgian(meta.familyName)
    || stripToAscii(meta.familyName)
    || "GeorgianWorkshopFont";

  // UNIQUE ASCII internal identity. This single string drives the CFF
  // FontName AND Name ID 6 (PostScript name) on EVERY platform, so the
  // font is spec-compliant and installs on Windows.
  //
  // Why the random suffix matters for Windows: the PostScript name is
  // the OS's unique key for a font. Two participants who both name
  // their font "28" would otherwise both get PS name "28Regular" →
  // Windows treats them as the SAME font, so the second one collides
  // with / overwrites the first on install (the "duplicated fonts /
  // won't install" bug). The suffix guarantees per-upload uniqueness.
  //
  // Pre-fix, this suffix was applied ONLY to the Macintosh name
  // records while Windows/Unicode kept the non-unique, non-matching
  // construction-time value — a PostScript-name mismatch across
  // platforms that macOS/CoreText tolerated but Windows' installer
  // rejected outright.
  const uniqueTag = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  const psBase = `${asciiBase}-${uniqueTag}`;

  // opentype.js's TypeScript declarations are incomplete: weightClass
  // is typed as string but the OS/2 writer reads it as a number, and
  // panose is not declared at all but IS read at runtime (see
  // opentype.js dist line ~15363). Cast through `any` once so we can
  // pass the runtime-correct shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fontOptions: any = {
    // Unique ASCII identity — drives CFF FontName + Name ID 6
    // (PostScript name) consistently across all platforms. User-
    // visible display names get set to the Georgian original
    // post-construction (see below).
    familyName: psBase,
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
  // remaining 4 OS/2 fields aren't reachable through opentype.js's
  // constructor — patch tables.os2 directly. Verified to stick in the
  // output binary via post-build validation (validateFontBytes below).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = (font as any).tables;
  if (tables) {
    tables.os2 = tables.os2 ?? {};
    tables.os2.fsSelection = 0x40 | 0x80; // REGULAR | USE_TYPO_METRICS
    tables.os2.achVendID = "WKSH";
    // Pin Win metrics to match Typo metrics. Without this, opentype.js
    // computes usWinAscent/usWinDescent from each glyph's actual ink
    // bounding box, which produces inconsistent line-height behavior
    // across browsers:
    //   - macOS Safari + Chrome respect USE_TYPO_METRICS (set in
    //     fsSelection above) → use Typo metrics → consistent
    //   - Some older Android Chrome / WebView versions IGNORE the
    //     USE_TYPO_METRICS bit and fall back to Win metrics → with
    //     ink-derived defaults like 748/253, the line height is
    //     2-3 units smaller than Typo's 750/250 → glyphs render at
    //     slightly wrong vertical position
    // Pinning to ASCENDER (750) / -DESCENDER (250) guarantees Win
    // and Typo agree, so regardless of which metric a renderer picks,
    // the result is identical.
    tables.os2.usWinAscent = ASCENDER;
    tables.os2.usWinDescent = -DESCENDER;
  }

  // NAME TABLE — the two-identity model, applied CONSISTENTLY across
  // every platform:
  //
  //   • INTERNAL identity  → Name ID 6 (PostScript), Name ID 3
  //     (Unique ID), and the CFF FontName. Must be ASCII, unique, and
  //     IDENTICAL on every platform. Constructed from `psBase` (see
  //     above), so opentype.js already wrote the matching value to all
  //     three platforms' Name ID 6 + the CFF FontName. We MUST NOT
  //     overwrite Name ID 6 with a platform-specific value here — that
  //     mismatch is exactly what made Windows reject the font.
  //
  //   • DISPLAY identity   → Name ID 1 (Family), Name ID 2 (Subfamily),
  //     Name ID 4 (Full), Name ID 16 (Preferred Family). User-visible
  //     labels; may be non-ASCII. Set to the Georgian name the
  //     participant typed so font menus / the workshop UI show it.
  //
  // opentype.js emits records for three platforms — Unicode, Windows
  // (UTF-16), and Macintosh (Mac Roman). Mac Roman has no Georgian, so
  // for a Georgian family name opentype.js omits the mac DISPLAY
  // records; CoreText then refuses to register the font (@font-face
  // falls back to Times). We backfill every platform's display records
  // — Windows/Unicode with the real Georgian string, Macintosh with an
  // ASCII transliteration (so CoreText still registers it) — while
  // leaving Name ID 6 as the unique ASCII everywhere.
  const displayName = meta.familyName;
  const displayFull = `${displayName} Regular`;
  const macDisplay = asciiBase; // Mac Roman-safe fallback label
  const uniqueId = `Xarafontinator: ${psBase} Regular`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const names = font.names as any;

  // Windows + Unicode: Georgian display, unique-ASCII internal.
  for (const scope of ["windows", "unicode"] as const) {
    names[scope] = names[scope] ?? {};
    names[scope].fontFamily = { en: displayName };
    names[scope].fullName = { en: displayFull };
    names[scope].preferredFamily = { en: displayName };
    names[scope].uniqueID = { en: uniqueId };
    // Name ID 6 (postScriptName) intentionally left as constructed
    // (psBase-Regular) — do not touch.
  }

  // Macintosh: ASCII display (Mac Roman can't hold Georgian), same
  // unique-ASCII internal identity. Name ID 6 left as constructed.
  names.macintosh = names.macintosh ?? {};
  names.macintosh.fontFamily = { en: macDisplay };
  names.macintosh.fullName = { en: `${macDisplay} Regular` };
  names.macintosh.preferredFamily = { en: macDisplay };
  names.macintosh.uniqueID = { en: uniqueId };

  // OPTICAL KERNING: with all glyphs assembled, compute per-pair kern
  // values from each glyph's edge profile (right edge of left glyph
  // vs. left edge of right glyph) and bake them into the font's
  // `kern` table. Without this, scanned glyphs with varied side-
  // bearings leave visually uneven gaps when typeset. The pipeline
  // produces ~1000 candidate pairs; sub-threshold ones are dropped
  // so the resulting kern table stays a few KB. See optical-kerning.ts
  // for the algorithm + tuning constants.
  const kerningPairs = computeOpticalKerning(font);
  attachKerning(font, kerningPairs);

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

  // 1. Required tables present. Skips hmtx because opentype.js's
  // parser doesn't expose it as a table object — the hmtx data is
  // folded into per-glyph advanceWidth/leftSideBearing fields. The
  // binary still contains hmtx (otherwise the font wouldn't be valid
  // OpenType) but parsed.tables.hmtx is undefined either way.
  const requiredTables = ["cmap", "head", "hhea", "maxp", "name", "OS/2", "post"];
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
  if (os2.usWinAscent !== ASCENDER) {
    console.warn(`[buildFont] usWinAscent=${os2.usWinAscent} expected ${ASCENDER} (${familyName})`);
  }
  if (os2.usWinDescent !== -DESCENDER) {
    console.warn(`[buildFont] usWinDescent=${os2.usWinDescent} expected ${-DESCENDER} (${familyName})`);
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
 * BGN-style transliteration of Mkhedruli Georgian → ASCII. Capital
 * letters disambiguate the aspirated / ejective pairs (e.g. ტ→t,
 * თ→T; პ→p, ფ→f; კ→k, ქ→q). Used to derive an ASCII PostScript /
 * CFF FontName from a user-supplied Georgian family name so the
 * resulting font binary satisfies the OpenType spec.
 *
 * Why this matters: Chrome/Edge's OTS (OpenType Sanitizer) enforces
 * the spec requirement that Name ID 6 (postScriptName) and the CFF
 * Name INDEX FontName be ASCII-only. Pre-fix, a Georgian-named upload
 * baked the Georgian string into both → OTS rejected the font →
 * Chrome silently fell back to the system Georgian font even though
 * the .otf downloaded successfully. CoreText (Safari/iOS) is lenient
 * and renders the font regardless, which is why phones looked fine.
 *
 * Strategy: use the transliteration ONLY for the spec-required
 * internal identifiers (PostScript name + CFF FontName). The user-
 * visible display names (Name ID 1 fontFamily, Name ID 4 fullName)
 * in the unicode/windows name tables get overridden back to the
 * original Georgian string so the workshop UI and font picker still
 * show the actual name the participant typed.
 *
 * Mapping crib sheet (only the letters that aren't direct Latin):
 *   თ→T  ჟ→J  ღ→R  ყ→y  შ→S  ჩ→C  ც→c  ძ→Z  წ→w  ჭ→W  ხ→x
 */
const GEORGIAN_TO_LATIN: Record<string, string> = {
  ა: "a", ბ: "b", გ: "g", დ: "d", ე: "e",
  ვ: "v", ზ: "z", თ: "T", ი: "i", კ: "k",
  ლ: "l", მ: "m", ნ: "n", ო: "o", პ: "p",
  ჟ: "J", რ: "r", ს: "s", ტ: "t", უ: "u",
  ფ: "f", ქ: "q", ღ: "R", ყ: "y", შ: "S",
  ჩ: "C", ც: "c", ძ: "Z", წ: "w", ჭ: "W",
  ხ: "x", ჯ: "j", ჰ: "h",
};

function transliterateGeorgian(s: string): string {
  let out = "";
  for (const ch of s) {
    out += GEORGIAN_TO_LATIN[ch] ?? ch;
  }
  // Run the result through the ASCII stripper so any leftover non-
  // Georgian non-ASCII characters (spaces, punctuation, latin accents
  // someone might have mixed in) get normalized the same way as the
  // pure-ASCII path.
  return stripToAscii(out);
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

  // Transform every command to font coords (y-up, scaled, offset) up
  // front. Doing this BEFORE winding correction means the area sign of
  // each subpath is computed in the same coordinate system that the
  // final font renderer sees — no surprises from coord-system flips.
  const transformed: ParsedCmd[] = cmds.map((cmd) => {
    if (cmd.type === "Z") return cmd;
    const newPoints = cmd.points.map(([x, y]) => [
      Math.round(x * scale + offsetX),
      Math.round(offsetY - y * scale),
    ] as [number, number]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { type: cmd.type, points: newPoints } as any;
  });

  // CRITICAL: fix CFF contour winding for non-zero rule rendering.
  //
  // Symptom: existing fonts rendered as solid filled blobs on Android
  // Chrome (FreeType) while macOS/iOS Safari kept hollows correctly.
  // Diagnosed via shoelace area on the rendered glyphs — every
  // contour in our fonts was CW (negative area in y-up). With both
  // outer and inner contours winding the same direction, the
  // non-zero fill rule (which OpenType CFF uses per spec) sums their
  // winding numbers and fills the entire shape including holes.
  // macOS CoreText silently falls back to even-odd in many cases;
  // FreeType doesn't.
  //
  // Fix: ensure inner contours wind OPPOSITE to the outer contour
  // (= positive signed area when outer is negative, and vice versa).
  // Then non-zero rule: outer(±1) + inner(∓1) = 0 inside the hole.
  //
  // GUIDE-LINE ARTIFACT REMOVAL: filter out subpaths matching the
  // template's printed-guide signature BEFORE fixCFFWinding runs
  // (fewer subpaths to evaluate + winding correction never gets
  // distracted by template artifacts). The signature was tuned in
  // scripts/fix-guide-artifacts.mjs against 71 production fonts
  // before being lifted into the live pipeline — same constants,
  // same detection logic, just runs on every new upload now so we
  // never have to post-process again.
  const deartifacted = stripGuideArtifacts(transformed);
  const corrected = fixCFFWinding(deartifacted);

  const path = new opentype.Path();
  for (const cmd of corrected) {
    if (cmd.type === "M") {
      const [x, y] = cmd.points[0];
      path.moveTo(x, y);
    } else if (cmd.type === "L") {
      const [x, y] = cmd.points[0];
      path.lineTo(x, y);
    } else if (cmd.type === "C") {
      const [[x1, y1], [x2, y2], [x, y]] = cmd.points;
      path.curveTo(x1, y1, x2, y2, x, y);
    } else if (cmd.type === "Q") {
      const [[x1, y1], [x, y]] = cmd.points;
      path.quadraticCurveTo(x1, y1, x, y);
    } else if (cmd.type === "Z") {
      path.close();
    }
  }
  return path;
}

// --- Guide-line artifact filter -----------------------------------------
//
// The printed workshop template draws four light-grey horizontal guide
// lines per cell (ascender / cap-height / x-height / baseline). They're
// designed to be lighter than the scan threshold, but in practice they
// frequently bleed through — bad lighting, aggressive Otsu, JPEG-edge
// darkening. Result: every glyph carries a thin horizontal stripe or
// row of dots at the cell edges (Y≈0 baseline, Y≈750 ascender top),
// which renders as an unwanted underline under typeset text.
//
// Constants below were calibrated against 71 production fonts in
// scripts/fix-guide-artifacts.mjs — see that file's commit message
// (ea34280) for the empirical Y-histogram + aspect-ratio data.

/** Max bbox height for a subpath to qualify as an artifact. Real
 *  glyph strokes (drawn with markers) are thicker than this. */
const GUIDE_ARTIFACT_MAX_H = 30;

/** Min aspect ratio (width/height) for the LONG-STRIPE detector.
 *  Catches obvious continuous guide-lines + long dashes. Smaller
 *  dot-like marks fall through to the SMALL_DOT detector below. */
const GUIDE_ARTIFACT_MIN_ASPECT = 2.5;

/** Width range for the SMALL DOT detector. Guide-dots after warp
 *  measure ~25-40 units wide × 10-20 tall (aspect 1.5-2.5) — too
 *  square for the aspect filter. The 15-60 window excludes noise
 *  specks (<15) and full glyph strokes that happen to span the cell
 *  width (>60). */
const GUIDE_ARTIFACT_SMALL_DOT_MIN_W = 15;
const GUIDE_ARTIFACT_SMALL_DOT_MAX_W = 60;

/** Y centroids of cell-divider artifacts in font coordinate space.
 *  See svgPathToOpentype for the pixel-to-font scaling that places
 *  these:
 *    baseline (= 0) — cell-bottom divider line
 *    ascender (= 750) — cell-top edge + label-divider line
 *  ±60 tolerance accommodates trace wobble — fxali histogram showed
 *  artifacts clustering at Y=0 (98 hits) and Y=-50 (49 hits). */
const GUIDE_ARTIFACT_Y_CENTERS = [0, 750];
const GUIDE_ARTIFACT_Y_TOLERANCE = 60;

/** True when a subpath's geometry matches a printed-template
 *  artifact (horizontal stripe OR small dot near a cell edge). The
 *  Y-near-guide check is the primary safety guard against false
 *  positives — small thin subpaths in the MIDDLE of a cell are
 *  almost certainly real glyph features and are left alone. */
function isGuideArtifact(subpath: ParsedCmd[]): boolean {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of subpath) {
    for (const [x, y] of c.points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (h <= 0 || h >= GUIDE_ARTIFACT_MAX_H) return false;

  // Primary guard: must sit near a guide line.
  const cy = (minY + maxY) / 2;
  let nearGuide = false;
  for (const center of GUIDE_ARTIFACT_Y_CENTERS) {
    if (Math.abs(cy - center) <= GUIDE_ARTIFACT_Y_TOLERANCE) {
      nearGuide = true;
      break;
    }
  }
  if (!nearGuide) return false;

  // Two-prong match: long-stripe (aspect-based) or small-dot (width-based).
  if (h > 0 && w / h >= GUIDE_ARTIFACT_MIN_ASPECT) return true;
  if (w >= GUIDE_ARTIFACT_SMALL_DOT_MIN_W && w <= GUIDE_ARTIFACT_SMALL_DOT_MAX_W) return true;
  return false;
}

/** Remove guide-line artifact subpaths from a glyph's command stream.
 *  Splits by M-commands to identify subpaths, drops any matching
 *  isGuideArtifact, flattens the survivors back. Idempotent — running
 *  on an already-clean glyph is a no-op. */
function stripGuideArtifacts(allCmds: ParsedCmd[]): ParsedCmd[] {
  // Group into subpaths (each starts with M).
  const subs: ParsedCmd[][] = [];
  let cur: ParsedCmd[] = [];
  for (const cmd of allCmds) {
    if (cmd.type === "M" && cur.length > 0) {
      subs.push(cur);
      cur = [];
    }
    cur.push(cmd);
  }
  if (cur.length > 0) subs.push(cur);

  // Filter out artifact subpaths and re-flatten.
  return subs.filter((sp) => !isGuideArtifact(sp)).flat();
}

/** Group commands into subpaths (by M), compute each subpath's signed
 *  area in current coords, identify the largest-area subpath as "outer"
 *  and reverse any other subpath that has the SAME winding direction
 *  as outer. After this, the non-zero fill rule correctly treats inner
 *  contours as holes. */
function fixCFFWinding(allCmds: ParsedCmd[]): ParsedCmd[] {
  // Split into subpaths
  const subpaths: ParsedCmd[][] = [];
  let current: ParsedCmd[] = [];
  for (const cmd of allCmds) {
    if (cmd.type === "M" && current.length > 0) {
      subpaths.push(current);
      current = [];
    }
    current.push(cmd);
  }
  if (current.length > 0) subpaths.push(current);
  if (subpaths.length <= 1) return allCmds;

  // Signed area for each subpath (shoelace formula on endpoints —
  // close enough for winding-direction detection; full bezier
  // integration not needed since we only care about the sign).
  const areas = subpaths.map(signedArea);
  let outerIdx = 0;
  for (let i = 1; i < areas.length; i++) {
    if (Math.abs(areas[i]) > Math.abs(areas[outerIdx])) outerIdx = i;
  }
  const outerSign = Math.sign(areas[outerIdx]);

  const fixed: ParsedCmd[][] = subpaths.map((sp, i) => {
    if (i === outerIdx) return sp;
    if (Math.sign(areas[i]) === outerSign) return reverseSubpath(sp);
    return sp;
  });
  return fixed.flat();
}

/** Shoelace area on the subpath's endpoint sequence. Sign indicates
 *  winding: positive = CCW (in y-up), negative = CW. */
function signedArea(subpath: ParsedCmd[]): number {
  const pts: [number, number][] = [];
  for (const c of subpath) {
    if (c.type === "Z") continue;
    pts.push(c.points[c.points.length - 1]);
  }
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

/** Reverse a subpath's direction. Each segment becomes its reverse:
 *  endpoints swap roles, cubic bezier control points swap order.
 *  Requires the input to start with M and optionally end with Z. */
function reverseSubpath(sp: ParsedCmd[]): ParsedCmd[] {
  if (sp.length < 2 || sp[0].type !== "M") return sp;
  const hasClose = sp[sp.length - 1].type === "Z";
  // Collect endpoint of every non-Z command, in order.
  const endpoints: [number, number][] = [];
  for (const c of sp) {
    if (c.type === "Z") continue;
    endpoints.push(c.points[c.points.length - 1]);
  }
  if (endpoints.length === 0) return sp;

  // Walk original segments in reverse. For segs[k], the original
  // segment travels endpoints[k] → endpoints[k+1] (with optional
  // bezier control points). Reversed, it travels endpoints[k+1] →
  // endpoints[k] with control points reversed in order.
  const segs = sp.slice(1).filter((c) => c.type !== "Z");
  const out: ParsedCmd[] = [];
  out.push({ type: "M", points: [endpoints[endpoints.length - 1]] });
  for (let k = segs.length - 1; k >= 0; k--) {
    const orig = segs[k];
    const targetPoint = endpoints[k];
    if (orig.type === "L") {
      out.push({ type: "L", points: [targetPoint] });
    } else if (orig.type === "C") {
      // Original: prev → cp1 → cp2 → end. Reversed: end → cp2 → cp1 → prev.
      out.push({
        type: "C",
        points: [orig.points[1], orig.points[0], targetPoint],
      });
    } else if (orig.type === "Q") {
      out.push({
        type: "Q",
        points: [orig.points[0], targetPoint],
      });
    }
  }
  if (hasClose) out.push({ type: "Z", points: [] });
  return out;
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
