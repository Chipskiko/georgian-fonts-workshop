import path from "node:path";
import { unstable_cache } from "next/cache";
import type { FontEntry } from "./types";
import { listFonts } from "./font-storage";

export type { FontEntry };

/** Cache tag for the font list. Server actions that mutate fonts
 *  (saveFont, deleteFont, saveFontFromPreview) call revalidateTag with
 *  this string to drop the cache immediately on upload/delete. */
export const FONTS_LIST_TAG = "fonts-list";

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

/** Inner implementation — runs the Blob list() call. Always uncached
 *  by itself; the public getFonts wraps it with unstable_cache so
 *  callers in server components get a cached result. */
async function _getFonts(): Promise<FontEntry[]> {
  const stored = await listFonts();
  // Carry createdAt alongside the FontEntry just inside this function
  // (don't leak it through the public type — callers only need name +
  // file). Used for the newest-first sort at the bottom of the body.
  const fonts: (FontEntry & { _createdAt: number })[] = [];
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
      _createdAt: s.createdAt,
    });
  }
  // Disambiguate identical display names. When two workshop participants
  // both name their font "კატა" (or any other clash), the picker would
  // show two indistinguishable rows. Both fonts render correctly under
  // the hood (each has a unique CSS @font-face name derived from the
  // random suffix in their filename), but the human label needs to tell
  // them apart. Strategy: keep the first occurrence's name unmodified,
  // append " (2)", " (3)", ... to subsequent ones. Use the filename for
  // tiebreaking inside a group so the same upload always gets the same
  // suffix between renders.
  const groups = new Map<string, FontEntry[]>();
  for (const f of fonts) {
    const list = groups.get(f.name);
    if (list) list.push(f);
    else groups.set(f.name, [f]);
  }
  for (const list of groups.values()) {
    if (list.length <= 1) continue;
    list.sort((a, b) => a.filename.localeCompare(b.filename));
    for (let i = 1; i < list.length; i++) {
      list[i].name = `${list[i].name} (${i + 1})`;
    }
  }
  // NEWEST-FIRST: workshop participants should see their fresh upload
  // at the top of every consumer of this list (home-page font specimens,
  // /add page, cascade picker). Sort by _createdAt descending — ties
  // (same millisecond) fall back to filename for stable ordering across
  // renders. Strip the internal _createdAt before returning so the
  // FontEntry shape stays stable for downstream consumers.
  fonts.sort((a, b) => {
    if (b._createdAt !== a._createdAt) return b._createdAt - a._createdAt;
    return a.filename.localeCompare(b.filename);
  });
  return fonts.map(({ _createdAt: _unused, ...rest }) => rest);
}

// Cache the font list at the function level. Every page that calls
// getFonts() (layout, /, /add, /cascade) shares the same cached entry —
// so a single Blob list() per cache window (60s) instead of one per
// page render. Tag-based invalidation in save/delete actions drops the
// cache immediately so new uploads appear on the very next request.
// The TTL is a safety net for any invalidation that doesn't fire.
export const getFonts = unstable_cache(_getFonts, ["fonts-list"], {
  tags: [FONTS_LIST_TAG],
  revalidate: 60,
});

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
