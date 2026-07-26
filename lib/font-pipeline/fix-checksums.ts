/**
 * Recompute every sfnt table checksum + head.checkSumAdjustment.
 *
 * WHY: opentype.js's writer computes checksums with
 *
 *     sum += (bytes[i] << 24) + (bytes[i+1] << 16) + ...
 *     sum %= Math.pow(2, 32);
 *
 * `bytes[i] << 24` is a SIGNED 32-bit shift, so any byte ≥ 0x80 makes the
 * term negative; JS's `%` then preserves the sign and the stored ULONG is
 * wrong. It's data-dependent, which is why only SOME generated fonts were
 * affected — and why the breakage looked so arbitrary:
 *
 *   - macOS/CoreText, FreeType and every browser IGNORE sfnt checksums,
 *     so the fonts looked perfect everywhere we tested.
 *   - Windows Font Viewer VALIDATES them and refuses to install with
 *     "The requested file ... is not a valid font file."
 *
 * Fix per the OpenType spec:
 *   - each table record's checkSum = sum of big-endian ULONGs over the
 *     table data, zero-padded to a 4-byte multiple
 *   - the head table's own checksum is computed with its
 *     checkSumAdjustment field treated as 0
 *   - head.checkSumAdjustment = 0xB1B0AFBA − (checksum of the WHOLE file,
 *     computed with checkSumAdjustment set to 0)
 *
 * All arithmetic is forced unsigned with `>>> 0`.
 */

/** Sum of big-endian ULONGs over [offset, offset+length), zero-padded. */
function tableChecksum(view: DataView, offset: number, length: number): number {
  let sum = 0;
  const nLongs = Math.ceil(length / 4);
  for (let i = 0; i < nLongs; i++) {
    let word = 0;
    for (let b = 0; b < 4; b++) {
      const p = offset + i * 4 + b;
      word = ((word << 8) | (p < offset + length ? view.getUint8(p) : 0)) >>> 0;
    }
    sum = (sum + word) >>> 0;
  }
  return sum >>> 0;
}

/**
 * Returns a COPY of the font with all checksums corrected. Safe to call
 * on any sfnt (OTF/TTF); returns the input unchanged if it doesn't look
 * like one.
 */
export function fixSfntChecksums(input: Uint8Array): Uint8Array {
  if (input.byteLength < 12) return input;
  const bytes = new Uint8Array(input); // copy — never mutate the caller's buffer
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const numTables = view.getUint16(4);
  if (numTables === 0 || 12 + numTables * 16 > bytes.byteLength) return input;

  const records: { recOff: number; off: number; len: number; isHead: boolean }[] = [];
  let headOff = -1;
  for (let i = 0; i < numTables; i++) {
    const recOff = 12 + i * 16;
    const tag = String.fromCharCode(
      view.getUint8(recOff), view.getUint8(recOff + 1),
      view.getUint8(recOff + 2), view.getUint8(recOff + 3),
    );
    const off = view.getUint32(recOff + 8);
    const len = view.getUint32(recOff + 12);
    if (off + len > bytes.byteLength) return input; // malformed — leave alone
    const isHead = tag === "head";
    if (isHead) headOff = off;
    records.push({ recOff, off, len, isHead });
  }

  // head.checkSumAdjustment must be 0 while checksums are computed.
  if (headOff >= 0 && headOff + 12 <= bytes.byteLength) {
    view.setUint32(headOff + 8, 0);
  }

  // Per-table records.
  for (const r of records) {
    view.setUint32(r.recOff + 4, tableChecksum(view, r.off, r.len));
  }

  // Whole-file checksum (directory included), then the adjustment.
  if (headOff >= 0) {
    const whole = tableChecksum(view, 0, bytes.byteLength);
    view.setUint32(headOff + 8, (0xb1b0afba - whole) >>> 0);
  }

  return bytes;
}
