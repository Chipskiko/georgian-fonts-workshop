import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { unstable_cache } from "next/cache";
import { listAllBlobs } from "./blob-list-all";

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
  /** Public URL for the pre-computed B&W (grayscale) partner. Generated
   *  by the cascade at save time so per-tile + batch downloads can be
   *  instant fetches with no client-side conversion. Undefined for
   *  legacy posters uploaded before bnw partner generation was added;
   *  the gallery falls back to on-the-fly canvas conversion in that
   *  case (see Gallery.tsx fetchAndConvertToBnw). */
  bnwUrl?: string;
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

/** B&W partners follow the same naming convention as thumbs:
 *  `poster_<ts>_<rand>_bnw.jpg`. Cascade generates the bnw at save
 *  time and uploads it alongside the color file; listing pairs them
 *  the same way thumbs are paired. */
function isBnw(name: string): boolean {
  return /_bnw\.(jpe?g|png)$/i.test(name);
}

function fullToBnwName(full: string): string {
  return full.replace(/(\.[^.]+)$/, "_bnw$1");
}

function bnwToFullName(bnw: string): string {
  return bnw.replace(/_bnw(\.[^.]+)$/, "$1");
}

/** True when a file is a SIDECAR of another poster (thumb or bnw),
 *  not a poster in its own right. Used everywhere we filter posters
 *  out of an image listing — keep the parent posters, hide the
 *  sidecars from gallery rows. */
function isSidecar(name: string): boolean {
  return isThumb(name) || isBnw(name);
}

// --- Local FS adapter ----------------------------------------------------

function ensureFsDir() {
  if (!existsSync(POSTER_DIR_FS)) mkdirSync(POSTER_DIR_FS, { recursive: true });
}

function listFs(): StoredPoster[] {
  if (!existsSync(POSTER_DIR_FS)) return [];
  const entries = readdirSync(POSTER_DIR_FS, { withFileTypes: true });
  // First pass: collect all image filenames so sidecars (thumb + bnw)
  // can be paired against their parent posters in the second pass.
  const allImages: string[] = [];
  for (const e of entries) {
    if (!e.isFile() || !isImage(e.name)) continue;
    allImages.push(e.name);
  }
  const thumbSet = new Set(allImages.filter(isThumb));
  const bnwSet = new Set(allImages.filter(isBnw));
  const out: StoredPoster[] = [];
  for (const name of allImages) {
    // Sidecars (thumb/bnw) are listed only via their parent, never as
    // standalone posters in the gallery.
    if (isSidecar(name)) continue;
    const full = path.join(POSTER_DIR_FS, name);
    const st = statSync(full);
    const thumbName = fullToThumbName(name);
    const bnwName = fullToBnwName(name);
    const thumbUrl = thumbSet.has(thumbName)
      ? `/posters/${encodeURIComponent(thumbName)}`
      : undefined;
    const bnwUrl = bnwSet.has(bnwName)
      ? `/posters/${encodeURIComponent(bnwName)}`
      : undefined;
    out.push({
      id: name,
      url: `/posters/${encodeURIComponent(name)}`,
      thumbUrl,
      bnwUrl,
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
  // Delete the full poster + every sidecar (thumb + bnw). Best-effort
  // on sidecars — a leftover sidecar is harmless (orphaned without a
  // parent poster, never surfaces in the gallery) but we try anyway.
  if (existsSync(dest)) await unlink(dest);
  for (const siblingName of [fullToThumbName(safe), fullToBnwName(safe)]) {
    const sibling = path.join(POSTER_DIR_FS, siblingName);
    if (existsSync(sibling)) {
      try {
        await unlink(sibling);
      } catch {
        /* ok — leftover sidecar is harmless */
      }
    }
  }
}

// --- Vercel Blob adapter -------------------------------------------------

async function listBlob(): Promise<StoredPoster[]> {
  const blobs = await listAllBlobs(BLOB_PREFIX);
  // Build lookups of sidecar-name → URL so the parent-poster pass can
  // pair each full poster with its thumb + bnw partners. Single Blob
  // list call covers all three (full + thumb + bnw) — doesn't multiply
  // the network cost.
  const imageBlobs = blobs.filter((b) => isImage(b.pathname));
  const thumbByFull = new Map<string, string>();
  const bnwByFull = new Map<string, string>();
  for (const b of imageBlobs) {
    const filename = b.pathname.replace(BLOB_PREFIX, "");
    if (isThumb(filename)) {
      thumbByFull.set(thumbToFullName(filename), b.url);
    } else if (isBnw(filename)) {
      bnwByFull.set(bnwToFullName(filename), b.url);
    }
  }
  return imageBlobs
    .filter((b) => !isSidecar(b.pathname.replace(BLOB_PREFIX, "")))
    .map((b) => {
      const filename = b.pathname.replace(BLOB_PREFIX, "");
      const createdAt = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
      return {
        id: filename,
        url: b.url,
        thumbUrl: thumbByFull.get(filename),
        bnwUrl: bnwByFull.get(filename),
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
  const { del } = await import("@vercel/blob");
  // Delete the full poster + every sidecar (thumb + bnw). Single
  // list() call with the shared timestamp prefix finds all three.
  const stem = filename.replace(/\.[^.]+$/, "");
  const blobs = await listAllBlobs(`${BLOB_PREFIX}${stem}`);
  const fullPath = `${BLOB_PREFIX}${filename}`;
  const thumbPath = `${BLOB_PREFIX}${fullToThumbName(filename)}`;
  const bnwPath = `${BLOB_PREFIX}${fullToBnwName(filename)}`;
  const urlsToDelete: string[] = [];
  for (const b of blobs) {
    if (b.pathname === fullPath || b.pathname === thumbPath || b.pathname === bnwPath) {
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

/** Derive the B&W partner filename from a full-poster filename.
 *  poster_X_y.jpg → poster_X_y_bnw.jpg. */
export function bnwFilenameFor(fullFilename: string): string {
  return fullToBnwName(fullFilename);
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
