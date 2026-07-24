// Near-duplicate detector: catches the same hand-drawn sheet uploaded
// twice, which produces SIMILAR (not identical) outlines — different
// photo, slight rotation, trace noise — so the exact-hash check misses
// it. For each font we build a per-codepoint shape vector and score
// every pair by how closely their shared glyphs match.
//
// Per glyph feature (at em=1000, origin-independent): normalized ink
// bbox aspect ratio + relative ink area + vertical position. These
// survive re-scanning far better than absolute path data. Two fonts
// that share most codepoints AND whose shared glyphs nearly all match
// are almost certainly the same drawing.
//
// Read-only. Prints the most-similar pairs, ranked.
import opentype from "opentype.js";
import { list } from "@vercel/blob";

const { blobs } = await list({ prefix: "fonts/" });
const fonts = blobs
  .filter((b) => /\.(otf|ttf)$/i.test(b.pathname))
  .map((b) => ({ filename: b.pathname.replace("fonts/", ""), url: b.url }));

const EM = 1000;
/** Map codepoint -> [aspect, areaFrac, yMid] for each mapped glyph. */
function features(font) {
  const cmap = font.tables.cmap;
  if (!cmap?.glyphIndexMap) return null;
  const m = new Map();
  for (const [cpStr, gi] of Object.entries(cmap.glyphIndexMap)) {
    const cp = Number(cpStr);
    const glyph = font.glyphs.get(gi);
    if (!glyph) continue;
    let p;
    try {
      p = glyph.getPath(0, 0, EM);
    } catch {
      continue;
    }
    const b = p.getBoundingBox();
    const w = b.x2 - b.x1;
    const h = b.y2 - b.y1;
    if (!(w > 0) || !(h > 0)) continue;
    const aspect = w / h; // shape proportion
    const areaFrac = (w * h) / (EM * EM); // relative size in the em
    const yMid = (b.y1 + b.y2) / 2 / EM; // vertical placement
    m.set(cp, [aspect, areaFrac, yMid]);
  }
  return m;
}

const feats = [];
for (const f of fonts) {
  try {
    const ab = await (await fetch(`${f.url}?cb=${Date.now()}`)).arrayBuffer();
    const font = opentype.parse(ab);
    const m = features(font);
    if (m && m.size) feats.push({ filename: f.filename, m });
  } catch (e) {
    console.warn(`  ${f.filename}: ${e.message}`);
  }
}

/** Similarity in [0,1]: over codepoints both fonts map, the fraction
 *  whose feature vectors are within tolerance, weighted by coverage. */
function similarity(a, b) {
  let shared = 0;
  let close = 0;
  for (const [cp, va] of a.m) {
    const vb = b.m.get(cp);
    if (!vb) continue;
    shared++;
    const dAspect = Math.abs(va[0] - vb[0]) / Math.max(va[0], vb[0]);
    const dArea = Math.abs(va[1] - vb[1]) / Math.max(va[1], vb[1], 0.001);
    const dY = Math.abs(va[2] - vb[2]);
    if (dAspect < 0.15 && dArea < 0.25 && dY < 0.08) close++;
  }
  if (shared < 10) return { score: 0, shared, close };
  const coverage = shared / Math.max(a.m.size, b.m.size);
  return { score: (close / shared) * coverage, shared, close };
}

const pairs = [];
for (let i = 0; i < feats.length; i++) {
  for (let j = i + 1; j < feats.length; j++) {
    const s = similarity(feats[i], feats[j]);
    if (s.score > 0.5)
      pairs.push({ a: feats[i].filename, b: feats[j].filename, ...s });
  }
}
pairs.sort((x, y) => y.score - x.score);

console.log(`${feats.length} fonts compared, ${pairs.length} pair(s) above 0.5 similarity\n`);
for (const p of pairs.slice(0, 15)) {
  console.log(`  ${p.score.toFixed(2)}  (${p.close}/${p.shared} glyphs match)`);
  console.log(`        ${p.a}`);
  console.log(`        ${p.b}`);
}
if (!pairs.length) console.log("  No suspicious pairs — all artwork is distinct.");
