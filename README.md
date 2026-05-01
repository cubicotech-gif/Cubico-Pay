# Cubico Pay — PWA

Internal payment-logging app for Cubico Technologies. Posts to a Google Form,
which writes to the Cubico Payments Tracker spreadsheet.

## File structure

```
cubico-pay/
├── index.html              ← The app
├── manifest.json           ← PWA manifest
├── sw.js                   ← Service worker (offline shell)
├── vercel.json             ← Hosting config (cache headers)
├── icon-192.png            ← PWA icon (Android)
├── icon-512.png            ← PWA icon (large)
├── icon-maskable-512.png   ← PWA icon (Android adaptive)
├── apple-touch-icon.png    ← iOS home-screen icon
├── favicon-32.png          ← Browser tab icon
├── splash-1284x2778.png    ← iOS splash (Pro Max)
├── splash-1170x2532.png    ← iOS splash (Pro)
└── splash-750x1334.png     ← iOS splash (SE)
```

## Deploy to Vercel (2 minutes)

### Option A — Drag-drop (no GitHub)
1. Go to https://vercel.com/new
2. Drag this entire `cubico-pay/` folder onto the page
3. Vercel auto-detects it as a static site → click Deploy
4. You get a URL like `cubico-pay.vercel.app`

### Option B — CLI
```bash
cd cubico-pay
npx vercel --prod
```

## Install on phone

### iPhone
1. Open the Vercel URL in **Safari** (not Chrome — iOS only allows Safari to
   install PWAs)
2. The app shows an install hint on first visit. Or:
3. Tap the Share icon → "Add to Home Screen" → "Add"

### Android
1. Open the Vercel URL in Chrome
2. An install banner appears at the bottom of the screen → tap "Install"

After install: the app opens fullscreen with no browser chrome, has its own
home-screen icon, works offline (form shell loads, but submission needs net),
and feels native.

## Updating the app

Edit any file → redeploy to Vercel. The service worker version is bumped in
`sw.js` (`CACHE_VERSION`). To force users to get the new version:
1. Bump `CACHE_VERSION` in `sw.js` (e.g., `v1` → `v2`)
2. Redeploy
3. Users get the update on next app open (may need to close/reopen)

## What this does NOT do (yet)

- Submissions still post via Google Forms iframe trick. No real success/error
  feedback. (Phase 2 — Apps Script backend — fixes this.)
- No offline submission queue. If you submit while offline, it fails silently.
  (Phase 2 — adds background sync.)
- No dashboard inside the app. To see your payments, open the spreadsheet.
  (Phase 3 — adds in-app dashboard.)
