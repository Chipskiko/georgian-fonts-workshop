// Generate a flickering alphabet-grid specimen GIF.
//
// Layout: a grid of the Georgian alphabet (ა–ჰ, 33 letters) on an
// Instagram-portrait (4:5) canvas. Each cell shows one letter; each
// frame, every cell independently swaps to a random font from the
// database with probability SWAP_P, so the whole grid shimmers
// through every font in the workshop.
//
// Colors: yellow background, pink letters (inverse of the site's
// pink-bg/yellow-fg palette, per request).
//
// Pipeline: opentype.js renders each glyph → SVG path; one SVG per
// frame (bg rect + 35 positioned glyph paths); sharp rasterizes each
// SVG → PNG; sharp joins all frames into an animated GIF (no extra
// deps — sharp's `join: { animated: true }` builds multi-page output).
//
// Requires BLOB_READ_WRITE_TOKEN (load via `set -a && source .env.local
// && set +a`) to enumerate the font list; font bytes are fetched from
// the public blob URL.
//
// Usage: node scripts/make-specimen-gif.mjs [outPath]

import opentype from "opentype.js";
import { list } from "@vercel/blob";
import sharp from "sharp";
import { writeFile } from "node:fs/promises";

// --- Config --------------------------------------------------------------

const OUT = process.argv[2] || "specimen-alphabet.gif";

// Instagram portrait 4:5.
const W = 1080;
const H = 1350;

// Grid: 5 columns honors the requested "5x4"; 7 rows fits the 33-letter
// alphabet (35 cells, last 2 wrap to ა/ბ so the grid reads as full).
const COLS = 5;
const ROWS = 7;
const CELL_W = W / COLS;
const CELL_H = H / ROWS;

// Glyph sizing inside each cell.
const GLYPH_H_FRAC = 0.56; // target glyph height as fraction of cell height
const GLYPH_W_FRAC = 0.8; // cap glyph width to this fraction of cell width

const BG = "#ffea00"; // yellow
const FG = "#ff10b8"; // pink

// Animation. FRAMES is derived from the font count at runtime: each
// cell cycles through EVERY font exactly once over a full loop, so the
// loop length = number of fonts. DELAY sets the flicker speed.
const DELAY_MS = 100; // per-frame delay (~10 fonts/sec per cell)

const PUBLIC_BASE =
  "https://m9rikrlplfcm8hve.public.blob.vercel-storage.com/fonts/";

// Georgian alphabet ა (U+10D0) … ჰ (U+10F0) = 33 letters.
const ALPHABET = Array.from({ length: 33 }, (_, i) =>
  String.fromCharCode(0x10d0 + i),
);

// --- Randomness ----------------------------------------------------------
// Plain Math.random is fine for a one-off; kept simple.
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Tracks which fonts actually RENDER a visible glyph (by tagged __idx),
// so we can report true coverage at the end — not just "assigned" but
// "appeared on screen".
const USED = new Set();

// --- Load fonts ----------------------------------------------------------

async function loadFonts() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN not set — run `set -a && source .env.local && set +a` first",
    );
  }
  const { blobs } = await list({ prefix: "fonts/" });
  const files = blobs
    .filter((b) => b.pathname.endsWith(".otf"))
    .map((b) => b.pathname.replace("fonts/", ""));
  console.log(`Found ${files.length} fonts. Downloading + parsing…`);

  const fonts = [];
  for (const fn of files) {
    try {
      const res = await fetch(`${PUBLIC_BASE}${encodeURIComponent(fn)}?cb=${Date.now()}`);
      if (!res.ok) {
        console.warn(`  skip ${fn}: HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const font = opentype.parse(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      );
      // Tag with a stable index + display name for coverage reporting.
      font.__idx = fonts.length;
      font.__name = fn.split("__")[0]; // human-readable prefix
      fonts.push(font);
    } catch (e) {
      console.warn(`  skip ${fn}: ${e.message}`);
    }
  }
  console.log(`Parsed ${fonts.length} fonts OK.`);
  if (fonts.length === 0) throw new Error("no fonts parsed");
  return fonts;
}

// --- Glyph → positioned SVG <g> ------------------------------------------

/** Render one letter in one font, centered + scaled to fit a grid cell.
 *  Returns an SVG <g>…</g> string, or "" if the glyph is empty/missing. */
function glyphSvg(font, char, cellX, cellY) {
  const BASE = 200; // base font size for path extraction
  let path;
  try {
    path = font.getPath(char, 0, 0, BASE);
  } catch {
    return "";
  }
  const pd = path.toPathData(1);
  if (!pd || pd.length < 4) return "";
  const bb = path.getBoundingBox();
  const gw = bb.x2 - bb.x1;
  const gh = bb.y2 - bb.y1;
  if (!(gw > 0) || !(gh > 0)) return "";

  // Scale to target height, cap to width.
  let s = (CELL_H * GLYPH_H_FRAC) / gh;
  if (gw * s > CELL_W * GLYPH_W_FRAC) s = (CELL_W * GLYPH_W_FRAC) / gw;

  // Center the glyph's bbox center on the cell center.
  const cx = cellX + CELL_W / 2;
  const cy = cellY + CELL_H / 2;
  const tx = cx - ((bb.x1 + bb.x2) / 2) * s;
  const ty = cy - ((bb.y1 + bb.y2) / 2) * s;

  // Record that this font produced a visible glyph (coverage tracking).
  if (typeof font.__idx === "number") USED.add(font.__idx);

  return `<g transform="translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${s.toFixed(4)})"><path d="${pd}" fill="${FG}"/></g>`;
}

// --- Build one frame's SVG -----------------------------------------------

function frameSvg(cellFonts, allFonts) {
  // cellFonts: array of length COLS*ROWS, each an opentype.Font.
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${BG}"/>`,
  ];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      // Wrap the alphabet to fill all cells (last 2 of a 35-cell grid
      // repeat ა/ბ — invisible amid the flicker).
      const char = ALPHABET[idx % ALPHABET.length];
      let g = glyphSvg(cellFonts[idx], char, c * CELL_W, r * CELL_H);
      // Fallback: if the assigned font has an empty/missing glyph for
      // this letter, try a few other random fonts so the cell doesn't
      // render blank (blanks read as bugs in the grid).
      for (let t = 0; t < 8 && g === ""; t++) {
        g = glyphSvg(pick(allFonts), char, c * CELL_W, r * CELL_H);
      }
      parts.push(g);
    }
  }
  parts.push(`</svg>`);
  return parts.join("");
}

// --- Main ----------------------------------------------------------------

async function main() {
  const fonts = await loadFonts();
  const nCells = COLS * ROWS;
  const nFonts = fonts.length;

  // ONE FULL LOOP = nFonts frames. Each cell cycles through EVERY font
  // exactly once across the loop, so every letter "wears" every font.
  const FRAMES = nFonts;

  // Per-cell font order: each cell gets its OWN shuffled permutation of
  // all font indices. Frame f → cell i shows fonts[perm[i][f]]. Because
  // each cell's order is independent, the grid never shows all cells in
  // the same font on a frame (no synchronized look) — it shimmers — yet
  // every cell is guaranteed to pass through all nFonts over the loop.
  const perms = Array.from({ length: nCells }, () =>
    shuffle(fonts.map((_, i) => i)),
  );

  console.log(
    `Rendering ${FRAMES} frames (${W}×${H}, ${COLS}×${ROWS} grid, each cell cycles all ${nFonts} fonts)…`,
  );
  const frameBuffers = [];
  for (let f = 0; f < FRAMES; f++) {
    const cellFonts = perms.map((perm) => fonts[perm[f]]);
    const svg = frameSvg(cellFonts, fonts);
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    frameBuffers.push(png);
    if ((f + 1) % 10 === 0) console.log(`  ${f + 1}/${FRAMES} frames`);
  }

  console.log("Encoding animated GIF…");
  const gif = await sharp(frameBuffers, { join: { animated: true } })
    .gif({ delay: DELAY_MS, loop: 0 })
    .toBuffer();

  await writeFile(OUT, gif);
  console.log(`\n✓ wrote ${OUT} (${(gif.length / 1024 / 1024).toFixed(2)} MB, ${FRAMES} frames)`);

  // Coverage: by construction each cell's permutation contains every
  // font index, so every cell cycles all fonts. Confirm the global
  // visible-render set too (a font only fails to show if it has empty
  // glyphs for every letter it lands on across the whole grid).
  const used = USED.size;
  console.log(
    `\nPer-cell coverage: all ${nCells} cells cycle through all ${nFonts} fonts (guaranteed by construction).`,
  );
  console.log(`Global visible-render coverage: ${used}/${nFonts} fonts.`);
  if (used < nFonts) {
    const missing = fonts.filter((fnt) => !USED.has(fnt.__idx)).map((fnt) => fnt.__name);
    console.log(`  Rendered blank everywhere (empty glyphs): ${missing.join(", ")}`);
  } else {
    console.log("  ✓ every font shows a visible glyph somewhere.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
