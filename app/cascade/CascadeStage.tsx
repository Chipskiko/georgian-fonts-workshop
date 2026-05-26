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
// Cascade polls /api/fonts to pick up newly-uploaded fonts so the picker
// stays current without a reload. Was 3000 — but every poll hits a
// Vercel function (cache:'no-store' bypasses HTTP cache). At 3s, one
// open cascade tab = 1200 function invocations/hour. The Vercel logs
// (2026-05-22) showed this was the dominant invocation source by far —
// dwarfing every other route combined.
//
// 30s matches the gallery's poll cadence. Server-side getFonts() is
// already wrapped in unstable_cache + tag-invalidated on upload, so
// freshness is preserved on navigation (going /add → /cascade always
// server-renders with the latest list). The 30s window only delays
// updates that happen while a user is ALREADY on cascade.
const POLL_INTERVAL_MS = 30_000;

// Drawing-tool constants. The draw canvas runs at print resolution so
// strokes stay crisp in the saved PNG (the snapshot scales the canvas
// up ~6x, and a low-res buffer would look blurry).
const DRAW_SCALE = SAVE_PX_W / A4_WIDTH;
const PENCIL_WIDTH_CSS = 3; // CSS px on screen
const ERASER_RADIUS_CSS = 14; // CSS px on screen

type Tool = "move" | "pencil" | "eraser" | "type" | "textbox";

/** Static text element placed by the textbox tool. Unlike Letter
 *  (physics body that falls + collides), TextBox sits where the user
 *  places it and only moves when explicitly dragged. Renders as a
 *  positioned <div> on the stage; html2canvas captures the DOM
 *  directly so saving works for free. */
type TextBox = {
  id: number;
  /** Stage-local coordinates of the text box's TOP-LEFT corner. */
  x: number;
  y: number;
  /** The text content. Empty after commit removes the box. */
  text: string;
  /** Font family used to render. Snapshotted at place-time so changing
   *  the picker selection later doesn't reflow already-placed boxes. */
  fontId: string;
  /** Display color (foreground). Same snapshotting reason. */
  color: string;
  /** Font-size in px. Fixed at place-time so the workshop participant
   *  can place several boxes at consistent sizes; future iteration
   *  could add resize handles. */
  fontSize: number;
  /** Rotation in radians around the box's center. The rotate handle
   *  drags this; default 0 = upright. */
  rotation: number;
};

// Default poster colors match the workshop's two-color palette
// inverted from the site chrome — site is pink with yellow text, the
// poster canvas starts as yellow with pink ink. Same colors the
// onboarding explainer overlay (public/cascade-explainer.jpg) is drawn
// in, so when the explainer dismisses on first interaction the empty
// canvas underneath visually continues the same colorway.
const DEFAULT_BG = "#ffea00"; // fluo yellow (matches CSS --fg)
const DEFAULT_FG = "#ff10b8"; // fluo pink (matches CSS --bg)

// Sentinel value used by the font-picker <select> to mean "pick a random
// font for EACH letter spawned". Not a real font id (font ids derive from
// filenames). Stored in currentFontId state so the dropdown's selected
// value reflects "random mode is active".
const RANDOM_FONT_ID = "__random__";

// Reverse of the GEORGIAN_TO_LATIN mapping in lib/font-pipeline/build-font.ts.
// Used by the font picker preview: workshop fonts only contain Georgian
// glyphs (the cmap maps U+10D0–U+10FF), so a Latin-named font like "kiko"
// can't display its own name in its own letterforms (the font has no
// "k"/"i"/"o" glyphs). Transliterating "kiko" → "კიკო" lets the font
// render its own name as a visual preview.
//
// Capital letters disambiguate the aspirated/ejective pairs the same way
// the forward mapping does (T→თ vs t→ტ, etc).
const LATIN_TO_GEORGIAN: Record<string, string> = {
  a: "ა", b: "ბ", g: "გ", d: "დ", e: "ე",
  v: "ვ", z: "ზ", T: "თ", i: "ი", k: "კ",
  l: "ლ", m: "მ", n: "ნ", o: "ო", p: "პ",
  J: "ჟ", r: "რ", s: "ს", t: "ტ", u: "უ",
  f: "ფ", q: "ქ", R: "ღ", y: "ყ", S: "შ",
  C: "ჩ", c: "ც", Z: "ძ", w: "წ", W: "ჭ",
  x: "ხ", j: "ჯ", h: "ჰ",
};

/** Build a preview string that the picker rows can display using the
 *  font's own letterforms. Logic:
 *   - Georgian char → pass through unchanged
 *   - Latin char with a Georgian equivalent → substitute
 *   - Anything else (digits, punctuation, unmapped letters) → space
 *     so positioning stays consistent while leaving a visual "gap"
 *     where the font has no coverage. */
function previewForFontName(name: string): string {
  let out = "";
  for (const ch of name) {
    if (/[ა-ჿ]/.test(ch)) {
      out += ch;
    } else if (LATIN_TO_GEORGIAN[ch]) {
      out += LATIN_TO_GEORGIAN[ch];
    } else {
      // Spaces, digits, punctuation — render as space so multi-word
      // names keep their gaps without breaking the custom-font preview.
      out += " ";
    }
  }
  return out;
}

/** Fixed sample text rendered in every picker row, regardless of what
 *  the user named the font. The full Mkhedruli alphabet so every font
 *  shows the same length preview — a one-letter-named font like "ა"
 *  isn't reduced to a single glyph in the picker. Rendered as one
 *  unbroken string (no spaces between letters) so CSS overflow:hidden
 *  + white-space:nowrap can truncate it cleanly to whatever the row
 *  width allows. The user-supplied name is still discoverable on
 *  hover via the row's title attribute. */
const FONT_PREVIEW_TEXT = ALPHABET.join("");

/** Parse a CSS hex color string ("#RRGGBB" or "RRGGBB") into a
 *  3-tuple of 0-255 RGB components. Used by the bnw generator to
 *  compare each pixel's distance to bg vs fg in RGB space. Defaults
 *  to white on parse failure so a malformed input degrades to "fill
 *  everything as background" rather than corrupting the B&W output. */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [255, 255, 255];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

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
}: {
  initialFonts: FontEntry[];
}) {
  const [, setTick] = useState(0);
  const [bg, setBg] = useState(DEFAULT_BG);
  const [fg, setFg] = useState(DEFAULT_FG);
  // Default to the random sentinel so first-time users land in a mode
  // where each tapped letter picks a different font — closer to the
  // "type playground" feel of the workshop than picking one specific font.
  // If there are no fonts at all, the picker isn't rendered (noFontsYet
  // empty-state path), so this default never reaches the UI in that case.
  const [currentFontId, setCurrentFontId] = useState<string | null>(
    initialFonts.length > 0 ? RANDOM_FONT_ID : null,
  );
  // Custom font-picker modal state. Replaces the native <select> so the
  // picker matches site styling (the iOS-style overlay clashed with
  // the pink/yellow theme) AND each row can render in the font's own
  // typeface — including a Latin→Georgian transliteration preview so
  // even Latin-named fonts display their custom letterforms.
  const [pickerOpen, setPickerOpen] = useState(false);
  // TextBox tool state: placed text elements + active input position.
  // textBoxes are committed, draggable elements. pendingTextBox is the
  // ephemeral input UX — visible only while the user is typing into a
  // brand-new box. On commit (Enter/blur with content) it gets pushed
  // into textBoxes and pendingTextBox clears; on commit with empty
  // content the input vanishes without adding anything.
  const [textBoxes, setTextBoxes] = useState<TextBox[]>([]);
  const [pendingTextBox, setPendingTextBox] = useState<
    null | { x: number; y: number; fontId: string; color: string; fontSize: number }
  >(null);
  const textBoxIdRef = useRef(0);
  const pendingInputRef = useRef<HTMLInputElement | null>(null);
  // Currently-selected textbox id — when non-null AND tool === "move",
  // the selection overlay (dashed bbox + rotate handle) renders around it.
  // Mirrors the selectedLetterId pattern for parity with letters.
  const [selectedTextBoxId, setSelectedTextBoxId] = useState<number | null>(null);
  // TextBox drag state — analogous to dragRef for letters. Stored
  // in a ref so the document-level pointer-move handler doesn't pay
  // re-render cost while dragging.
  const textBoxDragRef = useRef<{
    id: number | null;
    offsetX: number;
    offsetY: number;
  }>({ id: null, offsetX: 0, offsetY: 0 });
  // TextBox rotation state — analogous to rotateHandleRef for letters.
  // Snapshots the box's pre-rotation angle + the pointer's initial
  // angle from box center; pointer move computes delta from these.
  const textBoxRotateRef = useRef<{
    id: number | null;
    centerX: number;
    centerY: number;
    initialPointerAngle: number;
    initialBoxRotation: number;
  }>({ id: null, centerX: 0, centerY: 0, initialPointerAngle: 0, initialBoxRotation: 0 });
  // DOM ref map for textbox span elements — lets us read each box's
  // axis-aligned bounding rect when starting a rotation gesture
  // (we need the box's center in viewport coords to compute the
  // pointer's angle relative to it). Populated via React's ref
  // callback prop in the JSX below.
  const textBoxElemsRef = useRef<Map<number, HTMLElement>>(new Map());
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
  // Which letter currently has its rotation handle + bounding box visible.
  // Set when a letter is grabbed in move mode; cleared when the user
  // taps an empty area or switches to a non-move tool. State (not ref)
  // because the overlay JSX needs to re-render on change.
  const [selectedLetterId, setSelectedLetterId] = useState<number | null>(null);
  // Rotation-handle drag state. Independent of dragRef so a tap-on-handle
  // doesn't trigger translation logic. The handle is rendered as a div
  // anchored to the selected letter; pointerdown on the handle starts
  // rotate mode, pointermove computes a new angle from the pointer
  // position relative to the letter center, pointerup ends it.
  const rotateHandleRef = useRef<{ letterId: number | null }>({
    letterId: null,
  });
  // True if the user has drawn anything on the draw canvas in the
  // current session (since the last clearAll / save). Drives whether
  // the clear-poster X button is enabled — without this, drawings-only
  // posters (no typed letters) couldn't be cleared with the X tool.
  // Set to true on every pencilStroke/pencilDot, reset to false in
  // clearDrawCanvas (which is called by both clearAll and saveAndReset).
  // Note: not reset by the eraser — if the user erases everything by
  // hand, hasDrawing stays true and the X button stays enabled. That's
  // acceptable overreach (clicking X with nothing to clear is a no-op).
  const [hasDrawing, setHasDrawing] = useState(false);
  // Onboarding overlay — drawn arrows + Georgian labels pointing at
  // each tool. Shown on first mount, dismissed by ANY user interaction
  // (pointer, key, button click). Per-session only — page reload shows
  // it again. Stored as a hand-drawn JPEG in public/ so it visually
  // continues the workshop's color palette and aesthetic.
  const [showExplainer, setShowExplainer] = useState(true);
  // All currently-active pointers on the stage. React only fires events
  // for one pointer at a time, so the only way to detect multi-touch
  // (2-finger pinch-rotate) is to remember the others. Keyed by
  // pointerId; insertion order is preserved by Map so [...values()][0]
  // is reliably the FIRST pointer that landed.
  const pointersRef = useRef<Map<number, { clientX: number; clientY: number }>>(
    new Map(),
  );
  // Two-finger pinch-rotate snapshot. Taken when a 2nd finger lands on
  // the stage while finger #1 is already dragging a letter. We freeze
  // (a) the angle between the two pointers and (b) the letter's body
  // angle at that moment. Each subsequent pointermove computes the
  // current pointer-pair angle and applies the DELTA to the letter, so
  // rotation is "additive" and the letter doesn't snap on touch-down.
  const twoFingerRef = useRef<{
    active: boolean;
    letterId: number | null;
    initialPointersAngle: number;
    initialBodyAngle: number;
  }>({ active: false, letterId: null, initialPointersAngle: 0, initialBodyAngle: 0 });
  // Desktop fallback for rotation: shift+drag a letter rotates instead
  // of translating. Same snapshot-and-delta pattern as twoFingerRef but
  // computed from the angle of (pointer - letter_center).
  const shiftRotateRef = useRef<{
    letterId: number | null;
    initialPointerAngle: number;
    initialBodyAngle: number;
  }>({ letterId: null, initialPointerAngle: 0, initialBodyAngle: 0 });
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
    // Recolor existing pencil strokes on the draw canvas to match the
    // new fg. globalCompositeOperation = "source-in" replaces every
    // non-transparent pixel's color while preserving alpha — so strokes
    // change color in place, eraser cutouts (transparent) stay
    // transparent. New strokes after this point already use fgRef.current,
    // so behavior is consistent.
    const c = drawCanvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = fg;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.restore();
  }, [fg]);

  // Font-picker keyboard dismiss: Escape closes the modal. The
  // backdrop click handler (in JSX) handles outside-click; the X
  // button and each font row also dismiss. This effect only needs
  // to cover the keyboard case. Mounted only while open so we don't
  // pay for a document-level listener during normal typing.
  useEffect(() => {
    if (!pickerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pickerOpen]);

  // Body scroll lock while the picker modal is open. On phones, when
  // a user scrolls inside the picker's list and hits the top/bottom,
  // iOS Safari + some Android browsers rubber-band the gesture into
  // the page underneath — pulling the cascade canvas off-screen.
  // overscroll-behavior:contain on the list (see globals.css) handles
  // most cases, but iOS Safari is famously inconsistent about it, so
  // we belt-and-suspenders by pinning body position:fixed at the
  // current scrollY. On close we restore and scroll back to the
  // original position so the user lands exactly where they were.
  useEffect(() => {
    if (!pickerOpen) return;
    const scrollY = window.scrollY;
    const prev = {
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
      overflow: document.body.style.overflow,
    };
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.position = prev.position;
      document.body.style.top = prev.top;
      document.body.style.width = prev.width;
      document.body.style.overflow = prev.overflow;
      // Restore the scroll position the user had before opening —
      // otherwise the page would jump to the top on close because
      // position:fixed effectively reset scroll to 0.
      window.scrollTo(0, scrollY);
    };
  }, [pickerOpen]);
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
    // Bounding box + rotation handle only make sense in move mode.
    // Switching away clears selection so the overlay disappears; switching
    // back leaves the user with no selection (they'll re-tap to select).
    if (tool !== "move") {
      setSelectedLetterId(null);
    }
    return () => {
      document.body.classList.remove("cascade-focused");
    };
  }, [tool]);

  // Onboarding explainer dismiss-on-interaction. ANY user action (tap,
  // keystroke, button click anywhere) takes the overlay down. Listeners
  // are { once: true } so they self-remove after first fire; the
  // cleanup return only matters if the component unmounts before any
  // interaction (e.g., user navigates away on first load). Window-level
  // capture phase catches events before they reach individual handlers,
  // so the dismiss runs even if the user taps a tool button (whose own
  // handler also fires normally — both can run from the same event).
  useEffect(() => {
    if (!showExplainer) return;
    const dismiss = () => setShowExplainer(false);
    window.addEventListener("pointerdown", dismiss, { once: true });
    window.addEventListener("keydown", dismiss, { once: true });
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [showExplainer]);

  /** Wipe the entire poster — letters + drawing strokes — without saving.
   * Used by the X (clear) tool-button; no confirmation since the action is
   * non-destructive (nothing's been committed to the gallery yet). */
  function handleClearPoster() {
    clearAll();
    clearDrawCanvas();
    setSelectedLetterId(null);
    setTextBoxes([]);
    setPendingTextBox(null);
    setSelectedTextBoxId(null);
    setTick((n) => (n + 1) % 1_000_000);
  }

  // BUG FIX: switching to a non-textbox tool while a pending input
  // is open used to leave the input visible AND lose the typed text
  // (the rendered input element survives tool changes since it
  // depends on pendingTextBox state, not on tool). Force-commit
  // any pending input as soon as the user switches away. If they
  // typed nothing, commitPendingTextBox cleans up silently; if they
  // typed something, it gets placed at the click position they
  // originally clicked.
  useEffect(() => {
    if (tool !== "textbox" && pendingTextBox && pendingInputRef.current) {
      commitPendingTextBox(pendingInputRef.current.value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  /** Commit (or discard) the pending textbox input. Called from the
   *  input's Enter handler and onBlur. Non-empty content becomes a
   *  new TextBox in the textBoxes list; empty content cleanly
   *  cancels — no zero-content boxes left behind. */
  function commitPendingTextBox(text: string) {
    const trimmed = text.trim();
    if (!pendingTextBox) return;
    if (trimmed.length > 0) {
      setTextBoxes((cur) => [
        ...cur,
        {
          id: ++textBoxIdRef.current,
          x: pendingTextBox.x,
          y: pendingTextBox.y,
          text: trimmed,
          fontId: pendingTextBox.fontId,
          color: pendingTextBox.color,
          fontSize: pendingTextBox.fontSize,
          // Newly-placed boxes start upright; users rotate via the
          // selection-overlay handle (rotate-textbox).
          rotation: 0,
        },
      ]);
    }
    setPendingTextBox(null);
  }

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
    // BUG FIX: pre-save commit. If the user is mid-typing in a
    // pending textbox input and hits save, the snapshot would
    // capture the input (with its data-html2canvas-ignore'd dashed
    // border SKIPPED but the typed text DROPPED entirely because
    // the input gets unmounted in the post-save reset before its
    // value lands in textBoxes). Commit now so anything typed gets
    // placed and included in the snapshot.
    if (pendingTextBox && pendingInputRef.current) {
      commitPendingTextBox(pendingInputRef.current.value);
    }
    // Allow save if there's ANY content — letters, drawing, OR
    // text boxes. Previously the guard checked only letters +
    // drawing, so a textbox-only poster would silently bail here
    // even though the save button was enabled.
    if (
      runtime.letters.length === 0
      && !hasDrawing
      && textBoxes.length === 0
    ) {
      return;
    }
    savingInFlightRef.current = true;
    setSaveStatus("saving");
    try {
      // FONT-LOAD RACE FIX:
      //
      // Plain `await document.fonts.ready` resolves IMMEDIATELY if no
      // font is currently in the loading pipeline — it doesn't wait
      // for fonts that haven't been requested yet. Users were saving
      // posters where the cascade letters rendered as system fallback
      // (tiny default Georgian) because:
      //   1. User spawned a letter → ensureFontFaceLoaded() injects
      //      @font-face declaration + kicks off FontFace.load()
      //   2. User immediately taps save before the binary downloads
      //   3. document.fonts.ready resolves (nothing actively loading)
      //   4. html2canvas snapshots → font binary not present →
      //      fallback rendered → saved JPG has wrong glyphs
      // Live UI later swaps to the custom font (font-display:swap)
      // so the preview LOOKS right, but the bytes captured are fallback.
      //
      // Belt-and-suspenders fix:
      //   (a) Enumerate every fontId currently on the stage (any
      //       fontId used by a letter, plus the active picker font in
      //       case it differs).
      //   (b) Explicitly `document.fonts.load("Npx <id>")` each one.
      //       This kicks the browser to actually fetch any missing
      //       binary AND returns a promise that resolves only when
      //       the font is ready for paint.
      //   (c) Final `await document.fonts.ready` for fonts loaded via
      //       CSS-only paths the FontFace API didn't see.
      //   (d) 100ms paint settle: even after fonts.load resolves, the
      //       browser hasn't necessarily re-laid-out the stage with
      //       the new font yet. One macrotask + 100ms gives the
      //       layout/paint pass time to land before html2canvas
      //       walks the DOM.
      const fontsInUse = new Set<string>();
      for (const l of runtime.letters) fontsInUse.add(l.fontId);
      // Same race fix applies to TextBox fonts — each box snapshots
      // its fontId at place-time so they may differ from the current
      // picker selection. Force-load every one.
      for (const b of textBoxes) fontsInUse.add(b.fontId);
      if (currentFontIdRef.current && currentFontIdRef.current !== RANDOM_FONT_ID) {
        fontsInUse.add(currentFontIdRef.current);
      }
      await Promise.all(
        Array.from(fontsInUse).map((fid) =>
          // 24px is arbitrary — document.fonts.load only uses the family
          // name; the size is required by the FontFaceSet API signature.
          // .catch swallows network failures so one bad font doesn't
          // abort the whole save (the offending letter renders fallback
          // but everything else stays correct).
          document.fonts.load(`24px "${fid}"`).catch(() => undefined),
        ),
      );
      await document.fonts.ready;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

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
      // JPEG instead of PNG: ~10× smaller files for posters that are
      // mostly flat-color backgrounds + glyphs. Quality 0.92 keeps text
      // edges crisp; artifacts are invisible at print sizes.
      const fullBlob: Blob | null = await new Promise((res) =>
        canvas.toBlob(res, "image/jpeg", 0.92),
      );
      if (!fullBlob) throw new Error("toBlob full failed");

      // Gallery thumbnail — 1/3 each dimension = 1/9 the pixels. Loaded
      // in the grid view so opening /posterizer doesn't pull megabytes
      // per poster. Lightbox still loads the full version.
      const THUMB_W = Math.round(SAVE_PX_W / 3);
      const THUMB_H = Math.round(SAVE_PX_H / 3);
      const thumbCanvas = document.createElement("canvas");
      thumbCanvas.width = THUMB_W;
      thumbCanvas.height = THUMB_H;
      const tctx = thumbCanvas.getContext("2d");
      // Best-effort: if thumb generation fails (no 2d context, etc.) we
      // still upload the full and the gallery falls back to the full URL.
      let thumbBlob: Blob | null = null;
      if (tctx) {
        tctx.imageSmoothingEnabled = true;
        tctx.imageSmoothingQuality = "high";
        tctx.drawImage(canvas, 0, 0, THUMB_W, THUMB_H);
        thumbBlob = await new Promise<Blob | null>((res) =>
          thumbCanvas.toBlob(res, "image/jpeg", 0.85),
        );
      }

      // B&W partner — luminance-weighted grayscale of the full poster.
      // Generated here at save time so downloads can be instant fetches
      // (no per-click client-side conversion in the gallery). Stored
      // alongside the color file under poster_X_bnw.jpg. Best-effort:
      // failure leaves the partner missing and the gallery's legacy
      // fallback does the conversion on the fly.
      //
      // Rec. 709 luminance coefficients (same as Gallery's legacy
      // fetchAndConvertToBnw helper) so the pre-computed bnw matches
      // what the old code produced byte-for-byte except for being
      // generated once at save time instead of per download.
      let bnwBlob: Blob | null = null;
      try {
        const bnwCanvas = document.createElement("canvas");
        bnwCanvas.width = canvas.width;
        bnwCanvas.height = canvas.height;
        const bctx = bnwCanvas.getContext("2d");
        if (bctx) {
          bctx.drawImage(canvas, 0, 0);
          const imgData = bctx.getImageData(0, 0, bnwCanvas.width, bnwCanvas.height);
          const d = imgData.data;
          // SEMANTIC B&W: pick the closer of the two known poster
          // colors per pixel. We know bg and fg exactly (user picked
          // them in the controls), so distance comparison gives
          // unambiguous mapping regardless of which color is light
          // or dark:
          //   - Closer to bg → 255 (white)
          //   - Closer to fg → 0 (black)
          // Earlier luminance-threshold approach only worked when bg
          // was lighter than fg; flipped wrong on dark-bg/light-ink
          // combos. This works for ANY user color pair.
          //
          // Pixels that match neither cleanly (canvas anti-aliasing,
          // JPEG compression artifacts at letter edges) snap to
          // whichever they're nearer — usually the bg, which produces
          // the cleanest silhouette on the printed output.
          const bgRgb = hexToRgb(bgRef.current);
          const fgRgb = hexToRgb(fgRef.current);
          for (let i = 0; i < d.length; i += 4) {
            const dBg = Math.abs(d[i] - bgRgb[0])
              + Math.abs(d[i + 1] - bgRgb[1])
              + Math.abs(d[i + 2] - bgRgb[2]);
            const dFg = Math.abs(d[i] - fgRgb[0])
              + Math.abs(d[i + 1] - fgRgb[1])
              + Math.abs(d[i + 2] - fgRgb[2]);
            const bw = dBg <= dFg ? 255 : 0;
            d[i] = bw;
            d[i + 1] = bw;
            d[i + 2] = bw;
          }
          bctx.putImageData(imgData, 0, 0);
          bnwBlob = await new Promise<Blob | null>((res) =>
            bnwCanvas.toBlob(res, "image/jpeg", 0.92),
          );
        }
      } catch (e) {
        console.warn("[saveAndReset] bnw generation failed (non-fatal):", e);
      }

      const fd = new FormData();
      fd.append("file", fullBlob, "poster.jpg");
      if (thumbBlob) fd.append("thumb", thumbBlob, "poster_thumb.jpg");
      if (bnwBlob) fd.append("bnw", bnwBlob, "poster_bnw.jpg");
      const result = await uploadPoster(fd);
      if (!result.ok) throw new Error(result.message);
      // Wipe stage so the user can start the next poster immediately
      clearAll();
      clearDrawCanvas();
      setSelectedLetterId(null);
      setTextBoxes([]);
      setPendingTextBox(null);
      setSelectedTextBoxId(null);
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

  /** Spawn one letter (with QWERTY → Georgian transliteration + random
   *  font handling). Pulled into a helper so onKeyDown AND onInput can
   *  both call it. The dual-handler is needed because Android Chrome
   *  + Gboard fires onKeyDown with e.key='Process' or 'Unidentified'
   *  during composition (especially with Georgian or autocorrect on)
   *  and the real character only arrives via the input event's
   *  nativeEvent.data field. Without this, OnePlus + similar Android
   *  setups had typing in poster mode completely silently fail. */
  function spawnTypedChar(rawCh: string): boolean {
    if (savingInFlightRef.current) return false;
    let ch = rawCh;
    if (ch.length === 1 && !ALPHABET_SET.has(ch)) {
      ch = QWERTY_TO_GEORGIAN[ch.toLowerCase()] ?? ch;
    }
    if (!ALPHABET_SET.has(ch)) return false;
    let fontId: string | null = currentFontIdRef.current ?? allFontsRef.current[0]?.id ?? null;
    if (fontId === RANDOM_FONT_ID) {
      const fonts = allFontsRef.current;
      if (fonts.length === 0) return false;
      fontId = fonts[Math.floor(Math.random() * fonts.length)].id;
    }
    if (!fontId) return false;
    spawnLetter(ch, fontId);
    return true;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (savingInFlightRef.current) {
      e.preventDefault();
      return;
    }
    // Skip composition placeholder keys — let the input handler below
    // process the actual character once composition resolves. Android
    // Gboard fires e.key='Process' here for in-progress composition
    // and the matching real char arrives via onInput.
    if (e.key === "Process" || e.key === "Unidentified" || e.nativeEvent.isComposing) {
      return;
    }
    if (spawnTypedChar(e.key)) {
      e.preventDefault();
      setTick((n) => (n + 1) % 1_000_000);
    }
  }

  /** Android Chrome + Gboard handler. Reads nativeEvent.data which holds
   *  the actually-committed character(s) regardless of composition state.
   *  Always clears the input afterwards so the controlled empty value
   *  resets cleanly. Also runs for desktop browsers but the keydown
   *  handler will have already consumed those chars (its preventDefault
   *  cancels the input event before this fires for non-composition keys),
   *  so this is mostly a no-op there. */
  function handleInput(e: React.FormEvent<HTMLInputElement>) {
    const data = (e.nativeEvent as InputEvent).data;
    e.currentTarget.value = "";
    if (!data) return;
    let spawned = false;
    for (const c of data) {
      if (spawnTypedChar(c)) spawned = true;
    }
    if (spawned) setTick((n) => (n + 1) % 1_000_000);
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
    // Drop the "has drawing" flag so the X button disables itself
    // again until the user draws something new.
    if (hasDrawing) setHasDrawing(false);
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
    if (!hasDrawing) setHasDrawing(true);
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
    if (!hasDrawing) setHasDrawing(true);
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
    // Remember EVERY active pointer's position — required for the
    // 2-finger gesture detection below.
    pointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

    // TEXTBOX TOOL: clicking anywhere opens an input at the click
    // position. The user types a word, presses Enter (or blurs) to
    // commit, Escape to cancel. Resolved coordinates are stage-local
    // (top-left = 0,0), matching how textBoxes are positioned.
    if (tool === "textbox") {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      // BUG FIX: if there's already a pending input open, commit it
      // FIRST before opening a new one at the new position. Without
      // this React reuses the same DOM <input> element (no key prop)
      // → the input just appears to "move" to the new position with
      // the old text still in it, then on Enter the user's first
      // text gets overwritten + lost. Snapshot the current value
      // straight from the live input DOM via the ref so we capture
      // whatever the user typed before clicking again.
      if (pendingTextBox && pendingInputRef.current) {
        commitPendingTextBox(pendingInputRef.current.value);
      }
      // Convert from viewport coords to stage-local. On mobile the
      // stage uses transform:scale, so divide by the rendered scale
      // to land in the layout-box coord space the textBoxes use.
      const scale = rect.width / A4_WIDTH;
      const x = (e.clientX - rect.left) / (scale || 1);
      const y = (e.clientY - rect.top) / (scale || 1);
      // Snapshot the picker font + fg color at place-time so changing
      // them later doesn't mutate this box.
      const pickerId = currentFontIdRef.current;
      const fontId = pickerId && pickerId !== RANDOM_FONT_ID
        ? pickerId
        : allFonts.length > 0
          ? allFonts[Math.floor(Math.random() * allFonts.length)].id
          : "serif";
      setPendingTextBox({
        x, y, fontId,
        color: fgRef.current,
        fontSize: 64,
      });
      // Don't capture/preventDefault — let click-events propagate
      // normally so the input that mounts can take focus.
      return;
    }

    if (tool === "move") {
      // TEXTBOX ROTATE HANDLE: clicking on the yellow rotate-ball that
      // orbits the selected textbox starts a rotation gesture. The
      // handle has data-cascade-handle="rotate-textbox" + data-textbox-id
      // so we can identify both the gesture type and which box.
      const rotTarget = (e.target as HTMLElement | null);
      if (rotTarget?.dataset?.cascadeHandle === "rotate-textbox") {
        const id = Number(rotTarget.dataset.textboxId);
        const box = textBoxes.find((b) => b.id === id);
        const el = textBoxElemsRef.current.get(id);
        if (box && el) {
          e.preventDefault();
          safeCapture(e);
          // The textbox span has transform-origin: center (CSS default)
          // so its viewport-axis-aligned bbox center IS the rotation
          // pivot regardless of current rotation angle. Use it as the
          // anchor for computing pointer angles below.
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          textBoxRotateRef.current = {
            id,
            centerX: cx,
            centerY: cy,
            initialPointerAngle: Math.atan2(e.clientY - cy, e.clientX - cx),
            initialBoxRotation: box.rotation,
          };
          return;
        }
      }
      // TEXTBOX DRAG: clicking on a textbox in move mode picks it up
      // for drag. The textbox <div> has data-textbox-id="N" so we can
      // identify the hit target without geometric hit-testing.
      const tbTarget = (e.target as HTMLElement | null)?.closest('[data-textbox-id]') as HTMLElement | null;
      if (tbTarget) {
        const id = Number(tbTarget.dataset.textboxId);
        const box = textBoxes.find((b) => b.id === id);
        if (box) {
          e.preventDefault();
          safeCapture(e);
          // Select on click so the overlay (bbox + rotate handle)
          // appears. Same UX as letters: tap to select + drag,
          // tap empty space to deselect.
          setSelectedTextBoxId(id);
          // Clear letter selection so two overlays never show at once.
          if (selectedLetterId !== null) setSelectedLetterId(null);
          const rect = stageRef.current?.getBoundingClientRect();
          if (rect) {
            const scale = rect.width / A4_WIDTH;
            const px = (e.clientX - rect.left) / (scale || 1);
            const py = (e.clientY - rect.top) / (scale || 1);
            textBoxDragRef.current = {
              id, offsetX: px - box.x, offsetY: py - box.y,
            };
          }
          return;
        }
      }
      // Rotation-handle path: when the user lands on the small yellow
      // handle that orbits the selected letter, branch to rotate mode
      // instead of translate. The handle is a div with
      // data-cascade-handle="rotate" + pointer-events:auto; the stage's
      // delegated pointerdown still fires for it (event bubbling).
      const target = e.target as HTMLElement | null;
      if (target?.dataset?.cascadeHandle === "rotate" && selectedLetterId !== null) {
        e.preventDefault();
        safeCapture(e);
        rotateHandleRef.current = { letterId: selectedLetterId };
        return;
      }
      // TWO-FINGER PINCH-ROTATE detection: 2nd pointer lands and a
      // letter is currently selected. Works in two scenarios:
      //   1) Finger 1 is still down on the letter (active drag) and
      //      the user puts finger 2 down anywhere to rotate.
      //   2) User already tapped the letter to select it (drag ended,
      //      selection persists) and now uses two fingers somewhere
      //      on the stage to rotate.
      // The previous condition required dragRef.current.letterId — so
      // scenario 2 silently didn't work and users on phone couldn't
      // rotate without an awkward "hold the letter + tap with another
      // finger" gesture. Using selectedLetterId fixes that.
      if (
        pointersRef.current.size === 2 &&
        selectedLetterId !== null &&
        !twoFingerRef.current.active
      ) {
        const pts = [...pointersRef.current.values()];
        const initAng = Math.atan2(
          pts[1].clientY - pts[0].clientY,
          pts[1].clientX - pts[0].clientX,
        );
        const letter = runtime.letters.find((l) => l.id === selectedLetterId);
        if (letter) {
          twoFingerRef.current = {
            active: true,
            letterId: letter.id,
            initialPointersAngle: initAng,
            initialBodyAngle: letter.body.angle,
          };
        }
        e.preventDefault();
        safeCapture(e);
        return;
      }
      const hit = letterAt(p.x, p.y);
      if (!hit) {
        // Tapped empty space → clear BOTH selections so neither
        // overlay is left dangling. Symmetric with the textbox-drag
        // branch above that clears letter selection on textbox-hit.
        if (selectedLetterId !== null) setSelectedLetterId(null);
        if (selectedTextBoxId !== null) setSelectedTextBoxId(null);
        return;
      }
      e.preventDefault();
      safeCapture(e);
      // SHIFT+DRAG rotation (desktop fallback for the 2-finger gesture).
      // shiftKey is a no-op on touch devices (no shift on a soft kb), so
      // there's no conflict with the touch path.
      // Selecting a letter clears any selected textbox so two
      // overlays never show at once. Mirrors the textbox-drag
      // branch above that clears letter selection on textbox-hit.
      if (selectedTextBoxId !== null) setSelectedTextBoxId(null);
      if (e.shiftKey) {
        setSelectedLetterId(hit.id);
        shiftRotateRef.current = {
          letterId: hit.id,
          initialPointerAngle: Math.atan2(
            p.y - hit.body.position.y,
            p.x - hit.body.position.x,
          ),
          initialBodyAngle: hit.body.angle,
        };
        return;
      }
      // Tapping a letter both selects it (so the overlay appears) and
      // starts the drag-to-translate interaction.
      setSelectedLetterId(hit.id);
      // Freeze the letter in place AND make it a phantom: setStatic
      // pins position, isSensor=true makes other letters pass through
      // it. The combination lets users build stable arrangements
      // without falling letters bumping their placed ones around.
      // We never undo isSensor — once placed, a letter stays
      // non-colliding for the rest of the poster's lifetime. (Clearing
      // the whole stage rebuilds everything from scratch.)
      Matter.Body.setStatic(hit.body, true);
      hit.body.isSensor = true;
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
    // Keep the tracked position fresh for every active pointer. The
    // 2-finger gesture reads from this on each move.
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    }
    // TEXTBOX ROTATE: highest precedence in move mode. Computes the
    // delta between the initial pointer angle (snapshotted on handle
    // pointerdown) and the current angle, applies to the snapshotted
    // initial rotation. The box's CSS transform-origin is its center,
    // so this delta directly maps to the visible rotation.
    if (tool === "move" && textBoxRotateRef.current.id !== null) {
      const r = textBoxRotateRef.current;
      const cur = Math.atan2(e.clientY - r.centerY, e.clientX - r.centerX);
      const newRot = r.initialBoxRotation + (cur - r.initialPointerAngle);
      const id = r.id;
      setTextBoxes((cs) => cs.map((b) => (b.id === id ? { ...b, rotation: newRot } : b)));
      return;
    }
    // TEXTBOX DRAG: highest precedence in move mode so it doesn't
    // collide with letter-drag / rotation handlers below. Updates
    // the dragged box's position to follow the pointer (minus the
    // initial offset so the box doesn't jump under the cursor).
    if (tool === "move" && textBoxDragRef.current.id !== null) {
      const rect = stageRef.current?.getBoundingClientRect();
      if (rect) {
        const scale = rect.width / A4_WIDTH;
        const px = (e.clientX - rect.left) / (scale || 1);
        const py = (e.clientY - rect.top) / (scale || 1);
        const id = textBoxDragRef.current.id;
        const offX = textBoxDragRef.current.offsetX;
        const offY = textBoxDragRef.current.offsetY;
        setTextBoxes((cur) =>
          cur.map((b) => (b.id === id ? { ...b, x: px - offX, y: py - offY } : b)),
        );
      }
      return;
    }
    if (tool === "move") {
      // TWO-FINGER PINCH-ROTATE: highest precedence on move while two
      // pointers are tracked. Recompute the angle between the two
      // pointer positions and apply (current - initial) as a delta on
      // top of the snapshot body angle.
      if (twoFingerRef.current.active && pointersRef.current.size >= 2) {
        const pts = [...pointersRef.current.values()];
        const cur = Math.atan2(
          pts[1].clientY - pts[0].clientY,
          pts[1].clientX - pts[0].clientX,
        );
        const delta = cur - twoFingerRef.current.initialPointersAngle;
        const letter = runtime.letters.find(
          (l) => l.id === twoFingerRef.current.letterId,
        );
        if (letter) {
          Matter.Body.setAngle(
            letter.body,
            twoFingerRef.current.initialBodyAngle + delta,
          );
          setTick((n) => (n + 1) % 1_000_000);
        }
        // Skip translation while 2-finger is active so the letter
        // doesn't simultaneously fly around — purely a rotation gesture.
        return;
      }
      // SHIFT+DRAG rotation (desktop). Same delta-from-snapshot pattern,
      // but the snapshot is "angle of pointer relative to letter center"
      // rather than "angle between two pointers".
      if (shiftRotateRef.current.letterId !== null) {
        const p = pointerToPhysics(e.clientX, e.clientY);
        if (!p) return;
        const letter = runtime.letters.find(
          (l) => l.id === shiftRotateRef.current.letterId,
        );
        if (!letter) return;
        const cur = Math.atan2(
          p.y - letter.body.position.y,
          p.x - letter.body.position.x,
        );
        const delta = cur - shiftRotateRef.current.initialPointerAngle;
        Matter.Body.setAngle(
          letter.body,
          shiftRotateRef.current.initialBodyAngle + delta,
        );
        setTick((n) => (n + 1) % 1_000_000);
        return;
      }
      // Rotation-handle drag wins over translation. While the user has
      // the handle grabbed, we ignore translation logic entirely — set
      // the body's angle so its local +up direction (the handle's home
      // position) points at the current pointer location.
      if (rotateHandleRef.current.letterId !== null) {
        const p = pointerToPhysics(e.clientX, e.clientY);
        if (!p) return;
        const letter = runtime.letters.find(
          (l) => l.id === rotateHandleRef.current.letterId,
        );
        if (!letter) return;
        // atan2(dx, dy_inverted) returns 0 when pointer is directly
        // above the letter (matching the handle's home position) and
        // grows clockwise — same convention as Matter.Body.angle and
        // CSS rotate(rad).
        const dx = p.x - letter.body.position.x;
        const dy = letter.body.position.y - p.y;
        Matter.Body.setAngle(letter.body, Math.atan2(dx, dy));
        setTick((n) => (n + 1) % 1_000_000);
        return;
      }
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
    // Drop this pointer from the tracked set. Done BEFORE the move-tool
    // branch so the 2-finger exit logic sees the post-removal count.
    pointersRef.current.delete(e.pointerId);
    // TEXTBOX ROTATE end: clear the rotation ref so subsequent
    // pointer-moves don't accidentally continue rotating.
    if (textBoxRotateRef.current.id !== null) {
      textBoxRotateRef.current = { id: null, centerX: 0, centerY: 0, initialPointerAngle: 0, initialBoxRotation: 0 };
      return;
    }
    // TEXTBOX DRAG end: clear the drag ref so subsequent letter-drag
    // doesn't reuse the offsets.
    if (textBoxDragRef.current.id !== null) {
      textBoxDragRef.current = { id: null, offsetX: 0, offsetY: 0 };
      return;
    }
    if (tool === "move") {
      // End shift+drag rotation.
      if (shiftRotateRef.current.letterId !== null) {
        shiftRotateRef.current = {
          letterId: null,
          initialPointerAngle: 0,
          initialBodyAngle: 0,
        };
        return;
      }
      // End 2-finger rotation when we drop below 2 pointers. RE-ANCHOR
      // the surviving translation drag's offset so the letter doesn't
      // visually JUMP at the moment the 2nd finger lifts (the 1st finger
      // may have moved during the gesture — we paused translation, so
      // its current position differs from its position when grabbed).
      if (twoFingerRef.current.active && pointersRef.current.size < 2) {
        twoFingerRef.current = {
          active: false,
          letterId: null,
          initialPointersAngle: 0,
          initialBodyAngle: 0,
        };
        if (dragRef.current.letterId !== null && pointersRef.current.size === 1) {
          const remaining = [...pointersRef.current.values()][0];
          const p = pointerToPhysics(remaining.clientX, remaining.clientY);
          const letter = runtime.letters.find(
            (l) => l.id === dragRef.current.letterId,
          );
          if (p && letter) {
            dragRef.current.offsetX = letter.body.position.x - p.x;
            dragRef.current.offsetY = letter.body.position.y - p.y;
          }
        }
        return;
      }
      // End rotation-handle drag (if active). Selection stays so the
      // overlay remains visible after release — same shape as a
      // typical select-then-rotate UX (Figma/Sketch).
      if (rotateHandleRef.current.letterId !== null) {
        rotateHandleRef.current = { letterId: null };
        return;
      }
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
      {/* @font-face declarations live in the root layout's <head> style
          block (server-rendered via getFonts + fontFaceCss). We used to
          duplicate that block here too because html2canvas-pro couldn't
          find fonts loaded only via the FontFace API; with the layout-
          level <style> present, html2canvas's stylesheet scan picks it
          up and the duplicate just wastes ~4KB per cascade render.
          ensureFontFaceLoaded still appends per-font CSS to a separate
          dynamicStyleRef as the picker changes, which covers fonts
          uploaded after the page was rendered. */}

      <input
        ref={keyInputRef}
        type="text"
        className="poster-key-input"
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        aria-label="cascade keyboard"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        // inputMode="none" would suppress the soft keyboard. We DO want
        // the soft keyboard, so leave it default. enterKeyHint="done"
        // makes the Gboard "Enter" button read as "done" instead of
        // "send" — purely cosmetic.
        enterKeyHint="done"
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
            {/* TextBox tool — click on canvas opens an input at that
                position for typing a static word. Distinct from the
                type tool which spawns physics letters that cascade. */}
            <button
              type="button"
              className={
                tool === "textbox"
                  ? "cascade-tool-btn active"
                  : "cascade-tool-btn"
              }
              onClick={() => setTool("textbox")}
              aria-label="text box tool"
              title="place static text"
            >
              {/* Capital T inside a box — distinguishes from the
                  cascade-type tool which uses a plain T. */}
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
                <rect x="2" y="3" width="12" height="10" fill="none" stroke="currentColor" strokeWidth="1.6"/>
                <path
                  d="M5 6 H11 M8 6 V11"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            {/* Clear-poster action button. Not a tool toggle (doesn't get
                .active), just an immediate action: drops all letters and
                wipes drawing strokes. No confirmation — nothing has been
                committed to the gallery yet, and the user can retype/
                redraw immediately. */}
            <button
              type="button"
              className="cascade-tool-btn cascade-clear-btn"
              onClick={handleClearPoster}
              aria-label="clear poster"
              title="clear poster (letters + drawings)"
              // Enabled if EITHER there are letters OR there's a
              // drawing — was previously letters-only, which meant a
              // pencil-only poster (drawn shapes with no typed letters)
              // couldn't be cleared via the X button.
              disabled={letterCount === 0 && !hasDrawing && textBoxes.length === 0}
            >
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
                <path
                  d="M4 4 L12 12 M12 4 L4 12"
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
          {/* Onboarding explainer overlay. Hand-drawn arrows + Georgian
              labels pointing at each tool. pointer-events:none so taps
              fall through to the cascade-a4-stage's own pointerdown
              handler — the global window listener on showExplainer
              fires concurrently from any pointerdown anywhere, dropping
              the overlay. Image is the same dimensions as the canvas
              (SAVE_PX_W × SAVE_PX_H) so objectFit:fill covers exactly. */}
          {showExplainer ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src="/cascade-explainer.jpg"
              alt=""
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "fill",
                pointerEvents: "none",
                zIndex: 5,
              }}
            />
          ) : null}
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
          {/* Placed text boxes — rendered as positioned <span>s so
              html2canvas captures them automatically at save time.
              data-textbox-id lets the move-tool pointer-down identify
              the hit target without geometric hit-testing. Cursor is
              move when the move tool is active (so users see it's
              draggable) and default otherwise. */}
          {textBoxes.map((b) => {
            const isSelected = tool === "move" && selectedTextBoxId === b.id;
            return (
              <span
                key={b.id}
                ref={(el) => {
                  // Maintain the ref map so the rotate-handle's
                  // pointerdown handler can read the box's viewport
                  // bounding rect to find the rotation pivot center.
                  if (el) textBoxElemsRef.current.set(b.id, el);
                  else textBoxElemsRef.current.delete(b.id);
                }}
                data-textbox-id={b.id}
                className={
                  "cascade-textbox" +
                  (isSelected ? " cascade-textbox-selected" : "")
                }
                style={{
                  position: "absolute",
                  left: `${b.x}px`,
                  top: `${b.y}px`,
                  color: b.color,
                  fontFamily: `"${b.fontId}", var(--ui-georgian)`,
                  fontSize: `${b.fontSize}px`,
                  lineHeight: 1,
                  whiteSpace: "pre",
                  userSelect: "none",
                  WebkitUserSelect: "none",
                  cursor: tool === "move" ? "move" : "default",
                  // pointer-events:auto so the move-tool can grab it; the
                  // stage's delegated pointerdown still fires via bubble.
                  pointerEvents: tool === "move" ? "auto" : "none",
                  touchAction: "none",
                  // CSS transform: rotate around center (default
                  // transform-origin = 50% 50%). Keeping origin centered
                  // means the box's axis-aligned bbox center stays put
                  // during rotation, which is what the rotate-gesture
                  // math assumes.
                  transform: `rotate(${b.rotation}rad)`,
                }}
                data-html2canvas-ignore-children="false"
              >
                {b.text}
                {/* Rotation handle — orbits the box (because it's a
                    child of the rotated span). Same data-html2canvas-
                    ignore trick as the letter overlay so the yellow
                    ball doesn't leak into the saved JPG. */}
                {isSelected ? (
                  <span
                    className="cascade-textbox-rotate-handle"
                    data-cascade-handle="rotate-textbox"
                    data-textbox-id={b.id}
                    data-html2canvas-ignore="true"
                    aria-label="rotate text box"
                    role="button"
                  />
                ) : null}
              </span>
            );
          })}
          {/* Pending textbox input — only visible while the user is
              typing a brand-new box (right after clicking with the
              textbox tool). Commits on Enter or blur with non-empty
              content; cancels on Escape or empty blur. Positioned
              absolutely at the click point. Auto-focuses on mount so
              the user can start typing immediately. */}
          {pendingTextBox ? (
            <input
              ref={pendingInputRef}
              type="text"
              autoFocus
              dir="auto"
              className="cascade-textbox-input"
              data-html2canvas-ignore="true"
              style={{
                position: "absolute",
                left: `${pendingTextBox.x}px`,
                top: `${pendingTextBox.y}px`,
                color: pendingTextBox.color,
                fontFamily: `"${pendingTextBox.fontId}", var(--ui-georgian)`,
                fontSize: `${pendingTextBox.fontSize}px`,
                lineHeight: 1,
                padding: 0,
                margin: 0,
                background: "transparent",
                border: `1px dashed ${pendingTextBox.color}`,
                outline: "none",
                minWidth: "100px",
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitPendingTextBox(e.currentTarget.value);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setPendingTextBox(null);
                }
              }}
              onBlur={(e) => commitPendingTextBox(e.currentTarget.value)}
            />
          ) : null}
          {/* Selection overlay: dashed bounding box + rotation handle.
              Rendered only in move mode for the currently-selected
              letter. The box stays in screen pixels (px) because the
              stage's layout box is fixed-physics-units even on mobile
              (where transform:scale shrinks the visual but coords stay
              in the 420×594 space). */}
          {(() => {
            if (tool !== "move" || selectedLetterId === null) return null;
            const sel = runtime.letters.find((l) => l.id === selectedLetterId);
            if (!sel) return null;
            const cx = sel.body.position.x;
            const cy = sel.body.position.y;
            const ang = sel.body.angle;
            // Bbox is square circumscribing the letter circle (radius =
            // size*0.5 + padding). Keep it loose so the dashes don't
            // visually crowd the glyph edges.
            const side = sel.size + 8;
            // Handle sits directly above the letter in its LOCAL frame
            // (so it rotates with the letter — visual feedback that
            // rotation works). Distance: half-side + breathing room +
            // half-handle so the line+circle don't overlap the bbox.
            // Radius 14 (28px diameter) is large enough to comfortably
            // hit on phone (iOS recommends ≥44px but the surrounding
            // line + visual chunk make this hittable in practice).
            const handleR = 14;
            const handleDist = side / 2 + 18 + handleR;
            return (
              <>
                {/* Bounding box: rotates with the letter via the same
                    transform pattern the letter span uses.
                    data-html2canvas-ignore tells the save-poster
                    snapshotter to skip this element — otherwise the
                    dashed bbox + spine + handle bleed into the saved
                    JPG when a letter happens to be selected at save
                    time. */}
                <div
                  className="cascade-bbox"
                  data-html2canvas-ignore="true"
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: `${side}px`,
                    height: `${side}px`,
                    transform: `translate3d(${cx}px, ${cy}px, 0) translate(-50%, -50%) rotate(${ang}rad)`,
                    transformOrigin: "center",
                    pointerEvents: "none",
                  }}
                />
                {/* Spine line from letter center to handle. Lives in the
                    same rotating local frame so it always reads as
                    "letter's up-axis". */}
                <div
                  className="cascade-handle-spine"
                  data-html2canvas-ignore="true"
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: "1px",
                    height: `${handleDist}px`,
                    // Rotate first (about local origin), then translate
                    // up by handleDist so the line spans center→handle.
                    transform: `translate3d(${cx}px, ${cy}px, 0) rotate(${ang}rad) translate(0, -${handleDist}px)`,
                    transformOrigin: "top left",
                    pointerEvents: "none",
                  }}
                />
                {/* The handle itself — pointer-events:auto so it can
                    receive the pointerdown that bubbles to the stage's
                    delegated handler. data-cascade-handle lets that
                    handler distinguish handle-drag from letter-drag. */}
                <div
                  className="cascade-rotate-handle"
                  data-cascade-handle="rotate"
                  data-html2canvas-ignore="true"
                  aria-label="rotate letter"
                  role="button"
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: `${handleR * 2}px`,
                    height: `${handleR * 2}px`,
                    // Same pattern: rotate then offset along the local
                    // -y direction (which is "up" in the letter's frame).
                    transform: `translate3d(${cx}px, ${cy}px, 0) rotate(${ang}rad) translate(-${handleR}px, -${handleDist + handleR}px)`,
                    transformOrigin: "top left",
                    pointerEvents: "auto",
                    touchAction: "none",
                  }}
                />
              </>
            );
          })()}
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
          {/* Custom font picker. Renders the trigger inline with the
              other cascade controls; tapping opens a center-screen
              modal (rendered outside this div via the JSX block below)
              so the picker doesn't get clipped by the controls bar
              or hide behind canvas content. */}
          <div className="poster-font-picker">
            <span>შრიფტი</span>
            <button
              type="button"
              className="poster-font-picker-trigger"
              onClick={() => setPickerOpen((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={pickerOpen}
            >
              <span
                className="poster-font-picker-current"
                // Render the trigger label in the currently-selected
                // font's typeface (with the previewForFontName
                // transliteration so Latin-named fonts also display
                // their own letterforms). Random sentinel falls back
                // to the UI font.
                style={
                  currentFontId && currentFontId !== RANDOM_FONT_ID
                    ? { fontFamily: `"${currentFontId}", var(--ui-georgian)` }
                    : undefined
                }
              >
                {currentFontId === RANDOM_FONT_ID
                  ? "შემთხვევითი"
                  : previewForFontName(
                      allFonts.find((f) => f.id === currentFontId)?.name ?? "—",
                    )}
              </span>
              <span className="poster-font-picker-arrow" aria-hidden>
                ▾
              </span>
            </button>
          </div>
          {/* Center-screen modal — rendered as a sibling of the
              trigger so it's not clipped by the controls' flex layout.
              The backdrop catches outside-clicks; the X button and
              every font row also dismiss. */}
          {pickerOpen ? (
            <div
              className="poster-font-picker-modal"
              role="dialog"
              aria-modal="true"
              aria-label="font picker"
              onClick={() => setPickerOpen(false)}
            >
              <div
                className="poster-font-picker-modal-inner"
                // Stop click propagation so taps INSIDE the modal
                // body don't bubble up to the backdrop dismiss.
                onClick={(e) => e.stopPropagation()}
              >
                <div className="poster-font-picker-modal-header">
                  <span className="poster-font-picker-modal-title">შრიფტი</span>
                  <button
                    type="button"
                    className="poster-font-picker-modal-close"
                    onClick={() => setPickerOpen(false)}
                    aria-label="close"
                  >
                    ✕
                  </button>
                </div>
                <ul className="poster-font-picker-list" role="listbox">
                  <li
                    role="option"
                    aria-selected={currentFontId === RANDOM_FONT_ID}
                    className={
                      "poster-font-picker-row poster-font-picker-row-random" +
                      (currentFontId === RANDOM_FONT_ID
                        ? " poster-font-picker-row-active"
                        : "")
                    }
                    onClick={() => {
                      setCurrentFontId(RANDOM_FONT_ID);
                      setPickerOpen(false);
                    }}
                  >
                    შემთხვევითი
                  </li>
                  {allFonts.map((f) => (
                    // Every row renders the SAME sample text — the
                    // full Mkhedruli alphabet — in the row's own font
                    // family. CSS truncates whatever doesn't fit on a
                    // single line, so every row gets a consistent
                    // preview width regardless of the font's name.
                    // Workshop feedback: a one-letter-named font was
                    // showing only one glyph in the picker, which made
                    // it impossible to judge the font's overall design.
                    // Filename is on hover via title=.
                    <li
                      key={f.id}
                      role="option"
                      aria-selected={currentFontId === f.id}
                      className={
                        "poster-font-picker-row" +
                        (currentFontId === f.id
                          ? " poster-font-picker-row-active"
                          : "")
                      }
                      onClick={() => {
                        setCurrentFontId(f.id);
                        setPickerOpen(false);
                      }}
                      style={{ fontFamily: `"${f.id}", var(--ui-georgian)` }}
                      title={f.name}
                    >
                      {FONT_PREVIEW_TEXT}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
          <button
            type="button"
            className="cascade-save-btn"
            onClick={() => void saveAndReset()}
            // Save is enabled when there's SOMETHING on the canvas —
            // typed letters OR pencil drawing — and a save isn't
            // already in flight. Consistent with the X clear button's
            // disabled rule above.
            disabled={(letterCount === 0 && !hasDrawing && textBoxes.length === 0 && !pendingTextBox) || saveStatus === "saving"}
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
