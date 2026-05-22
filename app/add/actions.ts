"use server";

import path from "node:path";
import { revalidatePath, updateTag } from "next/cache";
import {
  saveFont,
  deleteFont as storageDeleteFont,
} from "@/lib/font-storage";
import { FONTS_LIST_TAG } from "@/lib/fonts";
import { passwordsMatch } from "@/lib/auth";

const ALLOWED_EXT = [".ttf", ".otf", ".woff", ".woff2"];
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

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

  if (!(file instanceof File)) return { ok: false, message: "ფაილი არ არის არჩეული" };
  if (file.size === 0) return { ok: false, message: "ცარიელი ფაილი" };
  if (file.size > MAX_BYTES) return { ok: false, message: `ფაილი ძალიან დიდია (მაქს ${MAX_BYTES / 1024 / 1024}MB)` };

  const originalExt = path.extname(file.name).toLowerCase();
  if (!ALLOWED_EXT.includes(originalExt)) {
    return { ok: false, message: `მხარდაუჭერელი ფორმატი. გამოიყენე ${ALLOWED_EXT.join(", ")}` };
  }

  const baseName = safeSegment(fontName || path.basename(file.name, originalExt));
  if (!baseName) return { ok: false, message: "სახელი სავალდებულოა" };

  const cleanDesigner = safeSegment(designer);
  const requested = cleanDesigner ? `${baseName}__${cleanDesigner}${originalExt}` : `${baseName}${originalExt}`;

  // saveFont appends its own collision-safe random suffix, so dedupe
  // (a non-atomic check-then-write) is no longer needed.
  const buffer = Buffer.from(await file.arrayBuffer());
  const saved = await saveFont(requested, buffer);
  const finalName = saved.filename;

  // Drop the cached font list so layout + pages see the new upload on
  // the very next request. revalidatePath('layout') invalidates the
  // root layout's tree (where getFonts() is called); the tag matches
  // the unstable_cache wrapper around getFonts().
  updateTag(FONTS_LIST_TAG);
  revalidatePath("/", "layout");

  return { ok: true, message: `ატვირთულია ${finalName}` };
}

export async function checkPassword(password: string): Promise<boolean> {
  return passwordsMatch(password);
}

export async function deleteFont(filename: string, password: string): Promise<{ ok: boolean; message: string }> {
  if (!passwordsMatch(password)) {
    return { ok: false, message: "მცდარი პაროლი" };
  }

  const safe = path.basename(filename);
  if (!safe || safe !== filename) {
    return { ok: false, message: "არასწორი ფაილის სახელი" };
  }
  const ext = path.extname(safe).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    return { ok: false, message: "არ არის შრიფტის ფაილი" };
  }

  try {
    await storageDeleteFont(safe);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "წაშლა ვერ მოხერხდა" };
  }

  updateTag(FONTS_LIST_TAG);
  revalidatePath("/", "layout");
  return { ok: true, message: `წაშლილია ${safe}` };
}
