#!/usr/bin/env python3
"""
BVL — local admin dashboard
===========================
A single-page view of every registered player, read live from Supabase.

Run it:
    uv run python tools/dashboard.py
    # then open http://127.0.0.1:8080

Why a local server rather than a static HTML file:
    Reading `players` requires the Supabase secret key, which bypasses row
    level security on records of minors. That key must never reach a browser.
    Here it stays in this process — the browser receives rendered rows and
    nothing else — and the server binds to 127.0.0.1, so it is not reachable
    from the network.

Options:
    --port 8080      port to listen on
    --limit 5000     maximum rows to pull from Supabase
"""

from __future__ import annotations

import argparse
import html
import json
import os
import sys
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import requests

PROJECT_DIR = next(
    (p for p in [Path.cwd(), *Path(__file__).resolve().parents]
     if (p / "pyproject.toml").exists() or (p / "supabase" / "migrations").exists()),
    Path(__file__).resolve().parent,
)
ENV_FILE = PROJECT_DIR / ".env"


def load_config() -> dict:
    """Read Supabase credentials from the environment, falling back to .env."""
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

    url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY (checked the environment and .env)")
    return {"url": url, "key": key}


def fetch_rows(cfg: dict, limit: int) -> list[dict]:
    """Pull the joined registration view. Falls back to the raw players table
    if the view is missing, so an older database still renders."""
    headers = {"apikey": cfg["key"], "Authorization": f"Bearer {cfg['key']}"}
    for source, params in (
        ("v_registrations", {"select": "*", "order": "submitted_at.desc.nullslast", "limit": limit}),
        ("players", {"select": "*", "order": "synced_at.desc", "limit": limit}),
    ):
        resp = requests.get(f"{cfg['url']}/rest/v1/{source}",
                            headers=headers, params=params, timeout=60)
        if resp.ok:
            return resp.json()
        if resp.status_code not in (404, 400):
            raise RuntimeError(f"Supabase {resp.status_code}: {resp.text[:300]}")
    raise RuntimeError("Neither v_registrations nor players could be read.")


COLUMNS = [
    ("player_name", "Player"),
    ("sex", "Sex"),
    ("age_years", "Age"),
    ("dob", "Date of birth"),
    ("height_cm", "Height"),
    ("performance", "Level"),
    ("centre_name", "Centre"),
    ("district", "District"),
    ("joining_date", "Joined"),
    ("submitted_at", "Registered"),
]


def summarise(rows: list[dict]) -> dict:
    total = len(rows)
    girls = sum(1 for r in rows if str(r.get("sex", "")).upper().startswith("F"))
    centres = len({r.get("centre_name") or r.get("centre_code") for r in rows if
                   r.get("centre_name") or r.get("centre_code")})
    districts = len({r.get("district") for r in rows if r.get("district")})
    return {
        "total": total,
        "girls_pct": round(girls / total * 100) if total else 0,
        "centres": centres,
        "districts": districts,
    }


def render(rows: list[dict], error: str | None = None) -> str:
    stats = summarise(rows)
    fetched = datetime.now(timezone.utc).astimezone().strftime("%d %b %Y, %H:%M")
    payload = json.dumps(rows, default=str)
    cols = json.dumps([c[0] for c in COLUMNS])
    heads = json.dumps([c[1] for c in COLUMNS])
    banner = (f'<p class="error">{html.escape(error)}</p>' if error else "")

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BVL Player Registrations</title>
<style>
  :root {{
    --navy: #12284c; --orange: #e8621f;
    --bg: #f6f7f9; --surface: #ffffff; --border: #e2e5ea;
    --ink: #16202e; --ink-2: #5a6675; --ink-3: #8a94a1;
    --row-hover: #f0f4f9;
  }}
  @media (prefers-color-scheme: dark) {{
    :root:not([data-theme="light"]) {{
      --navy: #dbe4f0; --orange: #ff8b4d;
      --bg: #10151c; --surface: #171d26; --border: #2a323d;
      --ink: #e8edf3; --ink-2: #9aa6b4; --ink-3: #6d7885;
      --row-hover: #1e262f;
    }}
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }}
  header {{ background: var(--navy); color: #fff; padding: 18px 24px;
    display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }}
  @media (prefers-color-scheme: dark) {{
    :root:not([data-theme="light"]) header {{ background: var(--surface);
      color: var(--ink); border-bottom: 1px solid var(--border); }}
  }}
  header h1 {{ font-size: 17px; margin: 0; font-weight: 650; letter-spacing: .01em; }}
  header .sub {{ font-size: 12.5px; opacity: .75; }}
  main {{ padding: 20px 24px 48px; max-width: 1400px; margin: 0 auto; }}
  .tiles {{ display: grid; gap: 12px; margin-bottom: 20px;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }}
  .tile {{ background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 16px; }}
  .tile .n {{ font-size: 26px; font-weight: 680; letter-spacing: -.02em;
    font-variant-numeric: tabular-nums; }}
  .tile .l {{ font-size: 12px; color: var(--ink-2); margin-top: 2px; }}
  .bar {{ display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; align-items: center; }}
  input, select {{ font: inherit; padding: 8px 11px; border: 1px solid var(--border);
    border-radius: 8px; background: var(--surface); color: var(--ink); }}
  input:focus, select:focus {{ outline: 2px solid var(--orange); outline-offset: -1px; }}
  #q {{ flex: 1 1 240px; min-width: 200px; }}
  .count {{ color: var(--ink-2); font-size: 12.5px; margin-left: auto; }}
  .wrap {{ background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; overflow-x: auto; }}
  table {{ border-collapse: collapse; width: 100%; font-size: 13.5px; }}
  th {{ text-align: left; font-weight: 600; font-size: 12px; letter-spacing: .03em;
    text-transform: uppercase; color: var(--ink-2); padding: 11px 14px;
    border-bottom: 1px solid var(--border); cursor: pointer; white-space: nowrap;
    position: sticky; top: 0; background: var(--surface); }}
  th:hover {{ color: var(--ink); }}
  th .arrow {{ color: var(--orange); }}
  td {{ padding: 10px 14px; border-bottom: 1px solid var(--border); white-space: nowrap; }}
  tbody tr:last-child td {{ border-bottom: none; }}
  tbody tr:hover {{ background: var(--row-hover); }}
  td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  td.name {{ font-weight: 550; white-space: normal; min-width: 160px; }}
  .empty {{ padding: 40px; text-align: center; color: var(--ink-2); }}
  .error {{ background: #fdecea; border: 1px solid #f5c2bc; color: #8c2318;
    padding: 10px 14px; border-radius: 8px; margin: 0 0 16px; }}
  footer {{ color: var(--ink-3); font-size: 12px; margin-top: 14px; }}
</style>
</head>
<body>
<header>
  <h1>BVL Player Registrations</h1>
  <span class="sub">live from Supabase &middot; fetched {fetched}</span>
</header>
<main>
  {banner}
  <section class="tiles">
    <div class="tile"><div class="n">{stats['total']:,}</div><div class="l">Players registered</div></div>
    <div class="tile"><div class="n">{stats['girls_pct']}%</div><div class="l">Girls</div></div>
    <div class="tile"><div class="n">{stats['centres']}</div><div class="l">Centres represented</div></div>
    <div class="tile"><div class="n">{stats['districts']}</div><div class="l">Districts</div></div>
  </section>

  <div class="bar">
    <input id="q" type="search" placeholder="Search name, centre, district&hellip;" autocomplete="off">
    <select id="district"><option value="">All districts</option></select>
    <select id="sex">
      <option value="">All</option><option value="M">Male</option><option value="F">Female</option>
    </select>
    <span class="count" id="count"></span>
  </div>

  <div class="wrap">
    <table>
      <thead><tr id="head"></tr></thead>
      <tbody id="body"></tbody>
    </table>
    <div class="empty" id="empty" hidden>No players match that filter.</div>
  </div>
  <footer>Reload the page to refresh. Showing at most 500 rows at a time.</footer>
</main>

<script>
const ROWS = {payload};
const COLS = {cols};
const HEADS = {heads};
const NUMERIC = new Set(["age_years", "height_cm"]);
const MAX_RENDER = 500;
let sortCol = null, sortDir = 1;

const head = document.getElementById("head");
HEADS.forEach((label, i) => {{
  const th = document.createElement("th");
  th.textContent = label;
  th.onclick = () => {{
    if (sortCol === COLS[i]) sortDir = -sortDir; else {{ sortCol = COLS[i]; sortDir = 1; }}
    draw();
  }};
  head.appendChild(th);
}});

const districts = [...new Set(ROWS.map(r => r.district).filter(Boolean))].sort();
const dsel = document.getElementById("district");
districts.forEach(d => {{
  const o = document.createElement("option"); o.value = o.textContent = d; dsel.appendChild(o);
}});

function current() {{
  const q = document.getElementById("q").value.trim().toLowerCase();
  const d = dsel.value, s = document.getElementById("sex").value;
  let out = ROWS.filter(r => {{
    if (d && r.district !== d) return false;
    if (s && !String(r.sex || "").toUpperCase().startsWith(s)) return false;
    if (!q) return true;
    return COLS.some(c => String(r[c] ?? "").toLowerCase().includes(q));
  }});
  if (sortCol) {{
    out = out.slice().sort((a, b) => {{
      let x = a[sortCol], y = b[sortCol];
      if (NUMERIC.has(sortCol)) {{ x = Number(x) || 0; y = Number(y) || 0; return (x - y) * sortDir; }}
      return String(x ?? "").localeCompare(String(y ?? "")) * sortDir;
    }});
  }}
  return out;
}}

function draw() {{
  const rows = current();
  const shown = rows.slice(0, MAX_RENDER);
  document.getElementById("count").textContent =
    rows.length === ROWS.length
      ? `${{ROWS.length.toLocaleString()}} players`
      : `${{rows.length.toLocaleString()}} of ${{ROWS.length.toLocaleString()}}`;

  head.querySelectorAll("th").forEach((th, i) => {{
    const on = COLS[i] === sortCol;
    th.innerHTML = HEADS[i] + (on ? ` <span class="arrow">${{sortDir > 0 ? "\\u2191" : "\\u2193"}}</span>` : "");
  }});

  const body = document.getElementById("body");
  body.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const r of shown) {{
    const tr = document.createElement("tr");
    COLS.forEach(c => {{
      const td = document.createElement("td");
      if (NUMERIC.has(c)) td.className = "num";
      if (c === "player_name") td.className = "name";
      let v = r[c];
      if (c === "submitted_at" && v) v = String(v).slice(0, 16).replace("T", " ");
      td.textContent = v === null || v === undefined || v === "" ? "\\u2014" : v;
      tr.appendChild(td);
    }});
    frag.appendChild(tr);
  }}
  body.appendChild(frag);
  document.getElementById("empty").hidden = rows.length !== 0;
}}

["q", "district", "sex"].forEach(id =>
  document.getElementById(id).addEventListener("input", draw));
draw();
</script>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    cfg: dict = {}
    limit: int = 5000

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} {fmt % args}")

    def do_GET(self):
        if self.path not in ("/", "/index.html"):
            self.send_error(404)
            return
        try:
            rows = fetch_rows(self.cfg, self.limit)
            page = render(rows)
        except Exception as exc:                      # keep the page usable
            page = render([], error=f"Could not read from Supabase: {exc}")
        body = page.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    ap = argparse.ArgumentParser(description="Local admin dashboard for BVL registrations")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--limit", type=int, default=5000, help="max rows to fetch")
    ap.add_argument("--no-open", action="store_true", help="don't open a browser")
    args = ap.parse_args()

    Handler.cfg = load_config()
    Handler.limit = args.limit
    url = f"http://127.0.0.1:{args.port}"
    print(f"BVL dashboard on {url}   (Ctrl-C to stop)")
    print("The Supabase key stays in this process — the browser never sees it.")
    if not args.no_open:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    # 127.0.0.1, never 0.0.0.0 — this must not be reachable from the network.
    try:
        HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
