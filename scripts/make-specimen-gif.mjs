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

// Animation. FRAMES is derived at runtime from the font count × a
// "hold" multiplier: each cell still cycles through every font it can
// draw exactly once per loop, but each font is held for a varied
// number of frames and the cells' swap moments are staggered, so the
// grid shimmers gently instead of every cell flipping on every frame.
const DELAY_MS = 100; // per-frame delay
// Loop length = maxValidFonts × HOLD_MULT. Higher = each letter holds
// each font longer (calmer, fewer simultaneous swaps) at the cost of
// more frames / bigger file. 1.0 = the old every-frame strobe.
const HOLD_MULT = 2.4;

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

/** Build a per-cell frame schedule of length `frames`: an array where
 *  schedule[f] is the font to show at frame f. Every font in `valid`
 *  appears at least once (so the cell cycles all its drawable fonts),
 *  held for a varied number of consecutive frames, and the whole
 *  sequence is rotated by a random phase so this cell's swaps don't
 *  line up with other cells' (staggered → gentle, not lockstep). */
function buildSchedule(valid, frames) {
  const n = valid.length;
  // Base: each font held 1 frame. Distribute the remaining frames as
  // random +1 increments → organic hold durations (mostly 1–3 frames).
  const holds = new Array(n).fill(1);
  let extra = Math.max(0, frames - n);
  while (extra > 0) {
    holds[Math.floor(Math.random() * n)]++;
    extra--;
  }
  // Expand into a flat per-frame sequence (length === frames).
  const seq = [];
  for (let i = 0; i < n; i++) {
    for (let h = 0; h < holds[i]; h++) seq.push(valid[i]);
  }
  // Random phase rotation so this cell starts mid-cycle, offsetting its
  // swap frames from neighbors'.
  const phase = Math.floor(Math.random() * seq.length);
  return seq.slice(phase).concat(seq.slice(0, phase));
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

// --- Glyph helpers -------------------------------------------------------

const BASE = 200; // base font size for path extraction

/** True iff `font` renders a non-empty visible glyph for `char`. Used to
 *  precompute, per letter, which fonts can actually draw it — so blank
 *  (font, letter) combinations are skipped entirely rather than shown
 *  as empty cells. Mirrors glyphSvg's emptiness checks exactly. */
function hasGlyph(font, char) {
  let path;
  try {
    path = font.getPath(char, 0, 0, BASE);
  } catch {
    return false;
  }
  const pd = path.toPathData(1);
  if (!pd || pd.length < 4) return false;
  const bb = path.getBoundingBox();
  if (!(bb.x2 - bb.x1 > 0) || !(bb.y2 - bb.y1 > 0)) return false;
  return true;
}

/** Render one letter in one font, centered + scaled to fit a grid cell.
 *  Returns an SVG <g>…</g> string, or "" if the glyph is empty/missing.
 *  (Callers now pass only fonts pre-validated by hasGlyph, so "" is a
 *  defensive guard rather than an expected path.) */
function glyphSvg(font, char, cellX, cellY) {
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

function frameSvg(cellFonts) {
  // cellFonts: array of length COLS*ROWS, each an opentype.Font that's
  // already been validated to render this cell's letter (see main's
  // per-cell valid-font sets), so no blank-cell fallback is needed.
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${BG}"/>`,
  ];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      const char = ALPHABET[idx % ALPHABET.length];
      const font = cellFonts[idx];
      if (font) parts.push(glyphSvg(font, char, c * CELL_W, r * CELL_H));
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

  // PER-CELL VALID-FONT SETS: for each cell's letter, keep only the
  // fonts that actually render it (skip blank/empty glyphs entirely —
  // no blank cells, and a font that can't draw a letter never gets a
  // turn in that cell). Each cell's set is shuffled so its cycle order
  // is independent → the grid shimmers rather than changing in lockstep.
  console.log("Validating glyphs per letter (skipping blank ones)…");
  const cellValidFonts = [];
  for (let idx = 0; idx < nCells; idx++) {
    const char = ALPHABET[idx % ALPHABET.length];
    let valid = fonts.filter((fnt) => hasGlyph(fnt, char));
    if (valid.length === 0) valid = fonts; // degenerate: no font draws it
    cellValidFonts.push(shuffle(valid));
  }
  const validCounts = cellValidFonts.map((v) => v.length);
  const maxValid = Math.max(...validCounts);

  // LOOP LENGTH = maxValid × HOLD_MULT, so the best-covered letter shows
  // each of its fonts ~HOLD_MULT frames on average. Per-cell schedules
  // hold each font for a varied count of frames and start at a random
  // phase, so swaps stagger across the grid (gentle, not strobe) while
  // every letter still cycles all the fonts that can draw it.
  const FRAMES = Math.round(maxValid * HOLD_MULT);
  const schedules = cellValidFonts.map((v) => buildSchedule(v, FRAMES));

  console.log(
    `Rendering ${FRAMES} frames (${W}×${H}, ${COLS}×${ROWS} grid; each letter cycles ${Math.min(...validCounts)}–${maxValid} fonts, staggered timing)…`,
  );
  const frameBuffers = [];
  for (let f = 0; f < FRAMES; f++) {
    const cellFonts = schedules.map((s) => s[f]);
    const svg = frameSvg(cellFonts);
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

  // Coverage: every cell cycles its full valid-font set (guaranteed by
  // construction). USED collects fonts that rendered a visible glyph
  // anywhere; a font absent from USED is blank for EVERY letter it was
  // assigned — report it.
  const used = USED.size;
  console.log(
    `\nEach letter cycles only the fonts that can draw it (${Math.min(...validCounts)}–${maxValid} of ${nFonts}); blank glyphs skipped.`,
  );
  console.log(`Fonts that rendered a visible glyph somewhere: ${used}/${nFonts}.`);
  if (used < nFonts) {
    const missing = fonts.filter((fnt) => !USED.has(fnt.__idx)).map((fnt) => fnt.__name);
    console.log(`  Blank for every alphabet letter (never shown): ${missing.join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
