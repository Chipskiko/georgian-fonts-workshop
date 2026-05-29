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

// Animation.
const FRAMES = 50;
const DELAY_MS = 110; // per-frame delay
const SWAP_P = 0.4; // per-cell chance to swap font each frame

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

// Shuffle-bag font picker: draws every font once (in random order)
// before any repeat. GUARANTEES all fonts appear and keeps the
// distribution even — strictly better than pure-random pick(), which
// could (improbably) skip a font and over-show others. Still looks
// random to the eye because the order within each bag is shuffled.
function makeFontBag(fonts) {
  let bag = [];
  return function drawFont() {
    if (bag.length === 0) bag = shuffle(fonts);
    return bag.pop();
  };
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
  const drawFont = makeFontBag(fonts);

  // Initial assignment from the shuffle bag.
  const cellFonts = Array.from({ length: nCells }, () => drawFont());

  console.log(`Rendering ${FRAMES} frames (${W}×${H}, ${COLS}×${ROWS} grid)…`);
  const frameBuffers = [];
  for (let f = 0; f < FRAMES; f++) {
    // Each cell independently swaps to the next font from the shuffle
    // bag with SWAP_P. The bag guarantees every font is drawn before
    // any repeat. Frame 0 keeps the initial assignment so the loop
    // start is stable.
    if (f > 0) {
      for (let i = 0; i < nCells; i++) {
        if (Math.random() < SWAP_P) cellFonts[i] = drawFont();
      }
    }
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

  // Coverage report — which fonts actually rendered a visible glyph.
  const used = USED.size;
  const total = fonts.length;
  console.log(`\nFont coverage: ${used}/${total} fonts appeared on screen.`);
  if (used < total) {
    const missing = fonts
      .filter((fnt) => !USED.has(fnt.__idx))
      .map((fnt) => fnt.__name);
    console.log(`  Never rendered (all assigned letters were empty glyphs): ${missing.join(", ")}`);
  } else {
    console.log("  ✓ every font in the database is shown.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
