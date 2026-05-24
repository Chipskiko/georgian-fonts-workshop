// One-off rescue: undo the Y-flip introduced by the previous migration
// (scripts/migrate-font-winding.mjs first version), AND re-apply
// correct CFF contour winding in proper font-coord space.
//
// What went wrong:
//   The first winding-fix migration read glyph paths via
//   `glyph.getPath(0, 0, fontUnitsPerEm)`, which RETURNS DISPLAY
//   COORDS (y-down) — opentype.js applies a -y flip during getPath()
//   to convert from font's y-up to CSS y-down. The script then
//   assigned the modified Path back to glyph.path, which opentype.js
//   STORES AS FONT COORDS (y-up) without re-flipping. Net result:
//   every glyph's y-coords got negated → glyphs render upside-down
//   on any renderer that strictly respects the font's stored coords
//   (Android Chrome / FreeType). macOS/iOS Safari also showed them
//   upside-down (this isn't a fill-rule issue, it's a literal Y-flip).
//
// This script:
//   1. Reads each glyph's path via glyph.path (NOT getPath) so we
//      stay in font coords throughout.
//   2. Computes the y-range of glyph extents across the font's letters.
//      A correctly-stored font has max-y near ascender (750) and
//      min-y near descender (-250). A flipped font has max-y near
//      |descender| (250) and min-y near -ascender (-750).
//   3. If detected as flipped: negate Y for every point in every
//      glyph. This restores the original orientation.
//   4. After unflipping, group each glyph's contours into subpaths,
//      compute signed area, ensure outer + inner have opposite
//      winding (matches the in-font build-font.ts fix).
//   5. Re-encode and upload under a new random filename suffix.
//
// Idempotent: re-running on a corrected font checks the y-range first
// and skips the un-flip if not needed.
//
// Usage:
//   node --env-file=.env.local scripts/rescue-font-flip.mjs

import opentypeMod from "opentype.js";
import { list, put, del } from "@vercel/blob";

const opentype = opentypeMod.default ?? opentypeMod;
const PREFIX = "fonts/";

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("Missing BLOB_READ_WRITE_TOKEN. Run `vercel env pull .env.local` first.");
  process.exit(1);
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function reverseSubpath(sp) {
  if (sp.length < 2 || sp[0].type !== "M") return sp;
  const hasClose = sp[sp.length - 1].type === "Z";
  const segs = sp.slice(1).filter((c) => c.type !== "Z");
  const endpoints = [[sp[0].x, sp[0].y], ...segs.map((c) => [c.x, c.y])];
  const out = [{ type: "M", x: endpoints[endpoints.length - 1][0], y: endpoints[endpoints.length - 1][1] }];
  for (let k = segs.length - 1; k >= 0; k--) {
    const orig = segs[k];
    const [tx, ty] = endpoints[k];
    if (orig.type === "L") out.push({ type: "L", x: tx, y: ty });
    else if (orig.type === "C")
      out.push({ type: "C", x1: orig.x2, y1: orig.y2, x2: orig.x1, y2: orig.y1, x: tx, y: ty });
    else if (orig.type === "Q") out.push({ type: "Q", x1: orig.x1, y1: orig.y1, x: tx, y: ty });
  }
  if (hasClose) out.push({ type: "Z" });
  return out;
}

function fixWinding(commands) {
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
  const areas = subpaths.map((sp) =>
    signedArea(sp.filter((c) => c.type !== "Z").map((c) => [c.x, c.y])),
  );
  let outerIdx = 0;
  for (let i = 1; i < areas.length; i++)
    if (Math.abs(areas[i]) > Math.abs(areas[outerIdx])) outerIdx = i;
  const outerSign = Math.sign(areas[outerIdx]);
  return subpaths
    .map((sp, i) => {
      if (i === outerIdx) return sp;
      if (Math.sign(areas[i]) === outerSign) return reverseSubpath(sp);
      return sp;
    })
    .flat();
}

/** Negate y on every point in every command — undoes the Y-flip. */
function negateY(commands) {
  return commands.map((c) => {
    if (c.type === "Z") return c;
    const out = { ...c };
    if ("y" in out) out.y = -out.y;
    if ("y1" in out) out.y1 = -out.y1;
    if ("y2" in out) out.y2 = -out.y2;
    return out;
  });
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
    const buf = Buffer.from(await r.arrayBuffer());
    const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));

    // Heuristic: sample several alphabet glyphs, compute their max y
    // across all command endpoints. If max-y < ascender/2, the font
    // is upside-down (real letters' tops should be near ascender).
    const sampleChars = ["ა", "ე", "ი", "ო", "ბ", "ხ"];
    let maxY = -Infinity, minY = Infinity;
    let sampleCount = 0;
    for (const ch of sampleChars) {
      const idx = font.charToGlyphIndex(ch);
      if (idx <= 0) continue;
      const g = font.glyphs.get(idx);
      // IMPORTANT: read .path directly, NOT getPath() — stays in
      // font coords (y-up).
      const cmds = g.path?.commands ?? [];
      for (const c of cmds) {
        if (c.type === "Z") continue;
        if (typeof c.y === "number") {
          if (c.y > maxY) maxY = c.y;
          if (c.y < minY) minY = c.y;
        }
      }
      sampleCount++;
    }
    if (sampleCount === 0) {
      console.log("SKIP (no sample glyphs found)");
      skipped++;
      continue;
    }
    const upsideDown = maxY < font.ascender / 2;
    console.log(
      `glyph y-range ≈ [${minY}, ${maxY}]  ascender=${font.ascender} → ${upsideDown ? "UPSIDE-DOWN, will unflip" : "upright"}`,
    );

    // Process every glyph: unflip if needed, then fix winding.
    let glyphsTouched = 0;
    for (let i = 0; i < font.glyphs.length; i++) {
      const g = font.glyphs.get(i);
      const path = g.path;
      if (!path?.commands?.length) continue;
      let cmds = path.commands;
      if (upsideDown) cmds = negateY(cmds);
      cmds = fixWinding(cmds);
      // Mutate in place — opentype.js Glyph reads .path.commands on
      // toArrayBuffer to re-encode.
      const newPath = new opentype.Path();
      newPath.commands = cmds;
      g.path = newPath;
      delete g._path; // drop any cached representation
      glyphsTouched++;
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
    console.log(`    OK  ${oldName} → ${newName}  (${glyphsTouched} glyphs)`);
    migrated++;
  } catch (e) {
    console.log(`FAIL — ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

console.log(`\nDone. migrated=${migrated} skipped=${skipped} failed=${failed}`);
