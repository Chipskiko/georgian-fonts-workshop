import { getFonts } from "@/lib/fonts";
import { UploadForm } from "./UploadForm";
import { AdminPanel } from "./AdminPanel";
import { MakeFontForm } from "../make/MakeFontForm";

export default async function AddPage() {
  const fonts = await getFonts();
  return (
    <div id="contents">
      {/* Wrapper carries the full-width top border so it matches the
          home/cascade/gallery pages. The inner .add-page keeps a
          max-width so the form doesn't sprawl on wide monitors. */}
      <div className="add-page-wrap">
        <div className="add-page">
          <MakeFontForm />

          <UploadForm />

          <div className="admin-section">
            <h3>ადმინი</h3>
            <AdminPanel fonts={fonts} />
          </div>
        </div>
      </div>
    </div>
  );
}
