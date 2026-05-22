"use server";

import { revalidatePath, updateTag } from "next/cache";
import {
  listPosters as storageList,
  savePoster as storageSave,
  deletePoster as storageDelete,
  newPosterFilename,
  thumbFilenameFor,
  type StoredPoster,
} from "@/lib/poster-storage";
import { passwordsMatch } from "@/lib/auth";

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB — generous for an A4 image at 2x
const MAX_THUMB_BYTES = 512 * 1024; // 0.5 MB — thumbs should be << 100KB
const ALLOWED_MIMES = new Set(["image/png", "image/jpeg"]);

/** Upload a poster (JPEG or PNG) + optional thumbnail. Called from
 *  cascade when a poster is saved. The thumb is a smaller version of
 *  the same image and is paired by filename convention
 *  (poster_X.jpg → poster_X_thumb.jpg). Saving the thumb is best-effort:
 *  if it fails, the gallery falls back to the full image. */
export async function uploadPoster(
  formData: FormData,
): Promise<{ ok: boolean; message: string; id?: string }> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, message: "ფაილი არ არის" };
  if (file.size === 0) return { ok: false, message: "ცარიელი ფაილი" };
  if (file.size > MAX_BYTES) {
    return { ok: false, message: `ფაილი ძალიან დიდია (მაქს ${MAX_BYTES / 1024 / 1024}MB)` };
  }
  if (file.type && !ALLOWED_MIMES.has(file.type)) {
    return { ok: false, message: "უნდა იყოს PNG ან JPG" };
  }

  // Derive the extension from the uploaded MIME so .png uploads still
  // work even after the cascade switched to JPEG output.
  const ext = file.type === "image/png" ? ".png" : ".jpg";
  const filename = newPosterFilename(ext);
  const buffer = Buffer.from(await file.arrayBuffer());
  const saved = await storageSave(filename, buffer);

  // Optional thumbnail — paired by filename. Stored alongside the full
  // poster; listPosters in poster-storage pairs them. Failure here
  // doesn't fail the upload (gallery falls back to the full image).
  const thumb = formData.get("thumb");
  if (thumb instanceof File && thumb.size > 0 && thumb.size <= MAX_THUMB_BYTES) {
    if (!thumb.type || ALLOWED_MIMES.has(thumb.type)) {
      const thumbName = thumbFilenameFor(filename);
      const thumbBuf = Buffer.from(await thumb.arrayBuffer());
      try {
        await storageSave(thumbName, thumbBuf);
      } catch {
        // ok — gallery handles missing thumb.
      }
    }
  }

  revalidatePath("/posterizer");
  // Tag invalidation lets unstable_cache wrappers drop their cached
  // poster list immediately, so the next gallery poll sees the new
  // upload without waiting for the TTL.
  updateTag("posters-list");
  return { ok: true, message: `შენახულია ${saved.id}`, id: saved.id };
}

/** List posters, newest first. */
export async function listPosters(): Promise<StoredPoster[]> {
  return await storageList();
}

/** Admin-only delete. Also wipes the paired thumb (handled by the
 *  storage adapter). */
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
  updateTag("posters-list");
  return { ok: true, message: `წაშლილია ${filename}` };
}

/** Manual refresh — invalidates the cached poster list, then re-fetches.
 *  Used by the gallery's refresh button so the user can force-update
 *  even between the polling intervals. */
export async function refreshPosters(): Promise<StoredPoster[]> {
  updateTag("posters-list");
  return await storageList();
}
