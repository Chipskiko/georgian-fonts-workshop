import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { listAllBlobs } from "./blob-list-all";

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
  /** Epoch ms when the font was uploaded — mtimeMs for FS storage,
   *  uploadedAt for Vercel Blob. Used by the home-page font list to
   *  sort newest-first so workshop participants see their own upload
   *  at the top instead of scrolling past alphabetically-earlier fonts. */
  createdAt: number;
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
    // mtimeMs as a proxy for "uploaded-at" in FS mode — the file
    // gets written once at save time and never modified, so mtime
    // tracks the upload event well enough for newest-first sorting.
    let createdAt = 0;
    try {
      createdAt = statSync(path.join(FONT_DIR_FS, e.name)).mtimeMs;
    } catch {
      /* unreadable file — leave at 0, will sort to bottom */
    }
    out.push({
      filename: e.name,
      publicUrl: `/fonts/${encodeURIComponent(e.name)}`,
      fetchBytes: async () => new Uint8Array(readFileSync(path.join(FONT_DIR_FS, e.name))),
      createdAt,
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
    // Just-written = now. The next listFs() call will read mtimeMs;
    // returning Date.now() here keeps the returned StoredFont
    // consistent for any immediate consumer.
    createdAt: Date.now(),
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
  const blobs = await listAllBlobs(BLOB_PREFIX);
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
        // Vercel Blob's uploadedAt is an ISO string; parse to epoch ms
        // for consistency with the FS adapter (which uses mtimeMs).
        // Falls back to 0 for legacy blobs that somehow lack the field
        // — they sort to the bottom, which is correct (treat as ancient).
        createdAt: b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0,
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
    // Just-uploaded = now. The next listBlob() call will read
    // uploadedAt from the Blob metadata.
    createdAt: Date.now(),
  };
}

async function deleteBlob(filename: string): Promise<void> {
  const { del } = await import("@vercel/blob");
  // Find the exact URL for this filename — Blob delete is by URL, not path
  const blobs = await listAllBlobs(`${BLOB_PREFIX}${filename}`);
  const target = blobs.find((b) => b.pathname === `${BLOB_PREFIX}${filename}`);
  if (!target) return;
  await del(target.url);
}

async function dedupeBlob(filename: string): Promise<string> {
  const blobs = await listAllBlobs(BLOB_PREFIX);
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

// --- Preview-SVG sidecars (plan doc §8) ----------------------------------
// Each stored font gets a baked `<filename>.preview.svg` sidecar — the
// fonts page renders it via <img> so letterforms appear as themselves
// with no @font-face loading (no FOUT, no OTS dependency). Same idiom
// as poster `_thumb`/`_bnw` sidecars. Sidecars are best-effort: fonts
// without one (generation failed, pre-backfill uploads) fall back to
// @font-face text on the page.

const PREVIEW_SUFFIX = ".preview.svg";

async function savePreviewSidecar(fontFilename: string, svg: string): Promise<void> {
  if (useBlob()) {
    const { put } = await import("@vercel/blob");
    await put(`${BLOB_PREFIX}${fontFilename}${PREVIEW_SUFFIX}`, svg, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "image/svg+xml",
    });
  } else {
    await writeFile(path.join(FONT_DIR_FS, `${fontFilename}${PREVIEW_SUFFIX}`), svg, "utf8");
  }
}

async function deletePreviewSidecar(fontFilename: string): Promise<void> {
  if (useBlob()) {
    const { del } = await import("@vercel/blob");
    const target = `${BLOB_PREFIX}${fontFilename}${PREVIEW_SUFFIX}`;
    const blobs = await listAllBlobs(target);
    const hit = blobs.find((b) => b.pathname === target);
    if (hit) await del(hit.url);
  } else {
    await unlink(path.join(FONT_DIR_FS, `${fontFilename}${PREVIEW_SUFFIX}`)).catch(() => {});
  }
}

/** Map of font filename → public URL of its preview sidecar, for every
 *  font that has one. Consumed by lib/fonts.ts to attach previewSvg to
 *  FontEntry rows. */
export async function listFontPreviewUrls(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (useBlob()) {
    const blobs = await listAllBlobs(BLOB_PREFIX);
    for (const b of blobs) {
      if (!b.pathname.endsWith(PREVIEW_SUFFIX)) continue;
      const fontFilename = b.pathname
        .replace(BLOB_PREFIX, "")
        .slice(0, -PREVIEW_SUFFIX.length);
      out[fontFilename] = b.url;
    }
  } else {
    if (!existsSync(FONT_DIR_FS)) return out;
    for (const e of readdirSync(FONT_DIR_FS, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(PREVIEW_SUFFIX)) continue;
      const fontFilename = e.name.slice(0, -PREVIEW_SUFFIX.length);
      out[fontFilename] = `/fonts/${encodeURIComponent(e.name)}`;
    }
  }
  return out;
}

// --- Public API ----------------------------------------------------------

export async function listFonts(): Promise<StoredFont[]> {
  return useBlob() ? await listBlob() : listFs();
}

export async function saveFont(filename: string, bytes: Uint8Array | Buffer): Promise<StoredFont> {
  const stored = useBlob() ? await saveBlob(filename, bytes) : await saveFs(filename, bytes);
  // Bake the alphabet-preview sidecar. Non-fatal on failure — the font
  // is already saved; the page just falls back to @font-face for it.
  try {
    const { buildPreviewSvg } = await import("./font-pipeline/preview-svg");
    const svg = buildPreviewSvg(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
    if (svg) await savePreviewSidecar(stored.filename, svg);
  } catch (e) {
    console.warn("[saveFont] preview sidecar generation failed (non-fatal):", e);
  }
  return stored;
}

export async function deleteFont(filename: string): Promise<void> {
  if (useBlob()) {
    await deleteBlob(filename);
  } else {
    await deleteFs(filename);
  }
  // Best-effort sidecar cleanup — orphaned sidecars are invisible to
  // the UI (no matching font row) but waste storage.
  await deletePreviewSidecar(filename).catch(() => {});
}

export async function dedupeFontFilename(filename: string): Promise<string> {
  return useBlob() ? await dedupeBlob(filename) : dedupeFs(filename);
}
