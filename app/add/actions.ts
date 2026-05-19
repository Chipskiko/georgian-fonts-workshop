"use server";

import path from "node:path";
import { revalidatePath } from "next/cache";
import {
  saveFont,
  deleteFont as storageDeleteFont,
  dedupeFontFilename,
} from "@/lib/font-storage";

const ALLOWED_EXT = [".ttf", ".otf", ".woff", ".woff2"];
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
// Read admin password from env in production. Falls back to the original
// hard-coded workshop password for local dev. In Vercel, set
// ADMIN_PASSWORD as an environment variable so it isn't visible in the
// repo.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "vividxura";

function safeSegment(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[/\\?%*:|"<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function uploadFont(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const file = formData.get("file");
  const fontName = (formData.get("fontName") as string | null)?.trim() ?? "";
  const designer = (formData.get("designer") as string | null)?.trim() ?? "";

  if (!(file instanceof File)) return { ok: false, message: "no file selected" };
  if (file.size === 0) return { ok: false, message: "empty file" };
  if (file.size > MAX_BYTES) return { ok: false, message: `file too large (max ${MAX_BYTES / 1024 / 1024}MB)` };

  const originalExt = path.extname(file.name).toLowerCase();
  if (!ALLOWED_EXT.includes(originalExt)) {
    return { ok: false, message: `unsupported format. use ${ALLOWED_EXT.join(", ")}` };
  }

  const baseName = safeSegment(fontName || path.basename(file.name, originalExt));
  if (!baseName) return { ok: false, message: "name required" };

  const cleanDesigner = safeSegment(designer);
  const requested = cleanDesigner ? `${baseName}__${cleanDesigner}${originalExt}` : `${baseName}${originalExt}`;
  const finalName = await dedupeFontFilename(requested);

  const buffer = Buffer.from(await file.arrayBuffer());
  await saveFont(finalName, buffer);

  revalidatePath("/");
  revalidatePath("/cascade");
  revalidatePath("/add");
  revalidatePath("/posterizer");

  return { ok: true, message: `uploaded ${finalName}` };
}

export async function checkPassword(password: string): Promise<boolean> {
  return password === ADMIN_PASSWORD;
}

export async function deleteFont(filename: string, password: string): Promise<{ ok: boolean; message: string }> {
  if (password !== ADMIN_PASSWORD) {
    return { ok: false, message: "wrong password" };
  }

  const safe = path.basename(filename);
  if (!safe || safe !== filename) {
    return { ok: false, message: "invalid filename" };
  }
  const ext = path.extname(safe).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    return { ok: false, message: "not a font file" };
  }

  try {
    await storageDeleteFont(safe);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "delete failed" };
  }

  revalidatePath("/");
  revalidatePath("/cascade");
  revalidatePath("/add");
  revalidatePath("/posterizer");
  return { ok: true, message: `deleted ${safe}` };
}
