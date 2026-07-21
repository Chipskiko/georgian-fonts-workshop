// Backfill baked alphabet-preview SVG sidecars for fonts uploaded
// before the §8 feature (lib/font-pipeline/preview-svg.ts). New uploads
// get their sidecar at save time; this script generates them for the
// existing library. Idempotent: fonts that already have a sidecar are
// skipped, so re-running is safe and cheap.
//
// Layout constants MIRROR lib/font-pipeline/preview-svg.ts — keep in
// sync when tuning (SIZE, LINE_GAP, PAD, FILL, 17/16 line split).
//
// Modes:
//   --dry            (default) report which fonts need sidecars, write nothing
//   --apply <name>   generate + upload for one font filename
//   --apply-all      generate + upload for every font missing a sidecar
//
// Requires BLOB_READ_WRITE_TOKEN (set -a && source .env.local && set +a).

import opentype from "opentype.js";
import { list, put } from "@vercel/blob";

const BLOB_PREFIX = "fonts/";
const PREVIEW_SUFFIX = ".preview.svg";
const FONT_EXT = [".ttf", ".otf", ".woff"];

// --- Layout constants (mirror preview-svg.ts) ---------------------------

const ALPHABET = "ა ბ გ დ ე ვ ზ თ ი კ ლ მ ნ ო პ ჟ რ ს ტ უ ფ ქ ღ ყ შ ჩ ც ძ წ ჭ ხ ჯ ჰ".split(" ");
const SIZE = 64;
const PAD = 6;
const FILL = "#ffea00";
const LETTER_GAP = SIZE * 0.4;

// Single-line manual per-letter layout — skips characters mapping to
// .notdef (glyph index 0). Several workshop fonts have broken cmaps
// and/or inked notdef glyphs; a string render would stamp that ink at
// every space/missing char. Mirrors layoutAlphabet in preview-svg.ts.
function layoutAlphabet(font) {
  const combined = new opentype.Path();
  let x = 0;
  for (const ch of ALPHABET) {
    let glyph;
    try {
      glyph = font.charToGlyph(ch);
    } catch {
      continue;
    }
    if (!glyph || glyph.index === 0) continue;
    combined.extend(glyph.getPath(x, 0, SIZE));
    const advance = ((glyph.advanceWidth ?? font.unitsPerEm * 0.5) / font.unitsPerEm) * SIZE;
    x += advance + LETTER_GAP;
  }
  return combined;
}

function buildPreviewSvg(fontBytes) {
  let font;
  try {
    font = opentype.parse(
      fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength),
    );
  } catch {
    return null;
  }
  let path;
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

  const fmt = (n) => Math.round(n * 10) / 10;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}" height="${fmt(h)}" viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(w)} ${fmt(h)}">` +
    `<path d="${d}" fill="${FILL}"/>` +
    `</svg>`
  );
}

// --- Pipeline ------------------------------------------------------------

async function loadInventory() {
  const { blobs } = await list({ prefix: BLOB_PREFIX });
  const fonts = [];
  const sidecars = new Set();
  for (const b of blobs) {
    const name = b.pathname.replace(BLOB_PREFIX, "");
    if (name.endsWith(PREVIEW_SUFFIX)) {
      sidecars.add(name.slice(0, -PREVIEW_SUFFIX.length));
    } else if (FONT_EXT.some((e) => name.toLowerCase().endsWith(e))) {
      fonts.push({ filename: name, url: b.url });
    }
  }
  return { fonts, sidecars };
}

async function backfillOne(font) {
  const res = await fetch(`${font.url}?cb=${Date.now()}`);
  if (!res.ok) throw new Error(`fetch: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const svg = buildPreviewSvg(bytes);
  if (!svg) {
    console.log(`  ${font.filename}: SKIP (unparseable or empty outlines)`);
    return false;
  }
  await put(`${BLOB_PREFIX}${font.filename}${PREVIEW_SUFFIX}`, svg, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "image/svg+xml",
  });
  console.log(`  ${font.filename}: ✓ sidecar uploaded (${(svg.length / 1024).toFixed(1)} KB)`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  // `--force` regenerates sidecars that already exist (use after a
  // layout/palette change, like switching to single-line).
  const force = flags.has("--force");
  const mode = ["--dry", "--apply", "--apply-all"].find((m) => flags.has(m)) ?? "--dry";
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("BLOB_READ_WRITE_TOKEN not set — run `set -a && source .env.local && set +a` first");
    process.exit(1);
  }

  const { fonts, sidecars } = await loadInventory();
  const targets = force ? fonts : fonts.filter((f) => !sidecars.has(f.filename));
  console.log(
    `${fonts.length} fonts, ${sidecars.size} sidecars present, ${targets.length} to ${force ? "regenerate" : "generate"}`,
  );

  if (mode === "--dry") {
    for (const f of targets) console.log(`  ${force ? "regen" : "needs sidecar"}: ${f.filename}`);
    return;
  }
  if (mode === "--apply") {
    const filename = positional[0];
    if (!filename) {
      console.error("filename required for --apply");
      process.exit(1);
    }
    const f = fonts.find((x) => x.filename === filename);
    if (!f) throw new Error(`font not found: ${filename}`);
    await backfillOne(f);
    return;
  }
  let done = 0;
  for (const f of targets) {
    try {
      if (await backfillOne(f)) done++;
    } catch (e) {
      console.warn(`  ${f.filename}: failed — ${e.message}`);
    }
  }
  console.log(`\ndone — ${done} of ${targets.length} sidecars ${force ? "regenerated" : "generated"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
