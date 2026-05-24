// One-off migration: fix CFF contour winding in every font already in
// Blob so they render correctly on Android Chrome (and any other
// strict non-zero-rule renderer).
//
// Background: every existing font has every contour winding CW. Under
// the non-zero rule, hole contours then sum with their outer to give
// non-zero winding inside what should be a hole → entire shape fills.
// macOS CoreText and iOS Safari render correctly because they're
// tolerant (effectively use even-odd in many cases). Android FreeType
// is strict → fills. New uploads built by lib/font-pipeline/build-font.ts
// now fix winding at glyph-emission time; this migration applies the
// same fix to historical fonts in Blob.
//
// Idempotent: re-running skips fonts whose glyphs already have proper
// alternating winding (checked via the largest hole-containing glyph).
//
// Usage:
//   node --env-file=.env.local scripts/migrate-font-winding.mjs

import opentypeMod from "opentype.js";
import { list, put, del } from "@vercel/blob";

const opentype = opentypeMod.default ?? opentypeMod;
const PREFIX = "fonts/";

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("Missing BLOB_READ_WRITE_TOKEN. Run `vercel env pull .env.local` first.");
  process.exit(1);
}

/** Shoelace signed area on an array of endpoints. */
function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Reverse a subpath's commands (each cmd object has .type and a
 *  position; cubic curves have .x1,.y1,.x2,.y2,.x,.y; quadratic have
 *  .x1,.y1,.x,.y; line/move have .x,.y; Z has just .type). */
function reverseSubpath(sp) {
  if (sp.length < 2 || sp[0].type !== "M") return sp;
  const hasClose = sp[sp.length - 1].type === "Z";
  const segs = sp.slice(1).filter((c) => c.type !== "Z");
  const endpoints = [[sp[0].x, sp[0].y], ...segs.map((c) => [c.x, c.y])];
  const out = [{ type: "M", x: endpoints[endpoints.length - 1][0], y: endpoints[endpoints.length - 1][1] }];
  for (let k = segs.length - 1; k >= 0; k--) {
    const orig = segs[k];
    const [tx, ty] = endpoints[k];
    if (orig.type === "L") {
      out.push({ type: "L", x: tx, y: ty });
    } else if (orig.type === "C") {
      out.push({ type: "C", x1: orig.x2, y1: orig.y2, x2: orig.x1, y2: orig.y1, x: tx, y: ty });
    } else if (orig.type === "Q") {
      out.push({ type: "Q", x1: orig.x1, y1: orig.y1, x: tx, y: ty });
    }
  }
  if (hasClose) out.push({ type: "Z" });
  return out;
}

/** Group a glyph's commands into subpaths and fix winding so inner
 *  contours wind OPPOSITE to outer. Returns the new command list. */
function fixGlyphWinding(commands) {
  const subpaths = [];
  let current = [];
  for (const c of commands) {
    if (c.type === "M" && current.length > 0) {
      subpaths.push(current);
      current = [];
    }
    current.push(c);
  }
  if (current.length > 0) subpaths.push(current);
  if (subpaths.length <= 1) return commands;

  const areas = subpaths.map((sp) => {
    const pts = sp.filter((c) => c.type !== "Z").map((c) => [c.x, c.y]);
    return signedArea(pts);
  });
  let outerIdx = 0;
  for (let i = 1; i < areas.length; i++) {
    if (Math.abs(areas[i]) > Math.abs(areas[outerIdx])) outerIdx = i;
  }
  const outerSign = Math.sign(areas[outerIdx]);

  const fixed = subpaths.map((sp, i) => {
    if (i === outerIdx) return sp;
    if (Math.sign(areas[i]) === outerSign) return reverseSubpath(sp);
    return sp;
  });
  return fixed.flat();
}

function withRandomSuffix(filename) {
  const ext = filename.match(/\.[^.]+$/)?.[0] ?? ".otf";
  const base = filename.slice(0, filename.length - ext.length).replace(/__[a-z0-9]{6}$/i, "");
  const rand = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  return `${base}__${rand}${ext}`;
}

const { blobs } = await list({ prefix: PREFIX });
const fonts = blobs.filter((b) => /\.(otf|ttf|woff|woff2)$/i.test(b.pathname));
console.log(`Found ${fonts.length} fonts in ${PREFIX}\n`);

let migrated = 0, skipped = 0, failed = 0;

for (const b of fonts) {
  const oldName = b.pathname.replace(PREFIX, "");
  process.stdout.write(`  ${oldName}\n    `);

  try {
    const r = await fetch(b.url);
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());

    const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));

    // Quick check: does the largest hole-containing glyph already have
    // proper alternating winding? If yes, skip (already migrated or
    // built post-fix).
    let needsFix = false;
    for (const ch of ["ი", "ბ", "ხ", "ე", "ო", "დ", "ფ"]) {
      const idx = font.charToGlyphIndex(ch);
      if (idx <= 0) continue;
      const g = font.glyphs.get(idx);
      const path = g.getPath(0, 0, 1000);
      const subs = [];
      let cur = [];
      for (const c of path.commands) {
        if (c.type === "M" && cur.length) {
          subs.push(cur);
          cur = [];
        }
        cur.push(c);
      }
      if (cur.length) subs.push(cur);
      if (subs.length < 2) continue;
      const areas = subs.map((sp) => signedArea(sp.filter((c) => c.type !== "Z").map((c) => [c.x, c.y])));
      let outerIdx = 0;
      for (let i = 1; i < areas.length; i++) if (Math.abs(areas[i]) > Math.abs(areas[outerIdx])) outerIdx = i;
      const outerSign = Math.sign(areas[outerIdx]);
      const allCorrect = areas.every((a, i) => i === outerIdx || Math.sign(a) !== outerSign);
      if (!allCorrect) {
        needsFix = true;
        break;
      }
    }
    if (!needsFix) {
      console.log("SKIP (winding already correct)");
      skipped++;
      continue;
    }

    // Fix winding on every glyph. CRITICAL: read glyph.path directly
    // — NOT glyph.getPath(). getPath() applies a -y flip to convert
    // font's y-up coords to CSS y-down for display; assigning that
    // result back to glyph.path stores it as y-up again (no
    // un-flip), which double-flips and makes the font render
    // upside-down. This was the original bug in this migration's
    // first run; see scripts/rescue-font-flip.mjs for the recovery.
    let glyphsFixed = 0;
    for (let i = 0; i < font.glyphs.length; i++) {
      const g = font.glyphs.get(i);
      const path = g.path;
      if (!path?.commands?.length) continue;
      const fixed = fixGlyphWinding(path.commands);
      const newPath = new opentype.Path();
      newPath.commands = fixed;
      g.path = newPath;
      delete g._path;
      glyphsFixed++;
    }

    const newBytes = new Uint8Array(font.toArrayBuffer());
    const newName = withRandomSuffix(oldName);
    const newExt = newName.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? ".otf";
    const contentType =
      newExt === ".otf" ? "font/otf" :
      newExt === ".ttf" ? "font/ttf" :
      newExt === ".woff" ? "font/woff" :
      newExt === ".woff2" ? "font/woff2" : "application/octet-stream";

    await put(`${PREFIX}${newName}`, Buffer.from(newBytes), {
      access: "public",
      addRandomSuffix: false,
      contentType,
    });
    await del(b.url);
    console.log(`OK  ${oldName} → ${newName}  (${glyphsFixed} glyphs touched)`);
    migrated++;
  } catch (e) {
    console.log(`FAIL — ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

console.log(`\nDone. migrated=${migrated} skipped=${skipped} failed=${failed}`);
