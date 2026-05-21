"use client";

import { useEffect, useState } from "react";
import type { StoredPoster } from "@/lib/poster-storage";
import { deletePoster, listPosters } from "./actions";
import { useAdmin } from "../add/useAdmin";

const POLL_INTERVAL_MS = 5000;

export function Gallery({ initialPosters }: { initialPosters: StoredPoster[] }) {
  const [posters, setPosters] = useState<StoredPoster[]>(initialPosters);
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const { unlocked, password } = useAdmin();

  // Poll for new posters so participants see each other's saves without
  // having to manually refresh.
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
      setErrMsg(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusyId(null);
    }
  }

  const lightboxPoster = lightboxId
    ? posters.find((p) => p.id === lightboxId)
    : null;

  return (
    <div className="gallery">
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
                {/* Plain <img>: PNGs are already optimized & external Blob
                    URLs would require next/image domain config. onError
                    drops the tile if the underlying blob was deleted in
                    the gap between two polling cycles. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.url}
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
