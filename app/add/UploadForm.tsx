"use client";

import { useState } from "react";
import { uploadFont } from "./actions";

export function UploadForm() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setResult(null);
    const form = e.currentTarget;
    const fd = new FormData(form);
    try {
      const r = await uploadFont(fd);
      setResult(r);
      if (r.ok) {
        form.reset();
        setFileName(null);
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "upload failed" });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="add-form" onSubmit={handleSubmit}>
      <label className="add-row">
        <span>ფაილი</span>
        <span className="file-picker">
          <input
            type="file"
            name="file"
            accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
            required
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
            className="file-picker-input"
          />
          <span className="file-picker-label">
            {fileName ?? "ველოდები ფაილს..."}
          </span>
        </span>
      </label>
      <label className="add-row">
        <span>სახელი</span>
        <input
          type="text"
          name="fontName"
          lang="ka"
          style={{ fontFamily: "var(--ui-georgian)" }}
        />
      </label>
      <label className="add-row">
        <span>ავტორი</span>
        <input type="text" name="designer" />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "..." : "ატვირთე"}
      </button>
      {result ? (
        <p className={result.ok ? "add-msg ok" : "add-msg err"}>{result.message}</p>
      ) : null}
    </form>
  );
}
