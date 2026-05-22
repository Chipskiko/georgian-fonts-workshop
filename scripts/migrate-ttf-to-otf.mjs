// One-off migration: rename every .ttf in Vercel Blob's fonts/ prefix to .otf
// with the correct Content-Type (font/otf).
//
// Context: opentype.js produces CFF-outline fonts (magic "OTTO" = OpenType),
// but the upload pipeline was saving them as .ttf with Content-Type font/ttf
// and CSS format hint "truetype". On Vercel Blob (cross-origin + nosniff),
// browsers strictly enforce format hints, so the mismatch caused every
// scan-pipeline font to silently fail to render via @font-face — even though
// direct downloads worked, because OS font handlers read the magic bytes.
//
// The code is now fixed for new uploads (save as .otf, MIME font/otf,
// CSS format "opentype"). This script fixes the historical blobs.
//
// Usage:
//   1. Ensure BLOB_READ_WRITE_TOKEN is in .env.local (run `vercel env pull`).
//   2. node --env-file=.env.local scripts/migrate-ttf-to-otf.mjs
//   3. Re-deploy or wait for next request — layout has force-dynamic, so the
//      next page load will pick up the new .otf URLs automatically.

import { list, put, del } from "@vercel/blob";

const BLOB_PREFIX = "fonts/";

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("Missing BLOB_READ_WRITE_TOKEN. Run `vercel env pull` first.");
  process.exit(1);
}

const { blobs } = await list({ prefix: BLOB_PREFIX });
const ttfBlobs = blobs.filter((b) => b.pathname.toLowerCase().endsWith(".ttf"));

console.log(`Found ${blobs.length} blobs in ${BLOB_PREFIX} (${ttfBlobs.length} .ttf to migrate)`);
if (ttfBlobs.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

let migrated = 0;
let skipped = 0;
let failed = 0;

for (const b of ttfBlobs) {
  const oldName = b.pathname;
  const newName = oldName.replace(/\.ttf$/i, ".otf");
  process.stdout.write(`  ${oldName}\n    → ${newName} ... `);

  try {
    // Download
    const r = await fetch(b.url);
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());

    // Verify magic is OTTO (CFF/OpenType). If it's an actual TTF (magic
    // 00010000) we'd corrupt the format hint by renaming — skip it.
    const magic = buf.slice(0, 4);
    const isOtto =
      magic[0] === 0x4f && magic[1] === 0x54 && magic[2] === 0x54 && magic[3] === 0x4f;
    if (!isOtto) {
      const hex = Array.from(magic)
        .map((x) => x.toString(16).padStart(2, "0"))
        .join(" ");
      console.log(`SKIP (magic ${hex}, not OTTO)`);
      skipped++;
      continue;
    }

    // Upload to new path with correct Content-Type
    await put(newName, buf, {
      access: "public",
      addRandomSuffix: false,
      contentType: "font/otf",
    });

    // Delete the old .ttf blob (by URL)
    await del(b.url);

    console.log("OK");
    migrated++;
  } catch (e) {
    console.log(`FAIL — ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

console.log(`\nDone. migrated=${migrated} skipped=${skipped} failed=${failed}`);
