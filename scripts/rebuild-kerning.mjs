// Apply optical kerning to all existing fonts in Vercel Blob storage.
//
// For each scanned Georgian font:
//   1. Fetch the font's current .otf bytes
//   2. Parse with opentype.js
//   3. Compute per-pair optical kerning from glyph edge profiles
//   4. Attach to font.kerningPairs (legacy `kern` table on serialization)
//   5. Re-upload under the same filename
//
// Algorithm mirrors lib/font-pipeline/optical-kerning.ts — kept in sync
// when the constants there change. Inlined as JS so this script stays
// self-contained (no need for a TS runner).
//
// Modes:
//   --dry            (default) print pair counts per font, write nothing
//   --apply <name>   run on one font filename, upload result
//   --apply-all      run on every font, upload all results
//
// Examples:
//   node scripts/rebuild-kerning.mjs --dry fxali__fxalii__y3ajq3.otf
//   node scripts/rebuild-kerning.mjs --apply fxali__fxalii__y3ajq3.otf
//   node scripts/rebuild-kerning.mjs --apply-all
//
// Requires BLOB_READ_WRITE_TOKEN env var.

import opentype from "opentype.js";
import { list, put } from "@vercel/blob";

// --- Algorithm constants (mirror lib/font-pipeline/optical-kerning.ts) ---

const EDGE_ROWS = 40;
const BEZIER_SAMPLES = 16;
const DAMP = 0.5;  // half-way to median
const MIN_KERN_MAGNITUDE = 10;
const MAX_KERN_MAGNITUDE = 300;

// --- Edge profiling ------------------------------------------------------

function buildEdgeProfile(glyph) {
  const cmds = glyph.path?.commands;
  if (!cmds || cmds.length === 0) return null;

  const pts = [];
  let prevX = 0, prevY = 0;
  let startX = 0, startY = 0;

  const qBez = (a, b, c, t) => {
    const omt = 1 - t;
    return omt * omt * a + 2 * omt * t * b + t * t * c;
  };
  const cBez = (a, b, c, d, t) => {
    const omt = 1 - t;
    return omt ** 3 * a + 3 * omt ** 2 * t * b + 3 * omt * t * t * c + t ** 3 * d;
  };

  for (const cmd of cmds) {
    switch (cmd.type) {
      case "M": {
        prevX = startX = cmd.x ?? 0;
        prevY = startY = cmd.y ?? 0;
        pts.push({ x: prevX, y: prevY });
        break;
      }
      case "L": {
        const x = cmd.x ?? 0;
        const y = cmd.y ?? 0;
        pts.push({ x, y });
        prevX = x; prevY = y;
        break;
      }
      case "Q": {
        const cx = cmd.x1 ?? 0, cy = cmd.y1 ?? 0;
        const ex = cmd.x ?? 0, ey = cmd.y ?? 0;
        for (let i = 1; i <= BEZIER_SAMPLES; i++) {
          const t = i / BEZIER_SAMPLES;
          pts.push({ x: qBez(prevX, cx, ex, t), y: qBez(prevY, cy, ey, t) });
        }
        prevX = ex; prevY = ey;
        break;
      }
      case "C": {
        const c1x = cmd.x1 ?? 0, c1y = cmd.y1 ?? 0;
        const c2x = cmd.x2 ?? 0, c2y = cmd.y2 ?? 0;
        const ex = cmd.x ?? 0, ey = cmd.y ?? 0;
        for (let i = 1; i <= BEZIER_SAMPLES; i++) {
          const t = i / BEZIER_SAMPLES;
          pts.push({
            x: cBez(prevX, c1x, c2x, ex, t),
            y: cBez(prevY, c1y, c2y, ey, t),
          });
        }
        prevX = ex; prevY = ey;
        break;
      }
      case "Z":
        if (prevX !== startX || prevY !== startY) pts.push({ x: startX, y: startY });
        prevX = startX; prevY = startY;
        break;
    }
  }
  if (pts.length < 2) return null;

  let yMin = Infinity, yMax = -Infinity;
  for (const p of pts) {
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }
  if (!(yMax > yMin)) return null;

  const left = new Array(EDGE_ROWS).fill(NaN);
  const right = new Array(EDGE_ROWS).fill(NaN);
  const rowSpan = yMax - yMin;
  for (const p of pts) {
    const t = (p.y - yMin) / rowSpan;
    const row = Math.min(EDGE_ROWS - 1, Math.max(0, Math.floor(t * EDGE_ROWS)));
    if (Number.isNaN(left[row]) || p.x < left[row]) left[row] = p.x;
    if (Number.isNaN(right[row]) || p.x > right[row]) right[row] = p.x;
  }
  return { left, right, rowMin: yMin, rowMax: yMax };
}

function rowAt(edge, y) {
  if (y < edge.rowMin || y > edge.rowMax) return -1;
  const span = edge.rowMax - edge.rowMin;
  if (span <= 0) return -1;
  const t = (y - edge.rowMin) / span;
  return Math.min(EDGE_ROWS - 1, Math.max(0, Math.floor(t * EDGE_ROWS)));
}

function computeMinOpticalGap(leftEdge, leftAdvance, rightEdge) {
  const yLo = Math.max(leftEdge.rowMin, rightEdge.rowMin);
  const yHi = Math.min(leftEdge.rowMax, rightEdge.rowMax);
  if (yHi <= yLo) return Number.NaN;
  let minGap = Infinity;
  const STEPS = EDGE_ROWS * 2;
  for (let i = 0; i <= STEPS; i++) {
    const y = yLo + ((yHi - yLo) * i) / STEPS;
    const lRow = rowAt(leftEdge, y);
    const rRow = rowAt(rightEdge, y);
    if (lRow < 0 || rRow < 0) continue;
    const lr = leftEdge.right[lRow];
    const rl = rightEdge.left[rRow];
    if (Number.isNaN(lr) || Number.isNaN(rl)) continue;
    const gap = leftAdvance + rl - lr;
    if (gap < minGap) minGap = gap;
  }
  return minGap === Infinity ? Number.NaN : minGap;
}

function computeOpticalKerning(font) {
  const all = [];
  for (let i = 0; i < font.glyphs.length; i++) all.push(font.glyphs.get(i));

  const profiles = [];
  for (const g of all) {
    if (g.index === 0) continue;
    if (g.unicode === 0x20) continue;
    const edge = buildEdgeProfile(g);
    if (!edge) continue;
    profiles.push({ glyph: g, edge, advanceWidth: g.advanceWidth ?? 600 });
  }

  const allGaps = [];
  for (const a of profiles) {
    for (const b of profiles) {
      if (a.glyph.index === b.glyph.index) continue;
      const minGap = computeMinOpticalGap(a.edge, a.advanceWidth, b.edge);
      if (Number.isNaN(minGap)) continue;
      allGaps.push({ aIdx: a.glyph.index, bIdx: b.glyph.index, gap: minGap });
    }
  }
  if (allGaps.length === 0) return {};

  const sortedGaps = allGaps.map((g) => g.gap).sort((a, b) => a - b);
  const median = sortedGaps[Math.floor(sortedGaps.length / 2)];

  const pairs = {};
  for (const { aIdx, bIdx, gap } of allGaps) {
    const adjust = (median - gap) * DAMP;
    const kern = Math.max(-MAX_KERN_MAGNITUDE, Math.min(MAX_KERN_MAGNITUDE, Math.round(adjust)));
    if (Math.abs(kern) < MIN_KERN_MAGNITUDE) continue;
    pairs[`${aIdx},${bIdx}`] = kern;
  }
  return pairs;
}

// --- Pipeline ------------------------------------------------------------

async function kernOneFont(filename, { apply }) {
  const url = `https://m9rikrlplfcm8hve.public.blob.vercel-storage.com/fonts/${encodeURIComponent(filename)}?cb=${Date.now()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${filename}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  const pairs = computeOpticalKerning(font);
  const pairCount = Object.keys(pairs).length;
  const values = Object.values(pairs);
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  const mean = values.length > 0 ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
  console.log(`  ${filename}: ${pairCount} pairs (range ${min}..${max}, mean ${mean})`);

  if (!apply) return { pairCount };
  if (pairCount === 0) {
    console.log(`    nothing to attach — skipping upload`);
    return { pairCount };
  }

  font.kerningPairs = pairs;
  const bytes = new Uint8Array(font.toArrayBuffer());
  await put(`fonts/${filename}`, bytes, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "font/otf",
  });
  console.log(`    ✓ uploaded (${(bytes.length / 1024).toFixed(1)} KB)`);
  return { pairCount };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  if (!mode || (mode !== "--dry" && mode !== "--apply" && mode !== "--apply-all")) {
    console.error("usage: node scripts/rebuild-kerning.mjs <--dry|--apply|--apply-all> [filename]");
    process.exit(1);
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("BLOB_READ_WRITE_TOKEN not set — run `set -a && source .env.local && set +a` first");
    process.exit(1);
  }

  if (mode === "--apply-all") {
    const { blobs } = await list({ prefix: "fonts/" });
    const fontFiles = blobs.filter((b) => b.pathname.endsWith(".otf")).map((b) => b.pathname.replace("fonts/", ""));
    console.log(`Kerning ${fontFiles.length} fonts (apply mode)...`);
    let updated = 0;
    for (const fn of fontFiles) {
      try {
        const r = await kernOneFont(fn, { apply: true });
        if (r.pairCount > 0) updated++;
      } catch (e) {
        console.warn(`  ${fn}: failed — ${e.message}`);
      }
    }
    console.log(`\ndone — ${updated} of ${fontFiles.length} fonts updated`);
  } else {
    const filename = args[1];
    if (!filename) {
      console.error("filename required for --dry / --apply mode");
      process.exit(1);
    }
    await kernOneFont(filename, { apply: mode === "--apply" });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
