import type Matter from "matter-js";

/** A single A3 poster. Letters are physics-driven; finalised posters stop
 * accepting new typed letters but still allow colour changes. */
export type Poster = {
  id: number;
  engine: Matter.Engine;
  letters: PosterLetter[];
  bg: string;
  fg: string;
  /** Per-poster currently-selected font for the next typed letter. Each
   * letter remembers the font it was typed with, so changing this just
   * affects what comes next. */
  currentFontId: string | null;
  /** Marked true once user clicks + new-poster button OR when no more
   * letters fit. Finalised posters are read-only except for colour. */
  finalized: boolean;
};

export type PosterLetter = {
  id: number;
  body: Matter.Body;
  char: string;
  fontId: string;
  size: number;
};

// Module-level singleton — survives Posterizer component remounts (route
// navigation within the same tab). Cleared on full page reload (in which
// case the localStorage snapshot rehydrates).
type State = {
  posters: Poster[];
  loadedFontFaceIds: Set<string>;
  nextId: number;
  initialized: boolean;
};

export const posterizerState: State = {
  posters: [],
  loadedFontFaceIds: new Set(),
  nextId: 0,
  initialized: false,
};

// Snapshot for localStorage — strips out engine/body refs (which can't
// serialize) and keeps only what we need to rehydrate on load.
const STORAGE_KEY = "gfw_posterizer_v2"; // v2 = post-rework schema

export type PosterSnapshot = {
  posters: Array<{
    id: number;
    bg: string;
    fg: string;
    currentFontId: string | null;
    finalized: boolean;
    letters: Array<{
      id: number;
      char: string;
      fontId: string;
      size: number;
      x: number;
      y: number;
      angle: number;
    }>;
  }>;
  nextId: number;
};

export function snapshotState(): PosterSnapshot {
  return {
    posters: posterizerState.posters.map((p) => ({
      id: p.id,
      bg: p.bg,
      fg: p.fg,
      currentFontId: p.currentFontId,
      finalized: p.finalized,
      letters: p.letters.map((l) => ({
        id: l.id,
        char: l.char,
        fontId: l.fontId,
        size: l.size,
        x: l.body.position.x,
        y: l.body.position.y,
        angle: l.body.angle,
      })),
    })),
    nextId: posterizerState.nextId,
  };
}

export function persistState() {
  if (typeof window === "undefined") return;
  try {
    const snap = snapshotState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch {
    /* quota / private mode — silently skip */
  }
}

export function loadSnapshot(): PosterSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PosterSnapshot;
  } catch {
    return null;
  }
}

export function clearStoredState() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
