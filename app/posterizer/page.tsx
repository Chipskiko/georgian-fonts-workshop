import { listPosters } from "@/lib/poster-storage";
import { Gallery } from "./Gallery";

export const dynamic = "force-dynamic";

export default async function PosterizerPage() {
  const posters = await listPosters();
  return (
    <div id="contents">
      <Gallery initialPosters={posters} />
    </div>
  );
}
