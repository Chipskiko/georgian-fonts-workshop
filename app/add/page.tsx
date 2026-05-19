import { getFonts } from "@/lib/fonts";
import { UploadForm } from "./UploadForm";
import { AdminPanel } from "./AdminPanel";
import { MakeFontForm } from "../make/MakeFontForm";

export default async function AddPage() {
  const fonts = await getFonts();
  return (
    <div id="contents">
      <div className="add-page">
        <MakeFontForm />

        <UploadForm />

        <div className="admin-section">
          <h3>admin</h3>
          <AdminPanel fonts={fonts} />
        </div>
      </div>
    </div>
  );
}
