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
