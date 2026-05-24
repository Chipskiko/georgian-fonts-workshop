"use client";

import { useCallback, useEffect, useState } from "react";
import type { StoredPoster } from "@/lib/poster-storage";
import { deletePoster, listPosters, refreshPosters } from "./actions";
import { useAdmin } from "../add/useAdmin";

// Polling cadence: bumped 5s → 30s. Five viewers x 5s = 3600
// invocations/hour just from gallery polling; 30s cuts that 6×. The
// manual refresh button covers the "I want to see new posters NOW" case.
const POLL_INTERVAL_MS = 30_000;

/** Fetch a color poster URL and return its grayscale-converted JPEG
 *  blob. Used by both the per-tile B&W download and the batch
 *  "download all" zip. Luminance-weighted (Rec. 709) so perceived
 *  brightness matches the human eye instead of a flat 1/3-1/3-1/3
 *  average which crushes warm colors. */
async function fetchAndConvertToBnw(url: string): Promise<Blob> {
  const res = await fetch(url, { mode: "cors" });
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d ctx");
  ctx.drawImage(bitmap, 0, 0);
  const imgData = ctx.getImageData(0, 0, c.width, c.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    // Luminance (Rec. 709) → binary threshold at 160. Same formula
    // as the cascade's save-time bnw generation; keeps the legacy
    // fallback consistent with the pre-computed bnw output. Without
    // the threshold the output is pure grayscale with a grey cast
    // that doesn't reproduce cleanly through RISO printing.
    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const bw = y < 160 ? 0 : 255;
    d[i] = bw; d[i + 1] = bw; d[i + 2] = bw;
  }
  ctx.putImageData(imgData, 0, 0);
  const out: Blob | null = await new Promise((res) =>
    c.toBlob(res, "image/jpeg", 0.92),
  );
  if (!out) throw new Error("toBlob failed");
  return out;
}

/** Trigger a browser download for a URL with a custom filename.
 *  Used by both the pre-computed-bnw and legacy-conversion paths so
 *  they share the same DOM-anchor click trick. */
function triggerDownload(href: string, downloadName: string, revokeAfter = false): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = downloadName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revokeAfter) {
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
}

/** Per-tile B&W download trigger. Prefers the pre-computed _bnw blob
 *  cascade generated at save time (no client-side conversion needed).
 *  Falls back to on-the-fly canvas conversion for legacy posters
 *  uploaded before the dual-save change. Final fallback opens the
 *  color version in a new tab if conversion itself fails. */
async function downloadBnw(poster: StoredPoster): Promise<void> {
  // "_bnw" before the extension so the file is obviously paired with
  // the color version when both are saved into the same folder.
  const downloadName = poster.id.replace(/(\.[^.]+)$/, "_bnw$1");
  if (poster.bnwUrl) {
    // Pre-computed path: just download the already-prepared blob. The
    // fetch+blob URL roundtrip is needed because cross-origin URLs
    // (Vercel Blob storage) don't honor <a download> directly — the
    // browser navigates to the URL instead of saving it.
    try {
      const res = await fetch(poster.bnwUrl, { mode: "cors" });
      const blob = await res.blob();
      const downloadUrl = URL.createObjectURL(blob);
      triggerDownload(downloadUrl, downloadName, true);
      return;
    } catch (err) {
      console.warn("[downloadBnw] pre-computed fetch failed, falling back to conversion:", err);
      // fall through to legacy path
    }
  }
  // Legacy path: posters saved before the dual-save change have no
  // bnwUrl. Convert from color on the fly using the existing helper.
  try {
    const outBlob = await fetchAndConvertToBnw(poster.url);
    const downloadUrl = URL.createObjectURL(outBlob);
    triggerDownload(downloadUrl, downloadName, true);
  } catch (err) {
    console.warn("[downloadBnw] conversion failed, opening color version instead:", err);
    window.open(poster.url, "_blank");
  }
}

/** Batch: B&W-convert every poster and zip them into one download.
 *  Pure client-side — fetches the originals (CORS-friendly Vercel Blob
 *  URLs), converts, packages with JSZip. No server invocation cost.
 *  For a workshop with 30 posters at ~150KB each the zip is ~5MB and
 *  the whole roundtrip takes ~10-30 sec depending on network. */
async function downloadAllBnwZip(
  posters: StoredPoster[],
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  // Dynamic import to keep JSZip out of the initial gallery bundle —
  // it's only fetched when the user actually clicks "download all".
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  onProgress(0, posters.length);
  // Sequential rather than Promise.all so a 30-poster workshop doesn't
  // open 30 concurrent fetches (which throttles aggressively on Safari
  // and triggers Vercel Blob's per-IP burst limits).
  for (let i = 0; i < posters.length; i++) {
    const p = posters[i];
    try {
      // Prefer the pre-computed _bnw blob cascade generated at save
      // time — just fetch and zip, no canvas work. Falls back to
      // on-the-fly conversion for legacy posters uploaded before the
      // dual-save change.
      let bnwBlob: Blob;
      if (p.bnwUrl) {
        const res = await fetch(p.bnwUrl, { mode: "cors" });
        bnwBlob = await res.blob();
      } else {
        bnwBlob = await fetchAndConvertToBnw(p.url);
      }
      const name = p.id.replace(/(\.[^.]+)$/, "_bnw$1");
      zip.file(name, bnwBlob);
    } catch (e) {
      console.warn(`[downloadAllBnwZip] skipping ${p.id}:`, e);
    }
    onProgress(i + 1, posters.length);
  }
  const zipBlob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement("a");
  a.href = url;
  // Stamped filename so successive downloads don't clobber each other
  // in the user's Downloads folder.
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.download = `posters-bnw-${ts}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Gallery({ initialPosters }: { initialPosters: StoredPoster[] }) {
  const [posters, setPosters] = useState<StoredPoster[]>(initialPosters);
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Bulk B&W download state. `bnwProgress` is null when idle, otherwise
  // `{ done, total }` so the button label can show "5/30" mid-zip.
  const [bnwProgress, setBnwProgress] = useState<{ done: number; total: number } | null>(null);
  const { unlocked, password } = useAdmin();

  // Background poll for new posters so participants see each other's
  // saves without manual refresh. Uses listPosters (cached read) — fine
  // for background polling. The button below uses refreshPosters which
  // additionally invalidates the cache for a guaranteed-fresh read.
  useEffect(() => {
    const iv = window.setInterval(async () => {
      try {
        const next = await listPosters();
        setPosters(next);
      } catch {
        /* ignore */
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(iv);
  }, []);

  /** Explicit user-triggered refresh. Calls the cache-invalidating
   *  variant so the server forcibly re-reads from Blob — useful when
   *  the user knows new posters exist but doesn't want to wait. */
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setErrMsg(null);
    try {
      const next = await refreshPosters();
      setPosters(next);
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : "განახლება ვერ მოხერხდა");
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  /** Batch-download all posters as a B&W zip. Click → fetches each
   *  poster, converts to grayscale on a canvas, zips them all, triggers
   *  a single download. Sequential fetches (not parallel) to be polite
   *  to Vercel Blob's per-IP rate limits. */
  const handleDownloadAllBnw = useCallback(async () => {
    if (bnwProgress !== null || posters.length === 0) return;
    setErrMsg(null);
    try {
      await downloadAllBnwZip(posters, (done, total) => setBnwProgress({ done, total }));
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : "ჩამოტვირთვა ვერ მოხერხდა");
    } finally {
      setBnwProgress(null);
    }
  }, [posters, bnwProgress]);

  // Close lightbox on Escape
  useEffect(() => {
    if (!lightboxId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxId(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lightboxId]);

  async function handleDelete(id: string) {
    if (!unlocked) return;
    setBusyId(id);
    setErrMsg(null);
    try {
      const res = await deletePoster(id, password);
      if (!res.ok) throw new Error(res.message);
      setPosters((cur) => cur.filter((p) => p.id !== id));
      setPendingDelete(null);
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : "წაშლა ვერ მოხერხდა");
    } finally {
      setBusyId(null);
    }
  }

  const lightboxPoster = lightboxId
    ? posters.find((p) => p.id === lightboxId)
    : null;

  return (
    <div className="gallery">
      {/* Refresh button — visible whenever the gallery has content.
          Bypasses the cached list so the user can force a fresh read
          rather than waiting for the 30s background poll. */}
      {posters.length > 0 ? (
        <div className="gallery-header">
          <button
            type="button"
            className="gallery-refresh-btn"
            onClick={() => void handleDownloadAllBnw()}
            disabled={bnwProgress !== null}
            aria-label="download all posters as black-and-white zip"
            title="download all posters as black-and-white zip"
          >
            {bnwProgress !== null
              ? `↓ შ/თ ${bnwProgress.done}/${bnwProgress.total}`
              : "↓ ყველა შ/თ"}
          </button>
          <button
            type="button"
            className="gallery-refresh-btn"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            aria-label="refresh posters"
            title="refresh posters"
          >
            {refreshing ? "..." : "↻ განახლება"}
          </button>
        </div>
      ) : null}
      {posters.length === 0 ? (
        <p className="gallery-empty">
          ჯერ პოსტერი არ არის — შექმენი ერთი <a href="/cascade">პოსტერიზატორში</a>.
        </p>
      ) : (
        <div className="gallery-grid">
          {posters.map((p) => (
            <div key={p.id} className="gallery-tile">
              <button
                type="button"
                className="gallery-tile-img-btn"
                onClick={() => setLightboxId(p.id)}
                aria-label="open poster"
              >
                {/* Plain <img>: blob URLs are direct (no next/image
                    optimization to pay for). Use thumbUrl when present
                    (new uploads); fall back to the full URL for legacy
                    posters that have no paired thumb. onError drops the
                    tile if the underlying blob was deleted between
                    polls. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.thumbUrl ?? p.url}
                  alt="poster"
                  loading="lazy"
                  onError={() => setPosters((cur) => cur.filter((x) => x.id !== p.id))}
                />
              </button>
              <div className="gallery-tile-meta">
                <a href={p.url} download className="gallery-download">
                  ჩამოტვირთე
                </a>
                <button
                  type="button"
                  className="gallery-download gallery-bnw"
                  onClick={() => void downloadBnw(p)}
                  title="ჩამოტვირთე შავ-თეთრად"
                >
                  ↓ შ/თ
                </button>
                {unlocked ? (
                  pendingDelete === p.id ? (
                    <span className="gallery-confirm-row">
                      <button
                        type="button"
                        className="gallery-confirm"
                        disabled={busyId === p.id}
                        onClick={() => void handleDelete(p.id)}
                      >
                        წაშლა?
                      </button>
                      <button
                        type="button"
                        className="gallery-cancel"
                        disabled={busyId === p.id}
                        onClick={() => setPendingDelete(null)}
                      >
                        არა
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="gallery-delete"
                      onClick={() => setPendingDelete(p.id)}
                    >
                      წაშლა
                    </button>
                  )
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {errMsg ? <p className="gallery-err">{errMsg}</p> : null}

      {lightboxPoster ? (
        <div
          className="gallery-lightbox"
          onClick={() => setLightboxId(null)}
          role="dialog"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxPoster.url}
            alt="poster"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="gallery-lightbox-close"
            onClick={() => setLightboxId(null)}
            aria-label="close"
          >
            ✕
          </button>
        </div>
      ) : null}
    </div>
  );
}
