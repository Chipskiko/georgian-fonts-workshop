// Find fonts where the participant drew only one letter (or none) — the
// font has ≤1 glyph with actual ink. These are junk uploads (a test, or
// an abandoned sheet). Counts inked Georgian-letter glyphs: a glyph that
// (a) is mapped from a Mkhedruli codepoint and (b) has real outline
// commands, excluding .notdef and the always-present blank `space`.
//
//   --dry (default)  list fonts by inked-letter count, delete nothing
//   --apply          delete every font with ≤1 inked letter (+ sidecar)
//
// Requires BLOB_READ_WRITE_TOKEN (set -a && source .env.local && set +a).
import opentype from "opentype.js";
import { list, del } from "@vercel/blob";

const PREFIX = "fonts/";
const SUFFIX = ".preview.svg";
const apply = process.argv.includes("--apply");

function inkedLetterCount(font) {
  let n = 0;
  for (let cp = 0x10d0; cp <= 0x10ff; cp++) {
    const gi = font.charToGlyphIndex(String.fromCodePoint(cp));
    if (gi <= 0) continue;
    const g = font.glyphs.get(gi);
    const cmds = g?.path?.commands ?? [];
    // >2 commands = an actual contour (a blank glyph is 0, or a single
    // moveTo+close = 2).
    if (cmds.length > 2) n++;
  }
  return n;
}

const { blobs } = await list({ prefix: PREFIX });
const byPath = new Map(blobs.map((b) => [b.pathname, b.url]));
const fonts = blobs
  .filter((b) => /\.(otf|ttf)$/i.test(b.pathname))
  .map((b) => ({ filename: b.pathname.replace(PREFIX, ""), url: b.url }));

const counts = [];
for (const f of fonts) {
  try {
    const ab = await (await fetch(`${f.url}?cb=${Date.now()}`)).arrayBuffer();
    counts.push({ ...f, inked: inkedLetterCount(opentype.parse(ab)) });
  } catch (e) {
    console.warn(`  ${f.filename}: parse failed — ${e.message}`);
  }
}
counts.sort((a, b) => a.inked - b.inked);

const doomed = counts.filter((c) => c.inked <= 1);
console.log(`${fonts.length} fonts; ${doomed.length} with ≤1 inked letter:\n`);
for (const c of doomed) console.log(`  ${c.inked} letter  ${c.filename}`);
console.log(`\nnext up (2–4 letters), for context:`);
for (const c of counts.filter((c) => c.inked >= 2 && c.inked <= 4)) {
  console.log(`  ${c.inked} letters  ${c.filename}`);
}

if (!apply) {
  console.log(`\n(dry run — re-run with --apply to delete the ${doomed.length} ≤1-letter fonts)`);
} else {
  console.log(`\ndeleting ${doomed.length} fonts + sidecars…`);
  let n = 0;
  for (const c of doomed) {
    for (const target of [`${PREFIX}${c.filename}`, `${PREFIX}${c.filename}${SUFFIX}`]) {
      const url = byPath.get(target);
      if (!url) continue;
      await del(url);
      console.log(`  deleted ${target}`);
      n++;
    }
  }
  console.log(`\ndeleted ${n} blobs across ${doomed.length} fonts`);
}
