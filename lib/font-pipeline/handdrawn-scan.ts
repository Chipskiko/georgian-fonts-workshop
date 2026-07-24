import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import opentype from "opentype.js";
import {
  A4_W_PT,
  A4_H_PT,
  ALPHABET,
  BASELINE_FRAC_FROM_TOP,
  cellLayoutPt,
} from "./constants";
import { markersSvg, qrCellSvg } from "./calibration";

/**
 * Synthetic "hand-drawn" scan — the realism counterpart to the crisp
 * calibration sheet. The calibration image validates GEOMETRY (position,
 * scale, crop) with perfect black shapes; this one validates the IMAGE
 * pipeline the way real uploads stress it:
 *
 *   - actual Georgian letterforms in every cell (from the site's UI font),
 *     wobbled point-by-point like an unsteady hand tracing the shape
 *   - greyscale ink, varying per letter (pencil ↔ marker pressure), never
 *     pure black — exercises normalization + per-cell Otsu thresholding
 *   - size / position / rotation jitter — nobody centers perfectly
 *   - paper speckle, smudges, and soft lighting gradients — turdsize and
 *     threshold must eat these without eating the letters
 *   - gaussian blur + a JPEG round-trip — phone-camera softness and
 *     compression artifacts
 *
 * Markers and QR stay identical to the printed template (drawn crisp,
 * then degraded by the same blur/JPEG pass — exactly like a real photo),
 * so marker detection runs unmodified.
 *
 * Deterministic per seed: same seed → same image, so a failure can be
 * reproduced exactly.
 */

const TARGET_W = 2100;
const TARGET_H = Math.round(TARGET_W * (A4_H_PT / A4_W_PT));
const PT_TO_PX = TARGET_W / A4_W_PT;

// --- Seeded PRNG (mulberry32) -------------------------------------------

type Rng = () => number;
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo);

// --- Letterform source ----------------------------------------------------

let uiFont: opentype.Font | null | undefined;
function loadUiFont(): opentype.Font | null {
  if (uiFont !== undefined) return uiFont;
  try {
    const buf = readFileSync(
      path.join(process.cwd(), "public", "ui-fonts", "Xaraxfont4-kerned.otf"),
    );
    uiFont = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } catch {
    uiFont = null;
  }
  return uiFont;
}

/** Flatten an opentype path into polylines (one per contour), sampling
 *  curves finely enough that the wobble displacement dominates any
 *  flattening error. */
function flattenPath(p: opentype.Path, step = 3): [number, number][][] {
  const contours: [number, number][][] = [];
  let cur: [number, number][] = [];
  let px = 0;
  let py = 0;
  const sample = (fn: (t: number) => [number, number], approxLen: number) => {
    const n = Math.max(2, Math.ceil(approxLen / step));
    for (let i = 1; i <= n; i++) cur.push(fn(i / n));
  };
  for (const c of p.commands) {
    if (c.type === "M") {
      if (cur.length > 1) contours.push(cur);
      cur = [[c.x, c.y]];
      px = c.x;
      py = c.y;
    } else if (c.type === "L") {
      sample((t) => [px + (c.x - px) * t, py + (c.y - py) * t], Math.hypot(c.x - px, c.y - py));
      px = c.x;
      py = c.y;
    } else if (c.type === "C") {
      const { x1, y1, x2, y2, x, y } = c;
      const x0 = px;
      const y0 = py;
      sample(
        (t) => {
          const mt = 1 - t;
          return [
            mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x,
            mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y,
          ];
        },
        Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x - x2, y - y2),
      );
      px = x;
      py = y;
    } else if (c.type === "Q") {
      const { x1, y1, x, y } = c;
      const x0 = px;
      const y0 = py;
      sample(
        (t) => {
          const mt = 1 - t;
          return [
            mt * mt * x0 + 2 * mt * t * x1 + t * t * x,
            mt * mt * y0 + 2 * mt * t * y1 + t * t * y,
          ];
        },
        Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x - x1, y - y1),
      );
      px = x;
      py = y;
    } else if (c.type === "Z") {
      if (cur.length > 1) contours.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) contours.push(cur);
  return contours;
}

/** Hand-tremor displacement: two incommensurate sines + white noise per
 *  point, phases seeded per letter. Smooth enough to look like a shaky
 *  hand, not electrical noise. */
function wobble(contours: [number, number][][], rng: Rng, amp: number): [number, number][][] {
  const p1 = between(rng, 0, Math.PI * 2);
  const p2 = between(rng, 0, Math.PI * 2);
  const f1 = between(rng, 0.05, 0.12);
  const f2 = between(rng, 0.19, 0.31);
  return contours.map((poly) =>
    poly.map(([x, y], i) => {
      const s = Math.sin(i * f1 + p1) + 0.6 * Math.sin(i * f2 + p2);
      const c = Math.cos(i * f1 + p2) + 0.6 * Math.cos(i * f2 + p1);
      return [
        x + s * amp + (rng() - 0.5) * amp * 0.5,
        y + c * amp + (rng() - 0.5) * amp * 0.5,
      ];
    }),
  );
}

function contoursToPathD(contours: [number, number][][]): string {
  return contours
    .map(
      (poly) =>
        `M${poly.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L")} Z`,
    )
    .join(" ");
}

// --- Page assembly --------------------------------------------------------

export async function generateHandDrawnSvg(seed = 42): Promise<string> {
  const rng = mulberry32(seed);
  const w = TARGET_W;
  const h = TARGET_H;
  const font = loadUiFont();
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`);
  // Paper: slightly warm off-white, not pure white.
  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#fbfaf7"/>`);

  // Soft lighting gradients — uneven phone-photo illumination. Drawn as
  // huge translucent radial blobs before everything else.
  for (let i = 0; i < 3; i++) {
    const gx = between(rng, 0, w);
    const gy = between(rng, 0, h);
    const gr = between(rng, w * 0.4, w * 0.9);
    const dark = rng() < 0.5;
    const id = `g${i}`;
    parts.push(
      `<radialGradient id="${id}"><stop offset="0%" stop-color="${dark ? "#000000" : "#ffffff"}" stop-opacity="${between(rng, 0.02, 0.05).toFixed(3)}"/>` +
        `<stop offset="100%" stop-color="${dark ? "#000000" : "#ffffff"}" stop-opacity="0"/></radialGradient>` +
        `<circle cx="${gx.toFixed(0)}" cy="${gy.toFixed(0)}" r="${gr.toFixed(0)}" fill="url(#${id})"/>`,
    );
  }

  parts.push(markersSvg());

  // Template cell furniture — faint outlines like the printed sheet.
  for (let i = 0; i < ALPHABET.length; i++) {
    const layout = cellLayoutPt(i);
    const cellX = layout.cellX * PT_TO_PX;
    const cellY = (A4_H_PT - layout.cellY - layout.cellH) * PT_TO_PX;
    parts.push(
      `<rect x="${cellX.toFixed(1)}" y="${cellY.toFixed(1)}" width="${(layout.cellW * PT_TO_PX).toFixed(1)}" height="${(layout.cellH * PT_TO_PX).toFixed(1)}" fill="none" stroke="#dddddd" stroke-width="1"/>`,
    );
  }

  // The letters. Each drawn from the UI font's outline, wobbled, with
  // seeded jitter in size / position / rotation / ink.
  for (let i = 0; i < ALPHABET.length; i++) {
    const ch = ALPHABET[i];
    if (!font) break;
    let glyph: opentype.Glyph;
    try {
      glyph = font.charToGlyph(ch);
    } catch {
      continue;
    }
    if (!glyph || glyph.index === 0) continue;

    const layout = cellLayoutPt(i);
    const bx = layout.boxX * PT_TO_PX;
    const by = (A4_H_PT - layout.boxY - layout.boxH) * PT_TO_PX;
    const bw = layout.boxW * PT_TO_PX;
    const bh = layout.boxH * PT_TO_PX;
    const baselineY = by + bh * BASELINE_FRAC_FROM_TOP;

    // Target letter height: most of the box-top → baseline zone, with
    // per-letter variation (some people draw big, some small).
    const zone = baselineY - by;
    const fontSize = zone * between(rng, 0.75, 1.05);
    // Measure at final size to center horizontally.
    const probe = glyph.getPath(0, 0, fontSize);
    const bb = probe.getBoundingBox();
    const inkW = bb.x2 - bb.x1;
    const cx = bx + bw / 2 + between(rng, -bw * 0.06, bw * 0.06);
    const x = cx - inkW / 2 - bb.x1;
    const y = baselineY + between(rng, -zone * 0.04, zone * 0.06);

    const outline = glyph.getPath(x, y, fontSize);
    // Wobble amplitude scales with letter size — visible tremor, not chaos.
    const amp = fontSize * between(rng, 0.008, 0.022);
    const contours = wobble(flattenPath(outline, 3), rng, amp);
    const d = contoursToPathD(contours);

    // Ink: greyscale, uneven. Two passes — a full fill plus a slightly
    // offset lighter echo — read as pen pressure variation after blur.
    const ink = Math.round(between(rng, 0x12, 0x52));
    const inkHex = `#${ink.toString(16).padStart(2, "0").repeat(3)}`;
    const alpha = between(rng, 0.82, 0.95);
    const rot = between(rng, -2.5, 2.5);
    const echoDx = between(rng, -1.2, 1.2);
    const echoDy = between(rng, -1.2, 1.2);
    parts.push(
      `<g transform="rotate(${rot.toFixed(2)} ${cx.toFixed(1)} ${((by + baselineY) / 2).toFixed(1)})">` +
        `<path d="${d}" fill="${inkHex}" fill-opacity="${(alpha * 0.45).toFixed(2)}" transform="translate(${echoDx.toFixed(1)} ${echoDy.toFixed(1)})"/>` +
        `<path d="${d}" fill="${inkHex}" fill-opacity="${alpha.toFixed(2)}"/>` +
        `</g>`,
    );
  }

  // Paper noise: speckles (mostly faint; a few dark ones that turdsize
  // must remove) and a couple of long faint smudges.
  for (let i = 0; i < 420; i++) {
    const sx = between(rng, 0, w);
    const sy = between(rng, 0, h);
    const r = between(rng, 0.3, 1.3);
    const dark = rng() < 0.06;
    parts.push(
      `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${r.toFixed(2)}" fill="#000000" fill-opacity="${(dark ? between(rng, 0.25, 0.45) : between(rng, 0.03, 0.1)).toFixed(3)}"/>`,
    );
  }
  for (let i = 0; i < 4; i++) {
    const sx = between(rng, w * 0.1, w * 0.9);
    const sy = between(rng, h * 0.1, h * 0.9);
    const ex = sx + between(rng, -260, 260);
    const ey = sy + between(rng, -160, 160);
    const mx = (sx + ex) / 2 + between(rng, -70, 70);
    const my = (sy + ey) / 2 + between(rng, -70, 70);
    parts.push(
      `<path d="M${sx.toFixed(0)} ${sy.toFixed(0)} Q${mx.toFixed(0)} ${my.toFixed(0)} ${ex.toFixed(0)} ${ey.toFixed(0)}" fill="none" stroke="#000000" stroke-opacity="${between(rng, 0.02, 0.05).toFixed(3)}" stroke-width="${between(rng, 4, 14).toFixed(1)}" stroke-linecap="round"/>`,
    );
  }

  parts.push(await qrCellSvg());
  parts.push(`</svg>`);
  return parts.join("");
}

/** Rasterize + degrade: gaussian blur (camera softness) then a JPEG
 *  round-trip (phone compression). Returns a JPEG — same as a real
 *  phone upload. */
export async function generateHandDrawnJpeg(seed = 42): Promise<Buffer> {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const svg = await generateHandDrawnSvg(seed);
  const sigma = between(rng, 0.7, 1.3);
  const quality = Math.round(between(rng, 76, 88));
  return await sharp(Buffer.from(svg))
    .flatten({ background: "#fbfaf7" })
    .blur(sigma)
    .jpeg({ quality })
    .toBuffer();
}
