"use client";

import { useState } from "react";
import type { FontEntry } from "@/lib/types";

const GEORGIAN_ALPHABET = "ა ბ გ დ ე ვ ზ თ ი კ ლ მ ნ ო პ ჟ რ ს ტ უ ფ ქ ღ ყ შ ჩ ც ძ წ ჭ ხ ჯ ჰ".split(" ");

// Unicode ranges for Georgian scripts: Mkhedruli (U+10A0–U+10FF),
// Khutsuri (U+2D00–U+2D2F), Mtavruli (U+1C90–U+1CBF). If a font name
// contains any of these, render it with the Georgian UI font so it
// looks at home alongside the rest of the workshop chrome.
const GEORGIAN_RE = /[Ⴀ-ჿⴀ-⴯Ა-Ჿ]/;
function isGeorgian(s: string | undefined | null): boolean {
  return !!s && GEORGIAN_RE.test(s);
}

export function FontRow({ font, alphabet }: { font: FontEntry; alphabet: string }) {
  const [open, setOpen] = useState(false);
  const nameStyle = isGeorgian(font.name)
    ? { fontFamily: "var(--ui-georgian)" }
    : undefined;
  const designerStyle = isGeorgian(font.designer)
    ? { fontFamily: "var(--ui-georgian)" }
    : undefined;

  return (
    <div className={`collectionContainers${open ? " open" : ""}`}>
      <a
        className="workshops alphabet-preview"
        style={{ fontFamily: `"${font.id}"` }}
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
        href="#"
        aria-label={font.name}
      >
        {alphabet}
      </a>

      {open ? (
        <div className="specimen">
          <div className="specimen-meta">
            <span className="meta-text specimen-name">
              <strong style={nameStyle}>{font.name}</strong>
              {font.designer ? (
                <em>
                  {" — ავტორი "}
                  <span style={designerStyle}>{font.designer}</span>
                </em>
              ) : null}
            </span>
            <a className="meta-text meta-download" href={font.file} download>
              ↓ ჩამოტვირთე
            </a>
          </div>

          <div className="specimen-grid">
            {GEORGIAN_ALPHABET.map((ch) => (
              <span
                key={ch}
                className="specimen-cell"
                style={{ fontFamily: `"${font.id}"` }}
              >
                {ch}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
