"use client";

import { useState } from "react";

/** Refresh button on the home page. Forces a full page reload so the
 *  browser re-fetches the layout's <style> block, every @font-face
 *  binary, and the FontRow client components. Used as a fallback when
 *  fonts don't render correctly on the user's device (most often a
 *  stale browser font cache, a slow Vercel Blob cold-start, or — for
 *  fonts uploaded BEFORE the latest OS/2 hardening — a browser that
 *  rejected the old binary).
 *
 *  location.reload() doesn't bypass the HTTP cache by default, but
 *  Next.js's static page revalidate=60 and unstable_cache on
 *  getFonts() ensure the server returns the freshest font list on
 *  any reload after the cache TTL. For an even harder refresh, the
 *  user can Cmd+Shift+R — but that's a power-user gesture, hence
 *  this button. */
export function RefreshFontsButton() {
  const [refreshing, setRefreshing] = useState(false);
  return (
    <div className="fonts-refresh-row">
      <button
        type="button"
        className="fonts-refresh-btn"
        onClick={() => {
          setRefreshing(true);
          // Clearing FontFace API entries doesn't undo CSS @font-face
          // declarations but it does drop any document.fonts records
          // that the cascade page added — sometimes the cascade's
          // FontFace registrations conflict with the home page's
          // CSS @font-face if a font was re-uploaded mid-session.
          try {
            document.fonts.clear();
          } catch {
            /* not supported in all browsers, ignore */
          }
          window.location.reload();
        }}
        disabled={refreshing}
        title="re-fetch fonts and reload the page"
      >
        {refreshing ? "..." : "↻ განახლება"}
      </button>
    </div>
  );
}
