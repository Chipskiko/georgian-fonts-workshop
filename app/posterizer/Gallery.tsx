"use client";

import { useCallback, useEffect, useState } from "react";
import type { StoredPoster } from "@/lib/poster-storage";
import { deletePoster, listPosters, refreshPosters } from "./actions";
import { useAdmin } from "../add/useAdmin";

// Polling cadence: bumped 5s → 30s. Five viewers x 5s = 3600
// invocations/hour just from gallery polling; 30s cuts that 6×. The
// manual refresh button covers the "I want to see new posters NOW" case.
const POLL_INTERVAL_MS = 30_000;

export function Gallery({ initialPosters }: { initialPosters: StoredPoster[] }) {
  const [posters, setPosters] = useState<StoredPoster[]>(initialPosters);
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
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
