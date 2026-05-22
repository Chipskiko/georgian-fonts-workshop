// Generate PWA icons + favicon from a single source PNG.
//
// Source: public/logo-source.png (the yellow-blob mascot with face).
// Outputs:
//   public/icon-512.png       — PWA manifest
//   public/icon-192.png       — PWA manifest (Android home screen)
//   public/apple-touch-icon.png — iOS Safari Add-to-Home-Screen (180x180)
//   app/favicon.ico           — browser tab favicon (multi-size: 16, 32, 48)
//
// The source PNG has a transparent background. To match the site's two-
// color theme, we composite onto a fluo-pink (#ff10b8) square — that
// way the icons read the same in dark/light system themes and don't
// have anti-aliased rough edges around the blob shape.

import sharp from "sharp";
import path from "node:path";
import fs from "node:fs";
import pngToIco from "png-to-ico";

const ROOT = path.resolve("/Users/test/risocam/georgian-fonts-workshop");
const PUBLIC = path.join(ROOT, "public");
const APP = path.join(ROOT, "app");
const SOURCE = path.join(PUBLIC, "logo-source.png");

if (!fs.existsSync(SOURCE)) {
  console.error(`Source logo not found at ${SOURCE}`);
  console.error(
    `Copy your logo PNG there first, e.g.\n  cp /path/to/logo.png ${SOURCE}`,
  );
  process.exit(1);
}

const PINK = { r: 0xff, g: 0x10, b: 0xb8, alpha: 1 };

/** Resize the source to a square `size`×`size` PNG with pink padding.
 *  Logo is fit inside ~85% of the canvas so it doesn't crowd the edges. */
async function makeIcon(size) {
  const inner = Math.round(size * 0.85);
  const innerImg = await sharp(SOURCE)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  return await sharp({
    create: { width: size, height: size, channels: 4, background: PINK },
  })
    .composite([{ input: innerImg, gravity: "center" }])
    .png()
    .toBuffer();
}

const sizes = [
  { name: "icon-512.png", size: 512, dir: PUBLIC },
  { name: "icon-192.png", size: 192, dir: PUBLIC },
  { name: "apple-touch-icon.png", size: 180, dir: PUBLIC },
];

for (const { name, size, dir } of sizes) {
  const buf = await makeIcon(size);
  await sharp(buf).toFile(path.join(dir, name));
  console.log("wrote", name);
}

// Favicon: multi-size .ico containing 16/32/48 PNGs. Browsers pick the
// closest match for their tab-bar zoom level.
const favSizes = [16, 32, 48];
const favBufs = await Promise.all(favSizes.map((s) => makeIcon(s)));
const ico = await pngToIco(favBufs);
fs.writeFileSync(path.join(APP, "favicon.ico"), ico);
console.log("wrote app/favicon.ico");

console.log("done");
