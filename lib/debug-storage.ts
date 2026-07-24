import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Storage adapter for ephemeral debug images (per-stage scan
 * visualizations from the /add "debug" button).
 *
 * Why this exists separate from the inline-base64 path:
 * React Server Component serialization has an `_arraySizeLimit` of
 * 1,000,000 on the wire-format string length. A high-res phone scan
 * baked through renderDebugOverlay at q90 can easily exceed 1 MB →
 * ~1.33 MB base64 → over the ceiling. The action then fails with a
 * generic "Server Components render" error in Vercel production and
 * the client sees nothing useful. Pushing the image out-of-band to
 * Blob storage and returning only the URL sidesteps the limit.
 *
 * Lifecycle: debug images are short-lived (you look at them once,
 * dismiss). Two cleanup paths keep storage bounded:
 *   1. Client calls deleteDebugImage(url) from <img onLoad/onError>
 *      so the typical happy path frees the blob within seconds.
 *   2. sweepOldDebugImages() runs at the start of each new debugScan
 *      call and reaps anything older than DEBUG_TTL_MS. Covers the
 *      "user closed the tab before image loaded" leak.
 *
 * - Local dev (no BLOB_READ_WRITE_TOKEN): writes to public/debug/
 *   and returns a relative URL (`/debug/<name>`).
 * - On Vercel (BLOB_READ_WRITE_TOKEN set): puts under `debug/` prefix
 *   and returns the absolute Blob URL.
 */

const DEBUG_DIR_FS = path.join(process.cwd(), "public", "debug");
const BLOB_PREFIX = "debug/";

/** TTL for opportunistic sweep — debug images older than this get
 *  garbage-collected on the next debug invocation. 5 min comfortably
 *  outlives the "look at the image and decide what to tweak" window
 *  without leaving stale files around for very long. */
const DEBUG_TTL_MS = 5 * 60 * 1000;

function useBlob(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/** Generate a collision-resistant debug filename. Timestamp prefix
 *  lets the sweep filter on age via the filename (cheap) when the
 *  storage backend doesn't expose mtime efficiently. */
export function newDebugFilename(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `debug_${ts}_${rand}.jpg`;
}

/** Parse the embedded timestamp from a debug filename. Returns 0 if
 *  the name doesn't match the expected pattern (treat-as-old, will
 *  get swept on next invocation). */
function tsFromFilename(name: string): number {
  const m = /^debug_(\d+)_/.exec(name);
  return m ? Number(m[1]) : 0;
}

// --- Local FS adapter ----------------------------------------------------

function ensureFsDir() {
  if (!existsSync(DEBUG_DIR_FS)) mkdirSync(DEBUG_DIR_FS, { recursive: true });
}

async function saveFs(filename: string, bytes: Buffer): Promise<string> {
  ensureFsDir();
  const full = path.join(DEBUG_DIR_FS, filename);
  await writeFile(full, bytes);
  return `/debug/${encodeURIComponent(filename)}`;
}

function deleteFsByUrl(url: string): void {
  // URL is `/debug/<encoded-filename>` in FS mode. Strip the prefix
  // and decode. Defensive: refuse anything that escapes the dir.
  const m = /^\/debug\/(.+)$/.exec(url);
  if (!m) return;
  const filename = decodeURIComponent(m[1]);
  if (filename.includes("/") || filename.includes("..")) return;
  const full = path.join(DEBUG_DIR_FS, filename);
  if (!existsSync(full)) return;
  try {
    unlinkSync(full);
  } catch {
    /* best-effort — already gone is fine */
  }
}

function sweepFs(): number {
  if (!existsSync(DEBUG_DIR_FS)) return 0;
  const cutoff = Date.now() - DEBUG_TTL_MS;
  let deleted = 0;
  for (const name of readdirSync(DEBUG_DIR_FS)) {
    // Prefer the embedded timestamp; fall back to mtime for files
    // that don't match the naming pattern (shouldn't happen but
    // belt-and-suspenders so we don't accidentally pin a stale file).
    const ts = tsFromFilename(name);
    let age = ts || 0;
    if (!age) {
      try {
        age = statSync(path.join(DEBUG_DIR_FS, name)).mtimeMs;
      } catch {
        continue;
      }
    }
    if (age >= cutoff) continue;
    try {
      unlinkSync(path.join(DEBUG_DIR_FS, name));
      deleted++;
    } catch {
      /* skip */
    }
  }
  return deleted;
}

// --- Vercel Blob adapter -------------------------------------------------

async function saveBlob(filename: string, bytes: Buffer): Promise<string> {
  const { put } = await import("@vercel/blob");
  const blob = await put(`${BLOB_PREFIX}${filename}`, bytes, {
    access: "public",
    addRandomSuffix: false,
    contentType: "image/jpeg",
  });
  return blob.url;
}

async function deleteBlobByUrl(url: string): Promise<void> {
  // Defensive: refuse to delete URLs that don't look like our debug
  // blobs. Prevents a malicious caller passing in e.g. a font URL.
  if (!/\/debug_\d+_[a-z0-9]+\.jpg(\?|$)/.test(url)) return;
  const { del } = await import("@vercel/blob");
  try {
    await del(url);
  } catch {
    /* best-effort */
  }
}

async function sweepBlob(): Promise<number> {
  const { del } = await import("@vercel/blob");
  const { listAllBlobs } = await import("./blob-list-all");
  const blobs = await listAllBlobs(BLOB_PREFIX);
  const cutoff = Date.now() - DEBUG_TTL_MS;
  const toDelete: string[] = [];
  for (const b of blobs) {
    const filename = b.pathname.replace(BLOB_PREFIX, "");
    const ts = tsFromFilename(filename);
    const age = ts || (b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0);
    if (age && age < cutoff) toDelete.push(b.url);
  }
  for (const url of toDelete) {
    try {
      await del(url);
    } catch {
      /* skip */
    }
  }
  return toDelete.length;
}

// --- Public API ----------------------------------------------------------

/** Save a debug image and return a URL the client can `<img src>`. */
export async function saveDebugImage(
  filename: string,
  bytes: Buffer,
): Promise<string> {
  return useBlob() ? saveBlob(filename, bytes) : saveFs(filename, bytes);
}

/** Delete a debug image by the URL we previously returned from
 *  saveDebugImage. Best-effort — already-deleted is not an error. */
export async function deleteDebugImageByUrl(url: string): Promise<void> {
  if (useBlob()) {
    await deleteBlobByUrl(url);
  } else {
    deleteFsByUrl(url);
  }
}

/** Sweep debug images older than DEBUG_TTL_MS. Designed to run at the
 *  top of each new debugScan invocation so storage stays bounded
 *  without a cron. Returns the count for log visibility. */
export async function sweepOldDebugImages(): Promise<number> {
  return useBlob() ? sweepBlob() : sweepFs();
}
