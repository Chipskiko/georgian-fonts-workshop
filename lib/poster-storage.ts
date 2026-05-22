import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { unstable_cache } from "next/cache";

/** Cache tag for the poster list. Server actions that mutate posters
 *  (uploadPoster, deletePoster) call revalidateTag with this string so
 *  background gallery polls see the new state on their next call. */
export const POSTERS_LIST_TAG = "posters-list";

/**
 * Storage adapter for workshop posters (image snapshots from cascade).
 *
 * - Local dev (no BLOB_READ_WRITE_TOKEN): reads/writes from public/posters/
 * - On Vercel (BLOB_READ_WRITE_TOKEN set): reads/writes via @vercel/blob
 *
 * Filenames are timestamp-based so newest-first ordering is trivial.
 *
 * Accepts both .png (legacy uploads from before we switched cascade to
 * JPEG output) and .jpg / .jpeg (current format). Listing pairs each
 * full poster with its corresponding `_thumb.<ext>` sibling so the
 * gallery can render small thumbs in the grid and only load the full
 * image when the lightbox opens.
 */

export type StoredPoster = {
  /** Full poster filename (including extension). Unique id. */
  id: string;
  /** Public URL for the full-resolution poster. */
  url: string;
  /** Public URL for the smaller gallery thumbnail. Undefined for
   *  legacy posters uploaded before thumbnail generation was added. */
  thumbUrl?: string;
  /** Epoch ms — for sorting newest-first. */
  createdAt: number;
};

const POSTER_DIR_FS = path.join(process.cwd(), "public", "posters");
const BLOB_PREFIX = "posters/";

function useBlob(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg"]);
// Per-extension Content-Type for Blob uploads. See lib/font-storage.ts
// for the rationale — mismatched MIMEs caused fonts to silently fail
// to render. Belt-and-suspenders the poster path the same way.
const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function isImage(name: string): boolean {
  return ALLOWED_EXT.has(path.extname(name).toLowerCase());
}

/** Thumbnails are named like `poster_<ts>_<rand>_thumb.jpg` — the same
 *  basename as their parent with `_thumb` appended before the extension.
 *  Pairing logic relies on this convention. */
function isThumb(name: string): boolean {
  return /_thumb\.(jpe?g|png)$/i.test(name);
}

function fullToThumbName(full: string): string {
  return full.replace(/(\.[^.]+)$/, "_thumb$1");
}

function thumbToFullName(thumb: string): string {
  return thumb.replace(/_thumb(\.[^.]+)$/, "$1");
}

// --- Local FS adapter ----------------------------------------------------

function ensureFsDir() {
  if (!existsSync(POSTER_DIR_FS)) mkdirSync(POSTER_DIR_FS, { recursive: true });
}

function listFs(): StoredPoster[] {
  if (!existsSync(POSTER_DIR_FS)) return [];
  const entries = readdirSync(POSTER_DIR_FS, { withFileTypes: true });
  // First pass: collect all image filenames so thumbs can be paired.
  const allImages: string[] = [];
  for (const e of entries) {
    if (!e.isFile() || !isImage(e.name)) continue;
    allImages.push(e.name);
  }
  const thumbSet = new Set(allImages.filter(isThumb));
  const out: StoredPoster[] = [];
  for (const name of allImages) {
    if (isThumb(name)) continue; // thumbs aren't shown as separate posters
    const full = path.join(POSTER_DIR_FS, name);
    const st = statSync(full);
    const thumbName = fullToThumbName(name);
    const thumbUrl = thumbSet.has(thumbName)
      ? `/posters/${encodeURIComponent(thumbName)}`
      : undefined;
    out.push({
      id: name,
      url: `/posters/${encodeURIComponent(name)}`,
      thumbUrl,
      createdAt: st.mtimeMs,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function saveFs(filename: string, bytes: Buffer): Promise<StoredPoster> {
  // See lib/font-storage.ts for rationale — Vercel filesystem is read-only.
  if (process.env.VERCEL) {
    throw new Error(
      "Blob ფაილსაცავი არ არის კონფიგურირებული — დააყენე BLOB_READ_WRITE_TOKEN.",
    );
  }
  ensureFsDir();
  const safe = path.basename(filename);
  if (!safe || safe !== filename) throw new Error("არასწორი პოსტერის ფაილის სახელი");
  if (!isImage(safe)) throw new Error("პოსტერი უნდა იყოს PNG / JPG");
  const dest = path.join(POSTER_DIR_FS, safe);
  if (path.relative(POSTER_DIR_FS, dest).startsWith("..")) {
    throw new Error("არასწორი პოსტერის მისამართი");
  }
  await writeFile(dest, bytes);
  const st = statSync(dest);
  return {
    id: safe,
    url: `/posters/${encodeURIComponent(safe)}`,
    createdAt: st.mtimeMs,
  };
}

async function deleteFs(filename: string): Promise<void> {
  const safe = path.basename(filename);
  if (!safe || safe !== filename) throw new Error("არასწორი ფაილის სახელი");
  if (!isImage(safe)) throw new Error("არ არის პოსტერის ფაილი");
  const dest = path.join(POSTER_DIR_FS, safe);
  if (path.relative(POSTER_DIR_FS, dest).startsWith("..")) throw new Error("არასწორი მისამართი");
  // Delete the full poster + its thumb sibling (best-effort on thumb).
  if (existsSync(dest)) await unlink(dest);
  const thumbDest = path.join(POSTER_DIR_FS, fullToThumbName(safe));
  if (existsSync(thumbDest)) {
    try {
      await unlink(thumbDest);
    } catch {
      /* ok — leftover thumb is harmless */
    }
  }
}

// --- Vercel Blob adapter -------------------------------------------------

async function listBlob(): Promise<StoredPoster[]> {
  const { list } = await import("@vercel/blob");
  const { blobs } = await list({ prefix: BLOB_PREFIX });
  // Build a lookup of thumb-name → URL so the second pass can pair each
  // full poster with its corresponding thumb. Single Blob list call —
  // doesn't double the network cost.
  const imageBlobs = blobs.filter((b) => isImage(b.pathname));
  const thumbByFull = new Map<string, string>();
  for (const b of imageBlobs) {
    const filename = b.pathname.replace(BLOB_PREFIX, "");
    if (isThumb(filename)) {
      thumbByFull.set(thumbToFullName(filename), b.url);
    }
  }
  return imageBlobs
    .filter((b) => !isThumb(b.pathname.replace(BLOB_PREFIX, "")))
    .map((b) => {
      const filename = b.pathname.replace(BLOB_PREFIX, "");
      const createdAt = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
      return {
        id: filename,
        url: b.url,
        thumbUrl: thumbByFull.get(filename),
        createdAt,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function saveBlob(filename: string, bytes: Buffer): Promise<StoredPoster> {
  if (!isImage(filename)) throw new Error("პოსტერი უნდა იყოს PNG / JPG");
  const { put } = await import("@vercel/blob");
  const ext = path.extname(filename).toLowerCase();
  const contentType = EXT_TO_MIME[ext] ?? "application/octet-stream";
  const blob = await put(`${BLOB_PREFIX}${filename}`, bytes, {
    access: "public",
    addRandomSuffix: false,
    contentType,
  });
  return {
    id: filename,
    url: blob.url,
    createdAt: Date.now(),
  };
}

async function deleteBlob(filename: string): Promise<void> {
  if (!isImage(filename)) throw new Error("არ არის პოსტერის ფაილი");
  const { del, list } = await import("@vercel/blob");
  // Delete the full poster + its thumb sibling. Single list() call
  // (with the shared timestamp prefix) finds both at once.
  const stem = filename.replace(/\.[^.]+$/, "");
  const { blobs } = await list({ prefix: `${BLOB_PREFIX}${stem}` });
  const fullPath = `${BLOB_PREFIX}${filename}`;
  const thumbPath = `${BLOB_PREFIX}${fullToThumbName(filename)}`;
  const urlsToDelete: string[] = [];
  for (const b of blobs) {
    if (b.pathname === fullPath || b.pathname === thumbPath) {
      urlsToDelete.push(b.url);
    }
  }
  for (const url of urlsToDelete) {
    try {
      await del(url);
    } catch {
      // Best-effort: if a sibling was already deleted, ignore.
    }
  }
}

// --- Public API ----------------------------------------------------------

/** Generate a unique poster filename using timestamp + short random
 *  suffix. Defaults to .jpg (the current cascade output); pass an
 *  explicit ext if you need .png for compatibility. */
export function newPosterFilename(ext: string = ".jpg"): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `poster_${ts}_${rand}${ext}`;
}

/** Derive the thumbnail filename from a full-poster filename.
 *  poster_X_y.jpg → poster_X_y_thumb.jpg. */
export function thumbFilenameFor(fullFilename: string): string {
  return fullToThumbName(fullFilename);
}

async function _listPosters(): Promise<StoredPoster[]> {
  return useBlob() ? await listBlob() : listFs();
}

// Cache the poster list. The gallery polls every 30s — without this,
// each poll fires a fresh Blob list() call. With it, polls share a
// single cached result for 30s. Tag-invalidated on upload/delete so a
// new poster appears on the very next poll regardless of TTL.
export const listPosters = unstable_cache(_listPosters, ["posters-list"], {
  tags: [POSTERS_LIST_TAG],
  revalidate: 30,
});

export async function savePoster(filename: string, bytes: Buffer): Promise<StoredPoster> {
  return useBlob() ? await saveBlob(filename, bytes) : await saveFs(filename, bytes);
}

export async function deletePoster(filename: string): Promise<void> {
  return useBlob() ? await deleteBlob(filename) : await deleteFs(filename);
}

/** Load image bytes for a poster (used by server-side rendering, e.g. download). */
export async function getPosterBytes(filename: string): Promise<Uint8Array | null> {
  if (!isImage(filename)) return null;
  if (useBlob()) {
    const posters = await listBlob();
    const p = posters.find((x) => x.id === filename);
    if (!p) return null;
    const res = await fetch(p.url);
    return new Uint8Array(await res.arrayBuffer());
  }
  const safe = path.basename(filename);
  const full = path.join(POSTER_DIR_FS, safe);
  if (!existsSync(full)) return null;
  return new Uint8Array(readFileSync(full));
}
