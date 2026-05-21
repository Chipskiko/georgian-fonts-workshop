import sharp from "sharp";
import path from "node:path";

const PUBLIC = path.resolve("/Users/test/risocam/georgian-fonts-workshop/public");

// Pink square with a yellow X — fits the site's two-color palette and
// reads as an iconic "X marks the spot" without needing the Xarax font.
function svg(size) {
  const stroke = Math.round(size * 0.16);
  const m = Math.round(size * 0.22);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" fill="#ff10b8"/>
    <line x1="${m}" y1="${m}" x2="${size - m}" y2="${size - m}"
          stroke="#ffea00" stroke-width="${stroke}" stroke-linecap="round"/>
    <line x1="${size - m}" y1="${m}" x2="${m}" y2="${size - m}"
          stroke="#ffea00" stroke-width="${stroke}" stroke-linecap="round"/>
  </svg>`);
}

await sharp(svg(512)).png().toFile(path.join(PUBLIC, "icon-512.png"));
await sharp(svg(192)).png().toFile(path.join(PUBLIC, "icon-192.png"));
await sharp(svg(180)).png().toFile(path.join(PUBLIC, "apple-touch-icon.png"));
console.log("ok");
