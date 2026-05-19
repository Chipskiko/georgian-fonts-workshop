# Deploying to Vercel

The site is ready to host. Follow these steps in order.

## 1. Push to GitHub

The repo doesn't have a remote yet. Create a new GitHub repo and push:

```bash
gh repo create georgian-fonts-workshop --private --source=. --remote=origin
git push -u origin main
```

(Or via the web: create the repo on github.com, then
`git remote add origin <url>` and `git push -u origin main`.)

## 2. Import into Vercel

1. Go to <https://vercel.com/new>
2. Select the GitHub repo you just pushed
3. Vercel will auto-detect Next.js — leave the defaults
4. Click **Deploy** (don't worry about env vars yet)

The first deploy will succeed but the font/poster upload features won't
work until you add storage + the admin password (steps 3–4).

## 3. Enable Vercel Blob storage

Fonts and (later) gallery posters live in Vercel Blob, since the
serverless filesystem is read-only.

1. In your Vercel project dashboard → **Storage** tab → **Create Database** → **Blob**
2. Name it whatever (e.g. `gfw-blob`)
3. Click **Connect** — Vercel automatically injects
   `BLOB_READ_WRITE_TOKEN` into your project's env vars. No manual copying.

## 4. Set the admin password

Currently the admin password (`vividxura`) is hardcoded in
`app/add/actions.ts` as a fallback. Override it in production:

1. Vercel project dashboard → **Settings** → **Environment Variables**
2. Add: `ADMIN_PASSWORD` = whatever password you want
3. Apply to: **Production, Preview, Development**

Without this, anyone who reads the repo on GitHub knows the admin
password.

## 5. Redeploy

After steps 3 + 4, trigger a redeploy:

- Vercel dashboard → **Deployments** → ⋯ on the latest → **Redeploy**

Or just push any small commit to `main` — Vercel auto-deploys.

## 6. Verify

Visit your `*.vercel.app` URL and check:

- [ ] `/` browse page shows existing fonts (those bundled in `public/fonts/`)
- [ ] `/add` accepts a font upload (try a `.ttf`) — it should appear in `/`
  immediately (auto-saved to Blob)
- [ ] `/add` admin unlock works with the password you set in step 4
- [ ] `/posterizer` lets you type letters and see them spawn

## Workshop usage

Once deployed:

- Each participant goes to your Vercel URL on their own laptop/phone
- They use `/add` to scan + upload their font (saved to shared Blob)
- All participants immediately see all uploaded fonts on `/` and `/posterizer`
- Each participant makes their own poster (poster state is per-browser
  in localStorage, not shared)

Optional follow-up if you want shared posters: see "Posters on server"
section in chat history — we mapped out a gallery feature using PNG
snapshots, ~1 hour of work to add.

## Local development

Default storage is `public/fonts/` so dev needs no env vars:

```bash
npm install
npm run dev
```

To test the Vercel Blob code path locally, copy `BLOB_READ_WRITE_TOKEN`
from your Vercel project into `.env.local`:

```
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
```

Reads/writes will then go to the real Blob store. Be careful — this is
the live data your production users see.

## What's where

- **Fonts (server-side, shared)** — Vercel Blob `fonts/*.ttf`. Adapter in
  `lib/font-storage.ts` switches between fs and Blob based on
  `BLOB_READ_WRITE_TOKEN`.
- **Posters (client-side, per-browser)** — localStorage key
  `gfw_posterizer_v2`. Each participant's posters live only in their
  browser. Clear with browser devtools.
- **Admin lock (client-side, per-tab)** — sessionStorage key
  `gfw_admin_password`. Re-validated against server's `ADMIN_PASSWORD`
  on each unlock.

## Costs

Vercel free tier (Hobby plan):
- 100 GB bandwidth/month
- Vercel Blob: 1 GB storage + 10 GB bandwidth/month free
- Should handle a typical workshop easily

Each saved font is ~30–80 KB. 100 fonts = ~5 MB. Way under the limit.
