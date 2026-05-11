# Danish Diary — Personal Ledger PWA

A private khata / receivables tracker. Track money people owe you, log
charges and repayments, see who's overdue, and send WhatsApp reminders —
all from your phone, installable as a PWA.

## File structure

```
danish-diary/
├── index.html              ← The app
├── apps-script.gs          ← Google Apps Script backend
├── manifest.json           ← PWA manifest
├── sw.js                   ← Service worker (offline shell + push stub)
├── vercel.json             ← Vercel hosting config
└── README.md               ← This file
```

You'll also need to add your own PWA icons (not committed):

```
icon-192.png            ← PWA icon (Android)
icon-512.png            ← PWA icon (large)
icon-maskable-512.png   ← PWA icon (Android adaptive)
apple-touch-icon.png    ← iOS home-screen icon
favicon-32.png          ← Browser tab icon
```

Any 192/512 PNG of your choosing works. A simple solid-background "D"
mark in the brand colours (`#1A1A2E` background, `#C77B3D` accent) is
fine for a personal tool.

## Setup (~10 minutes, one-time)

### 1. Create the Google Sheet

1. Create a new Google Sheet. Name it whatever you like (e.g. "Danish
   Diary — Ledger").
2. The two required tabs (`People` and `Ledger`) are created
   automatically on first backend call — you don't need to do anything
   manually here.

### 2. Deploy the Apps Script backend

1. In the sheet, open **Extensions → Apps Script**.
2. Delete the empty `Code.gs` file. Create a new file named
   `apps-script.gs` and paste the contents of `apps-script.gs` from
   this folder.
3. (Optional but recommended) Change `SECRET_TOKEN` at the top of
   `apps-script.gs` to something only you know. Keep the same value in
   `index.html`'s `CONFIG.TOKEN` — they must match.
4. **Deploy → New deployment**:
   - Type: **Web app**
   - Description: "Danish Diary v1"
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, copy the resulting **Web app URL**.

### 3. Wire the PWA to the backend

1. Open `index.html` and find the `CONFIG` block near the top.
2. Paste the Web app URL into `CONFIG.ENDPOINT`.
3. Make sure `CONFIG.TOKEN` matches `SECRET_TOKEN` in `apps-script.gs`.

### 4. Deploy the frontend to Vercel

#### Option A — Drag-drop

1. Go to <https://vercel.com/new>.
2. Drag the entire `danish-diary/` folder onto the page.
3. Vercel auto-detects it as a static site → click **Deploy**.
4. You get a URL like `danish-diary-xyz.vercel.app`.

#### Option B — CLI

```bash
cd danish-diary
npx vercel --prod
```

### 5. Install on your phone

#### iPhone
1. Open the Vercel URL in **Safari** (not Chrome — iOS only allows
   Safari to install PWAs).
2. Tap the Share icon → **Add to Home Screen** → **Add**.

#### Android
1. Open the Vercel URL in Chrome.
2. An install banner appears at the bottom → tap **Install**.

After install: opens fullscreen, has its own icon, works offline (form
shell loads, submissions need network).

## Security note

There's no login on this app. The Vercel URL + the `SECRET_TOKEN`
inside `index.html` together are the secret. **Anyone with the URL can
read your full ledger.** Vercel URLs are unguessable so it's safe to
keep private, but:

- **Don't share the URL** with anyone you don't want seeing the data.
- **Don't post screenshots** that include the URL bar.
- If the URL leaks, generate a new Vercel deployment (which gives a new
  random URL) and rotate `SECRET_TOKEN` in both files.

## How it works

### Data model

**People** tab — one row per person you've lent to:
- `personId` (auto: `p001`, `p002`, …)
- `name` · `phone` · `notes` · `archived` · `createdAt`

**Ledger** tab — one row per transaction:
- `entryId` (auto: `e00001`, `e00002`, …)
- `personId` (which person)
- `date` · `type` (`charge` | `repayment`) · `amount` · `description` · `createdAt`

### Balance math

For each person, the dashboard computes:

```
balance = sum(charges) − sum(repayments)
```

`balance > 0` → they owe you that much. `balance = 0` → settled.
`balance < 0` → you overpaid them somehow (shouldn't happen often).

### Aging

For each person with `balance > 0`, "days since last payment" is
computed from either their last repayment (if any) or their first
charge. Colour-coded:

| Bucket      | Days       | Colour  |
|-------------|------------|---------|
| Fresh       | 0–7        | green   |
| Week        | 8–30       | gold    |
| Month       | 31–60      | copper  |
| Two-month   | 61–90      | orange  |
| Old         | 91+        | red     |

### WhatsApp reminders

Each person row in the drawer has a WhatsApp button. Tap it →
`wa.me/<phone>` opens with a prefilled message including their balance
and the date of last activity. You hit send.

The phone number must be entered in international format **without
the leading `+`** (e.g. `923001234567` for a Pakistan number, not
`+923001234567` or `03001234567`).

## What's NOT in v1

- **Browser push notifications.** The service worker has a `push`
  event handler so the frontend is ready, but the backend doesn't yet
  send pushes. Adding real push needs VAPID keys + ECDSA signing
  (Apps Script doesn't have native ECDSA, so this needs either a
  third-party push service like Pushover, OneSignal, or
  FCM + a JWT library port). Phase 2.
- **Categories / tags** on entries.
- **Currency switching** — hardcoded to PKR.
- **Recurring charges** (e.g. monthly rent owed).
- **Multi-device sync conflict handling** — last write wins. Fine for
  a single user.

## Updating

Edit any file → redeploy to Vercel. Bump `CACHE_VERSION` in `sw.js`
to force users to reload the new shell.

When you change `apps-script.gs`:
1. Paste the new contents into the Apps Script editor.
2. **Deploy → Manage deployments → edit the existing deployment → Save**.
   Keeps the same URL so you don't have to update `CONFIG.ENDPOINT`.
