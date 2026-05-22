import { generateTemplatePdf } from "@/lib/font-pipeline/template";

// force-static prerenders this route at BUILD time and serves the bytes
// as a static asset from Vercel's CDN — zero runtime CPU per QR scan.
// The PDF is fully deterministic (same markers + grid + QR + alphabet
// always), so caching forever is correct. If we ever want to change the
// template, bumping the deploy regenerates it.
export const dynamic = "force-static";

export async function GET() {
  const bytes = await generateTemplatePdf();
  // Pass as a typed ArrayBuffer view to satisfy the Response BodyInit signature
  return new Response(new Uint8Array(bytes).buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="georgian-fonts-template.pdf"`,
      // Belt + suspenders: force-static handles Next-side caching;
      // immutable + max-age=1yr tells every downstream CDN/browser to
      // hold onto it for a year. Workshop participants who scan the QR
      // on their phone get the file from device cache on second tap.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
