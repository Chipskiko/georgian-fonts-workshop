"use server";

import { revalidatePath } from "next/cache";
import {
  listPosters as storageList,
  savePoster as storageSave,
  deletePoster as storageDelete,
  newPosterFilename,
  type StoredPoster,
} from "@/lib/poster-storage";
import { passwordsMatch } from "@/lib/auth";

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB — generous for an A4 PNG at 2x

/** Upload a poster PNG. Called from cascade when a poster fills up. */
export async function uploadPoster(
  formData: FormData,
): Promise<{ ok: boolean; message: string; id?: string }> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, message: "ფაილი არ არის" };
  if (file.size === 0) return { ok: false, message: "ცარიელი ფაილი" };
  if (file.size > MAX_BYTES) {
    return { ok: false, message: `ფაილი ძალიან დიდია (მაქს ${MAX_BYTES / 1024 / 1024}MB)` };
  }
  if (file.type && file.type !== "image/png") {
    return { ok: false, message: "უნდა იყოს PNG" };
  }

  const filename = newPosterFilename();
  const buffer = Buffer.from(await file.arrayBuffer());
  const saved = await storageSave(filename, buffer);

  revalidatePath("/posterizer");
  return { ok: true, message: `შენახულია ${saved.id}`, id: saved.id };
}

/** List posters, newest first. */
export async function listPosters(): Promise<StoredPoster[]> {
  return await storageList();
}

/** Admin-only delete. */
export async function deletePoster(
  filename: string,
  password: string,
): Promise<{ ok: boolean; message: string }> {
  if (!passwordsMatch(password)) {
    return { ok: false, message: "მცდარი პაროლი" };
  }
  try {
    await storageDelete(filename);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "წაშლა ვერ მოხერხდა" };
  }
  revalidatePath("/posterizer");
  return { ok: true, message: `წაშლილია ${filename}` };
}
