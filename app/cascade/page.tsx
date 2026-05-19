import { getFonts } from "@/lib/fonts";
import { CascadeStage } from "./CascadeStage";

export default async function CascadePage() {
  const fonts = await getFonts();
  return <CascadeStage fontIds={fonts.map((f) => f.id)} />;
}
