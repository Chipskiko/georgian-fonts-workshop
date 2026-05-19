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
              georgian fonts
            </Link>
            <Link className="titleButtons" href="/add">
              დაამატე
            </Link>
            <Link className="titleButtons" href="/make">
              შექმენი
            </Link>
            <Link className="titleButtons" href="/posterizer">
              პოსტერიზატორი
            </Link>
            <Link className="titleButtons" href="/cascade">
              კასკადი
            </Link>
            <Link className="titleButtons" href="/">
              შრიფტები
            </Link>
          </div>
          {children}
        </div>
      </body>
    </html>
  );
}
