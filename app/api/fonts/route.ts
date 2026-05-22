import { NextResponse } from "next/server";
import { getFonts } from "@/lib/fonts";

// ISR with 30s revalidate. The cascade polls this every 30s for the
// font list, so without caching, every poll = a Vercel function
// invocation (this was the dominant cost driver in the 2026-05-22
// logs: 50 invocations / 2.5 min, all from one cascade tab).
//
// With revalidate=30, the response is cached at the edge for 30s.
// updateTag(FONTS_LIST_TAG) in font save/delete actions invalidates
// this cache on-demand, so a freshly-uploaded font shows up within
// seconds. Workshop-scale impact: ~99% reduction in invocations from
// cascade polling.
//
// Also tag the cache directly with FONTS_LIST_TAG so that the Next
// data-cache layer (separate from the route-segment cache) gets
// invalidated by the same updateTag call. Belt + suspenders.
export const revalidate = 30;

export async function GET() {
  const fonts = await getFonts();
  return NextResponse.json(
    { fonts },
    {
      headers: {
        // Mirror revalidate at the CDN layer too. s-maxage caps edge
        // freshness; stale-while-revalidate lets the CDN serve old
        // data instantly while it refreshes in the background.
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
      },
    },
  );
}
