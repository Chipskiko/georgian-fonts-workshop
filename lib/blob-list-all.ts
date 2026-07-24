import type { ListBlobResult } from "@vercel/blob";

/**
 * Fully-paginated wrapper around @vercel/blob `list()`. The SDK returns
 * at most 1000 blobs per call (`hasMore` + `cursor` for the rest); every
 * storage adapter in this repo used to read only the first page, which
 * silently truncates once fonts+sidecars (2 blobs each), posters
 * (3 blobs each), or debug images pass the limit — oldest entries would
 * just vanish from listings and sweeps. All list() call sites go through
 * this helper instead.
 */
export async function listAllBlobs(prefix: string): Promise<ListBlobResult["blobs"]> {
  const { list } = await import("@vercel/blob");
  const all: ListBlobResult["blobs"] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor });
    all.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return all;
}
