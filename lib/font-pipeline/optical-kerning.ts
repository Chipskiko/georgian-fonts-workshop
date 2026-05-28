/**
 * Optical kerning for scanned Georgian fonts.
 *
 * Each scanned glyph gets its own irregularly-shaped bounding box (chunky
 * letterforms with varied side-bearings depending on how the user drew on
 * the template). Without per-pair kerning, the default advance-width-only
 * layout leaves visually uneven gaps — wide gaps after letters that lean
 * left, tight gaps after letters that lean right.
 *
 * The algorithm:
 *   1. For each glyph: sample its path into points (resampling Bezier
 *      curves at small intervals) and bin them by Y-coordinate into
 *      EDGE_ROWS=40 horizontal slices. For each row, track the
 *      leftmost and rightmost X over all samples in that row.
 *   2. For each ordered pair (left, right): compute the per-row gap
 *      when the two are placed adjacent (taking advance-width into
 *      account). The MINIMUM gap across rows where both have ink is
 *      the visual "tightness" of the pair.
 *   3. Adjust the kerning so the minimum gap equals TARGET_GAP for
 *      every pair. Pairs already wider than TARGET_GAP get a negative
 *      kern (pull together); pairs tighter get a positive kern (push
 *      apart). Sub-threshold kerns are dropped to keep the kern table
 *      small.
 *
 * Output is a flat map "leftGlyphIndex,rightGlyphIndex" → kern value
 * suitable for assignment to opentype.js Font.kerningPairs, which
 * serializes into the legacy `kern` table on font.toArrayBuffer() —
 * supported by every renderer this project targets (browsers, CoreText,
 * FreeType, html2canvas).
 */

import opentype from "opentype.js";

/** Number of horizontal slices each glyph is divided into for edge sampling.
 *  Higher = more accurate optical analysis, more CPU per font. 40 covers
 *  typical Georgian display fonts well (each slice ≈ 25 em-units tall on
 *  a 1000-unit em). */
const EDGE_ROWS = 40;

/** How densely each Bezier segment is sampled. Higher = more accurate
 *  edges for curvy glyphs, more memory per glyph. 16 is plenty for the
 *  outlines we get from potrace. */
const BEZIER_SAMPLES = 16;

/** Damping factor for kerning adjustments. A pair's kerning value is
 *  (median_gap - pair_gap) × DAMP, so:
 *    - DAMP = 1.0 → every pair gets pulled exactly to the median
 *    - DAMP = 0.5 → pairs move halfway to the median (preserves
 *      half the font's natural character while flattening the worst
 *      outliers)
 *    - DAMP = 0.0 → no kerning emitted
 *
 *  0.5 matches what professional optical-kerning tools do (e.g.,
 *  InDesign optical kerning). Lower for fonts where individual
 *  character has strong sidebearings the designer wants preserved. */
const DAMP = 0.5;

/** Don't bother emitting kerning pairs smaller than this — they have no
 *  visible effect at typical render sizes and just bloat the kern table. */
const MIN_KERN_MAGNITUDE = 10;

/** Clamp kerning to a sane range so an outlier glyph (e.g., a scanned
 *  artifact extending way past its bbox) doesn't produce an extreme value
 *  that visibly destroys spacing. */
const MAX_KERN_MAGNITUDE = 300;

/** Per-row edge profile of a glyph in font-design coordinates. left[i] is
 *  the leftmost ink at row i; right[i] is the rightmost. Both are NaN where
 *  the glyph has no ink in that row (empty rows excluded from gap math). */
type EdgeProfile = {
  left: number[];
  right: number[];
  rowMin: number; // Y of row 0
  rowMax: number; // Y of last row
};

/** Sample the bezier curves in a glyph's path into a flat list of (x, y)
 *  points, then bin them into per-row left/right extents.
 *
 *  opentype.Path.commands is an array of normalized commands:
 *    { type: "M" | "L" | "C" | "Q" | "Z", x?, y?, x1?, y1?, x2?, y2? }
 *  We sample lines as their two endpoints and Beziers at BEZIER_SAMPLES
 *  evenly-spaced parameter values. */
function buildEdgeProfile(glyph: opentype.Glyph): EdgeProfile | null {
  const cmds = glyph.path?.commands;
  if (!cmds || cmds.length === 0) return null;

  // First pass: collect all sample points so we know the Y-range.
  type Pt = { x: number; y: number };
  const pts: Pt[] = [];
  let prevX = 0;
  let prevY = 0;
  let startX = 0;
  let startY = 0;

  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const qBez = (a: number, b: number, c: number, t: number): number => {
    const omt = 1 - t;
    return omt * omt * a + 2 * omt * t * b + t * t * c;
  };
  const cBez = (a: number, b: number, c: number, d: number, t: number): number => {
    const omt = 1 - t;
    return omt ** 3 * a + 3 * omt ** 2 * t * b + 3 * omt * t * t * c + t ** 3 * d;
  };

  for (const cmd of cmds) {
    switch (cmd.type) {
      case "M": {
        const x = cmd.x ?? 0;
        const y = cmd.y ?? 0;
        pts.push({ x, y });
        prevX = startX = x;
        prevY = startY = y;
        break;
      }
      case "L": {
        const x = cmd.x ?? 0;
        const y = cmd.y ?? 0;
        // Sample along the line. Endpoints sufficient — straight lines
        // have monotonic min/max, no need for intermediate samples.
        pts.push({ x, y });
        prevX = x;
        prevY = y;
        break;
      }
      case "Q": {
        const cx = cmd.x1 ?? 0;
        const cy = cmd.y1 ?? 0;
        const ex = cmd.x ?? 0;
        const ey = cmd.y ?? 0;
        for (let i = 1; i <= BEZIER_SAMPLES; i++) {
          const t = i / BEZIER_SAMPLES;
          pts.push({ x: qBez(prevX, cx, ex, t), y: qBez(prevY, cy, ey, t) });
        }
        prevX = ex;
        prevY = ey;
        break;
      }
      case "C": {
        const c1x = cmd.x1 ?? 0;
        const c1y = cmd.y1 ?? 0;
        const c2x = cmd.x2 ?? 0;
        const c2y = cmd.y2 ?? 0;
        const ex = cmd.x ?? 0;
        const ey = cmd.y ?? 0;
        for (let i = 1; i <= BEZIER_SAMPLES; i++) {
          const t = i / BEZIER_SAMPLES;
          pts.push({
            x: cBez(prevX, c1x, c2x, ex, t),
            y: cBez(prevY, c1y, c2y, ey, t),
          });
        }
        prevX = ex;
        prevY = ey;
        break;
      }
      case "Z":
        // Close to start of subpath.
        if (prevX !== startX || prevY !== startY) {
          pts.push({ x: startX, y: startY });
        }
        prevX = startX;
        prevY = startY;
        break;
    }
  }

  if (pts.length < 2) return null;

  // Bin samples by Y into EDGE_ROWS rows.
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const p of pts) {
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }
  if (!(yMax > yMin)) return null;

  const left = new Array<number>(EDGE_ROWS).fill(NaN);
  const right = new Array<number>(EDGE_ROWS).fill(NaN);
  const rowSpan = yMax - yMin;

  for (const p of pts) {
    const t = (p.y - yMin) / rowSpan;
    // Clamp to last row inclusive.
    const row = Math.min(EDGE_ROWS - 1, Math.max(0, Math.floor(t * EDGE_ROWS)));
    if (Number.isNaN(left[row]) || p.x < left[row]) left[row] = p.x;
    if (Number.isNaN(right[row]) || p.x > right[row]) right[row] = p.x;
  }

  return { left, right, rowMin: yMin, rowMax: yMax };
}

/** Compute the optical "tightness" of a pair if the two glyphs were placed
 *  side-by-side at the left glyph's advance width.
 *
 *  Per-row gap when right glyph starts at x=advanceLeft:
 *    gap(r) = (advanceLeft + right.left[r]) - left.right[r]
 *
 *  The minimum across rows where BOTH glyphs have ink is the optical gap
 *  (how close the two visibly come). We map rows of one glyph to rows of
 *  the other by Y-coordinate (rows are not 1:1 — each glyph has its own
 *  yMin..yMax). For each y in the overlapping Y-range, we find which row
 *  each glyph has at that y and use its edge values.
 */
function computeMinOpticalGap(
  leftEdge: EdgeProfile,
  leftAdvance: number,
  rightEdge: EdgeProfile,
): number {
  const yLo = Math.max(leftEdge.rowMin, rightEdge.rowMin);
  const yHi = Math.min(leftEdge.rowMax, rightEdge.rowMax);
  if (yHi <= yLo) {
    // No vertical overlap. Return a sentinel that the caller filters out
    // (we don't want non-overlapping pairs polluting the median).
    return Number.NaN;
  }

  let minGap = Infinity;
  // Walk the overlapping Y-range in small steps. Use EDGE_ROWS-aligned
  // sampling so we hit each row's data point at least once.
  const STEPS = EDGE_ROWS * 2;
  for (let i = 0; i <= STEPS; i++) {
    const y = yLo + ((yHi - yLo) * i) / STEPS;
    const leftRow = rowAt(leftEdge, y);
    const rightRow = rowAt(rightEdge, y);
    if (leftRow < 0 || rightRow < 0) continue;
    const lr = leftEdge.right[leftRow];
    const rl = rightEdge.left[rightRow];
    if (Number.isNaN(lr) || Number.isNaN(rl)) continue;
    const gap = leftAdvance + rl - lr;
    if (gap < minGap) minGap = gap;
  }
  return minGap === Infinity ? Number.NaN : minGap;
}

function rowAt(edge: EdgeProfile, y: number): number {
  if (y < edge.rowMin || y > edge.rowMax) return -1;
  const span = edge.rowMax - edge.rowMin;
  if (span <= 0) return -1;
  const t = (y - edge.rowMin) / span;
  return Math.min(EDGE_ROWS - 1, Math.max(0, Math.floor(t * EDGE_ROWS)));
}

/** Result of computing kerning for a font: a flat map from
 *  "leftGlyphIndex,rightGlyphIndex" → kern value in font-design units.
 *  Suitable for assignment to opentype.Font.kerningPairs. */
export type KerningPairs = Record<string, number>;

/** Walk all printable glyph pairs in the font (skipping .notdef and the
 *  space glyph as the left member — space doesn't need kerning on either
 *  side), compute optical kerning per pair, return the pair table.
 *
 *  Skipping conditions:
 *    - Either glyph has no path (notdef placeholder, or scanned empty cell)
 *    - Same glyph on both sides (kern AA almost never helps)
 *    - Resulting |kern| < MIN_KERN_MAGNITUDE (table-bloat avoidance)
 */
export function computeOpticalKerning(font: opentype.Font): KerningPairs {
  // opentype.js v2 stores glyphs in font.glyphs.glyphs (object indexed by
  // glyph index). Convert to array for iteration.
  const raw = font.glyphs as unknown as { glyphs: Record<string, opentype.Glyph> };
  const all = Object.values(raw.glyphs);

  // Precompute edge profiles. Glyphs without a usable profile are skipped.
  const profiles: Array<{
    glyph: opentype.Glyph;
    edge: EdgeProfile;
    advanceWidth: number;
  }> = [];
  for (const g of all) {
    // Skip the .notdef placeholder (index 0) and any glyph mapped to the
    // space character (Unicode 0x20).
    if (g.index === 0) continue;
    if (g.unicode === 0x20) continue;
    const edge = buildEdgeProfile(g);
    if (!edge) continue;
    profiles.push({
      glyph: g,
      edge,
      advanceWidth: g.advanceWidth ?? 600,
    });
  }

  // PASS 1: compute the optical gap for every pair, skipping pairs with
  // no vertical overlap (NaN means "incomparable" — used to filter out
  // letters like ი and მ which only overlap in one of two pairings).
  type PairGap = { aIdx: number; bIdx: number; gap: number };
  const allGaps: PairGap[] = [];
  for (const a of profiles) {
    for (const b of profiles) {
      if (a.glyph.index === b.glyph.index) continue;
      const minGap = computeMinOpticalGap(a.edge, a.advanceWidth, b.edge);
      if (Number.isNaN(minGap)) continue;
      allGaps.push({ aIdx: a.glyph.index, bIdx: b.glyph.index, gap: minGap });
    }
  }

  if (allGaps.length === 0) return {};

  // Find the median gap — represents the font's "natural" spacing as the
  // designer drew it. Pairs significantly larger than median look loose;
  // pairs smaller look tight. Median is robust to scanned-glyph
  // outliers (a single weird glyph won't pull it dramatically).
  const sortedGaps = allGaps.map((g) => g.gap).sort((a, b) => a - b);
  const median = sortedGaps[Math.floor(sortedGaps.length / 2)];

  // PASS 2: emit kerning to bring outlier pairs toward the median.
  // kerning = (median - pair_gap) × DAMP so a pair with gap 200 above
  // median gets pulled back by ~100 (at DAMP=0.5). Clamped to
  // ±MAX_KERN_MAGNITUDE and sub-MIN_KERN_MAGNITUDE values are dropped
  // (no audible effect at render sizes).
  const pairs: KerningPairs = {};
  for (const { aIdx, bIdx, gap } of allGaps) {
    const adjust = (median - gap) * DAMP;
    const kern = Math.max(
      -MAX_KERN_MAGNITUDE,
      Math.min(MAX_KERN_MAGNITUDE, Math.round(adjust)),
    );
    if (Math.abs(kern) < MIN_KERN_MAGNITUDE) continue;
    pairs[`${aIdx},${bIdx}`] = kern;
  }
  return pairs;
}

/** Attach an already-computed kerning table to a font, mutating it in
 *  place. Used by both the build-font pipeline (new uploads) and the
 *  rebuild script (existing fonts). opentype.js serializes
 *  font.kerningPairs into the legacy `kern` table on toArrayBuffer(). */
export function attachKerning(font: opentype.Font, pairs: KerningPairs): void {
  // `kerningPairs` is the documented attachment point but isn't in the
  // TypeScript types for opentype.js v2. Cast through unknown.
  (font as unknown as { kerningPairs: KerningPairs }).kerningPairs = pairs;
}
