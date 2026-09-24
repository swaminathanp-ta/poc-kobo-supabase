# BVL Player Registration POC — PWA → Supabase

Proof of concept for the Tier-2 "Digital Registration Flow" from the BVL AI-for-Good
roadmap: a validated, offline-capable registration app (a PWA) feeding a central
Postgres source of truth (Supabase).

The form enforces at the point of entry the exact data-quality problems found in the
current ledgers: one standard `sex` code (vs 13 variants), a fixed performance-level
vocabulary (vs 6+ "Beginner" spellings), plausible heights (100–220 cm), valid dates,
and — critically — a **centre chosen from the real registry of 141 BVL centres**
(district → centre cascade), so every player row joins cleanly to its centre.

> The original KoboToolbox pipeline (sync script, webhook, XLSForm) was retired once
> the PWA covered the same ground. It is preserved at the git tag `kobo-archive`.

## Project layout

| File | Purpose |
|---|---|
| `pwa/` | The registration app — see [pwa/README.md](pwa/README.md) |
| `pwa/admin/` | Admin dashboard (sign-in, charts, player and centre tables) — see [DEPLOYMENT.md](DEPLOYMENT.md#the-admin-dashboard) |
| `supabase/migrations/*.sql` | Versioned schema, centre seed and PWA policies |
| `supabase/sql/*.sql` | Standalone SQL copies for the dashboard SQL Editor |
| `tools/setup_supabase.py` | One-time Supabase bootstrap via the Management API |
| `tools/setup_supabase.sh` | Same job via the Supabase CLI; kept for `--local` Docker development |
| `tools/dashboard.py` | Local dashboard over the registrations (uses the secret key, never in a browser) |
| `.env.example` | Template for the Supabase settings the tools need |

## Setup

### 1. Supabase — pick one of two paths

**Path A — scripted (recommended). Pure Python, no Supabase CLI to install:**

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...      # from the dashboard, see below

uv run python tools/setup_supabase.py --list                    # show your orgs and projects
uv run python tools/setup_supabase.py --new "BVL Registration"  # create + migrate + write .env
uv run python tools/setup_supabase.py --link <project-ref>      # use an existing project
```

`tools/setup_supabase.py` talks to the [Supabase Management API](https://supabase.com/docs/reference/api/introduction)
over plain HTTPS — it creates the project, waits for the database, applies every file in
`supabase/migrations/`, verifies the seed landed, fetches the API key, and writes `.env`.
It runs identically on Windows, WSL, macOS and Linux.

The only browser step is creating the account and a
[Personal Access Token](https://supabase.com/dashboard/account/tokens). If you don't export
the token, the script prompts for it.

**Path B — dashboard (no CLI):** create a project at [supabase.com](https://supabase.com),
open **SQL Editor**, and run the files in `supabase/migrations/` in filename order.

> **Key formats:** Supabase is migrating from the legacy JWT `anon` / `service_role` keys to
> `sb_publishable_...` / `sb_secret_...` keys. The PWA uses the **publishable** key; the
> tools in `tools/` use the **secret** key, server-side only.

### 2. The PWA

Put the project URL and publishable key in `pwa/config.js`, then deploy — see
[pwa/README.md](pwa/README.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

### 3. Demo

Register a player in the app, then in Supabase:

```sql
select * from players_clean order by sl_no desc limit 10;
```

## Safeguarding notes (records of minors)

- Row level security is on. The publishable key shipped in the PWA can insert a
  registration and read the centre list — nothing else. It cannot read, change or
  delete any player's record.
- Guardian consent is required by the database policy, not only by the form.
- Only the secret key (server-side tools) can read player records. It must never
  reach a browser.
