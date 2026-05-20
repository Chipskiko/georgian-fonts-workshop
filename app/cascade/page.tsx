import { getFonts, fontFaceCss } from "@/lib/fonts";
import { CascadeStage } from "./CascadeStage";

export default async function CascadePage() {
  const fonts = await getFonts();
  return (
    <div id="contents">
      <CascadeStage initialFonts={fonts} cssFontFaces={fontFaceCss(fonts)} />
    </div>
  );
}
