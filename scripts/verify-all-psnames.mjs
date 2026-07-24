// Post-migration audit: for every font confirm the PostScript identity
// is now Windows-valid — Name ID 6 identical across macintosh/windows/
// unicode, matching the CFF FontName (read from raw bytes), ASCII, and
// globally unique across the library. Read-only.
import opentype from "opentype.js";
import { list } from "@vercel/blob";

function cffFontName(buf) {
  const dv = new DataView(buf);
  const numTables = dv.getUint16(4);
  let off = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(dv.getUint8(rec), dv.getUint8(rec+1), dv.getUint8(rec+2), dv.getUint8(rec+3));
    if (tag === "CFF ") { off = dv.getUint32(rec + 8); break; }
  }
  if (off < 0) return null;
  let p = off + dv.getUint8(off + 2);
  const count = dv.getUint16(p); p += 2;
  if (count === 0) return null;
  const offSize = dv.getUint8(p); p += 1;
  const rd = (o) => { let v = 0; for (let k = 0; k < offSize; k++) v = (v << 8) | dv.getUint8(o + k); return v; };
  const o0 = rd(p), o1 = rd(p + offSize);
  const base = p + (count + 1) * offSize - 1;
  let s = "";
  for (let k = o0; k < o1; k++) s += String.fromCharCode(dv.getUint8(base + k));
  return s;
}

const { blobs } = await list({ prefix: "fonts/" });
const fonts = blobs.filter((b) => /\.(otf|ttf)$/i.test(b.pathname)).map((b) => ({ filename: b.pathname.replace("fonts/",""), url: b.url }));

const seen = new Map();
let bad = 0;
for (const f of fonts) {
  const ab = await (await fetch(`${f.url}?cb=${Date.now()}`)).arrayBuffer();
  const font = opentype.parse(ab);
  const mac = font.names.macintosh?.postScriptName?.en;
  const win = font.names.windows?.postScriptName?.en;
  const uni = font.names.unicode?.postScriptName?.en;
  const cff = cffFontName(ab);
  const same = mac === win && win === uni && win === cff;
  const ascii = /^[\x20-\x7E]+$/.test(win ?? "");
  const problems = [];
  if (!same) problems.push(`not-identical (mac=${mac} win=${win} uni=${uni} cff=${cff})`);
  if (!ascii) problems.push("non-ascii");
  if (seen.has(win)) problems.push(`collides with ${seen.get(win)}`);
  seen.set(win, f.filename);
  if (problems.length) { bad++; console.log(`  ✗ ${f.filename}: ${problems.join("; ")}`); }
}
console.log(`\n${fonts.length} fonts audited`);
console.log(`  identical+ascii+matching-cff+unique: ${fonts.length - bad}/${fonts.length}`);
console.log(bad ? `  ✗ ${bad} still problematic` : "  ✓ all PostScript names are Windows-valid and globally unique");
