import { getFonts, fontFaceCss } from "@/lib/fonts";
import { Posterizer } from "./Posterizer";

export default async function PosterizerPage() {
  const fonts = await getFonts();
  return (
    <div id="contents">
      <Posterizer initialFonts={fonts} cssFontFaces={fontFaceCss(fonts)} />
    </div>
  );
}
