// One-shot fixer for cell-divider / guide-line bleed-through in
// already-uploaded fonts.
//
// Symptom: when the printed template's cell divider lines are too
// dark (bad lighting, aggressive thresholding), potrace traces them
// as ink and a thin horizontal stripe ends up inside EVERY glyph at
// the cell-top edge (font Y ≈ 750) and/or the baseline edge (font Y
// ≈ 0). The fix can't undo the trace, but it CAN identify and remove
// those stripe subpaths post-build.
//
// Detection signature (tuned against actual fonts to catch both the
// continuous stripes AND the discontinuous dashes — multiple short
// segments forming a visual line):
//   - bbox height ≤ 30 font units (real glyph strokes are thicker)
//   - bbox width / height ≥ 2.5 (horizontally oriented)
//   - Y centroid within ±60 of 0 (baseline/below) OR ±60 of 750 (top)
//
// Workshop letters don't have features matching ALL three criteria;
// users draw with markers (thick strokes) and rarely place horizontal
// segments exactly at the cell-bottom or cell-top edge. The 2.5:1
// aspect catches dashes — first-pass scan at fxali showed 147 dash
// subpaths in the baseline area (aspect 2.1–4.9) that the original
// 5:1 stripe detector missed.
//
// Modes:
//   --dry            (default) print per-glyph removal counts, write nothing
//   --apply <name>   run on one font filename, upload result
//   --apply-all      run on every font, upload all results
//
// Examples:
//   node scripts/fix-guide-artifacts.mjs --dry fxali__fxalii__y3ajq3.otf
//   node scripts/fix-guide-artifacts.mjs --apply fxali__fxalii__y3ajq3.otf
//   node scripts/fix-guide-artifacts.mjs --apply-all
//
// Requires BLOB_READ_WRITE_TOKEN env var (load via `source .env.local`).

import opentype from "opentype.js";
import { list, put } from "@vercel/blob";

// --- Detection thresholds -----------------------------------------------

/** Max bbox height for a subpath to qualify as an artifact. Real
 *  glyph strokes are thicker than this (workshop participants use
 *  markers that produce strokes of at least 40-60 font units). */
const STRIPE_MAX_H = 30;

/** Min aspect ratio (width / height) for the WIDE/long stripe
 *  detector. Catches obvious continuous lines and long dashes
 *  immediately. Smaller dot-like marks fall through to the
 *  SMALL_DOT detector below. */
const STRIPE_MIN_ASPECT = 2.5;

/** Width range for the SMALL DOT detector. Workshop template draws
 *  guide LINES via a sequence of small dot/dash marks; after trace
 *  + warp each looks like a roundish blob with width 25-40 font units
 *  and height 10-20 font units (aspect 1.5-2.5). Too square for the
 *  aspect filter above. Catch them by their small footprint near the
 *  guide-Y positions instead. Range 15-60 excludes tiny noise specks
 *  (w<15) and full glyph strokes that happen to span the cell (w>60). */
const SMALL_DOT_MIN_W = 15;
const SMALL_DOT_MAX_W = 60;

/** Y centroids of the cell-divider artifacts in font coordinate space.
 *  See lib/font-pipeline/build-font.ts svgPathToOpentype for the
 *  pixel-to-font scaling that places these values:
 *    - baseline = 0 (where the cell divider line at the bottom prints)
 *    - ascender = 750 (where the label-divider line at the top prints
 *      AND where the cell's TOP edge is)
 *  ±60 tolerance accommodates trace wobble — fxali histogram showed
 *  artifacts cluster at Y=0 (98 dashes) and Y=-50 (49 dashes), so
 *  the band needs to reach down to about -60. */
const STRIPE_Y_CENTERS = [0, 750];
const STRIPE_Y_TOLERANCE = 60;

// --- Font constants (match build-font.ts) -------------------------------

const UNITS_PER_EM = 1000;
const ASCENDER = 750;
const DESCENDER = -250;

const GEORGIAN_TO_LATIN = {
  ა: "a", ბ: "b", გ: "g", დ: "d", ე: "e",
  ვ: "v", ზ: "z", თ: "T", ი: "i", კ: "k",
  ლ: "l", მ: "m", ნ: "n", ო: "o", პ: "p",
  ჟ: "J", რ: "r", ს: "s", ტ: "t", უ: "u",
  ფ: "f", ქ: "q", ღ: "R", ყ: "y", შ: "S",
  ჩ: "C", ც: "c", ძ: "Z", წ: "w", ჭ: "W",
  ხ: "x", ჯ: "j", ჰ: "h",
};

function stripToAscii(s) {
  return s
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\w-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function transliterateGeorgian(s) {
  let out = "";
  for (const ch of s) out += GEORGIAN_TO_LATIN[ch] ?? ch;
  return stripToAscii(out);
}

// --- Core fixer ---------------------------------------------------------

/** Split a glyph's command stream into subpaths (each starts with M). */
function splitSubpaths(cmds) {
  const subs = [];
  let cur = [];
  for (const c of cmds) {
    if (c.type === "M" && cur.length > 0) {
      subs.push(cur);
      cur = [];
    }
    cur.push(c);
  }
  if (cur.length > 0) subs.push(cur);
  return subs;
}

/** True when a subpath matches the stripe / dot artifact signature.
 *  Two-prong: long-stripe (high aspect) OR small-dot (small footprint).
 *  Both require Y centroid near a guide line. */
function isStripeArtifact(subpath) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of subpath) {
    if (c.x != null) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
    }
    if (c.y != null) {
      if (c.y < minY) minY = c.y;
      if (c.y > maxY) maxY = c.y;
    }
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (h <= 0 || h >= STRIPE_MAX_H) return false;

  // Must sit near a guide line — this is the primary safety guard
  // against false positives. If a subpath happens to be thin/small
  // but is in the MIDDLE of the cell, it's almost certainly a real
  // glyph feature and we leave it alone.
  const cy = (minY + maxY) / 2;
  let nearGuide = false;
  for (const center of STRIPE_Y_CENTERS) {
    if (Math.abs(cy - center) <= STRIPE_Y_TOLERANCE) {
      nearGuide = true;
      break;
    }
  }
  if (!nearGuide) return false;

  // Match if either:
  //   (a) wide-aspect stripe: width/height ≥ 2.5 (long horizontal line)
  //   (b) small dot-like: 15 ≤ width ≤ 60 (roundish guide dot)
  if (w / h >= STRIPE_MIN_ASPECT) return true;
  if (w >= SMALL_DOT_MIN_W && w <= SMALL_DOT_MAX_W) return true;
  return false;
}

/** Drop matching subpaths from a glyph in-place. Returns count removed. */
function stripGlyphArtifacts(glyph) {
  const cmds = glyph.path?.commands ?? [];
  if (cmds.length === 0) return 0;
  const subs = splitSubpaths(cmds);
  let removed = 0;
  const kept = [];
  for (const sp of subs) {
    if (isStripeArtifact(sp)) {
      removed++;
    } else {
      kept.push(sp);
    }
  }
  if (removed > 0) {
    glyph.path.commands = kept.flat();
  }
  return removed;
}

// --- Font rebuild (mirrors scripts/rebuild-font-names.mjs) -------------

function rebuildFont(oldFont) {
  // Pull the original Georgian display name from the unicode/windows
  // tables; fall back to the ASCII Mac name if neither is present.
  const displayFamily =
    oldFont.names.unicode?.fontFamily?.en ??
    oldFont.names.windows?.fontFamily?.en ??
    oldFont.names.macintosh?.fontFamily?.en ??
    "GeorgianWorkshopFont";
  const designerName =
    oldFont.names.unicode?.designer?.en ?? "Workshop";
  const asciiBase =
    transliterateGeorgian(displayFamily) ||
    stripToAscii(displayFamily) ||
    "GeorgianWorkshopFont";

  // Extract glyphs (skip .notdef at index 0 — opentype.js adds its own)
  const newGlyphs = [];
  for (let i = 1; i < oldFont.glyphs.length; i++) {
    newGlyphs.push(oldFont.glyphs.get(i));
  }

  const fontOptions = {
    familyName: asciiBase,
    styleName: "Regular",
    designer: designerName,
    unitsPerEm: UNITS_PER_EM,
    ascender: ASCENDER,
    descender: DESCENDER,
    glyphs: newGlyphs,
    weightClass: 400,
    panose: [2, 0, 5, 3, 0, 0, 0, 0, 0, 0],
  };
  const font = new opentype.Font(fontOptions);

  // OS/2 monkey-patches (same as buildFont)
  const tables = font.tables;
  if (tables) {
    tables.os2 = tables.os2 ?? {};
    tables.os2.fsSelection = 0x40 | 0x80;
    tables.os2.achVendID = "WKSH";
    tables.os2.usWinAscent = ASCENDER;
    tables.os2.usWinDescent = -DESCENDER;
  }

  // Mac backfill with random suffix for global uniqueness
  const macUnique = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  const macFamily = `${asciiBase}-${macUnique}`;
  const names = font.names;
  names.macintosh = names.macintosh ?? {};
  names.macintosh.fontFamily = { en: macFamily };
  names.macintosh.fullName = { en: `${macFamily} Regular` };
  names.macintosh.postScriptName = { en: `${macFamily}-Regular` };
  names.macintosh.uniqueID = { en: `: ${macFamily} Regular` };

  // Restore Georgian display name to unicode + windows
  if (displayFamily !== asciiBase) {
    const displayFullName = `${displayFamily} Regular`;
    names.unicode = names.unicode ?? {};
    names.unicode.fontFamily = { en: displayFamily };
    names.unicode.fullName = { en: displayFullName };
    names.unicode.preferredFamily = { en: displayFamily };
    names.windows = names.windows ?? {};
    names.windows.fontFamily = { en: displayFamily };
    names.windows.fullName = { en: displayFullName };
    names.windows.preferredFamily = { en: displayFamily };
  }

  return new Uint8Array(font.toArrayBuffer());
}

// --- Pipeline -----------------------------------------------------------

async function fixOneFont(filename, { apply }) {
  const url = `https://m9rikrlplfcm8hve.public.blob.vercel-storage.com/fonts/${encodeURIComponent(filename)}?cb=${Date.now()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${filename}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  let totalRemoved = 0;
  let glyphsAffected = 0;
  for (let i = 1; i < font.glyphs.length; i++) {
    const removed = stripGlyphArtifacts(font.glyphs.get(i));
    totalRemoved += removed;
    if (removed > 0) glyphsAffected++;
  }

  console.log(`  ${filename}: ${totalRemoved} stripe subpaths removed across ${glyphsAffected} glyphs`);

  if (!apply) return { totalRemoved, glyphsAffected };
  if (totalRemoved === 0) {
    console.log(`    nothing to upload — font unchanged`);
    return { totalRemoved, glyphsAffected };
  }

  const newBytes = rebuildFont(font);
  await put(`fonts/${filename}`, newBytes, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "font/otf",
  });
  console.log(`    ✓ uploaded (${(newBytes.length / 1024).toFixed(1)} KB)`);
  return { totalRemoved, glyphsAffected };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  if (!mode || (mode !== "--dry" && mode !== "--apply" && mode !== "--apply-all")) {
    console.error("usage: node scripts/fix-guide-artifacts.mjs <--dry|--apply|--apply-all> [filename]");
    process.exit(1);
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("BLOB_READ_WRITE_TOKEN not set — run `set -a && source .env.local && set +a` first");
    process.exit(1);
  }

  if (mode === "--apply-all") {
    const { blobs } = await list({ prefix: "fonts/" });
    const fontFiles = blobs.filter((b) => b.pathname.endsWith(".otf")).map((b) => b.pathname.replace("fonts/", ""));
    console.log(`Scanning ${fontFiles.length} fonts (apply mode)...`);
    let touched = 0;
    for (const fn of fontFiles) {
      try {
        const r = await fixOneFont(fn, { apply: true });
        if (r.totalRemoved > 0) touched++;
      } catch (e) {
        console.warn(`  ${fn}: failed — ${e.message}`);
      }
    }
    console.log(`\ndone — ${touched} of ${fontFiles.length} fonts updated`);
  } else {
    const filename = args[1];
    if (!filename) {
      console.error("filename required for --dry / --apply mode");
      process.exit(1);
    }
    await fixOneFont(filename, { apply: mode === "--apply" });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
