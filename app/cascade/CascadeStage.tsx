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
// Print PNG output is computed at 150 DPI based on A4 mm dimensions.
// 150 DPI is the sweet spot for A4 home/office prints — visually
// indistinguishable from 300 unless you put your nose on the paper —
// while ~4× cheaper to render (html2canvas walks the DOM at this scale).
const A4_WIDTH = 420;
const A4_HEIGHT = Math.round(A4_WIDTH * Math.sqrt(2)); // 594
const A4_MM_W = 210;
const A4_MM_H = 297;
const DPI = 150;
const SAVE_PX_W = Math.round((A4_MM_W / 25.4) * DPI); // 1240
const SAVE_PX_H = Math.round((A4_MM_H / 25.4) * DPI); // 1754

const LETTER_SIZE = 56;
const SPAWN_TOP_Y = 12;
const CEILING_Y = -4;
const POLL_INTERVAL_MS = 3000;

// Drawing-tool constants. The draw canvas runs at print resolution so
// strokes stay crisp in the saved PNG (the snapshot scales the canvas
// up ~6x, and a low-res buffer would look blurry).
const DRAW_SCALE = SAVE_PX_W / A4_WIDTH;
const PENCIL_WIDTH_CSS = 3; // CSS px on screen
const ERASER_RADIUS_CSS = 14; // CSS px on screen

type Tool = "move" | "pencil" | "eraser" | "type";

const DEFAULT_BG = "#ffffff";
const DEFAULT_FG = "#000000";

type Letter = {
  id: number;
  body: Matter.Body;
  char: string;
  fontId: string;
  /** Current visual size (px). Equals baseSize * SCALES[scaleLevel]. */
  size: number;
  /** Size when the letter was first spawned. Cycling resets back to this. */
  baseSize: number;
  /** Index into SCALES — 0=original, 1=1.5x, 2=2x, then wraps back to 0. */
  scaleLevel: number;
};

// Double-click cycles letter size through these multipliers, then wraps.
const SCALES = [1.0, 1.5, 2.0];

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
  runtime.letters.push({
    id: runtime.nextId++,
    body,
    char,
    fontId,
    size,
    baseSize: size,
    scaleLevel: 0,
  });
}

/** Cycle a letter through SCALES. Body is replaced with a same-properties
 * one at the new radius — Matter.Body.scale leaves quirky mass/inertia
 * state, so a clean rebuild is safer. Position, angle and static-ness
 * are preserved. */
function scaleUpLetter(letter: Letter) {
  if (!runtime.engine) return;
  const nextLevel = (letter.scaleLevel + 1) % SCALES.length;
  const newSize = letter.baseSize * SCALES[nextLevel];
  const newRadius = newSize * 0.42;
  const wasStatic = letter.body.isStatic;
  const px = letter.body.position.x;
  const py = letter.body.position.y;
  const angle = letter.body.angle;
  Matter.Composite.remove(runtime.engine.world, letter.body);
  const newBody = Matter.Bodies.circle(px, py, newRadius, {
    restitution: 0.3,
    friction: 0.3,
    frictionAir: 0.005,
    density: 0.001,
    isStatic: wasStatic,
  });
  Matter.Body.setAngle(newBody, angle);
  Matter.Composite.add(runtime.engine.world, newBody);
  letter.body = newBody;
  letter.size = newSize;
  letter.scaleLevel = nextLevel;
}

function removeLetter(id: number) {
  if (!runtime.engine) return;
  const idx = runtime.letters.findIndex((l) => l.id === id);
  if (idx === -1) return;
  const [letter] = runtime.letters.splice(idx, 1);
  Matter.Composite.remove(runtime.engine.world, letter.body);
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
  // Current pointer tool: move (drag/resize letters), pencil (draw lines),
  // eraser (delete letters + erase canvas pixels).
  const [tool, setTool] = useState<Tool>("move");

  const allFontsRef = useRef<FontEntry[]>(initialFonts);
  const dynamicStyleRef = useRef<HTMLStyleElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const savingInFlightRef = useRef(false);
  // Drag-to-pin state. When the user grabs a letter, we store its id +
  // the pointer-to-body offset so the letter follows the pointer without
  // jumping its center. Body is set static on grab and stays static on
  // release — that's the "lock in place but still collides" behavior.
  const dragRef = useRef<{
    letterId: number | null;
    offsetX: number;
    offsetY: number;
  }>({ letterId: null, offsetX: 0, offsetY: 0 });
  // Pencil/eraser stroke tracking. `active` is set on pointerdown for
  // those tools and cleared on pointerup; lastX/lastY remember the
  // previous point so we can draw/erase a continuous line.
  const strokeRef = useRef<{ active: boolean; lastX: number; lastY: number }>(
    { active: false, lastX: 0, lastY: 0 },
  );
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Refs for values read inside saveAndReset / handlers — keeping them in
  // refs means the inner functions don't capture stale state.
  const currentFontIdRef = useRef(currentFontId);
  const bgRef = useRef(bg);
  const fgRef = useRef(fg);
  useEffect(() => {
    currentFontIdRef.current = currentFontId;
  }, [currentFontId]);
  useEffect(() => {
    bgRef.current = bg;
  }, [bg]);
  useEffect(() => {
    fgRef.current = fg;
  }, [fg]);
  // Switching to the "type" tool opens the soft keyboard (focus the
  // hidden input); switching away blurs to dismiss the keyboard so it
  // stops eating screen space during drag/draw/erase.
  // Also toggles a body class that enables "focus mode" on mobile:
  // hides the page nav so the cascade gets full vertical bleed when
  // typing. Switching to any non-T tool exits focus mode.
  useEffect(() => {
    if (tool === "type") {
      keyInputRef.current?.focus();
      if (window.matchMedia("(max-width: 700px)").matches) {
        document.body.classList.add("cascade-focused");
      }
    } else {
      keyInputRef.current?.blur();
      document.body.classList.remove("cascade-focused");
    }
    return () => {
      document.body.classList.remove("cascade-focused");
    };
  }, [tool]);

  async function ensureFontFaceLoaded(font: FontEntry) {
    if (runtime.loadedFontFaceIds.has(font.id)) return;
    runtime.loadedFontFaceIds.add(font.id);
    // ALWAYS inject the @font-face into the dynamic stylesheet.
    // html2canvas-pro parses CSS @font-face declarations to discover the
    // font binary at snapshot time — it does NOT enumerate the
    // document.fonts JS set. Fonts loaded only via the FontFace API
    // render fine in the live cascade but get replaced with the fallback
    // in the saved PNG, which was the "poster uses default font" bug.
    if (dynamicStyleRef.current) {
      dynamicStyleRef.current.appendChild(
        document.createTextNode(
          `@font-face{font-family:"${font.id}";src:url("${font.file}") format("${font.format}");font-display:swap;}`,
        ),
      );
    }
    // Also fire the FontFace API so document.fonts.ready resolves
    // before we snapshot — the CSS path alone is fire-and-forget.
    try {
      const ff = new FontFace(font.id, `url("${font.file}") format("${font.format}")`);
      const loaded = await ff.load();
      document.fonts.add(loaded);
    } catch {
      // CSS path is sufficient on its own.
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
      // Compute scale from the actual rendered width — the stage is
      // responsive on mobile (smaller than A4_WIDTH), so a fixed scale
      // would produce undersized PNGs on phones.
      const rect = stageRef.current.getBoundingClientRect();
      const captureScale = SAVE_PX_W / (rect.width || A4_WIDTH);
      const canvas = await html2canvas(stageRef.current, {
        backgroundColor: bgRef.current,
        scale: captureScale,
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
      clearDrawCanvas();
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
    e.preventDefault();
    let ch = e.key;
    if (ch.length === 1 && !ALPHABET_SET.has(ch)) {
      ch = QWERTY_TO_GEORGIAN[ch.toLowerCase()] ?? ch;
    }
    if (!ALPHABET_SET.has(ch)) return;
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
    if (!target.closest(".cascade-a4-stage")) return;
    // On mobile, only refocus when the user is in the "type" tool —
    // otherwise tapping the stage to drag/draw/erase would pop the soft
    // keyboard. Desktop always refocuses (no soft keyboard to worry
    // about, and typing should work the instant any control is clicked).
    const isMobile = window.matchMedia("(max-width: 700px)").matches;
    if (isMobile && tool !== "type") return;
    keyInputRef.current?.focus();
  }

  // --- Drag-to-pin handlers ------------------------------------------
  // Convert pointer client coords → physics coords. The stage uses fixed
  // pixel dimensions equal to physics units, but CSS could scale it
  // responsively, so we account for the bounding-rect ratio.
  function pointerToPhysics(
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((clientX - rect.left) * A4_WIDTH) / rect.width,
      y: ((clientY - rect.top) * A4_HEIGHT) / rect.height,
    };
  }

  /** Find the topmost (newest) letter whose body circle contains the
   * given physics point, or null if there's none. */
  function letterAt(px: number, py: number): Letter | null {
    for (let i = runtime.letters.length - 1; i >= 0; i--) {
      const l = runtime.letters[i];
      const dx = l.body.position.x - px;
      const dy = l.body.position.y - py;
      if (Math.hypot(dx, dy) <= l.size * 0.42) return l;
    }
    return null;
  }

  function clearDrawCanvas() {
    const c = drawCanvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
  }

  /** Draw a stroke segment from (fx,fy) to (tx,ty) in CSS coords. Coords
   * are multiplied by DRAW_SCALE because the canvas buffer is at print
   * resolution. */
  function pencilStroke(fx: number, fy: number, tx: number, ty: number) {
    const ctx = drawCanvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.strokeStyle = fgRef.current;
    ctx.lineWidth = PENCIL_WIDTH_CSS * DRAW_SCALE;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.moveTo(fx * DRAW_SCALE, fy * DRAW_SCALE);
    ctx.lineTo(tx * DRAW_SCALE, ty * DRAW_SCALE);
    ctx.stroke();
  }

  function pencilDot(x: number, y: number) {
    const ctx = drawCanvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = fgRef.current;
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.arc(
      x * DRAW_SCALE,
      y * DRAW_SCALE,
      (PENCIL_WIDTH_CSS / 2) * DRAW_SCALE,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  /** Erase a stroke of pixels from (fx,fy) to (tx,ty). Uses
   * destination-out compositing so it punches transparent holes
   * regardless of stroke color. */
  function eraseStroke(fx: number, fy: number, tx: number, ty: number) {
    const ctx = drawCanvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineWidth = ERASER_RADIUS_CSS * 2 * DRAW_SCALE;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(fx * DRAW_SCALE, fy * DRAW_SCALE);
    ctx.lineTo(tx * DRAW_SCALE, ty * DRAW_SCALE);
    ctx.stroke();
    ctx.restore();
  }

  function eraseDot(x: number, y: number) {
    const ctx = drawCanvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(
      x * DRAW_SCALE,
      y * DRAW_SCALE,
      ERASER_RADIUS_CSS * DRAW_SCALE,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.restore();
  }

  /** Eraser also kills any letters under the pointer (or within its
   * radius). Used by both pointerdown and pointermove in eraser mode. */
  function eraseLettersNear(px: number, py: number): boolean {
    let removed = false;
    for (let i = runtime.letters.length - 1; i >= 0; i--) {
      const l = runtime.letters[i];
      const dx = l.body.position.x - px;
      const dy = l.body.position.y - py;
      if (Math.hypot(dx, dy) <= ERASER_RADIUS_CSS + l.size * 0.42) {
        removeLetter(l.id);
        removed = true;
      }
    }
    return removed;
  }

  /** setPointerCapture can throw "No active pointer" in obscure cases
   * (browser quirks, programmatic events). Capture is a nice-to-have for
   * tracking drags off-element — failing it shouldn't abort the handler. */
  function safeCapture(e: React.PointerEvent<HTMLDivElement>) {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const p = pointerToPhysics(e.clientX, e.clientY);
    if (!p) return;

    if (tool === "move") {
      const hit = letterAt(p.x, p.y);
      if (!hit) return;
      e.preventDefault();
      safeCapture(e);
      // Freeze the letter in place while dragging. Static bodies still
      // collide with dynamic letters.
      Matter.Body.setStatic(hit.body, true);
      dragRef.current = {
        letterId: hit.id,
        offsetX: hit.body.position.x - p.x,
        offsetY: hit.body.position.y - p.y,
      };
      return;
    }

    if (tool === "pencil") {
      e.preventDefault();
      safeCapture(e);
      strokeRef.current = { active: true, lastX: p.x, lastY: p.y };
      // Stamp a dot for single-click marks (no move event will fire)
      pencilDot(p.x, p.y);
      return;
    }

    if (tool === "eraser") {
      e.preventDefault();
      safeCapture(e);
      strokeRef.current = { active: true, lastX: p.x, lastY: p.y };
      const removed = eraseLettersNear(p.x, p.y);
      eraseDot(p.x, p.y);
      if (removed) setTick((n) => (n + 1) % 1_000_000);
    }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (tool === "move") {
      if (dragRef.current.letterId === null) return;
      const p = pointerToPhysics(e.clientX, e.clientY);
      if (!p) return;
      const letter = runtime.letters.find(
        (l) => l.id === dragRef.current.letterId,
      );
      if (!letter) return;
      const radius = letter.size * 0.42;
      const x = Math.max(
        radius,
        Math.min(A4_WIDTH - radius, p.x + dragRef.current.offsetX),
      );
      const y = Math.max(
        radius,
        Math.min(A4_HEIGHT - radius, p.y + dragRef.current.offsetY),
      );
      Matter.Body.setPosition(letter.body, { x, y });
      return;
    }

    if (tool === "pencil") {
      if (!strokeRef.current.active) return;
      const p = pointerToPhysics(e.clientX, e.clientY);
      if (!p) return;
      pencilStroke(strokeRef.current.lastX, strokeRef.current.lastY, p.x, p.y);
      strokeRef.current.lastX = p.x;
      strokeRef.current.lastY = p.y;
      return;
    }

    if (tool === "eraser") {
      if (!strokeRef.current.active) return;
      const p = pointerToPhysics(e.clientX, e.clientY);
      if (!p) return;
      eraseStroke(strokeRef.current.lastX, strokeRef.current.lastY, p.x, p.y);
      const removed = eraseLettersNear(p.x, p.y);
      strokeRef.current.lastX = p.x;
      strokeRef.current.lastY = p.y;
      if (removed) setTick((n) => (n + 1) % 1_000_000);
    }
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (tool === "move") {
      if (dragRef.current.letterId === null) return;
      // Body stays static — that's the lock. Re-grabbing works because
      // handlePointerDown's hit-test catches static bodies too.
      dragRef.current = { letterId: null, offsetX: 0, offsetY: 0 };
      return;
    }
    strokeRef.current.active = false;
  }

  /** Double-click cycles the letter under the pointer through SCALES.
   * Only meaningful in move mode. */
  function handleDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (tool !== "move") return;
    const p = pointerToPhysics(e.clientX, e.clientY);
    if (!p) return;
    const hit = letterAt(p.x, p.y);
    if (!hit) return;
    e.preventDefault();
    scaleUpLetter(hit);
    setTick((n) => (n + 1) % 1_000_000);
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

    // Auto-focus the hidden keystroke input — but ONLY on viewports
    // wider than the mobile hamburger breakpoint. On phones, focusing
    // an <input> pops the iOS / Android soft keyboard immediately on
    // page load, which covers half the screen and intrudes on the
    // drag/draw workflow. On mobile the user has to tap the stage
    // intentionally to start typing (handlePageClick still refocuses).
    if (window.matchMedia("(min-width: 701px)").matches) {
      window.setTimeout(() => keyInputRef.current?.focus(), 50);
    }

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
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value=""
        onChange={() => {}}
      />

      {noFontsYet ? (
        <p className="poster-instruction">
          ჯერ შრიფტი არ არის — შექმენი ერთი <a href="/add">აქ</a>, შემდეგ დაბრუნდი.
        </p>
      ) : (
        <>
          {/* Tools above the canvas (mobile + desktop). Tools are the
              "mode switch" — pulled out of cascade-controls so they
              can sit above the stage and the input controls can sit
              below it. */}
          <div className="cascade-tool-group" role="toolbar" aria-label="tools">
            <button
              type="button"
              className={
                tool === "move"
                  ? "cascade-tool-btn active"
                  : "cascade-tool-btn"
              }
              onClick={() => setTool("move")}
              aria-label="move tool"
              title="move / drag letters"
            >
              {/* Classic mouse arrow */}
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
                <path
                  d="M3 2 L3 13 L6 10 L8 14.5 L9.7 13.8 L7.7 9.3 L11.5 9.3 Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              type="button"
              className={
                tool === "pencil"
                  ? "cascade-tool-btn active"
                  : "cascade-tool-btn"
              }
              onClick={() => setTool("pencil")}
              aria-label="pencil tool"
              title="draw"
            >
              {/* Diagonal pencil */}
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
                <path
                  d="M2.5 13.5 L4.5 11.5 L11 5 L13 7 L6.5 13.5 Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
                <path
                  d="M11 5 L12 4 L14 6 L13 7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              type="button"
              className={
                tool === "eraser"
                  ? "cascade-tool-btn active"
                  : "cascade-tool-btn"
              }
              onClick={() => setTool("eraser")}
              aria-label="eraser tool"
              title="erase letters + drawings"
            >
              {/* Angled rectangle with mid-line, eraser-style */}
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
                <path
                  d="M9 2 L14 7 L7 14 L2 9 Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
                <path
                  d="M5.5 12.5 L10.5 7.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
              </svg>
            </button>
            <button
              type="button"
              className={
                tool === "type"
                  ? "cascade-tool-btn active"
                  : "cascade-tool-btn"
              }
              onClick={() => setTool("type")}
              aria-label="type tool"
              title="type letters"
            >
              {/* Capital T — opens the soft keyboard for typing */}
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
                <path
                  d="M3 4 H13 M8 4 V13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </>
      )}

      <div className="cascade-a4-stage-wrap">
        <div
          ref={stageRef}
          className="cascade-a4-stage"
          data-tool={tool}
          style={{
            background: bg,
            color: fg,
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={handleDoubleClick}
        >
          {/* Drawing canvas — sits behind letters so glyphs stay on top.
              Buffer is at print resolution; CSS display fills the stage
              (which is responsive — 100% lets it shrink with the stage
              on mobile while the buffer stays at print res). */}
          <canvas
            ref={drawCanvasRef}
            className="cascade-draw-canvas"
            width={SAVE_PX_W}
            height={SAVE_PX_H}
            style={{ width: "100%", height: "100%" }}
          />
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

      {/* Input controls BELOW the canvas: color pickers + font dropdown
          + save button. Was previously in a single row above the canvas;
          moved here per the mobile-first reorder so the canvas gets the
          dominant visual weight, with tools (mode) above and inputs
          (data) below. */}
      {!noFontsYet ? (
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
