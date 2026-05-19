import { redirect } from "next/navigation";

// The font-making flow lives at /add now (alongside direct-upload).
// This route stays as a redirect so old bookmarks/links keep working.
export default function MakePage() {
  redirect("/add");
}
