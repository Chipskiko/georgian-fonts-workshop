import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Storage adapter for workshop posters (PNG snapshots from cascade).
 *
 * - Local dev (no BLOB_READ_WRITE_TOKEN): reads/writes from public/posters/
 * - On Vercel (BLOB_READ_WRITE_TOKEN set): reads/writes via @vercel/blob
 *
 * Filenames are timestamp-based so newest-first ordering is trivial.
 */

export type StoredPoster = {
  /** Filename including .png extension. Used as the unique id. */
  id: string;
  /** URL the browser uses to fetch the image. */
  url: string;
  /** Epoch ms — for sorting newest-first. */
  createdAt: number;
};

const POSTER_DIR_FS = path.join(process.cwd(), "public", "posters");
const BLOB_PREFIX = "posters/";

function useBlob(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function isPng(name: string): boolean {
  return path.extname(name).toLowerCase() === ".png";
}

// --- Local FS adapter ----------------------------------------------------

function ensureFsDir() {
  if (!existsSync(POSTER_DIR_FS)) mkdirSync(POSTER_DIR_FS, { recursive: true });
}

function listFs(): StoredPoster[] {
  if (!existsSync(POSTER_DIR_FS)) return [];
  const entries = readdirSync(POSTER_DIR_FS, { withFileTypes: true });
  const out: StoredPoster[] = [];
  for (const e of entries) {
    if (!e.isFile() || !isPng(e.name)) continue;
    const full = path.join(POSTER_DIR_FS, e.name);
    const st = statSync(full);
    out.push({
      id: e.name,
      url: `/posters/${encodeURIComponent(e.name)}`,
      createdAt: st.mtimeMs,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function saveFs(filename: string, bytes: Buffer): Promise<StoredPoster> {
  // See lib/font-storage.ts for rationale — Vercel filesystem is read-only.
  if (process.env.VERCEL) {
    throw new Error(
      "Blob storage not configured — set BLOB_READ_WRITE_TOKEN (Vercel project → Storage tab → connect Blob).",
    );
  }
  ensureFsDir();
  const safe = path.basename(filename);
  if (!safe || safe !== filename) throw new Error("invalid poster filename");
  if (!isPng(safe)) throw new Error("poster must be .png");
  const dest = path.join(POSTER_DIR_FS, safe);
  if (path.relative(POSTER_DIR_FS, dest).startsWith("..")) {
    throw new Error("invalid poster path");
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
  if (!safe || safe !== filename) throw new Error("invalid filename");
  if (!isPng(safe)) throw new Error("not a poster file");
  const dest = path.join(POSTER_DIR_FS, safe);
  if (path.relative(POSTER_DIR_FS, dest).startsWith("..")) throw new Error("invalid path");
  if (!existsSync(dest)) return;
  await unlink(dest);
}

// --- Vercel Blob adapter -------------------------------------------------

async function listBlob(): Promise<StoredPoster[]> {
  const { list } = await import("@vercel/blob");
  const { blobs } = await list({ prefix: BLOB_PREFIX });
  return blobs
    .filter((b) => isPng(b.pathname))
    .map((b) => {
      const filename = b.pathname.replace(BLOB_PREFIX, "");
      // Vercel Blob returns `uploadedAt` as a Date.
      const createdAt = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
      return {
        id: filename,
        url: b.url,
        createdAt,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function saveBlob(filename: string, bytes: Buffer): Promise<StoredPoster> {
  if (!isPng(filename)) throw new Error("poster must be .png");
  const { put } = await import("@vercel/blob");
  const blob = await put(`${BLOB_PREFIX}${filename}`, bytes, {
    access: "public",
    addRandomSuffix: false,
    contentType: "image/png",
  });
  return {
    id: filename,
    url: blob.url,
    createdAt: Date.now(),
  };
}

async function deleteBlob(filename: string): Promise<void> {
  if (!isPng(filename)) throw new Error("not a poster file");
  const { del, list } = await import("@vercel/blob");
  const { blobs } = await list({ prefix: `${BLOB_PREFIX}${filename}` });
  const target = blobs.find((b) => b.pathname === `${BLOB_PREFIX}${filename}`);
  if (!target) return;
  await del(target.url);
}

// --- Public API ----------------------------------------------------------

/** Generate a unique poster filename using timestamp + short random suffix. */
export function newPosterFilename(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `poster_${ts}_${rand}.png`;
}

export async function listPosters(): Promise<StoredPoster[]> {
  return useBlob() ? await listBlob() : listFs();
}

export async function savePoster(filename: string, bytes: Buffer): Promise<StoredPoster> {
  return useBlob() ? await saveBlob(filename, bytes) : await saveFs(filename, bytes);
}

export async function deletePoster(filename: string): Promise<void> {
  return useBlob() ? await deleteBlob(filename) : await deleteFs(filename);
}

/** Load PNG bytes for a poster (used by server-side rendering, e.g. download). */
export async function getPosterBytes(filename: string): Promise<Uint8Array | null> {
  if (!isPng(filename)) return null;
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
