"use client";

import { useState } from "react";
import type { FontEntry } from "@/lib/types";

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
          {/* Trimmed expanded panel: just name + author + download.
              The per-letter specimen grid was removed — it duplicated
              the alphabet preview already shown in the row header. */}
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
            {/* Restyled as a yellow button in the site's Georgian UI
                font, matching the action buttons elsewhere on the site
                (preview-actions, save buttons, etc). */}
            <a className="font-download-btn" href={font.file} download>
              ჩამოტვირთე
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
