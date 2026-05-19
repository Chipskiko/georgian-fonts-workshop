"use client";

import { useState } from "react";
import type { FontEntry } from "@/lib/types";
import { deleteFont } from "./actions";
import { useAdmin } from "./useAdmin";

export function AdminPanel({ fonts }: { fonts: FontEntry[] }) {
  const { unlocked, password, unlock, lock } = useAdmin();
  const [pwInput, setPwInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const ok = await unlock(pwInput);
    if (!ok) {
      setError("wrong password");
    } else {
      setPwInput("");
    }
  }

  function handleLock() {
    lock();
    setMsg(null);
  }

  async function handleDelete(filename: string) {
    setPendingDelete(filename);
    setMsg(null);
    const r = await deleteFont(filename, password);
    setPendingDelete(null);
    setConfirmingDelete(null);
    setMsg(r.message);
    if (!r.ok && r.message === "wrong password") {
      handleLock();
    }
  }

  if (!unlocked) {
    return (
      <form className="admin-gate" onSubmit={handleSubmit}>
        <label className="add-row">
          <span>admin password</span>
          <input
            type="password"
            value={pwInput}
            onChange={(e) => setPwInput(e.target.value)}
            autoComplete="off"
          />
        </label>
        <button type="submit">unlock</button>
        {error ? <p className="add-msg err">{error}</p> : null}
      </form>
    );
  }

  return (
    <div className="admin-panel">
      <div className="admin-header">
        <span className="admin-status">
          <strong>admin unlocked</strong> — click delete to remove a font
        </span>
        <button type="button" className="admin-lock" onClick={handleLock}>
          lock
        </button>
      </div>

      {msg ? <p className="add-msg ok">{msg}</p> : null}

      <ul className="admin-list">
        {fonts.map((f) => {
          const confirming = confirmingDelete === f.filename;
          const isPending = pendingDelete === f.filename;
          return (
            <li key={f.filename}>
              <span className="admin-font-name" style={{ fontFamily: `"${f.id}"` }}>
                {f.name}
              </span>
              {f.designer ? <em className="admin-designer"> by {f.designer}</em> : null}
              <span className="admin-actions">
                {confirming ? (
                  <>
                    <button
                      type="button"
                      className="admin-confirm"
                      onClick={() => handleDelete(f.filename)}
                      disabled={isPending}
                    >
                      {isPending ? "deleting..." : "yes, delete"}
                    </button>
                    <button
                      type="button"
                      className="admin-cancel"
                      onClick={() => setConfirmingDelete(null)}
                      disabled={isPending}
                    >
                      cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="admin-delete"
                    onClick={() => setConfirmingDelete(f.filename)}
                  >
                    delete
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
