import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Storage adapter for workshop fonts.
 *
 * - In local dev (no BLOB_READ_WRITE_TOKEN): reads/writes from public/fonts/
 *   so existing behaviour is unchanged.
 * - On Vercel (BLOB_READ_WRITE_TOKEN present): reads/writes via @vercel/blob,
 *   since the production filesystem is read-only.
 *
 * Both adapters return the same shape, so callers don't care which is in use.
 */

export type StoredFont = {
  filename: string;
  /** URL or path the browser uses to fetch the font (used in @font-face). */
  publicUrl: string;
  /** Bytes for downstream use (e.g. embedding into SVG); lazy-fetched on demand. */
  fetchBytes: () => Promise<Uint8Array>;
};

const ALLOWED_EXT = new Set([".ttf", ".otf", ".woff", ".woff2"]);
// Per-extension MIME for Blob uploads. Browsers' nosniff + cross-origin
// font loading enforces strict Content-Type/format-hint matching, so the
// MIME MUST match the actual file format — a previous hardcoded "font/ttf"
// for every upload made .otf/.woff/.woff2 fonts silently fail to render
// (downloads still worked because OS uses magic bytes, not Content-Type).
const EXT_TO_MIME: Record<string, string> = {
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const FONT_DIR_FS = path.join(process.cwd(), "public", "fonts");
const BLOB_PREFIX = "fonts/";

function useBlob(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/** Append a short random segment so concurrent uploads with the same
 * requested name don't overwrite each other. The `__` separator lets
 * toName() in lib/fonts.ts strip it cleanly when computing the display
 * name. Probability of two writes colliding: 36^6 ≈ 1 in 2 billion. */
function withRandomSuffix(filename: string): string {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  const rand = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  return `${base}__${rand}${ext}`;
}

// --- Local FS adapter ----------------------------------------------------

function listFs(): StoredFont[] {
  if (!existsSync(FONT_DIR_FS)) return [];
  const entries = readdirSync(FONT_DIR_FS, { withFileTypes: true });
  const out: StoredFont[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
    out.push({
      filename: e.name,
      publicUrl: `/fonts/${encodeURIComponent(e.name)}`,
      fetchBytes: async () => new Uint8Array(readFileSync(path.join(FONT_DIR_FS, e.name))),
    });
  }
  return out;
}

async function saveFs(filename: string, bytes: Uint8Array | Buffer): Promise<StoredFont> {
  // On Vercel the filesystem is read-only — writing to public/fonts/ throws
  // EROFS which surfaces as a generic 500. Surface the real cause early so
  // it's obvious that BLOB_READ_WRITE_TOKEN wasn't injected.
  if (process.env.VERCEL) {
    throw new Error(
      "Blob ფაილსაცავი არ არის კონფიგურირებული — დააყენე BLOB_READ_WRITE_TOKEN.",
    );
  }
  const unique = withRandomSuffix(filename);
  const dest = path.join(FONT_DIR_FS, unique);
  if (path.relative(FONT_DIR_FS, dest).startsWith("..")) {
    throw new Error("არასწორი შრიფტის ფაილის სახელი");
  }
  await writeFile(dest, Buffer.from(bytes));
  return {
    filename: unique,
    publicUrl: `/fonts/${encodeURIComponent(unique)}`,
    fetchBytes: async () => new Uint8Array(readFileSync(dest)),
  };
}

async function deleteFs(filename: string): Promise<void> {
  const safe = path.basename(filename);
  if (!safe || safe !== filename) throw new Error("არასწორი ფაილის სახელი");
  const ext = path.extname(safe).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw new Error("არ არის შრიფტის ფაილი");
  const dest = path.join(FONT_DIR_FS, safe);
  if (path.relative(FONT_DIR_FS, dest).startsWith("..")) throw new Error("არასწორი მისამართი");
  await unlink(dest);
}

function dedupeFs(filename: string): string {
  if (!existsSync(path.join(FONT_DIR_FS, filename))) return filename;
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}_${n}${ext}`;
    if (!existsSync(path.join(FONT_DIR_FS, candidate))) return candidate;
  }
  return `${base}_${Date.now()}${ext}`;
}

// --- Vercel Blob adapter -------------------------------------------------
// Lazy-required so dev environments without @vercel/blob can still build.

async function listBlob(): Promise<StoredFont[]> {
  const { list } = await import("@vercel/blob");
  const { blobs } = await list({ prefix: BLOB_PREFIX });
  return blobs
    .filter((b) => ALLOWED_EXT.has(path.extname(b.pathname).toLowerCase()))
    .map((b) => {
      const filename = b.pathname.replace(BLOB_PREFIX, "");
      return {
        filename,
        publicUrl: b.url,
        fetchBytes: async () => {
          const r = await fetch(b.url);
          return new Uint8Array(await r.arrayBuffer());
        },
      };
    });
}

async function saveBlob(filename: string, bytes: Uint8Array | Buffer): Promise<StoredFont> {
  const { put } = await import("@vercel/blob");
  const unique = withRandomSuffix(filename);
  const ext = path.extname(unique).toLowerCase();
  const contentType = EXT_TO_MIME[ext] ?? "application/octet-stream";
  const blob = await put(`${BLOB_PREFIX}${unique}`, Buffer.from(bytes), {
    access: "public",
    addRandomSuffix: false,
    contentType,
  });
  return {
    filename: unique,
    publicUrl: blob.url,
    fetchBytes: async () => {
      const r = await fetch(blob.url);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

async function deleteBlob(filename: string): Promise<void> {
  const { del, list } = await import("@vercel/blob");
  // Find the exact URL for this filename — Blob delete is by URL, not path
  const { blobs } = await list({ prefix: `${BLOB_PREFIX}${filename}` });
  const target = blobs.find((b) => b.pathname === `${BLOB_PREFIX}${filename}`);
  if (!target) return;
  await del(target.url);
}

async function dedupeBlob(filename: string): Promise<string> {
  const { list } = await import("@vercel/blob");
  const { blobs } = await list({ prefix: BLOB_PREFIX });
  const taken = new Set(blobs.map((b) => b.pathname.replace(BLOB_PREFIX, "")));
  if (!taken.has(filename)) return filename;
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}_${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}${ext}`;
}

// --- Public API ----------------------------------------------------------

export async function listFonts(): Promise<StoredFont[]> {
  return useBlob() ? await listBlob() : listFs();
}

export async function saveFont(filename: string, bytes: Uint8Array | Buffer): Promise<StoredFont> {
  return useBlob() ? await saveBlob(filename, bytes) : await saveFs(filename, bytes);
}

export async function deleteFont(filename: string): Promise<void> {
  return useBlob() ? await deleteBlob(filename) : await deleteFs(filename);
}

export async function dedupeFontFilename(filename: string): Promise<string> {
  return useBlob() ? await dedupeBlob(filename) : dedupeFs(filename);
}
