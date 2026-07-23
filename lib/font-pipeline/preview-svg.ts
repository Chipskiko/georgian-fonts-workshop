/**
 * Baked alphabet-preview SVG for the fonts page (plan doc §8).
 *
 * Renders the full Georgian alphabet in a given font as real vector
 * outlines and wraps them in a small standalone SVG. The fonts page
 * shows this via <img> instead of `@font-face` text, so the letterforms
 * appear AS THEMSELVES from the first paint — no fallback font, no
 * blank-then-swap (FOUT), no font download, and immune to browser OTS
 * font validation.
 *
 * Generated once at save time and stored as a sidecar next to the font
 * file (`<filename>.preview.svg`) — the "baked, auto-updating" model:
 * every upload creates its sidecar, deletes remove it, the page just
 * reads. scripts/backfill-preview-svg.mjs generates sidecars for fonts
 * uploaded before this feature (same layout constants — keep in sync).
 *
 * Layout: ALL letters on a SINGLE horizontal line (the fonts page shows
 * one specimen strip per font). Fill is the site's --fg yellow, baked
 * in (SVG-in-<img> can't inherit currentColor); sidecars are cheap to
 * regenerate if the palette ever changes.
 */

import opentype from "opentype.js";
import { ALPHABET } from "./constants";

/** Bump whenever the preview LAYOUT/PALETTE changes and sidecars are
 *  force-regenerated (scripts/backfill-preview-svg.mjs --force). The
 *  fonts page appends this as ?v= to sidecar URLs — Vercel Blob's CDN
 *  caches aggressively (~30 days) and regenerations reuse the same
 *  URL, so without the version bump users would see stale previews.
 *    v1: two-line layout, metric advances
 *    v2: single line, optical ink-edge spacing */
export const PREVIEW_SVG_VERSION = 2;

/** Font size (SVG units) the alphabet is rendered at. Purely internal —
 *  the SVG scales to its container via viewBox. */
const SIZE = 64;
/** Padding around the combined outline (SVG units). */
const PAD = 6;
/** Fixed horizontal gap between letters, INK-EDGE to INK-EDGE. We lay
 *  letters out MANUALLY (not via font.getPath on a spaced string) for
 *  two reasons:
 *  1. Several workshop fonts have broken cmaps and/or inked .notdef
 *     glyphs — a string render would stamp the notdef ink at every
 *     space/missing character. Manual layout SKIPS unmapped letters.
 *  2. OPTICAL spacing: workshop glyphs share a uniform metric advance
 *     (from the scan cell's aspect) but their actual ink is much
 *     narrower and sits at arbitrary offsets inside the cell (wherever
 *     the participant drew). Advancing by metrics produced big uneven
 *     gaps. Instead we position each glyph by its ink BOUNDING BOX —
 *     every pair of letters gets the same visual gap regardless of
 *     the font's metric quality. */
const LETTER_GAP = SIZE * 0.2;
/** Site --fg. Baked because <img>-embedded SVG can't see CSS vars. */
const FILL = "#ffea00";

/** Lay out the letters on a single baseline with optical (ink-edge)
 *  spacing. Skips characters that map to .notdef (glyph index 0) or
 *  have no visible ink — missing letters simply don't appear, like the
 *  @font-face fallback shows for absent glyphs (minus the notdef box). */
function layoutAlphabet(font: opentype.Font): opentype.Path {
  const combined = new opentype.Path();
  let x = 0;
  for (const ch of ALPHABET) {
    let glyph: opentype.Glyph;
    try {
      glyph = font.charToGlyph(ch);
    } catch {
      continue;
    }
    if (!glyph || glyph.index === 0) continue;
    // Measure the ink at pen position 0. Path coords are linear in the
    // pen position, so re-rendering at pen (x - bb.x1) lands the ink's
    // left edge exactly at the cursor.
    let probe: opentype.Path;
    try {
      probe = glyph.getPath(0, 0, SIZE);
    } catch {
      continue;
    }
    const bb = probe.getBoundingBox();
    const inkW = bb.x2 - bb.x1;
    if (!(inkW > 0)) continue; // empty glyph — no ink, no gap
    combined.extend(glyph.getPath(x - bb.x1, 0, SIZE));
    x += inkW + LETTER_GAP;
  }
  return combined;
}

/**
 * Build the preview SVG for a font binary. Returns null when the font
 * can't be parsed or produces no visible outlines (caller treats null
 * as "no sidecar" — the page falls back to @font-face text).
 */
export function buildPreviewSvg(fontBytes: Uint8Array): string | null {
  let font: opentype.Font;
  try {
    const ab = fontBytes.buffer.slice(
      fontBytes.byteOffset,
      fontBytes.byteOffset + fontBytes.byteLength,
    ) as ArrayBuffer;
    font = opentype.parse(ab);
  } catch {
    return null;
  }

  let path: opentype.Path;
  try {
    path = layoutAlphabet(font);
  } catch {
    return null;
  }

  const d = path.toPathData(1);
  if (!d || d.length < 4) return null;

  const b = path.getBoundingBox();
  const minX = b.x1 - PAD;
  const minY = b.y1 - PAD;
  const w = b.x2 - b.x1 + PAD * 2;
  const h = b.y2 - b.y1 + PAD * 2;
  if (!(w > 0) || !(h > 0)) return null;

  const fmt = (n: number) => Math.round(n * 10) / 10;

  // Explicit width/height (matching the viewBox) so renderers that
  // ignore a bare viewBox still get the right intrinsic size + aspect
  // ratio. In the browser, CSS `width:100%; height:auto` on the <img>
  // overrides these for responsive scaling while keeping the ratio.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}" height="${fmt(h)}" viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(w)} ${fmt(h)}">` +
    `<path d="${d}" fill="${FILL}"/>` +
    `</svg>`
  );
}

/** Sidecar filename for a stored font file. */
export function previewSvgFilename(fontFilename: string): string {
  return `${fontFilename}.preview.svg`;
}
