# Workshop prep

What to test before the workshop, what to watch for during, and how to
recover if something breaks.

The site has been hardened against the common failure modes (font
rendering across devices, mobile cascade, server cost), but a few
things can only be verified on the actual hardware participants will
use. Walk through this list 1–2 hours before the workshop starts.

## 1. Pre-workshop (1–2 hours before)

### On the same iPhone model participants will use

- [ ] Print one fresh template via the QR code on `/add`, scan it,
      fill in 10–15 letters, upload. Preview should show the font
      shapes recognizably. Save.
- [ ] After save, open `/cascade` — the new font appears in the
      picker dropdown within ~30s.
- [ ] Type 5–6 letters in cascade, drag one around, tap to select,
      drag the yellow rotation handle → letter rotates around its
      center. Then with the letter still selected, put a second
      finger on the stage and twist → letter rotates again.
- [ ] Save the poster from cascade. Refresh `/posterizer` (or tap the
      ↻ refresh button) — your poster appears. Tap to open lightbox.
- [ ] Click "debug" on the make form for one of your scans — debug
      image renders without error. (This was the last bug fixed; if
      it still throws "Maximum array nesting" report immediately.)
- [ ] Take a scan with **hollow letters** (an `ო` or hand-drawn `O`)
      → in the preview the interior should stay white, not fill in
      solid. (CONTRAST_FACTOR was tuned for this; verify on a real
      scan.)

### On a desktop browser

- [ ] Hard refresh `/` (Cmd+Shift+R). Every font row renders in its
      actual face, not Times serif fallback.
- [ ] Click any row → expanded panel shows name + author + yellow
      "ჩამოტვირთე" button. Click it → font downloads correctly,
      opens in any font viewer / Font Book.
- [ ] On `/cascade`, font picker dropdown's first option is
      "შემთხვევითი" (random) — selected by default. Type a few
      letters → each spawns in a different font.
- [ ] Hit the ↻ refresh button in `/posterizer` → poster list
      refreshes immediately.

### Admin checks

- [ ] Unlock admin on `/add` (the password is `ADMIN_PASSWORD` env
      var on Vercel — confirm it's set).
- [ ] Delete one test font → disappears from picker.
- [ ] Delete one test poster on `/posterizer` → disappears from
      gallery.
- [ ] Re-lock admin (close the tab is enough — state is per-session).

### Vercel side

- [ ] Open the Vercel dashboard. Confirm Pro plan is active.
- [ ] Check **Usage** tab — function invocations + bandwidth should be
      well under 5% of monthly limit. If above 10% before the workshop
      starts, something's wrong (probably the cascade poll is leaking).
- [ ] Set up function-error alerts:
      Settings → Notifications → toggle on "Function errors" and
      "Function failures".
- [ ] Keep `vercel.com/dashboard` open in a tab during the workshop
      so a spike is visible at a glance.

## 2. During the workshop

Things that are normal and don't need intervention:

- 30s lag between someone uploading a font and others seeing it in
  cascade — by design. The manual refresh button or navigating away
  and back gets it faster.
- Brief "saving..." spinners when 5+ people save fonts at the same
  time. Sharp + potrace + opentype.js processing serializes through
  available function instances. Should complete in under 10s.

Things to actively watch for:

- **Multiple participants reporting "font not rendering"** — could be
  a regression of the Mac name-table bug. Check `/api/fonts` response
  on a desktop browser; verify each `@font-face` URL returns 200 with
  `content-type: font/otf`.
- **"Saving" stuck longer than 30s** — Vercel function timeout
  (default 60s on Pro for Node functions). One offender can block
  others. Refresh the participant's page; if it persists, the scan
  may be triggering an OOM in sharp. Ask them to take a closer-up
  retake.
- **Anyone seeing the generic "Server Components render error"** —
  hard-refresh first (stale client JS holds old action IDs). If it
  persists, get the error digest hash and check Vercel logs.

## 3. Recovery procedures

### Bad font keeps appearing in picker

Unlock admin on `/add`, find the font, click delete. Tag invalidation
fires immediately so cascade pickers update within their next 30s poll
(or instantly on page navigation).

### Gallery cluttered with test posters

Unlock admin on `/posterizer`, delete individually. There's no bulk
delete — for many posters, easier to just SSH into the project locally
and run:

```bash
node --env-file=.env.local --input-type=module -e "
import { list, del } from '@vercel/blob';
const { blobs } = await list({ prefix: 'posters/' });
for (const b of blobs) { await del(b.url); console.log('deleted', b.pathname); }
"
```

### Font upload silently doesn't work

Check `vercel env ls` — `BLOB_READ_WRITE_TOKEN` must be set in
Production. Without it, every save throws "Blob storage not
configured" but the participant just sees a generic error.

### Site goes blank / 500s

Vercel dashboard → Deployments → most recent → check status. If a
recent deploy broke something, click **Promote to production** on the
previous working deploy. Rollback takes ~30s.

### Vercel quota exhausted mid-workshop

Unlikely (you're budgeted for ~330 workshops/month on Pro), but if it
happens:

1. Vercel → Settings → Usage → upgrade plan one tier (takes effect
   within minutes).
2. Investigate after: a runaway client poll is the usual cause.

## 4. Post-workshop cleanup

### Reclaim Blob storage

Delete obviously-junk posters via admin UI. For bulk, the script
above. If many fonts were made and you want to keep only the "good
ones," same approach — list, filter, delete.

### Snapshot the workshop output

If you want a record of the workshop's posters, run locally:

```bash
node --env-file=.env.local --input-type=module -e "
import { list } from '@vercel/blob';
import fs from 'node:fs';
import path from 'node:path';
const out = '/Users/test/Desktop/workshop-archive';
fs.mkdirSync(out, { recursive: true });
const { blobs } = await list({ prefix: 'posters/' });
for (const b of blobs) {
  if (b.pathname.includes('_thumb.')) continue;
  const r = await fetch(b.url);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(path.join(out, path.basename(b.pathname)), buf);
}
console.log('archived', blobs.length, 'posters');
"
```

Same pattern works for fonts (`prefix: 'fonts/'`).

### Reset for the next workshop

Decide whether to keep prior fonts as "starter content" or wipe. To
wipe everything:

```bash
node --env-file=.env.local --input-type=module -e "
import { list, del } from '@vercel/blob';
const { blobs } = await list();
for (const b of blobs) await del(b.url);
console.log('wiped', blobs.length, 'blobs');
"
```

(Drops everything — fonts + posters + thumbs. Run after archiving.)

## 5. Capacity reference

On Vercel Pro ($20/month), per workshop of 30 participants × 1.5
hours, each making 5 fonts + 5 posters:

| Resource | Used | Monthly headroom |
|---|---|---|
| Function invocations | ~3,000 | 0.3% (1M cap → ~330 such workshops/mo) |
| Function execution time | ~10 GB-min | 0.02% |
| Bandwidth | ~500 MB | 0.05% |
| Blob storage growth | ~50 MB | accumulates — needs occasional cleanup |
| Blob bandwidth | ~300 MB | 0.3% |

The practical ceiling is around 200 concurrent participants (Vercel
function concurrency limit during burst load) and ~2,000 workshops
between Blob cleanups.
