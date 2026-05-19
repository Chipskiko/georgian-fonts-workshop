"use client";

import { useEffect, useRef, useState } from "react";
import Matter from "matter-js";
import type { FontEntry } from "@/lib/types";
import { posterizerState, persistState, loadSnapshot, type Poster } from "./state";

// Georgian Mkhedruli alphabet — these are the only characters we accept
// from keyboard input. Filters out punctuation, numbers, Latin letters.
const ALPHABET = "ა ბ გ დ ე ვ ზ თ ი კ ლ მ ნ ო პ ჟ რ ს ტ უ ფ ქ ღ ყ შ ჩ ც ძ წ ჭ ხ ჯ ჰ".split(" ");
const ALPHABET_SET = new Set(ALPHABET);

const A3_WIDTH = 420;
const A3_HEIGHT = Math.round(A3_WIDTH * Math.sqrt(2));
const A3_MM_W = 297;
const A3_MM_H = 420;
const POLL_INTERVAL_MS = 3000;

// Same px size for every letter — no random variation, even spacing.
// Tuned so ~40-50 letters fill an A3 poster comfortably.
const LETTER_SIZE = 56;
const SPAWN_TOP_Y = 12;             // small margin from poster top edge
const CEILING_Y = -4;               // invisible collider above poster
const FULL_TOP_THRESHOLD = SPAWN_TOP_Y + 4; // when settled letters reach this, poster is full

const DEFAULT_BG = "#ffea00";
const DEFAULT_FG = "#ff10b8";

// Print-ready PNG: 300 DPI A3 (≈ 3508 × 4961). Good for high-quality
// printout without bloating the file too much.
const DPI = 300;
const SAVE_PX_W = Math.round((A3_MM_W / 25.4) * DPI);
const SAVE_PX_H = Math.round((A3_MM_H / 25.4) * DPI);

async function downloadPosterPng(p: Poster, idx: number) {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = SAVE_PX_W;
  canvas.height = SAVE_PX_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const scaleX = SAVE_PX_W / A3_WIDTH;
  const scaleY = SAVE_PX_H / A3_HEIGHT;
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, SAVE_PX_W, SAVE_PX_H);
  ctx.fillStyle = p.fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const l of p.letters) {
    if (l.body.position.y < -l.size) continue;
    ctx.save();
    ctx.translate(l.body.position.x * scaleX, l.body.position.y * scaleY);
    ctx.rotate(l.body.angle);
    ctx.font = `${l.size * scaleY}px "${l.fontId}"`;
    ctx.fillText(l.char, 0, 0);
    ctx.restore();
  }
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `poster-${String(idx + 1).padStart(2, "0")}-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, "image/png");
}

export function Posterizer({
  initialFonts,
  cssFontFaces,
}: {
  initialFonts: FontEntry[];
  cssFontFaces: string;
}) {
  const [, setTick] = useState(0);
  const allFontsRef = useRef<FontEntry[]>(initialFonts);
  const dynamicStyleRef = useRef<HTMLStyleElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const keyInputRef = useRef<HTMLInputElement | null>(null);

  function createPoster(currentFontId: string | null): Poster {
    const engine = Matter.Engine.create({
      gravity: { x: 0, y: 1.2 },
      enableSleeping: false,
    });
    const T = 200; // wall thickness
    // CEILING: invisible collider just above the visible top edge. Stops
    // letters from being squeezed out the top by the pile below.
    const ceiling = Matter.Bodies.rectangle(
      A3_WIDTH / 2,
      CEILING_Y - T / 2,
      A3_WIDTH * 4,
      T,
      { isStatic: true },
    );
    const floor = Matter.Bodies.rectangle(A3_WIDTH / 2, A3_HEIGHT + T / 2, A3_WIDTH * 4, T, { isStatic: true });
    const left = Matter.Bodies.rectangle(-T / 2, A3_HEIGHT / 2, T, A3_HEIGHT * 4, { isStatic: true });
    const right = Matter.Bodies.rectangle(A3_WIDTH + T / 2, A3_HEIGHT / 2, T, A3_HEIGHT * 4, { isStatic: true });
    Matter.Composite.add(engine.world, [ceiling, floor, left, right]);
    return {
      id: posterizerState.nextId++,
      engine,
      letters: [],
      bg: DEFAULT_BG,
      fg: DEFAULT_FG,
      currentFontId,
      finalized: false,
    };
  }

  function isPosterFull(p: Poster): boolean {
    if (p.letters.length === 0) return false;
    // Full when ANY settled letter (low vertical velocity) is touching the
    // top boundary — i.e. the pile reached the top.
    return p.letters.some(
      (l) =>
        l.body.position.y > 0 &&
        Math.abs(l.body.velocity.y) < 1.5 &&
        l.body.position.y - l.size * 0.42 < FULL_TOP_THRESHOLD,
    );
  }

  function spawnInPoster(p: Poster, char: string, fontId: string) {
    const size = LETTER_SIZE;
    const radius = size * 0.42;
    const x = Math.random() * (A3_WIDTH - size) + size / 2;
    const body = Matter.Bodies.circle(x, SPAWN_TOP_Y + size, radius, {
      restitution: 0.3,
      friction: 0.3,
      frictionAir: 0.005,
      density: 0.001,
    });
    Matter.Body.setVelocity(body, { x: (Math.random() - 0.5) * 2, y: 1 });
    Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.05);
    Matter.Composite.add(p.engine.world, body);
    p.letters.push({ id: posterizerState.nextId++, body, char, fontId, size });
  }

  function removeLastLetter(p: Poster) {
    const last = p.letters.pop();
    if (!last) return;
    Matter.Composite.remove(p.engine.world, last.body);
  }

  function activePoster(): Poster | null {
    const list = posterizerState.posters;
    if (list.length === 0) return null;
    const last = list[list.length - 1];
    return last.finalized ? null : last;
  }

  function setPosterColor(posterId: number, key: "bg" | "fg", value: string) {
    const p = posterizerState.posters.find((x) => x.id === posterId);
    if (!p) return;
    p[key] = value;
    setTick((n) => (n + 1) % 1_000_000);
  }

  function setPosterFont(posterId: number, fontId: string) {
    const p = posterizerState.posters.find((x) => x.id === posterId);
    if (!p) return;
    p.currentFontId = fontId;
    setTick((n) => (n + 1) % 1_000_000);
  }

  function addNewPoster() {
    // Finalise the current (last) poster, then create a new active one
    // inheriting its colours + font.
    const current = posterizerState.posters[posterizerState.posters.length - 1];
    if (current) current.finalized = true;
    const fontId = current?.currentFontId ?? initialFonts[0]?.id ?? null;
    const fresh = createPoster(fontId);
    if (current) {
      fresh.bg = current.bg;
      fresh.fg = current.fg;
    }
    posterizerState.posters.push(fresh);
    setTick((n) => (n + 1) % 1_000_000);
    // Focus the keyboard input so typing continues
    setTimeout(() => keyInputRef.current?.focus(), 50);
  }

  async function ensureFontFaceLoaded(font: FontEntry) {
    if (posterizerState.loadedFontFaceIds.has(font.id)) return;
    posterizerState.loadedFontFaceIds.add(font.id);
    try {
      const ff = new FontFace(font.id, `url("${font.file}") format("${font.format}")`);
      const loaded = await ff.load();
      document.fonts.add(loaded);
    } catch {
      if (dynamicStyleRef.current) {
        dynamicStyleRef.current.appendChild(
          document.createTextNode(
            `@font-face{font-family:"${font.id}";src:url("${font.file}") format("${font.format}");font-display:swap;}`,
          ),
        );
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const active = activePoster();
    if (!active) return;
    if (e.key === "Backspace") {
      e.preventDefault();
      removeLastLetter(active);
      setTick((n) => (n + 1) % 1_000_000);
      return;
    }
    // Accept Georgian letters only
    const ch = e.key;
    if (!ALPHABET_SET.has(ch)) return;
    e.preventDefault();
    if (active.finalized || isPosterFull(active)) {
      active.finalized = true;
      setTick((n) => (n + 1) % 1_000_000);
      return;
    }
    const fontId = active.currentFontId ?? allFontsRef.current[0]?.id ?? null;
    if (!fontId) return;
    spawnInPoster(active, ch, fontId);
    setTick((n) => (n + 1) % 1_000_000);
  }

  function refocusInput() {
    keyInputRef.current?.focus();
  }

  useEffect(() => {
    // Dynamic <style> for runtime-injected @font-face fallbacks
    if (!dynamicStyleRef.current) {
      const el = document.createElement("style");
      el.dataset.posterizer = "dynamic-fonts";
      document.head.appendChild(el);
      dynamicStyleRef.current = el;
    }

    for (const f of initialFonts) void ensureFontFaceLoaded(f);

    if (!posterizerState.initialized) {
      posterizerState.initialized = true;
      const snap = loadSnapshot();
      if (snap && snap.posters.length > 0) {
        posterizerState.nextId = snap.nextId;
        posterizerState.posters = snap.posters.map((s) => {
          const p = createPoster(s.currentFontId);
          p.id = s.id;
          p.bg = s.bg;
          p.fg = s.fg;
          p.finalized = s.finalized;
          for (const l of s.letters) {
            const radius = l.size * 0.42;
            const body = Matter.Bodies.circle(l.x, l.y, radius, {
              restitution: 0.3,
              friction: 0.3,
              frictionAir: 0.005,
              density: 0.001,
            });
            Matter.Body.setAngle(body, l.angle);
            Matter.Composite.add(p.engine.world, body);
            p.letters.push({ id: l.id, body, char: l.char, fontId: l.fontId, size: l.size });
          }
          return p;
        });
      } else {
        // Cold start — one empty poster, default font = first available
        const initialFontId = initialFonts[0]?.id ?? null;
        posterizerState.posters = [createPoster(initialFontId)];
      }
    } else {
      for (const f of initialFonts) void ensureFontFaceLoaded(f);
    }

    const loop = () => {
      for (const p of posterizerState.posters) {
        Matter.Engine.update(p.engine, 16, 1);
      }
      setTick((n) => (n + 1) % 1_000_000);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    const persistTimer = setInterval(() => persistState(), 1000);

    // Poll for newly-uploaded fonts so the font selector stays current
    const iv = setInterval(async () => {
      try {
        const res = await fetch("/api/fonts", { cache: "no-store" });
        const data = (await res.json()) as { fonts: FontEntry[] };
        allFontsRef.current = data.fonts;
        for (const f of data.fonts) await ensureFontFaceLoaded(f);
        setTick((n) => (n + 1) % 1_000_000);
      } catch {
        /* ignore */
      }
    }, POLL_INTERVAL_MS);

    // Auto-focus the keyboard input on mount and on any click in the page
    setTimeout(() => keyInputRef.current?.focus(), 50);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      clearInterval(iv);
      clearInterval(persistTimer);
      persistState();
    };
  }, [initialFonts]);

  const allFonts = allFontsRef.current;
  const active = activePoster();
  const noFontsYet = allFonts.length === 0;

  return (
    <div className="posterizer" onClick={refocusInput}>
      <style dangerouslySetInnerHTML={{ __html: cssFontFaces }} />

      {/* Off-screen input that captures all keystrokes. Stays focused
          so typing always goes to the active poster. */}
      <input
        ref={keyInputRef}
        type="text"
        className="poster-key-input"
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(refocusInput, 0)}
        aria-label="poster keyboard"
        autoComplete="off"
        spellCheck={false}
        // Keep its value empty so it doesn't accumulate or echo
        value=""
        onChange={() => {}}
      />

      {noFontsYet ? (
        <p className="poster-instruction">
          ჯერ შრიფტი არ არის — შექმენი ერთი <a href="/add">აქ</a>, შემდეგ
          დაბრუნდი.
        </p>
      ) : (
        <p className="poster-instruction">
          ჩაწერე ქართული ასოები. backspace ბოლოს მოაშორებს.
          {active ? null : " პოსტერი დასრულდა — დაამატე ახალი ➕"}
        </p>
      )}

      <div className="posters-row">
        {posterizerState.posters.map((p, idx) => {
          const fontsUsed = Array.from(
            new Set(p.letters.map((l) => l.fontId)),
          )
            .map((id) => allFonts.find((f) => f.id === id))
            .filter((f): f is FontEntry => !!f);
          const isActive = !p.finalized && idx === posterizerState.posters.length - 1;
          const full = isPosterFull(p);
          return (
            <div
              key={p.id}
              className={`poster-card${isActive ? " poster-active" : ""}`}
            >
              <div className="poster-controls">
                <label className="poster-color">
                  <span>ფონი</span>
                  <input
                    type="color"
                    value={p.bg}
                    onChange={(e) => setPosterColor(p.id, "bg", e.target.value)}
                  />
                </label>
                <label className="poster-color">
                  <span>ტექსტი</span>
                  <input
                    type="color"
                    value={p.fg}
                    onChange={(e) => setPosterColor(p.id, "fg", e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="poster-icon-btn"
                  onClick={() => downloadPosterPng(p, idx)}
                  aria-label="download png"
                  title="download png"
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                    <path d="M8 2v8M4 7l4 4 4-4M2 14h12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
                  </svg>
                </button>
              </div>

              <div
                className="a3-poster"
                style={{
                  width: A3_WIDTH,
                  height: A3_HEIGHT,
                  background: p.bg,
                  color: p.fg,
                }}
              >
                {p.letters.map((l) => (
                  <span
                    key={l.id}
                    className="poster-letter"
                    style={{
                      color: p.fg,
                      fontFamily: `"${l.fontId}"`,
                      fontSize: `${l.size}px`,
                      transform: `translate3d(${l.body.position.x}px, ${l.body.position.y}px, 0) translate(-50%, -50%) rotate(${l.body.angle}rad)`,
                    }}
                  >
                    {l.char}
                  </span>
                ))}
                {full ? <div className="poster-full-badge">გაივსო</div> : null}
              </div>

              {/* Font selector — only on the active poster */}
              {isActive && allFonts.length > 0 ? (
                <div className="poster-font-picker">
                  <span>შრიფტი</span>
                  <select
                    value={p.currentFontId ?? ""}
                    onChange={(e) => setPosterFont(p.id, e.target.value)}
                  >
                    {allFonts.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {/* Fonts used — live list of font names appearing in this poster */}
              {fontsUsed.length > 0 ? (
                <ul className="poster-fonts-used">
                  {fontsUsed.map((f) => (
                    <li key={f.id} style={{ fontFamily: `"${f.id}"` }}>
                      {f.name}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}

        {/* Add-new-poster tile — yellow square with pink + */}
        <button
          type="button"
          className="poster-add-btn"
          onClick={addNewPoster}
          aria-label="add poster"
          title="ახალი პოსტერი"
          disabled={
            posterizerState.posters[posterizerState.posters.length - 1]?.letters.length === 0
          }
        >
          <svg viewBox="0 0 24 24" width="48" height="48" aria-hidden="true">
            <line x1="12" y1="4" x2="12" y2="20" stroke="#ff10b8" strokeWidth="3" strokeLinecap="square" />
            <line x1="4" y1="12" x2="20" y2="12" stroke="#ff10b8" strokeWidth="3" strokeLinecap="square" />
          </svg>
        </button>
      </div>
    </div>
  );
}
