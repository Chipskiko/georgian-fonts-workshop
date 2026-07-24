// Definitive near-duplicate check: rasterize each glyph and compare
// pixel overlap (IoU). This distinguishes "same actual drawing" from
// "similar bounding-box proportions" — the coarse feature check can't.
//
// Per glyph: flatten the outline to polygons, normalize into an NxN
// bitmap (fit the ink bbox, aspect-preserving, centered), scanline-fill.
// For each font pair sharing enough codepoints, mean IoU over shared
// glyphs. IoU near 1.0 = the same hand-drawn sheet; low IoU = different
// artwork that merely shared a bbox aspect.
//
// Read-only. Prints pairs ranked by mean IoU.
import opentype from "opentype.js";
import { list } from "@vercel/blob";

const N = 32; // raster resolution
const { blobs } = await list({ prefix: "fonts/" });
const fonts = blobs
  .filter((b) => /\.(otf|ttf)$/i.test(b.pathname))
  .map((b) => ({ filename: b.pathname.replace("fonts/", ""), url: b.url }));

/** Flatten an opentype Path to an array of subpaths (each [x,y][]). */
function toPolys(path) {
  const polys = [];
  let cur = [];
  let px = 0;
  let py = 0;
  const steps = 8;
  for (const c of path.commands) {
    if (c.type === "M") {
      if (cur.length) polys.push(cur);
      cur = [[c.x, c.y]];
      px = c.x;
      py = c.y;
    } else if (c.type === "L") {
      cur.push([c.x, c.y]);
      px = c.x;
      py = c.y;
    } else if (c.type === "C") {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        const x = mt*mt*mt*px + 3*mt*mt*t*c.x1 + 3*mt*t*t*c.x2 + t*t*t*c.x;
        const y = mt*mt*mt*py + 3*mt*mt*t*c.y1 + 3*mt*t*t*c.y2 + t*t*t*c.y;
        cur.push([x, y]);
      }
      px = c.x;
      py = c.y;
    } else if (c.type === "Q") {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        const x = mt*mt*px + 2*mt*t*c.x1 + t*t*c.x;
        const y = mt*mt*py + 2*mt*t*c.y1 + t*t*c.y;
        cur.push([x, y]);
      }
      px = c.x;
      py = c.y;
    } else if (c.type === "Z") {
      if (cur.length) polys.push(cur);
      cur = [];
    }
  }
  if (cur.length) polys.push(cur);
  return polys;
}

/** Rasterize glyph outline into an NxN Uint8Array (1 = ink). Normalizes
 *  to the ink bbox, aspect-preserving, centered — so position/size from
 *  scanning don't matter, only shape. */
function raster(glyph) {
  let path;
  try {
    path = glyph.getPath(0, 0, 1000);
  } catch {
    return null;
  }
  const b = path.getBoundingBox();
  const w = b.x2 - b.x1;
  const h = b.y2 - b.y1;
  if (!(w > 0) || !(h > 0)) return null;
  const polys = toPolys(path);
  if (!polys.length) return null;
  const scale = (N - 2) / Math.max(w, h);
  const ox = (N - w * scale) / 2;
  const oy = (N - h * scale) / 2;
  // Transform to raster space (flip Y: font y-up -> raster y-down).
  const tp = polys.map((poly) =>
    poly.map(([x, y]) => [ox + (x - b.x1) * scale, N - (oy + (y - b.y1) * scale)]),
  );
  const grid = new Uint8Array(N * N);
  // Scanline even-odd fill at pixel-center rows.
  for (let row = 0; row < N; row++) {
    const yc = row + 0.5;
    const xs = [];
    for (const poly of tp) {
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[(i + 1) % poly.length];
        if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
          xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
    }
    xs.sort((a, b2) => a - b2);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(N - 1, Math.floor(xs[k + 1] - 0.5));
      for (let col = xa; col <= xb; col++) grid[row * N + col] = 1;
    }
  }
  return grid;
}

function iou(a, b) {
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] | b[i];
    if (x) uni++;
    if (a[i] & b[i]) inter++;
  }
  return uni ? inter / uni : 0;
}

const data = [];
for (const f of fonts) {
  try {
    const ab = await (await fetch(`${f.url}?cb=${Date.now()}`)).arrayBuffer();
    const font = opentype.parse(ab);
    const cmap = font.tables.cmap;
    if (!cmap?.glyphIndexMap) continue;
    const glyphs = new Map();
    for (const [cpStr, gi] of Object.entries(cmap.glyphIndexMap)) {
      const g = font.glyphs.get(gi);
      if (!g) continue;
      const r = raster(g);
      if (r) glyphs.set(Number(cpStr), r);
    }
    if (glyphs.size) data.push({ filename: f.filename, glyphs });
  } catch (e) {
    console.warn(`  ${f.filename}: ${e.message}`);
  }
}

const pairs = [];
for (let i = 0; i < data.length; i++) {
  for (let j = i + 1; j < data.length; j++) {
    const A = data[i];
    const B = data[j];
    let n = 0;
    let sum = 0;
    for (const [cp, ga] of A.glyphs) {
      const gb = B.glyphs.get(cp);
      if (!gb) continue;
      n++;
      sum += iou(ga, gb);
    }
    if (n >= 15) {
      const mean = sum / n;
      if (mean > 0.55) pairs.push({ a: A.filename, b: B.filename, mean, n });
    }
  }
}
pairs.sort((x, y) => y.mean - x.mean);

console.log(`${data.length} fonts rasterized @ ${N}px, ${pairs.length} pair(s) with mean IoU > 0.55\n`);
for (const p of pairs) {
  const tag = p.mean > 0.85 ? "  ★ SAME DRAWING" : p.mean > 0.7 ? "  ~ likely same" : "";
  console.log(`  IoU ${p.mean.toFixed(3)}  (${p.n} shared glyphs)${tag}`);
  console.log(`        ${p.a}`);
  console.log(`        ${p.b}`);
}
if (!pairs.length) console.log("  No overlapping artwork — every font is a distinct drawing.");
