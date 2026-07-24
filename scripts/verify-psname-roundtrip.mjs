// Verify the migration's in-place name patch actually round-trips:
// after fixNames + toArrayBuffer + re-parse, the PostScript name must be
// (a) identical across macintosh/windows/unicode, (b) ASCII, and (c)
// equal to the CFF FontName. Reads one real font from blob, patches it
// in memory, re-parses the bytes, prints the resulting identity. Writes
// nothing.
import opentype from "opentype.js";
import { list } from "@vercel/blob";

const GEORGIAN_TO_LATIN = {
  ა:"a",ბ:"b",გ:"g",დ:"d",ე:"e",ვ:"v",ზ:"z",თ:"T",ი:"i",კ:"k",ლ:"l",მ:"m",
  ნ:"n",ო:"o",პ:"p",ჟ:"J",რ:"r",ს:"s",ტ:"t",უ:"u",ფ:"f",ქ:"q",ღ:"R",ყ:"y",
  შ:"S",ჩ:"C",ც:"c",ძ:"Z",წ:"w",ჭ:"W",ხ:"x",ჯ:"j",ჰ:"h",
};
const stripToAscii = (s) => s.replace(/[^\x20-\x7E]/g,"").replace(/\s+/g," ").trim().replace(/[^\w-]/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"");
const transliterateGeorgian = (s) => { let o=""; for (const c of s) o+=GEORGIAN_TO_LATIN[c]??c; return stripToAscii(o); };

function fixNames(font, filename) {
  const displayFamily = font.names.windows?.fontFamily?.en ?? font.names.unicode?.fontFamily?.en ?? filename.split("__")[0].replace(/\.[^.]+$/, "");
  const asciiBase = transliterateGeorgian(displayFamily) || stripToAscii(displayFamily) || "GeorgianWorkshopFont";
  const tag = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  const psName = `${asciiBase}-${tag}Regular`;
  const uniqueId = `Xarafontinator: ${asciiBase}-${tag} Regular`;
  const n = font.names;
  for (const s of ["macintosh","windows","unicode"]) { n[s]=n[s]??{}; n[s].postScriptName={en:psName}; n[s].uniqueID={en:uniqueId}; }
  for (const s of ["windows","unicode"]) { n[s].fontFamily={en:displayFamily}; n[s].fullName={en:`${displayFamily} Regular`}; n[s].preferredFamily={en:displayFamily}; }
  n.macintosh.fontFamily={en:asciiBase}; n.macintosh.fullName={en:`${asciiBase} Regular`}; n.macintosh.preferredFamily={en:asciiBase};
  return { bytes: new Uint8Array(font.toArrayBuffer()), psName, displayFamily };
}

const target = process.argv[2]; // optional filename filter
const { blobs } = await list({ prefix: "fonts/" });
const fonts = blobs.filter((b) => /\.(otf|ttf)$/i.test(b.pathname)).map((b) => ({ filename: b.pathname.replace("fonts/",""), url: b.url }));
const pick = target ? fonts.filter((f) => f.filename.includes(target)) : [fonts.find((f) => f.filename.startsWith("კერამილკა")) ?? fonts[0]];

for (const f of pick) {
  const ab = await (await fetch(`${f.url}?cb=${Date.now()}`)).arrayBuffer();
  const before = opentype.parse(ab);
  const beforePs = {
    mac: before.names.macintosh?.postScriptName?.en,
    win: before.names.windows?.postScriptName?.en,
    uni: before.names.unicode?.postScriptName?.en,
    cff: before.tables?.cff?.topDict?._privateDict ? before.names.postScriptName?.en : (before.tables?.cff?.topDict?.fontName ?? "n/a"),
  };
  const { bytes, displayFamily } = fixNames(before, f.filename);
  const after = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const mac = after.names.macintosh?.postScriptName?.en;
  const win = after.names.windows?.postScriptName?.en;
  const uni = after.names.unicode?.postScriptName?.en;
  const cff = after.tables?.cff?.topDict?.fontName ?? "n/a";
  const allSame = mac === win && win === uni && win === cff;
  const ascii = /^[\x20-\x7E]+$/.test(win ?? "");
  console.log(`\n${f.filename}`);
  console.log(`  display family (win): "${after.names.windows?.fontFamily?.en}"  (expected "${displayFamily}")`);
  console.log(`  BEFORE  mac=${beforePs.mac}  win=${beforePs.win}  uni=${beforePs.uni}  cff=${beforePs.cff}`);
  console.log(`  AFTER   mac=${mac}  win=${win}  uni=${uni}  cff=${cff}`);
  console.log(`  identical-across-all=${allSame ? "✓" : "✗ MISMATCH"}   ascii=${ascii ? "✓" : "✗"}`);
}
