// One-shot: regenerate every existing poster's _bnw partner with
// the new color-aware B&W algorithm. The cascade saveAndReset
// stores the user-picked bg/fg only as the rendered color JPEG
// itself (not as metadata), so this script can't use the per-pixel
// distance approach — instead it mirrors the gallery's legacy
// fallback: detect mean luminance, pick threshold direction.
//
// Usage:
//   BLOB_READ_WRITE_TOKEN=… node scripts/regen-bnw.mjs
//
// Reads every posters/poster_*.jpg/png (skipping existing _thumb /
// _bnw sidecars), runs the binarization on the color image, writes
// back as posters/poster_X_bnw.jpg with allowOverwrite so existing
// bnw partners get replaced in place.

import { list, put } from "@vercel/blob";
import sharp from "sharp";

function isImage(name) {
  return /\.(png|jpe?g)$/i.test(name);
}
function isSidecar(name) {
  return /_thumb\.(jpe?g|png)$/i.test(name) || /_bnw\.(jpe?g|png)$/i.test(name);
}
function fullToBnwName(full) {
  return full.replace(/(\.[^.]+)$/, "_bnw$1");
}

async function binarize(srcUrl) {
  // Fetch the color image, decode to raw RGB via sharp, then walk
  // pixels. Mean-luminance direction detection mirrors Gallery.tsx's
  // legacy fallback so the output matches what the live gallery
  // would produce on the fly.
  const res = await fetch(srcUrl);
  const buf = Buffer.from(await res.arrayBuffer());
  const { data, info } = await sharp(buf)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixelCount = info.width * info.height;

  // Single pass to compute mean luminance.
  let lumaSum = 0;
  for (let i = 0; i < data.length; i += 3) {
    lumaSum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  const meanLuma = lumaSum / pixelCount;
  const darkBg = meanLuma < 128;

  // Second pass: threshold with auto-detected direction so bg → white
  // and ink → black regardless of which is lighter.
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 3) {
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    const bw = darkBg ? (y > 160 ? 0 : 255) : (y < 160 ? 0 : 255);
    out[i] = bw;
    out[i + 1] = bw;
    out[i + 2] = bw;
  }

  // Re-encode as JPEG quality 92 — same as cascade's save-time bnw.
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("BLOB_READ_WRITE_TOKEN not set");
    process.exit(1);
  }
  console.log("[1/2] listing posters");
  const { blobs } = await list({ prefix: "posters/" });
  const fullPosters = blobs.filter(
    (b) => isImage(b.pathname) && !isSidecar(b.pathname.replace("posters/", "")),
  );
  console.log(`      found ${fullPosters.length} full posters`);

  console.log("[2/2] regenerating bnw partners (sequential to be Blob-rate-friendly)");
  let ok = 0;
  let fail = 0;
  for (const p of fullPosters) {
    const filename = p.pathname.replace("posters/", "");
    const bnwName = fullToBnwName(filename);
    try {
      const bnwBytes = await binarize(p.url);
      const result = await put(`posters/${bnwName}`, bnwBytes, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "image/jpeg",
      });
      ok++;
      console.log(`      ✓ ${bnwName} (${(bnwBytes.length / 1024).toFixed(0)} KB)`);
    } catch (e) {
      fail++;
      console.warn(`      ✗ ${bnwName}: ${e.message}`);
    }
  }
  console.log("");
  console.log(`done — ${ok} regenerated, ${fail} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
