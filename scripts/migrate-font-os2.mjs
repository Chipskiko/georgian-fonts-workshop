// One-off migration: re-patch every existing font in Vercel Blob
// with the cross-platform-friendly OS/2 + Mac name table fields.
//
// Background: fonts created before today's build-font.ts changes have:
//   - Mac name table missing fontFamily (Georgian-named fonts)
//   - OR Mac name table colliding with other fonts (same fallback name)
//   - OS/2 usWeightClass=500 (Medium) instead of 400 (Regular)
//   - OS/2 fsSelection missing USE_TYPO_METRICS bit
//   - OS/2 achVendID="XXXX" placeholder
//
// Result: Safari + Chrome on Mac/iOS and Android Chrome all reject or
// silently mis-render these fonts. New uploads via /add get the right
// fields, but historical fonts in Blob need an in-place fix to render
// on participants' devices without re-making them through the scan
// pipeline.
//
// Approach: download each font → parse with opentype.js → patch
// tables.os2.{usWeightClass,fsSelection,achVendID} + names.macintosh
// → re-encode → upload under a NEW random suffix → delete old file.
// New random suffix forces a fresh URL so any browser holding a
// cached rejection of the old font won't re-use it.
//
// Panose stays [0,0,0,...] because opentype.js's OS/2 writer rebuilds
// from constructor options (not from parsed values) so the
// modification doesn't survive a round-trip. Panose is a soft hint
// only — the Mac name table fix is what unblocks rendering.
//
// Usage:
//   node --env-file=.env.local scripts/migrate-font-os2.mjs
//
// Idempotent: only migrates fonts whose OS/2.achVendID !== "WKSH"
// (the marker we set during patching), so re-running skips already-
// migrated fonts.

import opentypeMod from "opentype.js";
import { list, put, del } from "@vercel/blob";

const opentype = opentypeMod.default ?? opentypeMod;
const PREFIX = "fonts/";
const MIGRATED_MARKER = "WKSH";

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("Missing BLOB_READ_WRITE_TOKEN. Run `vercel env pull .env.local` first.");
  process.exit(1);
}

const { blobs } = await list({ prefix: PREFIX });
const fonts = blobs.filter((b) => /\.(otf|ttf|woff|woff2)$/i.test(b.pathname));
console.log(`Found ${fonts.length} font blobs in ${PREFIX}\n`);

let migrated = 0;
let skipped = 0;
let failed = 0;

function withRandomSuffix(filename) {
  const ext = filename.match(/\.[^.]+$/)?.[0] ?? ".otf";
  const base = filename.slice(0, filename.length - ext.length).replace(/__[a-z0-9]{6}$/i, "");
  const rand = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  return `${base}__${rand}${ext}`;
}

function stripToAscii(s) {
  return s
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\w-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

for (const b of fonts) {
  const oldName = b.pathname.replace(PREFIX, "");
  process.stdout.write(`  ${oldName}\n    `);

  try {
    const r = await fetch(b.url);
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());

    const font = opentype.parse(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
    );

    // Skip if already migrated (idempotent re-run safety).
    if (font.tables.os2?.achVendID === MIGRATED_MARKER) {
      console.log("SKIP (already WKSH)");
      skipped++;
      continue;
    }

    // Source the family name from name.windows or name.unicode (Georgian
    // names live there; Mac may be missing). Fall back to a short tag
    // from the filename.
    const familyName =
      font.names?.windows?.fontFamily?.en ??
      font.names?.unicode?.fontFamily?.en ??
      stripToAscii(oldName.replace(/__[a-z0-9]{6}\.[^.]+$/i, "")) ??
      "GeorgianWorkshopFont";

    // OS/2 patches (3 of 4 — panose won't survive round-trip, skipped).
    if (font.tables.os2) {
      font.tables.os2.usWeightClass = 400;
      font.tables.os2.fsSelection = 0x40 | 0x80;
      font.tables.os2.achVendID = MIGRATED_MARKER;
    }

    // Mac name table: ASCII fallback + unique random tag (matches the
    // logic in lib/font-pipeline/build-font.ts).
    const asciiBase = stripToAscii(familyName) || "GeorgianWorkshopFont";
    const macUnique = Math.random().toString(36).slice(2, 8).padStart(6, "0");
    const macFamily = `${asciiBase}-${macUnique}`;
    font.names.macintosh = font.names.macintosh ?? {};
    font.names.macintosh.fontFamily = { en: macFamily };
    font.names.macintosh.fullName = { en: `${macFamily} Regular` };
    font.names.macintosh.postScriptName = { en: `${macFamily}-Regular` };
    font.names.macintosh.uniqueID = { en: `: ${macFamily} Regular` };

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

    console.log(`OK  ${oldName} → ${newName}`);
    migrated++;
  } catch (e) {
    console.log(`FAIL — ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

console.log(`\nDone. migrated=${migrated} skipped=${skipped} failed=${failed}`);
