import path from "node:path";
import type { FontEntry } from "./types";
import { listFonts } from "./font-storage";

export type { FontEntry };

const EXT_TO_FORMAT: Record<string, FontEntry["format"]> = {
  ".ttf": "truetype",
  ".otf": "opentype",
  ".woff": "woff",
  ".woff2": "woff2",
};

function toName(filename: string): { name: string; designer?: string } {
  let base = filename.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/, "");
  // saveFont appends `__<6 alnum>` to every stored file as a collision-
  // avoidance suffix; strip it so the display name stays clean.
  base = base.replace(/__[a-z0-9]{6}$/i, "");
  const parts = base.split("__");
  if (parts.length >= 2) {
    return { name: parts[0].replace(/[-_]+/g, " "), designer: parts[1].replace(/[-_]+/g, " ") };
  }
  return { name: base.replace(/[-_]+/g, " ") };
}

export async function getFonts(): Promise<FontEntry[]> {
  const stored = await listFonts();
  const fonts: FontEntry[] = [];
  for (const s of stored) {
    const ext = path.extname(s.filename).toLowerCase();
    const format = EXT_TO_FORMAT[ext];
    if (!format) continue;
    const { name, designer } = toName(s.filename);
    const baseName = s.filename.replace(/\.[^.]+$/, "");
    fonts.push({
      id: baseName.replace(/["\\]/g, "_"),
      name,
      designer,
      file: s.publicUrl,
      filename: s.filename,
      format,
    });
  }
  return fonts.sort((a, b) => a.name.localeCompare(b.name));
}

export function fontFaceCss(fonts: FontEntry[]): string {
  return fonts
    .map(
      (f) => `@font-face {
  font-family: "${f.id}";
  src: url("${f.file}") format("${f.format}");
  font-display: swap;
}`,
    )
    .join("\n");
}

export const GEORGIAN_ALPHABET = "ა ბ გ დ ე ვ ზ თ ი კ ლ მ ნ ო პ ჟ რ ს ტ უ ფ ქ ღ ყ შ ჩ ც ძ წ ჭ ხ ჯ ჰ".split(" ");
