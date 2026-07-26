// Repair sfnt checksums on every stored font.
//
// opentype.js wrote some table checksums as negative/garbage values (its
// computeCheckSum uses a SIGNED `<< 24`), which browsers and macOS ignore
// but Windows Font Viewer validates — it refuses the install with
// "The requested file ... is not a valid font file."
//
// This ONLY rewrites checksum fields + head.checkSumAdjustment; glyphs,
// names and every other byte are untouched.
//
//   --dry (default)  report which fonts are corrupt
//   --apply          fix and re-upload the corrupt ones in place
//
// Requires BLOB_READ_WRITE_TOKEN (set -a && source .env.local && set +a).
import { list, put } from "@vercel/blob";

const PREFIX = "fonts/";
const apply = process.argv.includes("--apply");

function sum(view, offset, length) {
  let s = 0;
  for (let i = 0; i < Math.ceil(length / 4); i++) {
    let w = 0;
    for (let b = 0; b < 4; b++) {
      const p = offset + i * 4 + b;
      w = ((w << 8) | (p < offset + length ? view.getUint8(p) : 0)) >>> 0;
    }
    s = (s + w) >>> 0;
  }
  return s >>> 0;
}

/** Mirror of lib/font-pipeline/fix-checksums.ts (kept in sync). */
function fixSfntChecksums(input) {
  if (input.byteLength < 12) return { bytes: input, changed: false };
  const bytes = new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = view.getUint16(4);
  if (numTables === 0 || 12 + numTables * 16 > bytes.byteLength) return { bytes: input, changed: false };

  const recs = [];
  let headOff = -1;
  for (let i = 0; i < numTables; i++) {
    const recOff = 12 + i * 16;
    const tag = String.fromCharCode(
      view.getUint8(recOff), view.getUint8(recOff+1), view.getUint8(recOff+2), view.getUint8(recOff+3));
    const off = view.getUint32(recOff + 8);
    const len = view.getUint32(recOff + 12);
    if (off + len > bytes.byteLength) return { bytes: input, changed: false };
    if (tag === "head") headOff = off;
    recs.push({ recOff, off, len });
  }
  const before = Buffer.from(bytes);
  if (headOff >= 0) view.setUint32(headOff + 8, 0);
  for (const r of recs) view.setUint32(r.recOff + 4, sum(view, r.off, r.len));
  if (headOff >= 0) view.setUint32(headOff + 8, (0xb1b0afba - sum(view, 0, bytes.byteLength)) >>> 0);
  return { bytes, changed: !before.equals(Buffer.from(bytes)) };
}

const { blobs } = await list({ prefix: PREFIX });
const fonts = blobs.filter((b) => /\.(otf|ttf)$/i.test(b.pathname));
console.log(`${fonts.length} fonts\n`);

let corrupt = 0, fixed = 0;
for (const b of fonts) {
  const name = b.pathname.replace(PREFIX, "");
  const ab = await (await fetch(`${b.url}?cb=${Date.now()}`)).arrayBuffer();
  const { bytes, changed } = fixSfntChecksums(new Uint8Array(ab));
  if (!changed) continue;
  corrupt++;
  console.log(`  CORRUPT  ${name}`);
  if (apply) {
    await put(b.pathname, Buffer.from(bytes), {
      access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "font/otf",
    });
    fixed++;
    console.log(`           ✓ repaired + re-uploaded`);
  }
}
console.log(`\n${corrupt}/${fonts.length} fonts had bad checksums${apply ? `; ${fixed} repaired` : " (dry run — re-run with --apply)"}`);
