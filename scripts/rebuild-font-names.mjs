// One-shot migration: rebuild an existing font with the new ASCII-name
// fix applied. Use when a font was uploaded under the old build-font
// code that baked non-ASCII strings into the CFF FontName + Name ID 6
// (postScriptName), causing Chrome/Edge's OTS sanitizer to reject it
// silently — the .otf downloads fine but the browser falls back to a
// system font.
//
// What this does:
//   1. Download the existing .otf from Vercel Blob
//   2. Parse with opentype.js (preserves all glyph paths verbatim)
//   3. Construct a NEW opentype.Font with the same glyphs but with
//      an ASCII familyName (so CFF FontName + Name ID 6 are ASCII)
//   4. Apply the same OS/2 + Macintosh + unicode/windows display name
//      patches that buildFont() applies on fresh uploads
//   5. Re-upload to Vercel Blob under the SAME filename so existing
//      @font-face URLs and DOM references stay valid
//
// Usage:
//   BLOB_READ_WRITE_TOKEN=… node scripts/rebuild-font-names.mjs <filename>
//
// Example:
//   BLOB_READ_WRITE_TOKEN=… node scripts/rebuild-font-names.mjs \
//     "ორნამენტიკა__კიკო__yp1vka.otf"
//
// The original (broken) font is overwritten in place. If you'd rather
// keep the broken version around for comparison, copy it manually
// before running.

import opentype from "opentype.js";
import { put, list } from "@vercel/blob";

const UNITS_PER_EM = 1000;
const ASCENDER = 750;
const DESCENDER = -250;

// Same BGN-style transliteration as lib/font-pipeline/build-font.ts.
// Keep these two in sync — if you ever change the production mapping,
// re-run this script for any fonts you want to keep matching.
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

async function main() {
  const filename = process.argv[2];
  if (!filename) {
    console.error("usage: node scripts/rebuild-font-names.mjs <filename>");
    process.exit(1);
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("BLOB_READ_WRITE_TOKEN not set");
    process.exit(1);
  }

  // Look up the existing blob URL by listing under the fonts/ prefix.
  // We need the URL to fetch the existing bytes; put() with the same
  // pathname + addRandomSuffix:false overwrites in place.
  console.log(`[1/5] looking up blob: fonts/${filename}`);
  const { blobs } = await list({ prefix: `fonts/` });
  const blob = blobs.find((b) => b.pathname === `fonts/${filename}`);
  if (!blob) {
    console.error(`blob not found: fonts/${filename}`);
    console.error("available:", blobs.map((b) => b.pathname).join(", "));
    process.exit(1);
  }
  console.log(`      found at: ${blob.url}`);

  console.log(`[2/5] downloading + parsing existing font`);
  const res = await fetch(blob.url);
  const ab = await res.arrayBuffer();
  const oldFont = opentype.parse(ab);

  // Recover the original Georgian display name from the existing font.
  // The broken font has the Georgian string in name table Name ID 1
  // (fontFamily) under unicode + windows. If it's somehow missing
  // there, fall back to the filename stem (which encodes the name).
  const displayFamily =
    oldFont.names.unicode?.fontFamily?.en ??
    oldFont.names.windows?.fontFamily?.en ??
    filename.split("__")[0].replace(/\.[^.]+$/, "");
  const designerName =
    oldFont.names.unicode?.designer?.en ?? "Workshop";
  console.log(`      display family: "${displayFamily}"`);
  console.log(`      designer: "${designerName}"`);
  console.log(`      glyphs to preserve: ${oldFont.glyphs.length}`);

  const asciiBase =
    transliterateGeorgian(displayFamily) ||
    stripToAscii(displayFamily) ||
    "GeorgianWorkshopFont";
  console.log(`      ASCII internal name: "${asciiBase}"`);

  // Pull each glyph out of the old font as-is. opentype.Glyph
  // instances carry name + unicode + advanceWidth + path (in font
  // coords), which is everything the new Font constructor needs.
  // Skip glyph 0 (.notdef) — opentype.Font adds its own automatically.
  console.log(`[3/5] extracting glyphs`);
  const newGlyphs = [];
  for (let i = 1; i < oldFont.glyphs.length; i++) {
    const g = oldFont.glyphs.get(i);
    newGlyphs.push(g);
  }

  console.log(`[4/5] re-building font with ASCII names`);
  const fontOptions = {
    familyName: asciiBase, // → CFF FontName + Name ID 6 (postScriptName)
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

  // Same OS/2 monkey-patches as buildFont() — pin Android-friendly
  // values that opentype.js's defaults don't set correctly.
  const tables = font.tables;
  if (tables) {
    tables.os2 = tables.os2 ?? {};
    tables.os2.fsSelection = 0x40 | 0x80; // REGULAR | USE_TYPO_METRICS
    tables.os2.achVendID = "WKSH";
    tables.os2.usWinAscent = ASCENDER;
    tables.os2.usWinDescent = -DESCENDER;
  }

  // Macintosh backfill with random suffix for global uniqueness.
  const macUnique = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  const macFamily = `${asciiBase}-${macUnique}`;
  const names = font.names;
  names.macintosh = names.macintosh ?? {};
  names.macintosh.fontFamily = { en: macFamily };
  names.macintosh.fullName = { en: `${macFamily} Regular` };
  names.macintosh.postScriptName = { en: `${macFamily}-Regular` };
  names.macintosh.uniqueID = { en: `: ${macFamily} Regular` };

  // Restore the Georgian display name to unicode + windows tables
  // (Name ID 1 + Name ID 4 only — Name ID 6 stays ASCII).
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

  const newBytes = new Uint8Array(font.toArrayBuffer());
  console.log(`      new size: ${(newBytes.length / 1024).toFixed(1)} KB`);

  console.log(`[5/5] uploading to Vercel Blob (overwriting in place)`);
  // `allowOverwrite: true` is required by @vercel/blob v2 — without
  // it, a put() at an existing pathname errors instead of replacing.
  // We want exactly the overwrite behavior (so all existing @font-face
  // URLs pointing at this filename keep working).
  const result = await put(`fonts/${filename}`, newBytes, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "font/otf",
  });
  console.log(`      ✓ uploaded: ${result.url}`);
  console.log("");
  console.log("✓ rebuild complete");
  console.log("  next: hard-refresh the live site to clear the cached font.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
