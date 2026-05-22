import type { Metadata, Viewport } from "next";
import "./globals.css";
import { fontFaceCss, getFonts } from "@/lib/fonts";
import Link from "next/link";

export const metadata: Metadata = {
  title: "georgian fonts workshop",
  description: "custom georgian typography from the workshop.",
  // iOS standalone-mode flags. When a participant Adds to Home Screen,
  // launching from the icon opens the site without Safari chrome
  // (no URL pill, no input accessory bar) — full-bleed cascade.
  appleWebApp: {
    capable: true,
    title: "ხარახლოპია",
    statusBarStyle: "default",
  },
};

// Lock the viewport on phones: no pinch-zoom, no double-tap zoom,
// no zoom-on-input-focus drift. The cascade UI is hand-tuned for the
// device width and zooming would misalign the A4 stage's tap targets
// and the iOS Safari keyboard's auto-zoom-on-focus would shift the
// whole layout.
// `force-dynamic` was previously needed because:
//   1. revalidatePath('/') only invalidates the home page, NOT the
//      root layout. So a font upload would correctly invalidate the
//      page that lists fonts, but the layout's @font-face <style>
//      stayed stale and the page rendered with the system fallback.
// We've now removed it because:
//   1. getFonts is wrapped in unstable_cache and tagged FONTS_LIST_TAG.
//   2. Every font save/delete server action calls
//      revalidateTag(FONTS_LIST_TAG) AND revalidatePath('/', 'layout'),
//      which together drop both the function cache AND the layout's
//      cache so the next request sees the new fonts.
// With force-dynamic gone, the layout can be served from Vercel's CDN
// cache — huge reduction in function invocations during workshop
// browsing. The 60s TTL on the cached font list is a safety net for
// any invalidation that doesn't fire.
//
// IMPORTANT: if "fonts not appearing after upload" returns, the first
// thing to check is whether revalidateTag is firing in the save actions
// (it should — see app/add/actions.ts and app/make/actions.ts).

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  minimumScale: 1,
  userScalable: false,
  // viewportFit: cover lets the page extend under iOS safe areas
  // (notch / Dynamic Island corners), and CSS env(safe-area-inset-*)
  // controls padding from there. Without this, iOS Safari adds
  // implicit insets that show up as asymmetric content positioning.
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const fonts = await getFonts();
  const css = fontFaceCss(fonts);
  return (
    <html lang="en">
      <head>
        {/* Preload the UI font (Xarax) so the nav doesn't flash through
            the Times fallback on first paint. Without this the browser
            doesn't discover the @font-face url until it parses the
            stylesheet, so the nav renders in serif for ~100ms then
            swaps. crossOrigin="anonymous" is required for fonts even on
            same origin — the resource is treated as cross-origin by the
            preload spec. */}
        <link
          rel="preload"
          href="/ui-fonts/Xaraxfont4-kerned.otf"
          as="font"
          type="font/otf"
          crossOrigin="anonymous"
        />
        <style dangerouslySetInnerHTML={{ __html: css }} />
        {/* iOS Safari ignores user-scalable=no in browser mode (Apple's
            accessibility decision since iOS 10) so pinch-zoom can still
            fire. Block it at the event level — pinch fires gesture*
            events which we preventDefault. No effect on PWA mode (zoom
            is already off there) or on Android (no gesture* events). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              document.addEventListener('gesturestart', e => e.preventDefault());
              document.addEventListener('gesturechange', e => e.preventDefault());
              document.addEventListener('gestureend', e => e.preventDefault());
              // Drawer close behavior: tapping a link inside the menu
              // dismisses it (so the new page renders without the menu
              // overlay), and tapping anywhere outside also dismisses
              // it (covers any future case where the drawer isn't full-
              // screen). Native <details> doesn't auto-close on either.
              document.addEventListener('click', (e) => {
                const details = document.querySelector('details.nav-mobile');
                if (!details || !details.open) return;
                if (!e.target || !e.target.closest) return;
                const insideLink = e.target.closest('details.nav-mobile a');
                if (insideLink) {
                  details.open = false;
                  return;
                }
                if (e.target.closest('details.nav-mobile')) return;
                details.open = false;
              });
            `,
          }}
        />
      </head>
      <body>
        <div id="navigation">
          <div id="info">
            <Link className="infoButtons" href="/">
              ხარახლოპია
            </Link>
            {/* Desktop nav — floating-right links, hidden on mobile. */}
            <nav className="nav-desktop">
              <Link className="titleButtons" href="/add">
                დაამატე
              </Link>
              <Link className="titleButtons" href="/cascade">
                პოსტერი
              </Link>
              <Link className="titleButtons" href="/posterizer">
                გალერია
              </Link>
              <Link className="titleButtons" href="/">
                შრიფტები
              </Link>
            </nav>
            {/* Mobile nav — hamburger dropdown. Uses native <details>
                so no JS / no client component needed. */}
            <details className="nav-mobile">
              <summary className="nav-toggle" aria-label="menu">
                <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M4 7 H20 M4 12 H20 M4 17 H20"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                  />
                </svg>
              </summary>
              <nav className="nav-mobile-panel">
                <Link href="/add">დაამატე</Link>
                <Link href="/cascade">პოსტერი</Link>
                <Link href="/posterizer">გალერია</Link>
                <Link href="/">შრიფტები</Link>
              </nav>
            </details>
          </div>
          {children}
        </div>
      </body>
    </html>
  );
}
