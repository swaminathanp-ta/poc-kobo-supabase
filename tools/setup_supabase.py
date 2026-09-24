#!/usr/bin/env python3
"""
BVL POC — Supabase setup, in pure Python
========================================
Creates (or connects to) a Supabase project, applies the SQL migrations, and
writes a ready-to-use .env file — using only the Supabase Management REST API.

No CLI, no Docker, no tarball. Runs identically on Windows, WSL, macOS, Linux.
Only dependency: requests.

------------------------------------------------------------------------------
ONE-TIME PREREQUISITE
------------------------------------------------------------------------------
Create a Personal Access Token at https://supabase.com/dashboard/account/tokens
then either export it or let this script prompt you for it:

    export SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxx        # Linux / macOS / WSL
    $env:SUPABASE_ACCESS_TOKEN = "sbp_xxxxxxxx"      # Windows PowerShell

------------------------------------------------------------------------------
USAGE
------------------------------------------------------------------------------
    python setup_supabase.py --list                    # show orgs and projects
    python setup_supabase.py --new "BVL Registration"  # create + set up
    python setup_supabase.py --link <project-ref>      # use an existing project

--link is also how you re-apply migrations after editing them, or regenerate
a lost .env — it is safe to run repeatedly.

Migrations are read from supabase/migrations/*.sql in filename order. They are
written to be idempotent, so re-running is safe.
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
import secrets
import string
import sys
import time
from pathlib import Path

import requests

API_ROOT = "https://api.supabase.com/v1"
DEFAULT_REGION = "ap-south-1"          # Mumbai — closest to Assam
PROVISION_TIMEOUT = 300                # seconds to wait for a new database


def find_project_root() -> Path:
    """Locate the project root by walking up from this file.

    This script may live at the repo root or under tools/, so paths must not
    be relative to __file__'s own directory. We anchor on pyproject.toml (or
    the migrations folder) instead, which makes the layout free to change.
    """
    for candidate in [Path.cwd(), *Path(__file__).resolve().parents]:
        for marker in ("pyproject.toml", "supabase/migrations"):
            if (candidate / marker).exists():
                return candidate
    return Path(__file__).resolve().parent


PROJECT_DIR = find_project_root()
MIGRATIONS_DIR = PROJECT_DIR / "supabase" / "migrations"
ENV_FILE = PROJECT_DIR / ".env"
PASSWORD_FILE = PROJECT_DIR / ".db_password"


# ==========================================================================
# Small output helpers — keep the console readable
# ==========================================================================
def step(msg: str) -> None:
    print(f"\n==> {msg}", flush=True)


def info(msg: str) -> None:
    print(f"    {msg}", flush=True)


def fail(msg: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"\nERROR: {msg}", file=sys.stderr)
    sys.exit(1)


# ==========================================================================
# Management API client
# ==========================================================================
class Supabase:
    """Thin wrapper over the Supabase Management API.

    Every method maps to exactly one documented endpoint, so the mapping
    between this code and the API reference stays obvious.
    """

    def __init__(self, token: str) -> None:
        self.session = requests.Session()
        self.session.headers.update(
            {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        )

    def _request(self, method: str, path: str, soft: bool = False, **kwargs):
        """Call the Management API.

        soft=True is for calls we'd like but can live without — a scoped
        access token may be refused (403) on some endpoints while still
        being able to do the work that matters. Those return None instead
        of ending the run.
        """
        response = self.session.request(method, f"{API_ROOT}{path}", timeout=60, **kwargs)
        if response.status_code == 401:
            if soft:
                return None
            fail("Access token rejected (401). Generate a new one at\n"
                 "       https://supabase.com/dashboard/account/tokens")
        if response.status_code == 403 and not soft:
            fail(f"{method} {path} returned 403 — this token lacks the privileges for that\n"
                 "       endpoint. If you created a scoped token, generate a full-access one at\n"
                 "       https://supabase.com/dashboard/account/tokens")
        if response.status_code >= 400:
            if soft:
                return None
            fail(f"{method} {path} returned {response.status_code}:\n       {response.text[:400]}")
        return response.json() if response.content else None

    # -- organisations -----------------------------------------------------
    def list_organizations(self) -> list[dict]:
        """GET /v1/organizations"""
        return self._request("GET", "/organizations")

    # -- projects ----------------------------------------------------------
    def list_projects(self) -> list[dict]:
        """GET /v1/projects"""
        return self._request("GET", "/projects")

    def create_project(self, name: str, org_slug: str, db_password: str, region: str) -> dict:
        """POST /v1/projects

        `region` is marked deprecated in favour of `region_selection`, but is
        still accepted; if a future API version rejects it we retry without,
        letting Supabase choose a default region.
        """
        body = {
            "name": name,
            "organization_slug": org_slug,
            "db_pass": db_password,
            "region": region,
        }
        response = self.session.post(f"{API_ROOT}/projects", json=body, timeout=60)
        if response.status_code >= 400 and "region" in response.text.lower():
            info("Region field rejected — retrying with the account default.")
            body.pop("region")
            response = self.session.post(f"{API_ROOT}/projects", json=body, timeout=60)
        if response.status_code >= 400:
            fail(f"Could not create project ({response.status_code}):\n       {response.text[:400]}")
        return response.json()

    def get_project(self, ref: str, soft: bool = False) -> dict | None:
        """GET /v1/projects/{ref}"""
        return self._request("GET", f"/projects/{ref}", soft=soft)

    def find_project(self, ref: str) -> dict | None:
        """The same information, via the list endpoint.

        Some tokens can list projects but not read one directly, so this is
        the fallback when GET /projects/{ref} is refused.
        """
        for project in self.list_projects() or []:
            if project.get("id") == ref or project.get("ref") == ref:
                return project
        return None

    # -- keys --------------------------------------------------------------
    def get_api_keys(self, ref: str) -> list[dict]:
        """GET /v1/projects/{ref}/api-keys

        Returns both legacy JWT keys (anon / service_role) and, on newer
        projects, the replacement sb_publishable_ / sb_secret_ keys.
        """
        try:
            return self._request("GET", f"/projects/{ref}/api-keys?reveal=true") or []
        except SystemExit:
            return self._request("GET", f"/projects/{ref}/api-keys") or []

    # -- SQL ---------------------------------------------------------------
    def run_sql(self, ref: str, sql: str) -> list:
        """POST /v1/projects/{ref}/database/query"""
        return self._request("POST", f"/projects/{ref}/database/query", json={"query": sql})


# ==========================================================================
# Workflow steps
# ==========================================================================
def read_env_file() -> dict[str, str]:
    """Parse .env into a dict. Returns {} if the file does not exist."""
    values: dict[str, str] = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def save_token_to_env(token: str) -> None:
    """Append the access token to .env so future runs don't prompt."""
    existing = read_env_file()
    if existing.get("SUPABASE_ACCESS_TOKEN"):
        return
    with ENV_FILE.open("a", encoding="utf-8") as handle:
        if ENV_FILE.stat().st_size > 0:
            handle.write("\n")
        handle.write("# Account-level token for the Management API (setup only).\n")
        handle.write(f"SUPABASE_ACCESS_TOKEN={token}\n")
    try:
        ENV_FILE.chmod(0o600)
    except OSError:
        pass
    info(f"token saved to {ENV_FILE.name} — future runs won't ask")


def get_access_token() -> str:
    """Resolve the token from, in order: environment, .env, interactive prompt."""
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if token:
        return token.strip()

    token = read_env_file().get("SUPABASE_ACCESS_TOKEN")
    if token:
        info(f"using SUPABASE_ACCESS_TOKEN from {ENV_FILE.name}")
        return token

    print("\nNo SUPABASE_ACCESS_TOKEN found in the environment or .env")
    print("Create one at: https://supabase.com/dashboard/account/tokens")
    token = getpass.getpass("Paste your Personal Access Token (hidden): ").strip()
    if not token:
        fail("No token supplied.")
    if input(f"Save it to {ENV_FILE.name} so this stops asking? [Y/n] ").strip().lower() in ("", "y", "yes"):
        save_token_to_env(token)
    return token


def generate_db_password(length: int = 28) -> str:
    """Strong password, restricted to characters that survive connection
    strings and shell quoting without escaping."""
    alphabet = string.ascii_letters + string.digits + "-_"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def choose_organization(client: Supabase) -> str:
    orgs = client.list_organizations()
    if not orgs:
        fail("No organizations on this account. Create one in the Supabase dashboard first.")
    if len(orgs) == 1:
        info(f"Using organization: {orgs[0]['name']}")
        return orgs[0]["slug"]
    print("\nYour organizations:")
    for i, org in enumerate(orgs, 1):
        print(f"  {i}. {org['name']}  ({org['slug']})")
    while True:
        choice = input("Choose one by number: ").strip()
        if choice.isdigit() and 1 <= int(choice) <= len(orgs):
            return orgs[int(choice) - 1]["slug"]
        print("  Not a valid choice.")


def resolve_project_ref(client: Supabase, value: str) -> str:
    """Accept either a project reference id or a project name.

    Refs are 20-character lowercase strings; anything else is treated as a
    name and looked up, so `--link "BVL Registration"` works as expected.
    """
    if re.fullmatch(r"[a-z]{20}", value):
        return value

    matches = [p for p in client.list_projects() if p.get("name") == value]
    if not matches:
        matches = [p for p in client.list_projects()
                   if value.lower() in str(p.get("name", "")).lower()]
    if not matches:
        fail(f"No project named '{value}'. Run --list to see what exists.")
    if len(matches) > 1:
        names = "\n       ".join(f"{p['name']} (ref={p['id']})" for p in matches)
        fail(f"'{value}' matches more than one project — pass the ref instead:\n       {names}")

    info(f"resolved '{value}' to ref {matches[0]['id']}")
    return matches[0]["id"]


def wait_until_ready(client: Supabase, ref: str) -> None:
    """Poll the project until Supabase reports its database is healthy."""
    step(f"Waiting for the database to finish provisioning (up to {PROVISION_TIMEOUT // 60} min)")
    deadline = time.monotonic() + PROVISION_TIMEOUT
    last_status = ""
    while time.monotonic() < deadline:
        details = client.get_project(ref, soft=True) or client.find_project(ref)
        if details is None:
            info("Cannot read project status with this token — waiting 90s instead.")
            time.sleep(90)
            return
        status = details.get("status", "UNKNOWN")
        if status != last_status:
            info(f"status: {status}")
            last_status = status
        if status == "ACTIVE_HEALTHY":
            return
        if "FAILED" in status:
            fail(f"Provisioning failed with status {status}. Check the Supabase dashboard.")
        time.sleep(10)
    fail(f"Timed out waiting for the database. It may still come up — "
         f"re-run with --link {ref} in a few minutes.")


def load_migrations() -> list[tuple[str, str]]:
    if not MIGRATIONS_DIR.is_dir():
        fail(f"No migrations directory at {MIGRATIONS_DIR}")
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not files:
        fail(f"No .sql files found in {MIGRATIONS_DIR}")
    return [(f.name, f.read_text(encoding="utf-8")) for f in files]


def apply_migrations(client: Supabase, ref: str) -> None:
    step("Applying migrations")
    for name, sql in load_migrations():
        info(f"{name} ...")
        client.run_sql(ref, sql)
        info(f"{name} OK")


def verify(client: Supabase, ref: str) -> None:
    step("Verifying")
    centres = client.run_sql(ref, "select count(*)::int as n from centres;")
    players = client.run_sql(ref, "select count(*)::int as n from players;")
    n_centres = centres[0]["n"] if centres else 0
    n_players = players[0]["n"] if players else 0
    info(f"centres table: {n_centres} row(s)")
    info(f"players table: {n_players} row(s)")
    if n_centres == 0:
        fail("The centre seed did not land — check the migration output above.")


def pick_secret_key(keys: list[dict]) -> str | None:
    """Prefer a new-format secret key, else the legacy service_role key."""
    for key in keys:
        if str(key.get("api_key", "")).startswith("sb_secret_"):
            return key["api_key"]
    for key in keys:
        if key.get("name") == "service_role" or key.get("type") == "legacy":
            if key.get("api_key"):
                return key["api_key"]
    return None


def write_env_file(project_ref: str, secret_key: str) -> None:
    """Write .env, preserving the access token already there."""
    existing = read_env_file()

    content = f"""# Written by setup_supabase.py — do not commit this file.
SUPABASE_URL=https://{project_ref}.supabase.co
SUPABASE_SERVICE_KEY={secret_key}
"""
    if existing.get("SUPABASE_ACCESS_TOKEN"):
        content += ("\n# Account-level token for the Management API (setup only).\n"
                    f"SUPABASE_ACCESS_TOKEN={existing['SUPABASE_ACCESS_TOKEN']}\n")
    ENV_FILE.write_text(content, encoding="utf-8")
    try:
        ENV_FILE.chmod(0o600)
    except OSError:
        pass       # Windows filesystems may not support this
    info(f"wrote {ENV_FILE.name}")


# ==========================================================================
# Entry point
# ==========================================================================
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Set up the BVL Supabase project (pure Python, no CLI).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--new", metavar="NAME", help="create a new project with this name")
    group.add_argument("--link", metavar="REF_OR_NAME",
                       help="use an existing project, by reference id or by name")
    group.add_argument("--list", action="store_true", help="list organizations and projects, then exit")
    parser.add_argument("--region", default=DEFAULT_REGION, help=f"region for --new (default: {DEFAULT_REGION})")
    args = parser.parse_args()

    client = Supabase(get_access_token())

    # ---- --list ----------------------------------------------------------
    if args.list:
        step("Organizations")
        for org in client.list_organizations():
            print(f"    {org['name']:<30} slug={org['slug']}")
        step("Projects")
        for project in client.list_projects():
            print(f"    {project['name']:<30} ref={project['id']}  "
                  f"region={project.get('region', '?')}  status={project.get('status', '?')}")
        return

    # ---- --new -----------------------------------------------------------
    if args.new:
        org_slug = choose_organization(client)
        password = generate_db_password()

        step(f"Creating project '{args.new}' in {args.region}")
        project = client.create_project(args.new, org_slug, password, args.region)
        project_ref = project.get("ref") or project.get("id")
        if not project_ref:
            fail(f"Project created but no reference returned: {project}")
        info(f"project ref: {project_ref}")

        PASSWORD_FILE.write_text(password + "\n", encoding="utf-8")
        try:
            PASSWORD_FILE.chmod(0o600)
        except OSError:
            pass
        info(f"database password saved to {PASSWORD_FILE.name} — keep it, "
             "Supabase will not show it again")

        wait_until_ready(client, project_ref)
    else:
        project_ref = resolve_project_ref(client, args.link)
        step(f"Using existing project {project_ref}")
        # Cosmetic only — never let it stop the run.
        details = client.get_project(project_ref, soft=True) or client.find_project(project_ref)
        info(f"name: {(details or {}).get('name', '(not readable with this token)')}")

    # ---- shared path -----------------------------------------------------
    apply_migrations(client, project_ref)
    verify(client, project_ref)

    step("Fetching API keys")
    secret_key = pick_secret_key(client.get_api_keys(project_ref))
    if not secret_key:
        info("Could not read a secret key automatically.")
        info(f"Copy it from https://supabase.com/dashboard/project/{project_ref}/settings/api-keys")
        secret_key = getpass.getpass("Paste the service_role / sb_secret_ key (hidden): ").strip()

    write_env_file(project_ref, secret_key)

    print(f"""
--------------------------------------------------------------------------
Done.

  Project URL : https://{project_ref}.supabase.co
  Dashboard   : https://supabase.com/dashboard/project/{project_ref}
  Credentials : .env  (git-ignored)

Next:
  Put the project URL and its publishable key in pwa/config.js
  (see pwa/README.md).
--------------------------------------------------------------------------""")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\nCancelled.")
    except requests.RequestException as exc:
        fail(f"Network problem talking to api.supabase.com: {exc}")
