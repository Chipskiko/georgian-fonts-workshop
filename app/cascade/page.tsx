import { getFonts } from "@/lib/fonts";
import { CascadeStage } from "./CascadeStage";

export default async function CascadePage() {
  const fonts = await getFonts();
  return (
    <div id="contents">
      {/* fontFaceCss is no longer passed — layout.tsx already emits the
          full @font-face block in <head>, and html2canvas-pro reads
          from document.styleSheets so it finds the layout-level decls.
          See the comment in CascadeStage's JSX for the rationale. */}
      <CascadeStage initialFonts={fonts} />
    </div>
  );
}
