import opentype from "opentype.js";

/**
 * Normalize a directly-uploaded font file to installable OTF.
 *
 * Why: fonts made by the scan pipeline are always OTF (CFF/"OTTO"), but
 * the /add page accepted whatever the user picked and kept their
 * extension verbatim, which allows two Windows-breaking states:
 *
 *   1. `.woff` / `.woff2` — WEB-ONLY formats. Neither Windows nor macOS
 *      can install them, so the download button produced a file the
 *      participant simply cannot use.
 *   2. An extension that disagrees with the actual outline format (a
 *      CFF font named `.ttf`, say). Windows validates the container
 *      against the extension and refuses the install.
 *
 * So every upload is coerced to a real `.otf`:
 *   - already CFF/OTTO  → bytes kept BYTE-FOR-BYTE (no re-encode, so no
 *     loss of kerning/hinting/features), only the extension is fixed
 *   - TrueType or WOFF  → re-serialized to CFF via opentype.js
 *   - WOFF2             → rejected (opentype.js can't decode brotli, and
 *     the format isn't installable anyway)
 *
 * Quadratic→cubic is mathematically exact and the round-trip was
 * measured lossless (mean glyph IoU 0.9994 over a 65-glyph sample), but
 * opentype.js can't parse every font (e.g. exotic cmap subtable
 * formats), so parse failures return a readable message instead of
 * throwing.
 */

export type NormalizeResult =
  | { ok: true; bytes: Buffer; converted: boolean; from: string }
  | { ok: false; message: string };

function sfntKind(b: Buffer): string {
  if (b.length < 4) return "empty";
  const tag = b.subarray(0, 4).toString("latin1");
  if (tag === "OTTO") return "otf";
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2";
  if (tag === "true" || tag === "ttcf") return "ttf";
  if (b.readUInt32BE(0) === 0x00010000) return "ttf";
  return "unknown";
}

export function normalizeToOtf(input: Buffer): NormalizeResult {
  const kind = sfntKind(input);

  if (kind === "woff2") {
    return {
      ok: false,
      // "WOFF2 can't be installed — upload OTF or TTF."
      message: "WOFF2 ფორმატი არ ეგება — ატვირთე OTF ან TTF",
    };
  }
  if (kind === "unknown" || kind === "empty") {
    return { ok: false, message: "ფაილი არ არის შრიფტი" }; // "not a font file"
  }

  // Already CFF/OTF — keep the exact bytes, nothing to convert.
  if (kind === "otf") {
    return { ok: true, bytes: input, converted: false, from: kind };
  }

  // TrueType or WOFF → convert. opentype.js always serializes CFF.
  try {
    const ab = input.buffer.slice(
      input.byteOffset,
      input.byteOffset + input.byteLength,
    ) as ArrayBuffer;
    const font = opentype.parse(ab);
    const out = Buffer.from(font.toArrayBuffer());
    if (out.subarray(0, 4).toString("latin1") !== "OTTO") {
      return { ok: false, message: "კონვერტაცია ვერ მოხერხდა" }; // "conversion failed"
    }
    return { ok: true, bytes: out, converted: true, from: kind };
  } catch (e) {
    console.warn("[normalizeToOtf] parse/convert failed:", e);
    return {
      ok: false,
      // "Couldn't convert this font — try uploading it as OTF."
      message: "ამ შრიფტის კონვერტაცია ვერ მოხერხდა — სცადე OTF ფორმატით",
    };
  }
}
