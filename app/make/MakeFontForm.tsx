"use client";

import { useEffect, useRef, useState } from "react";
import {
  previewFontFromScan,
  saveFontFromPreview,
  debugScan,
  deleteDebugImage,
  tunableDebugScan,
  type PreviewResult,
  type DebugResult,
  type TunableDebugResult,
} from "./actions";
import { straightenScan } from "./perspective";
import { useAdmin } from "../add/useAdmin";

const ALPHABET = "ა ბ გ დ ე ვ ზ თ ი კ ლ მ ნ ო პ ჟ რ ს ტ უ ფ ქ ღ ყ შ ჩ ც ძ წ ჭ ხ ჯ ჰ".split(" ");

type Stage = "idle" | "straightening" | "tracing" | "previewing" | "saving" | "debugging";

type TunerView =
  | "thresholded"
  | "candidates"
  | "warped"
  | "cells"
  | "bg"
  | "normalized"
  | "binary"
  | "smoothed"
  | "vectorized";
type TunerParams = {
  view: TunerView;
  threshold: number;
  blur: number;
  traceThreshold: number;
};
type TunerData = Extract<TunableDebugResult, { ok: true }>["debug"];

const DEFAULT_TUNER_PARAMS: TunerParams = {
  view: "candidates",
  threshold: 110,
  blur: 0.8,
  traceThreshold: 180,
};

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[]);
  }
  return btoa(bin);
}

export function MakeFontForm() {
  const { unlocked: adminUnlocked } = useAdmin();
  const [stage, setStage] = useState<Stage>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<Extract<PreviewResult, { ok: true }> | null>(null);
  const [debug, setDebug] = useState<Extract<DebugResult, { ok: true }> | null>(null);
  const [debugFallback, setDebugFallback] = useState<
    null | { url: string; width: number; height: number; candidateCount: number; thresholdUsed: number }
  >(null);
  // Which path the client-side straightenScan took on the last upload.
  // Shown as a tiny status line — "warp" is the desirable case; "fallback"
  // means lower-quality JPEG was sent to the server (more likely to
  // produce hollow-fills-in-shapes artifacts on phone uploads).
  const [scanPath, setScanPath] = useState<"warp" | "fallback" | "passthrough" | null>(null);
  // Tuner state. `tunerFileB64` is the uploaded scan cached client-side so
  // we can re-call the server without re-uploading on every slider move.
  const [tunerFileB64, setTunerFileB64] = useState<string | null>(null);
  const [tunerParams, setTunerParams] = useState<TunerParams>(DEFAULT_TUNER_PARAMS);
  const [tunerData, setTunerData] = useState<TunerData | null>(null);
  const [tunerLoading, setTunerLoading] = useState(false);
  const [tunerError, setTunerError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const styleRef = useRef<HTMLStyleElement | null>(null);
  // Token to ignore stale debounced fetches when params change rapidly
  const tunerTokenRef = useRef(0);

  // Free debug-image storage when the user dismisses the preview or
  // when a fresh debug run replaces the previous one. The server also
  // sweeps stale debug images opportunistically on each invocation, so
  // these cleanups are the fast path — sweep is the safety net for
  // tab-closed / network-flake cases.
  useEffect(() => {
    if (!debug) return;
    const url = debug.url;
    return () => {
      void deleteDebugImage(url);
    };
  }, [debug]);
  useEffect(() => {
    if (!debugFallback) return;
    const url = debugFallback.url;
    return () => {
      void deleteDebugImage(url);
    };
  }, [debugFallback]);

  // Inject (and clean up) a temporary @font-face for the preview.
  // Uses a blob URL rather than a base64 data URL so the @font-face CSS
  // stays tiny — the browser fetches the binary directly via the blob.
  useEffect(() => {
    if (!preview) {
      if (styleRef.current) {
        styleRef.current.remove();
        styleRef.current = null;
      }
      return;
    }
    const familyId = "preview-" + preview.requestedName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const bytes = Uint8Array.from(atob(preview.ttfBase64), (c) => c.charCodeAt(0));
    // opentype.js produces CFF-outline fonts (magic "OTTO" = OpenType, not
     // TrueType), so the Blob's MIME and the @font-face format hint must be
     // "opentype" / font/otf. Same-origin blob URLs are lenient about
     // mismatches, but production Vercel Blob is cross-origin + nosniff and
     // strictly rejects format mismatches → font silently falls back.
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "font/otf" }));
    if (!styleRef.current) {
      styleRef.current = document.createElement("style");
      document.head.appendChild(styleRef.current);
    }
    styleRef.current.textContent = `@font-face{font-family:"${familyId}";src:url(${blobUrl}) format("opentype");font-display:block;}`;
    return () => {
      URL.revokeObjectURL(blobUrl);
      if (styleRef.current) {
        styleRef.current.remove();
        styleRef.current = null;
      }
    };
  }, [preview]);

  const previewFamilyId = preview
    ? "preview-" + preview.requestedName.replace(/[^a-zA-Z0-9_-]/g, "_")
    : null;

  // Debounced re-render: whenever the user changes a slider or view tab,
  // wait 300ms (so dragging a slider doesn't fire 60 requests/sec) and then
  // call the server with the new params. `tunerTokenRef` guards against
  // stale results overwriting newer ones.
  useEffect(() => {
    if (!tunerFileB64) return;
    const token = ++tunerTokenRef.current;
    const timer = window.setTimeout(async () => {
      setTunerLoading(true);
      setTunerError(null);
      try {
        const r = await tunableDebugScan(
          tunerFileB64,
          tunerParams.view,
          tunerParams.threshold,
          tunerParams.blur,
          tunerParams.traceThreshold,
        );
        if (token !== tunerTokenRef.current) return; // stale
        if (r.ok) {
          setTunerData(r.debug);
        } else {
          setTunerError(r.message);
        }
      } catch (err) {
        if (token !== tunerTokenRef.current) return;
        setTunerError(err instanceof Error ? err.message : "tune failed");
      } finally {
        if (token === tunerTokenRef.current) setTunerLoading(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    tunerFileB64,
    tunerParams.view,
    tunerParams.threshold,
    tunerParams.blur,
    tunerParams.traceThreshold,
  ]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    setOkMsg(null);
    const form = e.currentTarget;
    const fd = new FormData(form);

    try {
      const original = fd.get("scan");
      if (original instanceof File && original.size > 0) {
        setStage("straightening");
        const corrected = await straightenScan(original);
        // Surface the path the client took so we can diagnose "phone
        // upload fills hollows but desktop doesn't" — "warp" = best
        // case (perspective-corrected, q1.0 JPEG), "fallback" =
        // markers didn't detect (lower-quality compressed input ≡
        // more JPEG bleed risk), "passthrough" = couldn't even
        // re-encode so the server gets the original photo bytes.
        setScanPath(corrected.path);
        fd.set(
          "scan",
          new File([corrected.blob], original.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }),
        );
      }
      setStage("tracing");
      const r = await previewFontFromScan(fd);
      if (!r.ok) {
        setErrorMsg(r.message);
        setStage("idle");
        return;
      }
      setPreview(r);
      setStage("previewing");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "ვერ შესრულდა");
      setStage("idle");
    }
  }

  async function handleSave() {
    if (!preview) return;
    setStage("saving");
    setErrorMsg(null);
    try {
      const r = await saveFontFromPreview(preview.ttfBase64, preview.requestedName);
      if (!r.ok) {
        setErrorMsg(r.message);
        setStage("previewing");
        return;
      }
      setOkMsg(r.message);
      setPreview(null);
      setFileName(null);
      setStage("idle");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "შენახვა ვერ მოხერხდა");
      setStage("previewing");
    }
  }

  function handleDiscard() {
    setPreview(null);
    setStage("idle");
    setErrorMsg(null);
  }

  async function handleTune() {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    const original = fd.get("scan");
    if (!(original instanceof File) || original.size === 0) {
      setErrorMsg("აარჩიე ფაილი");
      return;
    }
    setErrorMsg(null);
    setOkMsg(null);
    setDebug(null);
    setDebugFallback(null);
    setTunerError(null);
    setTunerData(null);
    try {
      // Cache the raw uploaded file as base64 so the tuner can re-call the
      // server on every slider change without re-uploading. We skip the
      // client-side perspective correction here on purpose — the whole point
      // of the tuner is to see the raw photo and watch the algorithm respond
      // to parameter changes, not to debug a layered transformation.
      const b64 = await fileToBase64(original);
      setTunerFileB64(b64);
      setTunerParams(DEFAULT_TUNER_PARAMS);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "ფაილი ვერ წაიკითხა");
    }
  }

  function handleCloseTuner() {
    setTunerFileB64(null);
    setTunerData(null);
    setTunerError(null);
    setTunerParams(DEFAULT_TUNER_PARAMS);
  }

  async function handleDebug() {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    const original = fd.get("scan");
    if (!(original instanceof File) || original.size === 0) {
      setErrorMsg("აარჩიე ფაილი");
      return;
    }
    setStage("debugging");
    setErrorMsg(null);
    setOkMsg(null);
    setDebugFallback(null);
    try {
      // Run the SAME jscanify perspective correction the real flow uses,
      // so the debug image matches what processScan would see.
      const corrected = await straightenScan(original);
      setScanPath(corrected.path);
      const debugFd = new FormData();
      debugFd.set(
        "scan",
        new File([corrected.blob], original.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }),
      );
      const r = await debugScan(debugFd);
      if (!r.ok) {
        setErrorMsg(r.message);
        if (r.fallback) setDebugFallback(r.fallback);
      } else {
        setDebug(r);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "დებაგი ვერ შესრულდა");
    } finally {
      setStage("idle");
    }
  }

  const submitting = stage === "straightening" || stage === "tracing";
  const debugBusy = stage === "debugging";
  const submitLabel =
    stage === "straightening"
      ? "ვასწორებ..."
      : stage === "tracing"
        ? "ვაგზავნი..."
        : "გააკეთე";

  return (
    <>
      <ol className="add-blurb make-blurb make-steps">
        <li>
          <a href="/api/template" download className="make-link">გადმოწერე შაბლონი</a>
        </li>
        <li>დაბეჭდე</li>
        <li>შეავსე</li>
        <li>ატვირთე</li>
      </ol>

      {!preview ? (
        <form className="add-form" ref={formRef} onSubmit={handleSubmit}>
          <label className="add-row">
            <span>სკანი</span>
            <span className="file-picker">
              <input
                type="file"
                name="scan"
                accept="image/*"
                required
                onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
                className="file-picker-input"
              />
              <span className="file-picker-label">{fileName ?? "ველოდები სკანს..."}</span>
            </span>
          </label>
          <label className="add-row">
            <span>სახელი</span>
            <input
              type="text"
              name="fontName"
              required
              lang="ka"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              style={{ fontFamily: "var(--ui-georgian)" }}
            />
          </label>
          <label className="add-row">
            <span>ავტორი</span>
            <input
              type="text"
              name="designer"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>
          <div className="make-actions">
            <button type="submit" disabled={submitting || debugBusy}>
              {submitLabel}
            </button>
            {adminUnlocked ? (
              <>
                <button
                  type="button"
                  onClick={handleDebug}
                  disabled={submitting || debugBusy}
                >
                  {debugBusy ? "ვამოწმებ..." : "debug"}
                </button>
                <button
                  type="button"
                  onClick={handleTune}
                  disabled={submitting || debugBusy}
                  title="interactive per-stage tuning"
                >
                  tune
                </button>
              </>
            ) : null}
          </div>
          {errorMsg ? <p className="add-msg err">{errorMsg}</p> : null}
          {okMsg ? <p className="add-msg ok">{okMsg}</p> : null}
          {scanPath && adminUnlocked ? (
            <p className="debug-caption" style={{ marginTop: 4 }}>
              scan path: <strong>{scanPath}</strong>
              {scanPath === "fallback"
                ? " (client warp failed — server got a lower-quality JPEG. likely cause of hollow-shape fills on phone uploads.)"
                : scanPath === "passthrough"
                ? " (couldn't even re-encode — server got the original photo bytes.)"
                : " (best case — perspective-corrected JPEG q1.0 uploaded.)"}
            </p>
          ) : null}
          {debug ? (
            <div className="debug-preview">
              <p className="debug-caption">
                {debug.cellCount} cells detected — cyan dots = markers, pink rects = cell crops
              </p>
              <img
                src={debug.url}
                width={debug.width}
                height={debug.height}
                alt="debug overlay"
                style={{ maxWidth: "100%", height: "auto", border: "1px solid var(--fg)" }}
              />
              <button
                type="button"
                className="make-debug-btn"
                onClick={() => setDebug(null)}
                style={{ alignSelf: "flex-start", marginTop: 8 }}
              >
                close
              </button>
            </div>
          ) : null}
          {debugFallback ? (
            <div className="debug-preview">
              <p className="debug-caption">
                detection failed — found {debugFallback.candidateCount} marker-shaped blobs at threshold{" "}
                {debugFallback.thresholdUsed}. green = top 4 (would be picked), yellow = extras.
              </p>
              <img
                src={debugFallback.url}
                width={debugFallback.width}
                height={debugFallback.height}
                alt="detection debug"
                style={{ maxWidth: "100%", height: "auto", border: "1px solid var(--fg)" }}
              />
              <button
                type="button"
                className="make-debug-btn"
                onClick={() => setDebugFallback(null)}
                style={{ alignSelf: "flex-start", marginTop: 8 }}
              >
                close
              </button>
            </div>
          ) : null}
          {tunerFileB64 ? (
            <TunerPanel
              params={tunerParams}
              data={tunerData}
              loading={tunerLoading}
              error={tunerError}
              onParamsChange={setTunerParams}
              onClose={handleCloseTuner}
            />
          ) : null}
        </form>
      ) : (
        <div className="add-form preview-panel">
          <p className="preview-title">
            {preview.glyphCount} გლიფი — გადახედე და დაამტკიცე
          </p>
          <div
            className="preview-grid"
            style={previewFamilyId ? { fontFamily: `"${previewFamilyId}"` } : undefined}
          >
            {ALPHABET.map((ch) => {
              const detected = preview.detectedChars.includes(ch);
              return (
                <span
                  key={ch}
                  className={`preview-cell${detected ? "" : " preview-cell-missing"}`}
                >
                  {ch}
                </span>
              );
            })}
          </div>
          <div className="preview-actions">
            <button type="button" onClick={handleSave} disabled={stage === "saving"}>
              {stage === "saving" ? "ვინახავ..." : "შევინახო"}
            </button>
            <button
              type="button"
              className="preview-discard"
              onClick={handleDiscard}
              disabled={stage === "saving"}
            >
              გადაყარე
            </button>
          </div>
          {errorMsg ? <p className="add-msg err">{errorMsg}</p> : null}
          {debug ? (
            <div className="debug-preview">
              <p className="debug-caption">
                {debug.cellCount} cells detected — cyan dots = markers, pink rects = cell crops
              </p>
              <img
                src={debug.url}
                width={debug.width}
                height={debug.height}
                alt="debug overlay"
                style={{ maxWidth: "100%", height: "auto", border: "1px solid var(--fg)" }}
              />
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

// =====================================================================
//  Tuner panel — interactive sliders + view tabs for debugging the pipeline
// =====================================================================

function TunerPanel({
  params,
  data,
  loading,
  error,
  onParamsChange,
  onClose,
}: {
  params: TunerParams;
  data: TunerData | null;
  loading: boolean;
  error: string | null;
  onParamsChange: (p: TunerParams) => void;
  onClose: () => void;
}) {
  const update = <K extends keyof TunerParams>(key: K, value: TunerParams[K]) => {
    onParamsChange({ ...params, [key]: value });
  };

  const views: { id: TunerView; label: string; hint: string }[] = [
    { id: "thresholded", label: "thresholded", hint: "raw binary the detector sees" },
    { id: "candidates", label: "candidates", hint: "topology-passing blobs (green=top4)" },
    { id: "warped", label: "warped", hint: "perspective-corrected canonical page" },
    { id: "cells", label: "cells", hint: "stage 1 — raw extracted grayscale per cell" },
    { id: "bg", label: "bg", hint: "stage 2 — background blur (the local lighting estimate)" },
    { id: "normalized", label: "normalized", hint: "stage 3 — cell − background + 255 (uniform white paper)" },
    { id: "binary", label: "binary", hint: "stage 4 — normalized < 180 → ink (global threshold)" },
    { id: "smoothed", label: "smoothed", hint: "stage 5 — binary + anti-alias blur (exactly what potrace receives)" },
    { id: "vectorized", label: "vectorized", hint: "stage 6 — final traced glyphs overlaid" },
  ];

  return (
    <div className="debug-preview tuner-panel">
      <div className="tuner-header">
        <strong>tune pipeline</strong>
        <button type="button" className="make-debug-btn" onClick={onClose}>
          close
        </button>
      </div>

      <div className="tuner-tabs">
        {views.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`tuner-tab${params.view === v.id ? " active" : ""}`}
            onClick={() => update("view", v.id)}
            title={v.hint}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="tuner-controls">
        <TunerSlider
          label="threshold"
          value={params.threshold}
          min={30}
          max={230}
          step={1}
          hint="detection cut (lower → more dark blobs)"
          onChange={(v) => update("threshold", v)}
        />
        <TunerSlider
          label="blur"
          value={params.blur}
          min={0}
          max={3}
          step={0.1}
          hint="per-cell smoothing before tracing"
          onChange={(v) => update("blur", v)}
        />
        <TunerSlider
          label="trace threshold"
          value={params.traceThreshold}
          min={80}
          max={230}
          step={1}
          hint="potrace cut (affects vectorized view)"
          onChange={(v) => update("traceThreshold", v)}
        />
      </div>

      <div className="tuner-stats">
        {loading ? "loading…" : null}
        {data ? (
          <span>
            view: <code>{data.view}</code> · threshold {data.threshold} · blur {data.blur.toFixed(1)} · trace{" "}
            {data.traceThreshold} · candidates: {data.candidateCount} · markers:{" "}
            {data.detectedMarkers ? "locked" : "—"}
            {typeof data.cellCount === "number" ? ` · cells traced: ${data.cellCount}` : ""}
          </span>
        ) : null}
      </div>

      {data?.message ? <p className="add-msg err">{data.message}</p> : null}
      {error ? <p className="add-msg err">{error}</p> : null}

      {data ? (
        <img
          src={`data:image/jpeg;base64,${data.pngBase64}`}
          width={data.width}
          height={data.height}
          alt={`debug ${data.view}`}
          // image-rendering: pixelated forces nearest-neighbor browser scaling.
          // Without this, the browser bilinear-downscales the (large) debug
          // PNGs and creates moiré patterns on any high-frequency content
          // (cell borders, label text) that read as "scan lines" on screen.
          // For inspection we want crisp pixels, not smoothed ones.
          style={{
            maxWidth: "100%",
            height: "auto",
            border: "1px solid var(--fg)",
            imageRendering: "pixelated",
          }}
        />
      ) : null}
    </div>
  );
}

function TunerSlider({
  label,
  value,
  min,
  max,
  step,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  hint: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="tuner-slider">
      <span className="tuner-slider-label">
        {label} <code>{step < 1 ? value.toFixed(1) : value}</code>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        title={hint}
      />
    </label>
  );
}
