#!/usr/bin/env python3
"""
BVL POC — KoboToolbox -> Supabase sync
======================================
Pulls player-registration submissions from the KoboToolbox API (v2) and
upserts them into the Supabase `players` table via PostgREST.

Idempotent: each Kobo submission is keyed by its numeric `_id`
(unique in the `players.kobo_id` column), so re-running never duplicates.
Incremental: the last synced `_id` is kept in .sync_state.json and only
newer submissions are fetched on the next run.

Configuration comes from a .env file next to this script (written for you by
setup_supabase.sh) or from real environment variables, which take precedence:

    KOBO_TOKEN=...            # Kobo: Account Settings -> Security -> API Key
    KOBO_ASSET_UID=...        # from the form URL: /forms/<asset_uid>/...
    SUPABASE_URL=https://<project-ref>.supabase.co
    SUPABASE_SERVICE_KEY=...  # service_role or sb_secret_... key (server-side only!)
    KOBO_BASE_URL=https://kf.kobotoolbox.org   # optional; default shown

Usage:
    python kobo_to_supabase.py            # one sync pass
    python kobo_to_supabase.py --loop 300 # poll every 5 minutes
    python kobo_to_supabase.py --full     # ignore saved state, re-sync everything
    python kobo_to_supabase.py --check    # verify connectivity to both ends, then exit

Dependencies: pip install requests
"""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bvl-sync")

STATE_FILE = Path(__file__).with_name(".sync_state.json")
BATCH_SIZE = 100          # rows per Supabase upsert call
KOBO_PAGE_LIMIT = 500     # submissions per Kobo API page


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
def load_dotenv() -> None:
    """Minimal .env loader (no external dependency). Real env vars win."""
    env_file = Path(__file__).with_name(".env")
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


ENV_NAMES = {
    "kobo_base": "KOBO_BASE_URL",
    "kobo_token": "KOBO_TOKEN",
    "asset_uid": "KOBO_ASSET_UID",
    "supabase_url": "SUPABASE_URL",
    "supabase_key": "SUPABASE_SERVICE_KEY",
}


def get_config() -> dict:
    load_dotenv()
    cfg = {
        "kobo_base": os.environ.get("KOBO_BASE_URL", "https://kf.kobotoolbox.org").rstrip("/"),
        "kobo_token": os.environ.get("KOBO_TOKEN"),
        "asset_uid": os.environ.get("KOBO_ASSET_UID"),
        "supabase_url": (os.environ.get("SUPABASE_URL") or "").rstrip("/"),
        "supabase_key": os.environ.get("SUPABASE_SERVICE_KEY"),
    }
    missing = [ENV_NAMES[k] for k, v in cfg.items() if not v]
    if missing:
        sys.exit(
            "Missing required settings: " + ", ".join(missing)
            + "\nAdd them to .env (see README) or export them as environment variables."
        )
    return cfg


def supabase_headers(cfg: dict) -> dict:
    """Supabase accepts both the legacy JWT `service_role` key and the newer
    `sb_secret_...` keys. New keys are not JWTs and may only appear in an
    Authorization header when identical to the apikey header — which is the
    case here, so sending both is safe for either key format."""
    key = cfg["supabase_key"]
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


# --------------------------------------------------------------------------
# Kobo side
# --------------------------------------------------------------------------
def fetch_submissions(cfg: dict, since_id: int) -> list[dict]:
    """Fetch all submissions with _id > since_id, following pagination."""
    url = f"{cfg['kobo_base']}/api/v2/assets/{cfg['asset_uid']}/data.json"
    headers = {"Authorization": f"Token {cfg['kobo_token']}"}
    params = {
        "query": json.dumps({"_id": {"$gt": since_id}}),
        "limit": KOBO_PAGE_LIMIT,
        "sort": json.dumps({"_id": 1}),
    }
    results: list[dict] = []
    while url:
        resp = requests.get(url, headers=headers, params=params, timeout=60)
        resp.raise_for_status()
        payload = resp.json()
        results.extend(payload.get("results", []))
        url = payload.get("next")     # absolute URL for the next page (params baked in)
        params = None
    return results


def _field(sub: dict, name: str):
    """Kobo prefixes answers with the group path, e.g. 'registration/player_name'.
    Match on the leaf name so the mapping survives form-structure tweaks."""
    for key, value in sub.items():
        if key == name or key.endswith("/" + name):
            return value
    return None


def transform(sub: dict) -> dict | None:
    """Map one Kobo submission JSON to a `players` row. Returns None if invalid."""
    try:
        levels = (_field(sub, "performance") or "").split()   # select_multiple -> space-separated
        row = {
            "kobo_id": sub["_id"],
            "kobo_uuid": sub.get("_uuid"),
            "player_name": (_field(sub, "player_name") or "").strip(),
            "sex": _field(sub, "sex"),
            "dob": _field(sub, "dob"),
            "height_cm": int(_field(sub, "height_cm")) if _field(sub, "height_cm") else None,
            "joining_date": _field(sub, "joining_date"),
            "performance_levels": levels,
            "achievements": (_field(sub, "achievements") or None),
            "centre_code": _field(sub, "centre"),
            "district": _field(sub, "district"),
            "guardian_consent": _field(sub, "guardian_consent") == "yes",
            "submitted_at": sub.get("_submission_time"),
            "raw_submission": sub,
        }
        if not (row["player_name"] and row["sex"] and row["dob"] and row["centre_code"]):
            raise ValueError("missing required field")
        return row
    except (KeyError, ValueError, TypeError) as exc:
        log.warning("Skipping submission _id=%s: %s", sub.get("_id"), exc)
        return None


# --------------------------------------------------------------------------
# Supabase side (PostgREST upsert — no extra SDK needed)
# --------------------------------------------------------------------------
def upsert_players(cfg: dict, rows: list[dict]) -> None:
    url = f"{cfg['supabase_url']}/rest/v1/players?on_conflict=kobo_id"
    headers = supabase_headers(cfg) | {"Prefer": "resolution=merge-duplicates,return=minimal"}
    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i : i + BATCH_SIZE]
        resp = requests.post(url, headers=headers, json=batch, timeout=60)
        if resp.status_code >= 400:
            raise RuntimeError(f"Supabase upsert failed ({resp.status_code}): {resp.text[:500]}")
        log.info("Upserted %d row(s) into players", len(batch))


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------
def load_state() -> int:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text()).get("last_kobo_id", 0)
    return 0


def watermark_from_db(cfg: dict) -> int:
    """Highest kobo_id already in Supabase.

    Used instead of the local state file when running somewhere stateless —
    a GitHub Actions runner has no .sync_state.json between runs. The database
    is the more reliable source of truth anyway, since it reflects what the
    webhook inserted too.
    """
    resp = requests.get(
        f"{cfg['supabase_url']}/rest/v1/players",
        headers=supabase_headers(cfg),
        params={"select": "kobo_id", "order": "kobo_id.desc", "limit": 1},
        timeout=30,
    )
    resp.raise_for_status()
    rows = resp.json()
    return rows[0]["kobo_id"] if rows else 0


def save_state(last_id: int) -> None:
    STATE_FILE.write_text(json.dumps({"last_kobo_id": last_id, "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S")}))


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def sync_once(cfg: dict, full: bool = False, from_db: bool = False) -> None:
    if full:
        since = 0
    elif from_db:
        since = watermark_from_db(cfg)
        log.info("Watermark from database: kobo_id > %d", since)
    else:
        since = load_state()
    log.info("Fetching Kobo submissions with _id > %d ...", since)
    subs = fetch_submissions(cfg, since)
    if not subs:
        log.info("No new submissions.")
        return
    log.info("Fetched %d submission(s).", len(subs))

    rows = [r for r in (transform(s) for s in subs) if r]
    skipped = len(subs) - len(rows)
    if skipped:
        log.warning("%d submission(s) skipped as invalid (see warnings above).", skipped)
    if rows:
        upsert_players(cfg, rows)

    if not from_db:
        save_state(max(s["_id"] for s in subs))
    log.info("Sync complete: %d synced, %d skipped.", len(rows), skipped)


def check(cfg: dict) -> int:
    """Preflight: confirm both ends are reachable and correctly configured."""
    ok = True

    try:
        r = requests.get(
            f"{cfg['kobo_base']}/api/v2/assets/{cfg['asset_uid']}/data.json",
            headers={"Authorization": f"Token {cfg['kobo_token']}"},
            params={"limit": 1},
            timeout=30,
        )
        r.raise_for_status()
        log.info("Kobo OK — form reachable, %s submission(s) so far", r.json().get("count", "?"))
    except Exception as exc:
        log.error("Kobo FAILED: %s", exc)
        ok = False

    try:
        r = requests.get(
            f"{cfg['supabase_url']}/rest/v1/centres",
            headers=supabase_headers(cfg),
            params={"select": "centre_code", "limit": 1},
            timeout=30,
        )
        r.raise_for_status()
        log.info("Supabase OK — centres table reachable")
    except Exception as exc:
        log.error("Supabase FAILED: %s", exc)
        ok = False

    log.info("Preflight %s", "PASSED" if ok else "FAILED")
    return 0 if ok else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync Kobo registrations into Supabase")
    parser.add_argument("--loop", type=int, metavar="SECONDS", help="poll continuously at this interval")
    parser.add_argument("--full", action="store_true", help="ignore saved state and re-sync everything")
    parser.add_argument("--check", action="store_true", help="verify connectivity to both ends, then exit")
    parser.add_argument("--from-db", action="store_true",
                        help="read the watermark from Supabase rather than the local state "
                             "file; use when running stateless, e.g. in CI")
    args = parser.parse_args()

    cfg = get_config()
    if args.check:
        sys.exit(check(cfg))
    if args.loop:
        log.info("Polling every %d s. Ctrl-C to stop.", args.loop)
        while True:
            try:
                sync_once(cfg, full=args.full, from_db=args.from_db)
                args.full = False      # only the first pass is full
            except Exception:
                log.exception("Sync pass failed; retrying next cycle.")
            time.sleep(args.loop)
    else:
        sync_once(cfg, full=args.full, from_db=args.from_db)


if __name__ == "__main__":
    main()
