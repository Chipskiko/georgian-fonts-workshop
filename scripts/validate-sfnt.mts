// Structural validator for our generated OTFs — checks the things
// Windows Font Viewer enforces but macOS/CoreText and browsers tolerate.
import { list } from "@vercel/blob";

const target = process.argv[2] ?? "ჯჯჯ";

function u8(d: DataView, o: number) { return d.getUint8(o); }
function u16(d: DataView, o: number) { return d.getUint16(o); }
function u32(d: DataView, o: number) { return d.getUint32(o); }

function calcTableChecksum(d: DataView, offset: number, length: number): number {
  let sum = 0;
  const nLongs = Math.floor((length + 3) / 4);
  for (let i = 0; i < nLongs; i++) {
    let v = 0;
    for (let b = 0; b < 4; b++) {
      const p = offset + i * 4 + b;
      v = (v << 8) | (p < offset + length ? d.getUint8(p) : 0);
    }
    sum = (sum + v) >>> 0;
  }
  return sum >>> 0;
}

const { blobs } = await list({ prefix: "fonts/" });
const b = blobs.find((x) => x.pathname.includes(target) && x.pathname.endsWith(".otf"));
if (!b) { console.error("font not found:", target); process.exit(1); }
const ab = await (await fetch(`${b.url}?cb=${Date.now()}`)).arrayBuffer();
const d = new DataView(ab);
const size = ab.byteLength;
console.log(`file: ${b.pathname.replace("fonts/", "")}  ${size} bytes\n`);

const problems: string[] = [];

// --- sfnt header
const tag = String.fromCharCode(u8(d,0),u8(d,1),u8(d,2),u8(d,3));
const numTables = u16(d, 4);
const searchRange = u16(d, 6);
const entrySelector = u16(d, 8);
const rangeShift = u16(d, 10);
const expPow = Math.floor(Math.log2(numTables));
const expSearch = Math.pow(2, expPow) * 16;
const expRange = numTables * 16 - expSearch;
console.log(`sfntVersion=${tag} numTables=${numTables}`);
console.log(`  searchRange=${searchRange} (expect ${expSearch})  entrySelector=${entrySelector} (expect ${expPow})  rangeShift=${rangeShift} (expect ${expRange})`);
if (searchRange !== expSearch) problems.push(`searchRange ${searchRange} != ${expSearch}`);
if (entrySelector !== expPow) problems.push(`entrySelector ${entrySelector} != ${expPow}`);
if (rangeShift !== expRange) problems.push(`rangeShift ${rangeShift} != ${expRange}`);

// --- table directory
type T = { tag: string; checksum: number; offset: number; length: number };
const tables: T[] = [];
for (let i = 0; i < numTables; i++) {
  const r = 12 + i * 16;
  tables.push({
    tag: String.fromCharCode(u8(d,r),u8(d,r+1),u8(d,r+2),u8(d,r+3)),
    checksum: u32(d, r + 4), offset: u32(d, r + 8), length: u32(d, r + 12),
  });
}
console.log("\ntable directory:");
for (const t of tables) {
  const end = t.offset + t.length;
  const oob = end > size;
  const aligned = t.offset % 4 === 0;
  const actual = oob ? NaN : calcTableChecksum(d, t.offset, t.length);
  const csOk = t.tag === "head" ? true : actual === t.checksum;
  console.log(
    `  ${t.tag.padEnd(5)} off=${String(t.offset).padStart(6)} len=${String(t.length).padStart(6)} end=${String(end).padStart(6)}` +
    `${oob ? "  OUT-OF-BOUNDS" : ""}${aligned ? "" : "  UNALIGNED"}${csOk ? "" : `  CHECKSUM ${actual}!=${t.checksum}`}`,
  );
  if (oob) problems.push(`${t.tag} extends past EOF (${end} > ${size})`);
  if (!aligned) problems.push(`${t.tag} offset not 4-byte aligned`);
  if (!csOk && !oob) problems.push(`${t.tag} checksum mismatch`);
}

// sorted?
const sorted = [...tables].map(t=>t.tag).sort();
const asIs = tables.map(t=>t.tag);
if (JSON.stringify(sorted) !== JSON.stringify(asIs)) {
  problems.push(`table directory NOT sorted by tag: ${asIs.join(",")}`);
  console.log(`\n  directory order: ${asIs.join(",")}`);
  console.log(`  sorted would be: ${sorted.join(",")}`);
}

// required tables for CFF OpenType
const req = ["CFF ", "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post"];
const have = new Set(tables.map(t=>t.tag));
for (const r of req) if (!have.has(r)) problems.push(`missing required table ${r}`);

// --- head
const head = tables.find(t=>t.tag==="head");
if (head) {
  const magic = u32(d, head.offset + 12);
  const csAdj = u32(d, head.offset + 8);
  const upem = u16(d, head.offset + 18);
  console.log(`\nhead: magic=0x${magic.toString(16)} (expect 0x5f0f3cf5) unitsPerEm=${upem} checkSumAdjustment=0x${csAdj.toString(16)}`);
  if (magic !== 0x5f0f3cf5) problems.push(`head.magicNumber wrong`);
  if (upem < 16 || upem > 16384) problems.push(`head.unitsPerEm out of range`);
  // verify checkSumAdjustment
  let total = 0;
  for (const t of tables) if (t.offset + t.length <= size) total = (total + calcTableChecksum(d, t.offset, t.length)) >>> 0;
  // header checksum with csAdj zeroed
  const hdrLen = 12 + numTables * 16;
  let hdrSum = 0;
  for (let i = 0; i < Math.floor(hdrLen / 4); i++) hdrSum = (hdrSum + u32(d, i * 4)) >>> 0;
  const fileSum = (hdrSum + total) >>> 0;
  // csAdj is inside head and was included; subtract it then compute
  const expected = (0xB1B0AFBA - ((fileSum - csAdj) >>> 0)) >>> 0;
  console.log(`  computed checkSumAdjustment=0x${expected.toString(16)}  stored=0x${csAdj.toString(16)}  ${expected === csAdj ? "OK" : "MISMATCH"}`);
  if (expected !== csAdj) problems.push(`head.checkSumAdjustment mismatch (stored 0x${csAdj.toString(16)}, computed 0x${expected.toString(16)})`);
}

// --- maxp
const maxp = tables.find(t=>t.tag==="maxp");
if (maxp) {
  const ver = u32(d, maxp.offset);
  const n = u16(d, maxp.offset + 4);
  console.log(`\nmaxp: version=0x${ver.toString(16)} (CFF wants 0x5000) numGlyphs=${n} len=${maxp.length} (CFF wants 6)`);
  if (ver !== 0x00005000) problems.push(`maxp.version 0x${ver.toString(16)} — CFF fonts require 0x00005000`);
  if (maxp.length !== 6) problems.push(`maxp length ${maxp.length} — version 0.5 must be 6 bytes`);
}

// --- hhea / hmtx consistency
const hhea = tables.find(t=>t.tag==="hhea");
const hmtx = tables.find(t=>t.tag==="hmtx");
if (hhea && hmtx && maxp) {
  const numH = u16(d, hhea.offset + 34);
  const numGlyphs = u16(d, maxp.offset + 4);
  const need = numH * 4 + (numGlyphs - numH) * 2;
  console.log(`\nhhea.numberOfHMetrics=${numH} numGlyphs=${numGlyphs} → hmtx needs ${need}, has ${hmtx.length}`);
  if (numH === 0 || numH > numGlyphs) problems.push(`hhea.numberOfHMetrics invalid`);
  if (hmtx.length < need) problems.push(`hmtx too short (${hmtx.length} < ${need})`);
}

// --- OS/2
const os2 = tables.find(t=>t.tag==="OS/2");
if (os2) {
  const ver = u16(d, os2.offset);
  const expLen: Record<number, number> = {0:78,1:86,2:96,3:96,4:96,5:100};
  console.log(`\nOS/2: version=${ver} len=${os2.length} (expect ${expLen[ver] ?? "?"})`);
  if (expLen[ver] && os2.length < expLen[ver]) problems.push(`OS/2 length ${os2.length} < ${expLen[ver]} for version ${ver}`);
}

// --- name table sanity
const name = tables.find(t=>t.tag==="name");
if (name) {
  const fmt = u16(d, name.offset);
  const count = u16(d, name.offset + 2);
  const strOff = u16(d, name.offset + 4);
  console.log(`\nname: format=${fmt} count=${count} stringOffset=${strOff} len=${name.length}`);
  let bad = 0;
  for (let i = 0; i < count; i++) {
    const r = name.offset + 6 + i * 12;
    const len = u16(d, r + 8), off = u16(d, r + 10);
    if (strOff + off + len > name.length) bad++;
  }
  if (bad) problems.push(`${bad} name records point past the table`);
}

console.log("\n" + "=".repeat(60));
if (!problems.length) console.log("STRUCTURALLY VALID — no problems found");
else { console.log(`${problems.length} PROBLEM(S):`); for (const p of problems) console.log("  ✗ " + p); }
