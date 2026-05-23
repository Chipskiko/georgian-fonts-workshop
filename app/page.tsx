import { getFonts, GEORGIAN_ALPHABET } from "@/lib/fonts";
import { FontRow } from "./FontRow";
import { RefreshFontsButton } from "./RefreshFontsButton";

export default async function BrowsePage() {
  const fonts = await getFonts();

  if (fonts.length === 0) {
    return (
      <div id="contents">
        <div className="empty-msg">
          no fonts yet. drop <code>.ttf</code> / <code>.otf</code> / <code>.woff</code> files into{" "}
          <code>public/fonts/</code> and refresh. name the file{" "}
          <code>FontName__DesignerName.ttf</code> to display the designer.
        </div>
      </div>
    );
  }

  return (
    <div id="contents">
      {/* Refresh button — fallback when fonts don't render correctly on
          a participant's device. Forces re-fetch of layout's <style>
          block + every @font-face binary. */}
      <RefreshFontsButton />
      {fonts.map((f) => (
        <FontRow key={f.id} font={f} alphabet={GEORGIAN_ALPHABET.join(" ")} />
      ))}
    </div>
  );
}
