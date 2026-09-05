# BVL Registration — Progressive Web App

An installable, offline-first registration app. No Play Store, no app review,
no release cycle: push a change and every phone has it the next time it opens.

```
 register  ->  IndexedDB on the phone  ->  (whenever there is signal)  ->  Supabase
```

## Why this can be a plain web page

The app ships the Supabase **publishable** key, which is designed to be public.
Row level security decides what that key can actually do, and the answer is
narrow: insert a registration, read the centre list. Nothing else.

Verified against a real Postgres, as the `anon` role:

| Attempt | Result |
|---|---|
| Read any player record | **0 rows** — even with records present |
| Read the centre list | 141 rows |
| Insert a valid registration | accepted |
| Insert without guardian consent | **rejected by the database** |
| Insert claiming `source = 'kobo'` | **rejected** |
| Update an existing record | **0 rows** |
| Delete anything | **0 rows** |

Consent is enforced in the policy, not only in the form, so it holds even if
someone bypasses the app entirely.

## Setup

1. Apply the migration `supabase/migrations/20260902000001_pwa_intake.sql`
   (adds `source`/`source_id` and the two policies).
2. Put your project URL and **publishable** key in `pwa/config.js`.
3. Copy `workflows-to-copy/pages.yml` into `.github/workflows/`, push, and set
   **Settings → Pages → Source: GitHub Actions**.

Your URL will be `https://<user>.github.io/<repo>/`. HTTPS matters — service
workers, and therefore offline mode and installation, do not work without it.

If you skip step 2 the app still runs and shows a setup panel, so you can paste
the values on the phone to try it. Handy for testing, not for rollout.

## Installing on a phone

Open the link in Chrome → menu → **Add to Home screen**. It gets an icon, opens
full-screen with no browser bar, and works with no signal.

## What it does offline

- The app shell is cached by the service worker, so it opens with no network.
- The centre list is cached in IndexedDB, so the district → centre picker keeps
  working — that's what stops anyone typing a centre name by hand.
- Registrations are saved to IndexedDB immediately and queued.
- They send themselves on reconnect, or via **Send now**.
- A retry can never duplicate: each registration carries a device-generated
  `source_id`, unique in the database, and a `409 Conflict` is treated as
  success.
- The badge shows how many are waiting and how old the oldest is.

## Protecting the queue

Android can clear a website's storage when the phone runs low on space. Three
defences, in order of importance:

1. **Persistent storage** — the app calls `navigator.storage.persist()` on
   first save. When granted, the browser stops evicting this app's data
   automatically. Settings shows whether it was granted on that phone.
2. **Send early** — the queue drains on every reconnect, so data rarely sits.
3. **Backup file** — Settings → *Save a backup file* writes a JSON file to
   Downloads, or shares it straight to WhatsApp. That lives outside browser
   storage and survives anything short of deletion.

Nothing protects against the user clearing site data, uninstalling Chrome, or a
"phone cleaner" app. That last one is worth testing on real handsets — cleaner
utilities are common on budget Android phones and they do clear browser data.

## What to check on a real phone

The point of the pilot is these five things:

- Does `Add to Home screen` appear, and does the icon open full-screen?
- Does Settings report persistent storage as **granted**?
- Register 5 players in airplane mode, force-close the app, reopen — are they
  still queued?
- Leave it a week on a phone that's nearly full. Do they survive?
- Turn signal on. Do they arrive in Supabase without being touched?

If all five pass, a PWA is enough and you never need a native app. If the
fourth fails, you have a concrete, evidence-backed reason to build native — and
you'll know it before spending months.
