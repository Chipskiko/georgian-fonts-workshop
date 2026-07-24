// One-shot migration: fix the PostScript-name / CFF-FontName identity of
// EXISTING fonts so they install on Windows and don't collide with
// same-named fonts.
//
// The bug (pre-fix build-font.ts): the unique random suffix was applied
// ONLY to the Macintosh name records. Windows + Unicode kept opentype's
// construction-time PostScript name derived from the base name — so
// across one font the PostScript name was inconsistent across platforms
// AND not unique across fonts:
//     CFF FontName  : keramilka
//     mac  Name ID 6: keramilka-ttu5rt-Regular
//     win  Name ID 6: keramilkaRegular          ← different + non-unique
// macOS/CoreText tolerated this; Windows' installer rejected it, and two
// fonts named the same (e.g. "28", "Sopokik") both got PS name
// "<name>Regular" so Windows treated them as one font.
//
// This migration does an IN-PLACE name patch (parse → fix name records →
// re-serialize). opentype.js re-derives the CFF FontName from the name
// table's postScriptName at serialize time, so this fixes the CFF
// FontName too. Glyphs are preserved verbatim. (These fonts carry no
// `kern` table — opentype.js v2 doesn't serialize kerningPairs — so
// there's nothing kerning-related to preserve.)
//
// Result per font: ONE unique ASCII PostScript name, identical on every
// platform and matching the CFF FontName, with the Georgian display
// name kept in Name ID 1/4/16 (win + unicode).
//
// Modes:
//   --dry            (default) show before/after PS names, write nothing
//   --apply <name>   migrate one font filename, upload in place
//   --apply-all      migrate every font
//
// Requires BLOB_READ_WRITE_TOKEN (set -a && source .env.local && set +a).

import opentype from "opentype.js";
import { list, put } from "@vercel/blob";

const BLOB_PREFIX = "fonts/";

// Transliteration — mirror lib/font-pipeline/build-font.ts.
const GEORGIAN_TO_LATIN = {
  ა: "a", ბ: "b", გ: "g", დ: "d", ე: "e",
  ვ: "v", ზ: "z", თ: "T", ი: "i", კ: "k",
  ლ: "l", მ: "m", ნ: "n", ო: "o", პ: "p",
  ჟ: "J", რ: "r", ს: "s", ტ: "t", უ: "u",
  ფ: "f", ქ: "q", ღ: "R", ყ: "y", შ: "S",
  ჩ: "C", ც: "c", ძ: "Z", წ: "w", ჭ: "W",
  ხ: "x", ჯ: "j", ჰ: "h",
};
function stripToAscii(s) {
  return s
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\w-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
function transliterateGeorgian(s) {
  let out = "";
  for (const ch of s) out += GEORGIAN_TO_LATIN[ch] ?? ch;
  return stripToAscii(out);
}

/** Fix one parsed font's name identity in place; return the new bytes. */
function fixNames(font, filename) {
  const displayFamily =
    font.names.windows?.fontFamily?.en ??
    font.names.unicode?.fontFamily?.en ??
    filename.split("__")[0].replace(/\.[^.]+$/, "");

  const asciiBase =
    transliterateGeorgian(displayFamily) ||
    stripToAscii(displayFamily) ||
    "GeorgianWorkshopFont";
  const tag = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  // Match the shape opentype.js generates from familyName `${asciiBase}-${tag}`
  // + styleName "Regular": spaces stripped → "<asciiBase>-<tag>Regular".
  const psName = `${asciiBase}-${tag}Regular`;
  const uniqueId = `Xarafontinator: ${asciiBase}-${tag} Regular`;
  const displayFull = `${displayFamily} Regular`;

  const n = font.names;
  // Internal identity — identical, unique, ASCII on every platform.
  for (const s of ["macintosh", "windows", "unicode"]) {
    n[s] = n[s] ?? {};
    n[s].postScriptName = { en: psName };
    n[s].uniqueID = { en: uniqueId };
  }
  // Display identity.
  for (const s of ["windows", "unicode"]) {
    n[s].fontFamily = { en: displayFamily };
    n[s].fullName = { en: displayFull };
    n[s].preferredFamily = { en: displayFamily };
  }
  // Mac Roman can't hold Georgian → ASCII display label there.
  n.macintosh.fontFamily = { en: asciiBase };
  n.macintosh.fullName = { en: `${asciiBase} Regular` };
  n.macintosh.preferredFamily = { en: asciiBase };

  return { bytes: new Uint8Array(font.toArrayBuffer()), psName, displayFamily };
}

async function migrateOne(filename, url, { apply }) {
  const ab = await (await fetch(`${url}?cb=${Date.now()}`)).arrayBuffer();
  const font = opentype.parse(ab);
  const beforePs = font.names.windows?.postScriptName?.en ?? "(none)";
  const { bytes, psName, displayFamily } = fixNames(font, filename);
  console.log(`  ${filename}`);
  console.log(`      "${displayFamily}"  PS: ${beforePs} → ${psName}`);
  if (!apply) return;
  await put(`${BLOB_PREFIX}${filename}`, Buffer.from(bytes), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "font/otf",
  });
  console.log(`      ✓ uploaded (${(bytes.length / 1024).toFixed(1)} KB)`);
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] ?? "--dry";
  if (!["--dry", "--apply", "--apply-all"].includes(mode)) {
    console.error("usage: node scripts/migrate-font-psname.mjs <--dry|--apply|--apply-all> [filename]");
    process.exit(1);
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("BLOB_READ_WRITE_TOKEN not set — run `set -a && source .env.local && set +a` first");
    process.exit(1);
  }

  const { blobs } = await list({ prefix: BLOB_PREFIX });
  const fonts = blobs
    .filter((b) => /\.(otf|ttf|woff2?)$/i.test(b.pathname))
    .map((b) => ({ filename: b.pathname.replace(BLOB_PREFIX, ""), url: b.url }));
  console.log(`${fonts.length} fonts`);

  if (mode === "--apply") {
    const f = fonts.find((x) => x.filename === args[1]);
    if (!f) throw new Error(`font not found: ${args[1]}`);
    await migrateOne(f.filename, f.url, { apply: true });
    return;
  }
  const apply = mode === "--apply-all";
  let done = 0;
  for (const f of fonts) {
    try {
      await migrateOne(f.filename, f.url, { apply });
      done++;
    } catch (e) {
      console.warn(`  ${f.filename}: failed — ${e.message}`);
    }
  }
  console.log(`\n${apply ? "migrated" : "previewed"} ${done}/${fonts.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
