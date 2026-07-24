// Detect TRUE duplicate fonts by comparing glyph OUTLINES, not bytes or
// names. Two uploads of the same drawing have different filenames + name
// tables (random suffix) but identical glyph geometry. For each font we
// build a signature from every mapped glyph's path commands (rounded) +
// its cmap codepoint, hash it, and group. Same hash = same artwork.
//
// Read-only: downloads each font, computes a hash, prints groups. Writes
// nothing.
import opentype from "opentype.js";
import { list } from "@vercel/blob";
import { createHash } from "node:crypto";

const { blobs } = await list({ prefix: "fonts/" });
const fonts = blobs
  .filter((b) => /\.(otf|ttf)$/i.test(b.pathname))
  .map((b) => ({ filename: b.pathname.replace("fonts/", ""), url: b.url }));

/** Outline signature: for each unicode codepoint the font maps, emit
 *  `cp:roundedPathData`. Independent of names, ordering, and metrics
 *  precision (paths rounded to integer units). */
function outlineSig(font) {
  const parts = [];
  const cmap = font.tables.cmap;
  if (!cmap || !cmap.glyphIndexMap) return null;
  const entries = Object.entries(cmap.glyphIndexMap)
    .map(([cp, gi]) => [Number(cp), gi])
    .sort((a, b) => a[0] - b[0]);
  for (const [cp, gi] of entries) {
    const glyph = font.glyphs.get(gi);
    if (!glyph) continue;
    let d = "";
    try {
      d = glyph.getPath(0, 0, 1000).toPathData(0); // integer-rounded
    } catch {
      d = "(err)";
    }
    parts.push(`${cp}:${d}`);
  }
  return parts.length ? parts.join("|") : null;
}

const byHash = new Map();
for (const f of fonts) {
  try {
    const ab = await (await fetch(`${f.url}?cb=${Date.now()}`)).arrayBuffer();
    const font = opentype.parse(ab);
    const sig = outlineSig(font);
    const nGlyphs = font.glyphs.length;
    if (!sig) {
      console.warn(`  ${f.filename}: no cmap/outlines — skipped`);
      continue;
    }
    const h = createHash("sha1").update(sig).digest("hex").slice(0, 12);
    const rec = { filename: f.filename, bytes: ab.byteLength, nGlyphs };
    if (byHash.has(h)) byHash.get(h).push(rec);
    else byHash.set(h, [rec]);
  } catch (e) {
    console.warn(`  ${f.filename}: parse failed — ${e.message}`);
  }
}

const dups = [...byHash.entries()].filter(([, g]) => g.length > 1);
console.log(`\n${fonts.length} fonts, ${byHash.size} distinct outline sets`);
if (!dups.length) {
  console.log("No true content duplicates — every font has unique artwork.");
} else {
  console.log(`\n${dups.length} group(s) of IDENTICAL outlines:`);
  for (const [h, g] of dups) {
    console.log(`\n  [${h}]`);
    for (const r of g) console.log(`    ${r.filename}  (${(r.bytes / 1024).toFixed(1)} KB, ${r.nGlyphs} glyphs)`);
  }
}

// Also flag NEAR-duplicates: same display-name group but we already know
// those. Here additionally report same glyph COUNT + same first-glyph
// path but different hash (possible re-scan of same drawing).
