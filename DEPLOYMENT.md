# Deploying the sync

Three pieces. Each is independently useful — deploy them in this order and you
can stop after any one of them.

| Piece | Solves | Where it runs |
|---|---|---|
| 1. Edge Function + Kobo REST Service | instant sync on submission | Supabase |
| 2. GitHub Actions sync | missed submissions, **edits**, pause heartbeat | GitHub |
| 3. GitHub Actions backup | no backups on the free tier | GitHub |

Piece 2 is the one you actually need. Piece 1 is the one that feels good.

---

## 1. Edge Function — instant sync

### Deploy

```bash
# pick a long random password for Kobo to authenticate with
WEBHOOK_PASS=$(openssl rand -base64 24)
echo "$WEBHOOK_PASS"        # write this down, you need it in the Kobo UI

supabase secrets set KOBO_WEBHOOK_USER=bvl-kobo
supabase secrets set KOBO_WEBHOOK_PASSWORD="$WEBHOOK_PASS"

supabase functions deploy kobo-webhook --no-verify-jwt
```

`--no-verify-jwt` is required — Kobo cannot send a Supabase JWT. The function is
therefore publicly reachable and authenticates callers itself with HTTP Basic,
which is why the two secrets above must be set **before** you deploy. If they
are missing, the function rejects everything rather than running open.

> This step needs the Supabase CLI. If you never installed it, skip to piece 2 —
> the scheduled sync works on its own, just with up to 15 minutes of latency.

### Point Kobo at it

In Kobo: your project → **Settings → REST Services → Register a new service**

| Field | Value |
|---|---|
| Name | `Supabase sync` |
| Endpoint URL | `https://<project-ref>.supabase.co/functions/v1/kobo-webhook` |
| Type | JSON |
| Username | `bvl-kobo` |
| Password | the `WEBHOOK_PASS` from above |

Submit a test registration, then check **REST Services → the service → Logs**.
A `200` means the row is already in Supabase.

### What it does and does not do

- Fires once per **new** submission, within a second or two.
- Retries 3 times on failure — after 60s, 600s, then 6000s. Then it gives up.
- **Never fires when a submission is edited.** Only piece 2 catches corrections.

---

## 2. GitHub Actions sync — the important one

Push this repository to GitHub, then add these under
**Settings → Secrets and variables → Actions**:

| Secret | Where to find it |
|---|---|
| `KOBO_TOKEN` | Kobo → Account Settings → Security → API Key |
| `KOBO_ASSET_UID` | the `a...` id in your form's URL |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Project Settings → API → service_role / `sb_secret_` key |

Optional **variable** (not secret): `KOBO_BASE_URL`, only if you are on the EU
server (`https://eu.kobotoolbox.org`).

Then **Actions → Sync Kobo to Supabase → Run workflow** to test it by hand
before trusting the schedule.

### Schedule

- **every 15 min** — incremental. Reads the watermark from Supabase
  (`--from-db`) rather than a local state file, because the runner is stateless.
- **daily 02:00 UTC (07:30 IST)** — `--full`. The only thing that picks up
  **edited** submissions.

### The gotcha

**GitHub disables scheduled workflows in a repository with no commit activity
for 60 days.** A heartbeat that switches itself off is worse than none, because
you will believe you are covered. Either commit something occasionally, or add
an external pinger (cron-job.org, UptimeRobot) as a second line.

---

## 3. Backups

Two more secrets:

| Secret | Notes |
|---|---|
| `SUPABASE_DB_URL` | Project Settings → Database → Connection string → URI. **Use the session pooler string** — the direct connection is IPv6-only and GitHub runners are IPv4, so it will hang. |
| `BACKUP_PASSPHRASE` | Any long random string. **Store it outside this repo** — without it the backups are unreadable. |

Runs nightly, verifies the dump is non-empty (a silently empty dump is the
failure you discover on the worst possible day), encrypts it with AES256, and
keeps it as an artifact for 90 days.

To restore:

```bash
gpg --batch --passphrase "$BACKUP_PASSPHRASE" \
    --decrypt bvl-backup-YYYYMMDD-HHMM.sql.gpg > restore.sql
psql "$SUPABASE_DB_URL" -f restore.sql
```

Test a restore into a scratch project **before** you need one. An untested
backup is a hope, not a backup.

---

## How the two paths coexist

Both write the same row and both upsert on `kobo_id`, so a submission arriving
twice — once by webhook, once by poll — updates rather than duplicates. The
transform logic in `supabase/functions/kobo-webhook/index.ts` and in
`kobo_to_supabase.py` is deliberately identical; if you change one, change both.

## On pausing

A free project pauses after 7 days of low activity; Supabase says a few
requests a day is enough to prevent it. The 15-minute sync is far more than
that, so with piece 2 running you should never pause.

If it ever does pause, the database stops and nothing inside it can wake it —
which is why the heartbeat lives on GitHub rather than in Supabase Cron. You
restore from the dashboard, and the next sync backfills whatever Kobo held.

You have **one year** to restore a paused project. After that it is gone, which
is the real reason piece 3 exists.
