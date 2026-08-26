# BVL Player Registration POC — KoboToolbox → Supabase

Proof of concept for the Tier-2 "Digital Registration Flow" from the BVL AI-for-Good
roadmap: a validated, offline-capable registration form (KoboToolbox) feeding a central
Postgres source of truth (Supabase).

The form enforces at the point of entry the exact data-quality problems found in the
current ledgers: one standard `sex` code (vs 13 variants), a fixed performance-level
vocabulary (vs 6+ "Beginner" spellings), plausible heights (100–220 cm), valid dates,
and — critically — a **centre chosen from the real registry of 141 BVL centres**
(district → centre cascade), so every player row joins cleanly to its centre.

## Project layout

| File | Purpose |
|---|---|
| `src/bvl_registration/sync.py` | Sync service: KoboToolbox API v2 → Supabase upsert |
| `tools/setup_supabase.py` | One-time Supabase bootstrap via the Management API |
| `forms/player_registration.xlsx` | XLSForm to upload to KoboToolbox |
| `supabase/migrations/*.sql` | Versioned schema and centre seed applied by the Supabase CLI or bootstrap script |
| `supabase/sql/*.sql` | Standalone SQL copies for the dashboard SQL Editor |
| `pyproject.toml` | Python package metadata, dependency, and CLI commands |
| `setup_supabase.py` | Compatibility launcher for `tools/setup_supabase.py` |
| `kobo_to_supabase.py` | Compatibility launcher for `bvl-sync` |
| `setup_supabase.sh` | Same job via the Supabase CLI; kept for `--local` Docker development |
| `.env.example` | Template for the four settings the sync script needs |

The recurring application code is a normal installable Python package. The root-level
Python files remain small compatibility launchers for existing commands and cron jobs.

## Setup

### 1. Supabase — pick one of two paths

**Path A — scripted (recommended). Pure Python, no Supabase CLI to install:**

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...      # from the dashboard, see below

uv run python tools/setup_supabase.py --list                    # show your orgs and projects
uv run python tools/setup_supabase.py --new "BVL Registration"  # create + migrate + write .env
uv run python tools/setup_supabase.py --link <project-ref>      # use an existing project
```

The root `setup_supabase.py` launcher is also available for existing scripts.

`tools/setup_supabase.py` talks to the [Supabase Management API](https://supabase.com/docs/reference/api/introduction)
over plain HTTPS — it creates the project, waits for the database, applies every file in
`supabase/migrations/`, verifies the seed landed, fetches the API key, and writes `.env`.
It runs identically on Windows, WSL, macOS and Linux, and re-running it is safe.

The only browser step is creating the account and a
[Personal Access Token](https://supabase.com/dashboard/account/tokens). If you don't export
the token, the script prompts for it.

> `setup_supabase.sh` does the same job via the Supabase CLI. It is kept only for
> `--local` (the Docker stack, which the Management API cannot provide). For normal
> setup, prefer the Python version — one language across the project, and nothing to install.

**Path B — dashboard (no CLI):** create a project at [supabase.com](https://supabase.com),
open **SQL Editor**, run `supabase/sql/01_schema.sql` then `supabase/sql/02_centres_seed.sql`, and copy the
**Project URL** + **`service_role` key** from **Project Settings → API** into `.env`.

> **Key formats:** Supabase is migrating from the legacy JWT `anon` / `service_role` keys to
> `sb_publishable_...` / `sb_secret_...` keys, with the legacy pair deprecated at the end of
> 2026. The sync script works with either — use the **secret/service** key, server-side only.

### 2. KoboToolbox (5 min)
1. Create a free account at [kf.kobotoolbox.org](https://kf.kobotoolbox.org).
2. **New → Upload an XLSForm** → choose `forms/player_registration.xlsx` → **Deploy**.
3. Open the form's **Collect data** link (Enketo web form — works on phones and
   keeps working offline; submissions queue and send when signal returns).
4. Get your **API token**: Account Settings → Security → API Key.
5. Get the **asset UID** from the form URL: `.../forms/<THIS_PART>/...` (starts with `a`).

### 3. Sync script (5 min)
```bash
python3 -m pip install -e .
cp .env.example .env       # skip if setup_supabase.sh already wrote it
# add KOBO_TOKEN and KOBO_ASSET_UID to .env

bvl-sync --check     # preflight: are both ends reachable?
bvl-sync             # single pass
bvl-sync --loop 300  # or: poll every 5 minutes
```

Settings are read from `.env`; real environment variables override it, which is what
you want in cron or CI.

### Keeping it running

```bash
# cron: sync every 5 minutes, log to a file
*/5 * * * * cd /home/swaminathanp/projects/poc-kobo-supabase && \
  /usr/local/bin/bvl-sync >> sync.log 2>&1
```

### 4. Demo
Submit a registration in the Enketo form, run the script, then in Supabase:
```sql
select * from v_registrations order by submitted_at desc;
```
That view is also what you'd point Looker Studio / Metabase at for the Tier-2 dashboard.

## How the sync works

- Fetches `GET /api/v2/assets/{uid}/data.json` filtered to `_id` greater than the last
  synced id (stored in `.sync_state.json`), following pagination.
- Maps each submission to a `players` row (group-prefix tolerant, so renaming the
  form group won't break it).
- Upserts via PostgREST with `on_conflict=kobo_id` — re-running never duplicates,
  and edits made in Kobo re-sync over the old row with `--full`.
- Invalid submissions are logged and skipped, never crash the run.

## Safeguarding notes (records of minors)

- RLS is enabled with **no public policies**: the anon key can read nothing; only the
  service key (server-side) writes.
- The form requires explicit guardian consent before submission is allowed.
- Kobo projects can be restricted to specific enumerator accounts; do that before
  real data collection, and delete demo submissions afterwards.

## Production path (out of POC scope)

Swap the polling script for Kobo's **REST Services** (Settings → REST Services on the
form) pointed at a Supabase Edge Function for real-time push; schedule the poller with
cron as a belt-and-braces backfill; add a `coaches` table fed the same way from a
Centre In-charge form.
