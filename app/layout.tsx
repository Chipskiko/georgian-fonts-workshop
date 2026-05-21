import type { Metadata } from "next";
import "./globals.css";
import { fontFaceCss, getFonts } from "@/lib/fonts";
import Link from "next/link";

export const metadata: Metadata = {
  title: "georgian fonts workshop",
  description: "custom georgian typography from the workshop.",
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
                პოსტერიზატორი
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
                <Link href="/cascade">პოსტერიზატორი</Link>
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
