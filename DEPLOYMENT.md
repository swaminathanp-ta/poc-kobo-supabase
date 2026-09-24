# Deploying

Two pieces, both on GitHub Actions:

| Piece | Solves |
|---|---|
| 1. Pages deploy (`pages.yml`) | serves the PWA over HTTPS |
| 2. Nightly backup (`backup.yml`) | no backups on the free tier; also keeps the project from pausing |

---

## 1. The PWA

One-time: **Settings → Pages → Source: GitHub Actions**. Every push to `main`
that touches `pwa/` then redeploys it. See [pwa/README.md](pwa/README.md).

The workflow refuses to publish if `pwa/config.js` contains a secret key.

### The admin dashboard

Deployed with the app at `https://<user>.github.io/<repo>/admin/`. It uses the
same publishable key; admins sign in, and the database only shows player
records to accounts listed in the `admins` table
(`supabase/migrations/20260924000003_admin_access.sql`).

To add an admin:

1. Supabase dashboard → **Authentication → Users → Add user** (email + password,
   tick *Auto confirm*).
2. SQL Editor:
   ```sql
   insert into admins (user_id, email)
   select id, email from auth.users where email = 'them@example.org';
   ```

Turn off **Authentication → Sign In / Providers → Allow new users to sign up**.
Signing up would not grant access anyway, but there is no reason to allow it.

To remove an admin: `delete from admins where email = 'them@example.org';`

---

## 2. Backups

Add these under **Settings → Secrets and variables → Actions**:

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

## On pausing

A free project pauses after 7 days of low activity. PWA traffic is bursty — a
quiet week between registration drives is enough — so don't rely on it. The
nightly backup connects to the database every day, which is the heartbeat.

If it ever does pause, the database stops and nothing inside it can wake it —
which is why the heartbeat lives on GitHub rather than in Supabase Cron. Restore
from the dashboard; registrations made in the meantime wait in the phones'
queues and send once it is back.

**GitHub disables scheduled workflows in a repository with no commit activity
for 60 days.** A heartbeat that switches itself off is worse than none, because
you will believe you are covered. Either commit something occasionally, or add
an external pinger (cron-job.org, UptimeRobot) as a second line.

You have **one year** to restore a paused project. After that it is gone, which
is the other reason the backups exist.
