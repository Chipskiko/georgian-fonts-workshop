"use client";

import { useEffect, useRef, useState } from "react";
import Matter from "matter-js";
import type { FontEntry } from "@/lib/types";
import { uploadPoster } from "../posterizer/actions";

// Georgian Mkhedruli alphabet — these are the only characters we accept.
const ALPHABET = "ა ბ გ დ ე ვ ზ თ ი კ ლ მ ნ ო პ ჟ რ ს ტ უ ფ ქ ღ ყ შ ჩ ც ძ წ ჭ ხ ჯ ჰ".split(" ");
const ALPHABET_SET = new Set(ALPHABET);

// Optional QWERTY → Georgian fallback. If user is on a Latin keyboard layout,
// a→ა, b→ბ, etc., so they can still play without switching keyboards.
const QWERTY_TO_GEORGIAN: Record<string, string> = {
  a: "ა", b: "ბ", c: "ც", d: "დ", e: "ე", f: "ფ", g: "გ", h: "ჰ",
  i: "ი", j: "ჯ", k: "კ", l: "ლ", m: "მ", n: "ნ", o: "ო", p: "პ",
  q: "ქ", r: "რ", s: "ს", t: "ტ", u: "უ", v: "ვ", w: "წ", x: "ხ",
  y: "ყ", z: "ზ",
};

// A4 portrait. Screen units == physics units (no scaling).
// Print PNG output is computed at 300 DPI based on A4 mm dimensions.
const A4_WIDTH = 420;
const A4_HEIGHT = Math.round(A4_WIDTH * Math.sqrt(2)); // 594
const A4_MM_W = 210;
const A4_MM_H = 297;
const DPI = 300;
const SAVE_PX_W = Math.round((A4_MM_W / 25.4) * DPI); // 2480
const SAVE_PX_H = Math.round((A4_MM_H / 25.4) * DPI); // 3508

const LETTER_SIZE = 56;
const SPAWN_TOP_Y = 12;
const CEILING_Y = -4;
const FULL_TOP_THRESHOLD = SPAWN_TOP_Y + 4;
const POLL_INTERVAL_MS = 3000;

const DEFAULT_BG = "#ffea00";
const DEFAULT_FG = "#ff10b8";

type Letter = {
  id: number;
  body: Matter.Body;
  char: string;
  fontId: string;
  size: number;
};

// Module-level singleton so engine + letters survive component remounts
// (e.g. navigating between routes within the same tab). Cleared on
// reload — there's no localStorage persistence; the gallery is the
// archive. This is intentional: cascade is "in progress" only.
type CascadeRuntime = {
  engine: Matter.Engine | null;
  letters: Letter[];
  loadedFontFaceIds: Set<string>;
  nextId: number;
};

const runtime: CascadeRuntime = {
  engine: null,
  letters: [],
  loadedFontFaceIds: new Set(),
  nextId: 0,
};

function createEngine(): Matter.Engine {
  const engine = Matter.Engine.create({
    gravity: { x: 0, y: 0.6 },
    enableSleeping: false,
  });
  const T = 200;
  const ceiling = Matter.Bodies.rectangle(
    A4_WIDTH / 2,
    CEILING_Y - T / 2,
    A4_WIDTH * 4,
    T,
    { isStatic: true },
  );
  const floor = Matter.Bodies.rectangle(
    A4_WIDTH / 2,
    A4_HEIGHT + T / 2,
    A4_WIDTH * 4,
    T,
    { isStatic: true },
  );
  const left = Matter.Bodies.rectangle(
    -T / 2,
    A4_HEIGHT / 2,
    T,
    A4_HEIGHT * 4,
    { isStatic: true },
  );
  const right = Matter.Bodies.rectangle(
    A4_WIDTH + T / 2,
    A4_HEIGHT / 2,
    T,
    A4_HEIGHT * 4,
    { isStatic: true },
  );
  Matter.Composite.add(engine.world, [ceiling, floor, left, right]);
  return engine;
}

function isFull(): boolean {
  if (runtime.letters.length === 0) return false;
  // Full when any settled letter is touching the top boundary.
  return runtime.letters.some(
    (l) =>
      l.body.position.y > 0 &&
      Math.abs(l.body.velocity.y) < 1.5 &&
      l.body.position.y - l.size * 0.42 < FULL_TOP_THRESHOLD,
  );
}

function spawnLetter(char: string, fontId: string) {
  if (!runtime.engine) return;
  const size = LETTER_SIZE;
  const radius = size * 0.42;
  const x = Math.random() * (A4_WIDTH - size) + size / 2;
  const body = Matter.Bodies.circle(x, SPAWN_TOP_Y + size, radius, {
    restitution: 0.3,
    friction: 0.3,
    frictionAir: 0.005,
    density: 0.001,
  });
  Matter.Body.setVelocity(body, { x: (Math.random() - 0.5) * 2, y: 1 });
  Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.05);
  Matter.Composite.add(runtime.engine.world, body);
  runtime.letters.push({ id: runtime.nextId++, body, char, fontId, size });
}

function removeLast() {
  if (!runtime.engine) return;
  const last = runtime.letters.pop();
  if (!last) return;
  Matter.Composite.remove(runtime.engine.world, last.body);
}

function clearAll() {
  if (!runtime.engine) return;
  for (const l of runtime.letters) {
    Matter.Composite.remove(runtime.engine.world, l.body);
  }
  runtime.letters = [];
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

export function CascadeStage({
  initialFonts,
  cssFontFaces,
}: {
  initialFonts: FontEntry[];
  cssFontFaces: string;
}) {
  const [, setTick] = useState(0);
  const [bg, setBg] = useState(DEFAULT_BG);
  const [fg, setFg] = useState(DEFAULT_FG);
  const [currentFontId, setCurrentFontId] = useState<string | null>(
    initialFonts[0]?.id ?? null,
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  const allFontsRef = useRef<FontEntry[]>(initialFonts);
  const dynamicStyleRef = useRef<HTMLStyleElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const savingInFlightRef = useRef(false);
  // Refs for values the RAF loop reads — avoids loop restarts on every change.
  const currentFontIdRef = useRef(currentFontId);
  const bgRef = useRef(bg);
  const fgRef = useRef(fg);
  // Mirror save status to a ref so the RAF loop sees the latest value without
  // restarting on every change. Auto-save only re-fires when status is "idle"
  // — prevents retry storms when an error toast is showing and prevents
  // double-saves during the success-toast window.
  const saveStatusRef = useRef<SaveStatus>(saveStatus);
  useEffect(() => {
    currentFontIdRef.current = currentFontId;
  }, [currentFontId]);
  useEffect(() => {
    bgRef.current = bg;
  }, [bg]);
  useEffect(() => {
    fgRef.current = fg;
  }, [fg]);
  useEffect(() => {
    saveStatusRef.current = saveStatus;
  }, [saveStatus]);

  async function ensureFontFaceLoaded(font: FontEntry) {
    if (runtime.loadedFontFaceIds.has(font.id)) return;
    runtime.loadedFontFaceIds.add(font.id);
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

  async function saveAndReset() {
    if (savingInFlightRef.current) return;
    if (!stageRef.current) return;
    if (runtime.letters.length === 0) return;
    savingInFlightRef.current = true;
    setSaveStatus("saving");
    try {
      await document.fonts.ready;
      const html2canvas = (await import("html2canvas-pro")).default;
      const canvas = await html2canvas(stageRef.current, {
        backgroundColor: bgRef.current,
        // Capture at print resolution so saved poster is print-ready
        scale: SAVE_PX_W / A4_WIDTH,
        logging: false,
        useCORS: true,
      });
      const blob: Blob | null = await new Promise((res) =>
        canvas.toBlob(res, "image/png"),
      );
      if (!blob) throw new Error("toBlob failed");
      const fd = new FormData();
      fd.append("file", blob, "poster.png");
      const result = await uploadPoster(fd);
      if (!result.ok) throw new Error(result.message);
      // Wipe stage so the user can start the next poster immediately
      clearAll();
      setSaveStatus("saved");
      setTick((n) => (n + 1) % 1_000_000);
      window.setTimeout(() => setSaveStatus("idle"), 5000);
    } catch (err) {
      console.error("save failed:", err);
      setSaveStatus("error");
      window.setTimeout(() => setSaveStatus("idle"), 5000);
    } finally {
      savingInFlightRef.current = false;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Block typing during save so the snapshot doesn't change mid-flight
    if (savingInFlightRef.current) {
      e.preventDefault();
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      removeLast();
      setTick((n) => (n + 1) % 1_000_000);
      return;
    }
    e.preventDefault();
    let ch = e.key;
    if (ch.length === 1 && !ALPHABET_SET.has(ch)) {
      ch = QWERTY_TO_GEORGIAN[ch.toLowerCase()] ?? ch;
    }
    if (!ALPHABET_SET.has(ch)) return;
    if (isFull()) {
      // Already brimming — instead of accepting another letter, save it.
      void saveAndReset();
      return;
    }
    const fontId = currentFontIdRef.current ?? allFontsRef.current[0]?.id ?? null;
    if (!fontId) return;
    spawnLetter(ch, fontId);
    setTick((n) => (n + 1) % 1_000_000);
  }

  function handlePageClick(e: React.MouseEvent<HTMLDivElement>) {
    // Refocus the keyboard input only when the click lands inside the
    // A4 stage. Clicks on color pickers, font selector, save button must
    // not steal focus from those controls.
    const target = e.target as HTMLElement;
    if (target.closest(".cascade-a4-stage")) {
      keyInputRef.current?.focus();
    }
  }

  useEffect(() => {
    if (!dynamicStyleRef.current) {
      const el = document.createElement("style");
      el.dataset.cascade = "dynamic-fonts";
      document.head.appendChild(el);
      dynamicStyleRef.current = el;
    }
    for (const f of initialFonts) void ensureFontFaceLoaded(f);

    if (!runtime.engine) {
      runtime.engine = createEngine();
    }

    const loop = () => {
      if (runtime.engine) Matter.Engine.update(runtime.engine, 16, 1);
      // Auto-trigger save when the poster fills up naturally (without
      // the user pressing another key). Only fire when idle so we don't
      // retry-storm a failing upload or double-save during the success toast.
      if (
        !savingInFlightRef.current &&
        saveStatusRef.current === "idle" &&
        isFull()
      ) {
        void saveAndReset();
      }
      setTick((n) => (n + 1) % 1_000_000);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    // Poll for newly-uploaded fonts so the picker stays current.
    const iv = window.setInterval(async () => {
      try {
        const res = await fetch("/api/fonts", { cache: "no-store" });
        const data = (await res.json()) as { fonts: FontEntry[] };
        allFontsRef.current = data.fonts;
        for (const f of data.fonts) await ensureFontFaceLoaded(f);
        if (!currentFontIdRef.current && data.fonts.length > 0) {
          setCurrentFontId(data.fonts[0].id);
        }
        setTick((n) => (n + 1) % 1_000_000);
      } catch {
        /* ignore */
      }
    }, POLL_INTERVAL_MS);

    window.setTimeout(() => keyInputRef.current?.focus(), 50);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.clearInterval(iv);
    };
    // Intentionally only [initialFonts] — runtime values are accessed via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFonts]);

  const allFonts = allFontsRef.current;
  const noFontsYet = allFonts.length === 0;
  const letterCount = runtime.letters.length;
  // Fonts present in the current in-progress poster
  const fontsUsed = Array.from(new Set(runtime.letters.map((l) => l.fontId)))
    .map((id) => allFonts.find((f) => f.id === id))
    .filter((f): f is FontEntry => !!f);

  return (
    <div className="cascade-page" onClick={handlePageClick}>
      <style dangerouslySetInnerHTML={{ __html: cssFontFaces }} />

      <input
        ref={keyInputRef}
        type="text"
        className="poster-key-input"
        onKeyDown={handleKeyDown}
        aria-label="cascade keyboard"
        autoComplete="off"
        spellCheck={false}
        value=""
        onChange={() => {}}
      />

      {noFontsYet ? (
        <p className="poster-instruction">
          ჯერ შრიფტი არ არის — შექმენი ერთი <a href="/add">აქ</a>, შემდეგ დაბრუნდი.
        </p>
      ) : (
        <div className="cascade-controls">
          <label className="poster-color">
            <span>ფონი</span>
            <input
              type="color"
              value={bg}
              onChange={(e) => setBg(e.target.value)}
            />
          </label>
          <label className="poster-color">
            <span>ტექსტი</span>
            <input
              type="color"
              value={fg}
              onChange={(e) => setFg(e.target.value)}
            />
          </label>
          <div className="poster-font-picker">
            <span>შრიფტი</span>
            <select
              value={currentFontId ?? ""}
              onChange={(e) => setCurrentFontId(e.target.value)}
            >
              {allFonts.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="cascade-save-btn"
            onClick={() => void saveAndReset()}
            disabled={letterCount === 0 || saveStatus === "saving"}
          >
            შენახვა
          </button>
        </div>
      )}

      <div className="cascade-stage-wrap">
        <div
          ref={stageRef}
          className="cascade-a4-stage"
          style={{
            width: A4_WIDTH,
            height: A4_HEIGHT,
            background: bg,
            color: fg,
          }}
        >
          {runtime.letters.map((l) => (
            <span
              key={l.id}
              className="poster-letter"
              style={{
                color: fg,
                fontFamily: `"${l.fontId}"`,
                fontSize: `${l.size}px`,
                transform: `translate3d(${l.body.position.x}px, ${l.body.position.y}px, 0) translate(-50%, -50%) rotate(${l.body.angle}rad)`,
              }}
            >
              {l.char}
            </span>
          ))}
        </div>
      </div>

      {fontsUsed.length > 0 ? (
        <ul className="poster-fonts-used">
          {fontsUsed.map((f) => (
            <li key={f.id} style={{ fontFamily: `"${f.id}"` }}>
              {f.name}
            </li>
          ))}
        </ul>
      ) : null}

      {saveStatus === "saving" ? (
        <p className="cascade-toast">ინახება…</p>
      ) : saveStatus === "saved" ? (
        <p className="cascade-toast cascade-toast-ok">
          შენახულია — <a href="/posterizer">ნახე გალერეაში</a>
        </p>
      ) : saveStatus === "error" ? (
        <p className="cascade-toast cascade-toast-err">შენახვის შეცდომა</p>
      ) : null}
    </div>
  );
}
