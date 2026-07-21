# Migration plan: move font-build compute into the browser

Goal: make the heavy computation run **on the device (browser)** so the
Vercel **Hobby** plan is sufficient — and, as a bonus, remove the ~10s
serverless function timeout that can fail detailed scans.

Status: **PLAN ONLY** — no code changed yet.

---

## 1. Why this is needed

Vercel Hobby caps serverless functions at **~10s wall-clock** and limited
memory. Exactly one request path is heavy enough to risk that:

```
previewFontFromScan  (app/make/actions.ts:49)
  → processScan(buffer)          # sharp decode/resize/threshold/warp + potrace ×33 cells
  → buildFont(glyphPaths, …)     # opentype.js assembly + optical kerning
```

A high-detail scan can exceed 10s → upload fails. (This is the "is there a
ceiling on detailed files?" issue from earlier.)

Everything else server-side is cheap **storage I/O** and is fine on Hobby:
`saveFontFromPreview`, `uploadPoster`, font/poster `list`+`delete`,
calibration image compression.

---

## 2. The core idea — "thin server, fat client"

Do the heavy work in the browser; the server becomes a **storage writer**.

Most of the tooling needed is **already loaded client-side**:

| Server op today | Browser replacement | Notes |
|---|---|---|
| sharp: grayscale / resize / threshold / **perspective warp** / blur | **OpenCV.js** (`cvtColor`, `warpPerspective`, `threshold` incl. Otsu, `GaussianBlur`, `resize`) | OpenCV.js already loaded by jscanify on the make page → no new bundle cost |
| marker detection | client version in `app/make/perspective.ts` | **already exists** |
| potrace vectorization (`potrace.trace`) | **`esm-potrace-wasm`** | new ~100KB WASM dep; chosen to match current output |
| opentype.js font assembly + optical kerning | opentype.js (`build-font.ts`, `optical-kerning.ts`) | **already isomorphic — verified node-free, moves unchanged** |
| html2canvas poster + B&W | already client-side | ✓ |

### Verified during planning
- `lib/font-pipeline/build-font.ts` imports only `opentype.js` + a
  type + `constants` + `optical-kerning`. The lone `potrace` reference is
  a **comment**. → node-free.
- `lib/font-pipeline/optical-kerning.ts` imports only `opentype.js`. → node-free.
- `lib/font-pipeline/constants.ts` has no imports. → node-free.
- **So only `process-scan.ts` (sharp + potrace) must be ported.**

---

## 3. Storage is NOT the constraint

Blob/CDN storage + bandwidth are metered separately from **function
compute**. Serving fonts/posters is CDN traffic (cheap), browsing pages
are already static/ISR. At workshop scale (71 fonts ≈ a few MB; posters as
JPGs) this sits inside the Hobby free tier. The server still holds the
Blob write token (never shipped to the client) and does the `put()` —
good security posture, negligible compute.

---

## 4. New / changed files

### NEW: `lib/font-pipeline/process-scan.client.ts`
Browser twin of `process-scan.ts`, using OpenCV.js + esm-potrace-wasm.
Input: a `File`/`ImageBitmap`/canvas. Output: the **same** `GlyphPath[]`
(`{ svgPath, cellWidthPx, cellHeightPx }`) so `buildFont` consumes it
unchanged. Must replicate the existing pipeline **parameters exactly** so
output matches:
- marker detect → homography (reuse `app/make/perspective.ts`)
- `cv.warpPerspective` → canonical warped Mat (replaces `warpToCanonical`)
- per-cell ROI crop (single-source-of-truth rects from `cellRect()`)
- per-cell: grayscale → bg-subtract/normalize → **Otsu** threshold →
  Gaussian blur (match `TRACE_OPTIONS`: threshold 180, turdSize, alphaMax,
  optTolerance, gamma curve)
- vectorize each cell with esm-potrace-wasm → SVG path

### REUSE unchanged (move into client bundle)
`build-font.ts`, `optical-kerning.ts`, `constants.ts`.

### CHANGE: `app/make/MakeFontForm.tsx`
- Run `processScan.client` + `buildFont` in the browser to produce the
  `.otf` `Uint8Array`.
- Preview locally with the **FontFace API** (no server round-trip).
- On save, POST the prebuilt bytes (+ name/designer + thumbnail) to a thin
  server action.

### CHANGE: `app/make/actions.ts`
- `previewFontFromScan` → **deleted** (preview is now fully client-side).
- `saveFontFromPreview` → accept client-built `.otf` bytes and `put()`
  them (it already does most of this; just stop rebuilding server-side).
- `debugScan` / `tunableDebugScan` → **leave server-side for now**
  (admin-only, gated, rarely hit → no Hobby risk). Optional later port.
- `sharp` import drops out of the hot path; remains only for the
  admin/debug + calibration code and `/scripts`.

### ADD dep
`esm-potrace-wasm` (+ Next config for WASM async loading on the client).

---

## 5. Phased sequence (low-risk, reversible)

- **Phase 0** — add `esm-potrace-wasm`; confirm Next client WASM loading.
- **Phase 1** — build `process-scan.client.ts` behind a feature flag;
  run it **alongside** the server path and compare outputs using the
  existing debug views (`cells` / `binary` / `smoothed`) on a few known
  scans. Re-tune OpenCV/potrace params until parity.
- **Phase 2** — switch MakeFontForm preview to the client pipeline
  (FontFace preview, no server call).
- **Phase 3** — shrink the save action to a storage-writer; client
  uploads prebuilt bytes.
- **Phase 4** — remove sharp/potrace from the hot server path (keep for
  admin debug + scripts). Add `maxDuration` only where still relevant.
- **Phase 5** — deploy; confirm function durations drop to I/O-only and
  detailed scans no longer fail.

---

## 6. Risks & mitigations

- **OpenCV.js vs sharp parity** — subtle differences in threshold/warp.
  Mitigate with the existing side-by-side debug views + param re-tuning.
  This is the main QA effort.
- **esm-potrace-wasm fidelity** — chosen specifically to match current
  output; still verify per-glyph against a few existing fonts.
- **WASM loading in Next client** — needs async init + possibly a webpack
  `asyncWebAssembly` flag; one-time setup.
- **Mobile-browser memory** — a huge scan processed in-browser on a phone
  is memory-heavy, but a phone handles it better than a hard 10s function
  cap, and workshop uploads are typically from a laptop. Monitor.
- **No functional regression for browsing** — read paths (home, gallery,
  cascade) are untouched.

---

## 7. Net effect

- Server functions do **only fast storage I/O** → well inside Hobby.
- **No 10s timeout** on font creation → detailed scans always work.
- OpenCV.js already on the make page → minimal added bundle (+~100KB WASM).
- Font-assembly + kerning code reused **as-is** (already isomorphic).
- Only one module (`process-scan.ts`) gets a browser twin.

---

## 8. Fonts page (`/`) — render previews as baked SVG outlines

**Scope: the fonts list page ONLY.** Not textboxes, not cascade, not
font download — those stay `@font-face` (they need editable text / a
valid downloadable file).

### Why
Today each row on `/` shows the font's name via `@font-face`: the browser
downloads the `.otf`, validates it through the **OTS sanitizer**, then
renders (fallback-then-swap = FOUT, softened but not removed by
`font-display: block`). Rendering the name as an inline **SVG `<path>`**
outline instead means:
- no fallback, no swap, no blank — the shape is just there;
- **no font download** for that page;
- **immune to OTS rejection** — a font a strict browser would refuse
  still displays (kills that whole class of fragility for the list page).

### Approach: **Option A — generate at upload, store a sidecar SVG**
(Recommended over the ISR-render alternative; see below.)

- When a font is saved, also compute its preview SVG and store it as a
  **sidecar** next to the `.otf`: `fonts/<filename>.preview.svg`. This
  reuses the existing sidecar idiom (posters already carry `_thumb` +
  `_bnw` sidecars).
- Generation = `opentype` `font.getPath(displayName, 0, 0, size)` → one
  combined path (handles advance widths + the kern table automatically)
  → wrap in an `<svg>` sized to the path bbox, fill `currentColor`.
- The fonts page **reads the stored SVG** and inlines it — no font-byte
  download, no parsing at render → render stays trivial.
- Add `aria-label={fontName}` on the `<svg>` for screen readers /
  searchability (the one accessibility cost of dropping real text).

### Why A, not "generate at cached ISR render" (Option B)
Option B would add, to the home-page render, fetching + opentype-parsing
**all ~71 `.otf`s in a single invocation**. ISR regeneration is itself a
function call under the 10s cap, so the first render after any font
add/delete becomes the heaviest function on the site — the exact timeout
we're designing away. Option A spreads the work to **one font per upload**
(a parse you're already doing during build) and leaves the render reading
static strings.

### "Baked in + auto-updating"
- Auto-updates because every upload generates its own sidecar; deletes
  remove it. No manual script to re-run (unlike the specimen GIF).
- Composes with the client-compute migration: once the build runs in the
  browser, the font bytes are **already on-device at upload**, so the
  preview SVG is generated client-side and uploaded with the `.otf` →
  **zero server compute** for it.

### Files
- NEW `lib/font-pipeline/preview-svg.ts` — `buildPreviewSvg(fontBytes,
  name, size) → string` (pure opentype.js, isomorphic).
- CHANGE save path (`app/make/actions.ts` save / or client upload) —
  also write the `.preview.svg` sidecar.
- CHANGE fonts page (`app/page.tsx` + its font-row component) — inline
  the stored SVG instead of `@font-face` text for the name.
- CHANGE `lib/font-storage.ts` listing — surface the sidecar URL per font.
- NEW `scripts/backfill-preview-svg.mjs` — one-time generation for the
  existing 71 fonts (same shape as the kerning / bnw backfills).

### Risks
- **Accessibility** — SVG isn't selectable text; mitigate with
  `aria-label` + `role="img"`.
- **DOM weight** — negligible: one small SVG per row (the name only), not
  every glyph.
- **Name layout fidelity** — `getPath` already applies kerning, so the
  rendered name matches typeset output.

---

## 9. Going all the way: dropping Vercel entirely

Question investigated (multi-agent audit of the codebase + web research,
2026-07): can the site run with **zero Vercel** — compute fully on-device
and no server functions at all?

### Audit facts (verified against the code)
- The site is **not Vercel-specific**. All 3 storage adapters
  (`font-storage`, `poster-storage`, `debug-storage`) switch on the mere
  presence of `BLOB_READ_WRITE_TOKEN`: absent → local filesystem under
  `public/`. **The whole site already runs fully self-contained on a
  laptop** (`npm run dev` / `next build && next start`) with zero cloud.
- What actually requires a server today: **14 server actions** (3 files).
  The compute ones (`previewFontFromScan`, debug tooling) disappear with
  the client-compute migration (§2–5). The remaining write path is
  storage I/O: `uploadFont`, `saveFontFromPreview`, `uploadPoster`
  (all anonymous) + `deleteFont`/`deletePoster` (server-checked admin
  password) + `checkPassword`.
- No `next/image`, no middleware, no cookies/headers, no dynamic params
  → the **read half exports statically** with modest work. Blockers for
  `output: 'export'` are exactly: server actions + ISR revalidation +
  `/api/fonts` (30s cascade poll) + gallery's 30s `listPosters()` poll.
- One cosmetic tie: the template PDF QR hardcodes
  `https://xarafontinator.vercel.app/add` (`lib/font-pipeline/template.ts:19`).

### Research facts (sources in workflow run wf_2ef733b5-f00)
- **Supabase Storage free tier** is the one mainstream **card-free,
  genuinely zero-server** storage: 1 GB storage, 5+5 GB egress/mo, RLS
  allows **anonymous client-direct uploads** with **server-enforced**
  per-bucket file-size caps + MIME restrictions; deletes restrictable to
  an authenticated admin identity. Worst-case abuse = a full/paused free
  project, never a bill. Caveat: free projects **pause after 7 days of
  inactivity** (needs keepalive or occasional visits). Current content
  (~36 MB) ≈ 4% of the free quota.
- **Firebase** now requires a credit card (Blaze) for Storage. **R2/B2**
  have no anonymous client-write path (need a signer = server). Both out.
- **GitHub Pages**: 1 GB site, 100 GB/mo soft bandwidth, free Actions on
  public repos — comfortably fits ~100 MB of fonts/posters.
  **Cloudflare Workers static assets**: also fine (25 MiB/file cap).
- **GitHub-as-database** (commit uploads → Action rebuild → republish):
  works, ~2–5 min upload-to-live, but anonymous browser commits are
  unsafe (token exposure) — needs an OAuth proxy or PR moderation, i.e.
  not fully serverless for anonymous contributors.

### The three viable end-states

**A. Workshop mode (available today, zero work)** — run the site locally
on the studio laptop: fs storage, no cloud at all. The physical workshop
never needed Vercel. Publish afterwards via any of the below.

**B. Zero-server live site (full Vercel removal)** —
static hosting (GitHub Pages / Cloudflare) + **Supabase** storage +
client-side compute (§2–5):
- Fonts/posters upload **directly from the browser** to Supabase
  (anon key + RLS caps; optional Turnstile CAPTCHA for rate limiting).
- Font list + gallery become **client fetches of Supabase lists**
  (replaces `getFonts` ISR, `/api/fonts` poll, `listPosters()` poll —
  same 30s polling pattern, different endpoint).
- Admin deletes via Supabase auth (replaces `ADMIN_PASSWORD`).
- `@font-face` CSS built client-side from the fetched list (or §8's
  baked SVG previews, which fit this model perfectly).
- Template PDF already `force-static` → ships as a baked asset.
- Work: client-compute migration (§5 phases) + storage-layer swap
  (`supabase-js` replaces the 3 adapters) + convert 5 read pages from
  server-fetch to client-fetch/build-bake + QR URL config.
- Trade: Vercel dependence → Supabase dependence (also free, also a
  platform; plus the 7-day-pause keepalive chore).

**C. Frozen bake (zero external services, period)** — during workshops
run mode A locally; afterwards `next build` a static snapshot (fonts
baked in, uploads disabled or replaced with a "bring your scan to the
workshop" note) and publish to GitHub Pages via Actions. The public
site is a pure artifact: no storage service, no functions, nothing to
pause or bill. Uploads simply aren't live between workshops.

### Recommendation
- Motive = **cost** → stop at the §2–5 migration; Vercel **Hobby is $0**
  and becomes trivially sufficient. Removing Vercel saves no money.
- Motive = **drop the Vercel dependency** → **B** is fully viable; it
  swaps one free platform for another (Supabase) — do it as §5 Phase 6.
- Motive = **maximum permanence/simplicity** → **A + C hybrid**: local
  during events, frozen static bake between them. The only end-state
  with literally zero external runtime dependencies.

### Static-host candidates compared (for B's host slice, or C)

| | Neocities (free) | GitHub Pages | Cloudflare (Workers assets) |
|---|---|---|---|
| Storage / site | 1 GB | 1 GB | 20k files, 25 MiB/file |
| Bandwidth / mo | **200 GB** (soft) | 100 GB (soft) | unmetered |
| Font files (.otf/.ttf/.woff2) | ✅ whitelisted on free | ✅ | ✅ |
| **.wasm files** | ❌ **not on free-tier whitelist** (supporter $5/mo, or inline-as-JS/CDN workaround) | ✅ | ✅ |
| Custom domain | supporter-only ($5/mo); free = name.neocities.org | ✅ free | ✅ free |
| Publish workflow | **drag-and-drop in browser** or `deploy-to-neocities` GitHub Action (diff-aware) | git push + Action | git push / wrangler |
| Vibe fit | indie-web / creative-community — matches the project | generic | generic |

**Neocities verdict:** best-fit for **end-state C (frozen bake)** — the
whitelist covers every file the bake emits (html/css/js/otf/ttf/woff2/
jpg/png/svg/pdf/json/webmanifest), publishing can be literally
drag-and-drop, and 200 GB/mo beats GitHub Pages. For **end-state B**
(live maker with client compute) the free tier's **no-.wasm rule** bites:
esm-potrace-wasm / OpenCV.js WASM must be base64-inlined in JS, loaded
from a CDN, or you pay the $5/mo supporter tier (which also unlocks
custom domains). Neocities never removes the Supabase need for live
uploads — it only replaces the hosting slice.
