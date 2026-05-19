import { generateTemplatePdf } from "@/lib/font-pipeline/template";

export const dynamic = "force-dynamic";

export async function GET() {
  const bytes = await generateTemplatePdf();
  // Pass as a typed ArrayBuffer view to satisfy the Response BodyInit signature
  return new Response(new Uint8Array(bytes).buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="georgian-fonts-template.pdf"`,
    },
  });
}
