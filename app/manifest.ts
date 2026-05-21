import type { MetadataRoute } from "next";

/** PWA manifest. Participants can tap Share → "Add to Home Screen" in
 * iOS Safari (or "Install" in Android Chrome) to launch the site in
 * standalone mode — no URL bar, no input accessory bar, no browser
 * chrome. Starts on /cascade so workshop participants land directly
 * in the maker. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ხარახლოპია",
    short_name: "ხარახლოპია",
    description: "Georgian fonts workshop — make fonts, make posters.",
    start_url: "/cascade",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ff10b8",
    theme_color: "#ff10b8",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
