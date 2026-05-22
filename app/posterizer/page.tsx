import { listPosters } from "@/lib/poster-storage";
import { Gallery } from "./Gallery";

// listPosters is wrapped in unstable_cache (tag: POSTERS_LIST_TAG).
// Removing force-dynamic lets the page be prerendered as static; the
// background poll + manual refresh button in <Gallery/> fetch fresh
// data client-side after first paint. Upload/delete actions call
// updateTag so the cache drops immediately on mutation.
export default async function PosterizerPage() {
  const posters = await listPosters();
  return (
    <div id="contents">
      <Gallery initialPosters={posters} />
    </div>
  );
}
