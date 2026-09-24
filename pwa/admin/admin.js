/* =========================================================================
   BVL Admin — sign-in + registration dashboard
   =========================================================================
   Runs entirely in the browser with the PUBLISHABLE key. It can only read
   player records because the signed-in user is listed in `admins` — see
   supabase/migrations/20260924000003_admin_access.sql. No secret key here.
   ========================================================================= */

const TEAMS = [
  ["u12_boys", "Under 12 boys"], ["u12_girls", "Under 12 girls"],
  ["u16_boys", "Under 16 boys"], ["u16_girls", "Under 16 girls"],
];
const TEAM_LABEL = { ...Object.fromEntries(TEAMS), above16: "Above 16", none: "No team" };
const LEVELS = ["BEGINNER", "BVL", "DISTRICT", "STATE", "NATIONAL"];
const LEVEL_LABEL = { BEGINNER: "Beginner", BVL: "BVL", DISTRICT: "District", STATE: "State", NATIONAL: "National" };
const PAGE = 50;

// Inline icons: emoji depend on the viewer's fonts and render as boxes on some machines.
const icon = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  users: icon('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14.6c2.6.2 4.4 1.9 5 5.4"/>'),
  girl: icon('<circle cx="12" cy="8" r="5"/><path d="M12 13v8M8.5 17.5h7"/>'),
  ball: icon('<circle cx="12" cy="12" r="9"/><path d="M12 3c-1.5 4 0 8 4.5 10.5M3.5 9c4 .3 7.4 2.6 8.5 3M7 19.5c1.5-3.6 4.6-6 9-6.5"/>'),
  phone: icon('<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18h2"/>'),
};

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("en-IN");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

const state = {
  players: [], centres: [], filtered: [],
  tab: "overview", search: "", sort: { key: "sl_no", dir: -1 }, page: 0,
  centreSort: { key: "players", dir: -1 }, tableView: {},
};

/* ------------------------------------------------------------ supabase */

function config() {
  const c = window.BVL_CONFIG || {};
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("bvl_config") || "{}"); } catch { /* ignore */ }
  return {
    url: (saved.url || c.SUPABASE_URL || "").replace(/\/+$/, ""),
    key: saved.key || c.SUPABASE_PUBLISHABLE_KEY || "",
  };
}

const { url, key } = config();
const sb = window.supabase.createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "bvl-admin-auth" },
});

async function fetchAll(table, columns, order) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(columns).order(order).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

/* ------------------------------------------------------------ sign-in */

function showLogin(message) {
  $("app").hidden = true;
  $("login").hidden = false;
  $("loginMsg").hidden = !message;
  $("loginMsg").textContent = message || "";
  $("loginBtn").disabled = false;
  $("loginBtn").textContent = "Sign in";
  setTimeout(() => $("email").focus(), 0);
}

async function onLogin(event) {
  event.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) return showLogin("Enter your email and password.");
  $("loginBtn").disabled = true;
  $("loginBtn").textContent = "Signing in…";
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return showLogin(error.status === 400 ? "Email or password is incorrect." : error.message);
  $("password").value = "";
  enter(data.session);
}

async function enter(session) {
  // Being signed in is not enough — the account must be listed in `admins`.
  const { data, error } = await sb.from("admins").select("user_id").eq("user_id", session.user.id).maybeSingle();
  if (error) {
    await sb.auth.signOut();
    return showLogin("Admin access is not set up in the database yet (run migration 20260924000003).");
  }
  if (!data) {
    await sb.auth.signOut();
    return showLogin("This account is not an admin. Ask a BVL administrator to add you.");
  }
  $("login").hidden = true;
  $("app").hidden = false;
  $("whoEmail").textContent = session.user.email;
  load();
}

/* ------------------------------------------------------------ data */

function ageFrom(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

// Imported centre names carry stray spaces and case differences.
const centreKey = (name) => String(name || "").trim().replace(/\s+/g, " ").toLowerCase();

async function load() {
  $("loading").hidden = false;
  $("content").style.opacity = ".5";
  $("stateMsg").hidden = true;
  try {
    const [centres, players] = await Promise.all([
      fetchAll("centres", "centre_code,centre_name,district", "centre_name"),
      fetchAll("players_clean",
        "sl_no,player_id,player_name,sex,dob,height_cm,joining_date,performance_levels,achievements,centre_name,team,source,submitted_at",
        "sl_no"),
    ]);
    const byKey = new Map(centres.map((c) => [centreKey(c.centre_name), c]));
    state.centres = centres;
    state.players = players.map((p) => {
      const c = byKey.get(centreKey(p.centre_name));
      const age = ageFrom(p.dob);
      return {
        ...p,
        sex: String(p.sex || "").trim().toUpperCase(),
        levels: String(p.performance_levels || "").split("/").map((s) => s.trim().toUpperCase()).filter(Boolean),
        age,
        centre: c ? c.centre_name : String(p.centre_name || "").trim() || "Unknown centre",
        district: c ? c.district : "Centre not in registry",
        team: p.team || "",
        // Display-only grouping. The database stores no team for these; an
        // empty team under 16 means sex or date of birth is missing.
        group: p.team || (age !== null && age >= 16 ? "above16" : "none"),
      };
    });
    buildFilters();
    $("chipUpdated").textContent = "Updated " + new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    $("content").hidden = false;
    apply();
  } catch (err) {
    const missing = /column|does not exist|schema cache/i.test(err.message || "");
    $("stateMsg").hidden = false;
    $("stateMsg").textContent = missing
      ? "The database is missing columns this dashboard needs. Run the latest migrations in supabase/migrations/ (20260924000002 and 20260924000006), then refresh."
      : `Could not load registrations: ${err.message || err}`;
  } finally {
    $("loading").hidden = true;
    $("content").style.opacity = "";
  }
}

/* ------------------------------------------------------------ filters */

function buildFilters() {
  // Only districts and centres that have players: picking an empty one would
  // just blank the dashboard. Empty centres are listed in the Centres tab.
  const districts = [...new Set(state.players.map((p) => p.district))].sort();
  const keep = $("fDistrict").value;
  $("fDistrict").innerHTML = '<option value="">All districts</option>' +
    districts.map((d) => `<option>${esc(d)}</option>`).join("");
  $("fDistrict").value = districts.includes(keep) ? keep : "";
  $("fTeam").innerHTML = '<option value="">All teams</option>' +
    TEAMS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("") +
    '<option value="above16">Above 16</option>' +
    (state.players.some((p) => p.group === "none") ? '<option value="none">No team</option>' : "");
  buildCentreFilter();
}

function buildCentreFilter() {
  const district = $("fDistrict").value;
  const names = new Set();
  state.players.forEach((p) => { if (!district || p.district === district) names.add(p.centre); });
  const keep = $("fCentre").value;
  const list = [...names].sort();
  $("fCentre").innerHTML = '<option value="">All centres</option>' + list.map((n) => `<option>${esc(n)}</option>`).join("");
  $("fCentre").value = list.includes(keep) ? keep : "";
}

function apply() {
  const d = $("fDistrict").value, c = $("fCentre").value, s = $("fSex").value, t = $("fTeam").value;
  state.filtered = state.players.filter((p) =>
    (!d || p.district === d) && (!c || p.centre === c) && (!s || p.sex === s) &&
    (!t || p.group === t));
  state.page = 0;
  const all = state.players.length, n = state.filtered.length;
  $("fCount").textContent = n === all ? `${fmt(all)} players` : `${fmt(n)} of ${fmt(all)} players`;
  render();
}

/* ------------------------------------------------------------ render */

function render() {
  const P = state.filtered;
  const districts = new Set(P.map((p) => p.district).filter((d) => d !== "Centre not in registry"));
  const centres = new Set(P.map((p) => p.centre));
  $("heroN").textContent = fmt(P.length);
  $("heroL").textContent = P.length === state.players.length ? "registered players" : "players in this view";
  $("chipDistricts").textContent = `${districts.size} districts`;
  $("chipCentres").textContent = `${centres.size} centres`;
  $("badgePlayers").textContent = fmt(P.length);
  $("badgeCentres").textContent = fmt(centres.size);

  renderTiles(P);
  renderAge(P);
  renderTeam(P);
  renderLevel(P);
  renderDistrict(P);
  renderJoined(P);
  renderPlayers();
  renderCentres();
}

function renderTiles(P) {
  const boys = P.filter((p) => p.sex === "M").length;
  const girls = P.filter((p) => p.sex === "F").length;
  const u12 = P.filter((p) => p.team.startsWith("u12")).length;
  const u16 = P.filter((p) => p.team.startsWith("u16")).length;
  const pwa = P.filter((p) => p.source === "pwa");
  const month = Date.now() - 30 * 86400000;
  const recent = pwa.filter((p) => p.submitted_at && new Date(p.submitted_at).getTime() >= month).length;
  const pct = P.length ? Math.round((girls / P.length) * 100) : 0;
  const tiles = [
    ["users", "#2a78d6", "Players", fmt(P.length), `${fmt(boys)} boys · ${fmt(girls)} girls`],
    ["girl", "#eb6834", "Girls", `${pct}%`, "share of players in view"],
    ["ball", "#d99400", "In a team", fmt(u12 + u16), `Under 12: ${fmt(u12)} · Under 16: ${fmt(u16)}`],
    ["phone", "#1c9b6c", "Via the app", fmt(pwa.length), `${fmt(recent)} in the last 30 days`],
  ];
  $("tiles").innerHTML = tiles.map(([ic, color, lab, val, sub]) => `
    <div class="tile">
      <div class="ic" style="--ic:${color}" aria-hidden="true">${ICONS[ic]}</div>
      <div><div class="lab">${lab}</div><div class="val">${val}</div><div class="sub">${sub}</div></div>
    </div>`).join("");
}

/* ------------------------------------------------------------ card shell
   Every chart has a table view one click away, so no value is reachable only
   by hovering or by colour. */

function card(id, title, subtitle, drawChart, tableRows, tableHead) {
  const el = $(id);
  const asTable = state.tableView[id];
  el.innerHTML = `
    <div class="card-head">
      <div class="grow"><h3>${title}</h3><p>${subtitle}</p></div>
      <button class="linkbtn" type="button">${asTable ? "Show chart" : "Show table"}</button>
    </div>
    <div class="body"></div>`;
  el.querySelector(".linkbtn").onclick = () => { state.tableView[id] = !asTable; render(); };
  const body = el.querySelector(".body");
  if (asTable) {
    body.innerHTML = `<div class="table-wrap"><table><thead><tr>${tableHead.map((h, i) =>
      `<th class="${i ? "num" : ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${tableRows.map((r) =>
      `<tr>${r.map((v, i) => `<td class="${i ? "num" : ""}">${esc(i ? fmt(v) : v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  } else {
    drawChart(body);
  }
}

/* ------------------------------------------------------------ age chart */

function renderAge(P) {
  const buckets = ["≤8"];
  for (let a = 9; a <= 24; a++) buckets.push(String(a));
  buckets.push("25+");
  const bucketOf = (a) => (a <= 8 ? "≤8" : a >= 25 ? "25+" : String(a));
  const boys = Object.fromEntries(buckets.map((b) => [b, 0]));
  const girls = { ...boys };
  P.forEach((p) => {
    if (p.age === null) return;
    const b = bucketOf(p.age);
    if (p.sex === "F") girls[b]++; else if (p.sex === "M") boys[b]++;
  });
  const series = [
    { name: "Boys", color: "var(--series-1)", values: buckets.map((b) => boys[b]) },
    { name: "Girls", color: "var(--series-2)", values: buckets.map((b) => girls[b]) },
  ];
  card("cardAge", "Players by age", "Age today. Lines mark the Under 12 and Under 16 cut-offs.",
    (body) => {
      body.innerHTML = legend(series);
      columns(body, buckets, series, { height: 240, markers: [["12", "Under 12 cut-off", "U12"], ["16", "Under 16 cut-off", "U16"]], xTitle: "Age" });
    },
    buckets.map((b, i) => [b, series[0].values[i], series[1].values[i]]), ["Age", "Boys", "Girls"]);
}

function legend(series) {
  return `<div class="legend">${series.map((s) =>
    `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>`;
}

/* ------------------------------------------------------------ bar lists */

function renderTeam(P) {
  const rows = TEAMS.map(([v, l]) => [l, P.filter((p) => p.team === v).length]);
  rows.push(["Above 16", P.filter((p) => p.group === "above16").length, true]);
  const none = P.filter((p) => p.group === "none").length;
  if (none) rows.push(["No team", none, true]);
  card("cardTeam", "Players by team", "Team recorded at registration, or worked out from age and sex",
    (body) => hbars(body, rows), rows.map((r) => r.slice(0, 2)), ["Team", "Players"]);
}

function renderLevel(P) {
  const counts = new Map(LEVELS.map((l) => [l, 0]));
  P.forEach((p) => p.levels.forEach((l) => counts.set(l, (counts.get(l) || 0) + 1)));
  const rows = [...counts].map(([l, n]) => [LEVEL_LABEL[l] || l, n]);
  card("cardLevel", "Level played", "A player listing several levels counts once in each",
    (body) => hbars(body, rows), rows, ["Level", "Players"]);
}

function renderDistrict(P) {
  const counts = new Map();
  P.forEach((p) => counts.set(p.district, (counts.get(p.district) || 0) + 1));
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 10).map(([d, n]) => [d, n, d === "Centre not in registry"]);
  const rest = sorted.slice(10).reduce((s, [, n]) => s + n, 0);
  if (rest) top.push([`Other ${sorted.length - 10} districts`, rest, true]);
  card("cardDistrict", "Players by district", sorted.length > 10 ? "Top 10 districts" : "All districts in view",
    (body) => hbars(body, top), sorted, ["District", "Players"]);
}

function renderJoined(P) {
  const counts = new Map();
  P.forEach((p) => {
    const y = p.joining_date && p.joining_date.slice(0, 4);
    if (y) counts.set(y, (counts.get(y) || 0) + 1);
  });
  // Every year in the range, so a year with no joiners shows as a gap rather than vanishing.
  const known = [...counts.keys()].map(Number).sort((a, b) => a - b);
  const years = [];
  for (let y = known[0]; y <= known[known.length - 1]; y++) years.push(String(y));
  years.forEach((y) => counts.has(y) || counts.set(y, 0));
  const series = [{ name: "Players", color: "var(--series-1)", values: years.map((y) => counts.get(y)) }];
  card("cardJoined", "Players by year joined", "Year each player joined their centre",
    (body) => columns(body, years, series, { height: 220 }),
    years.map((y) => [y, counts.get(y)]), ["Year", "Players"]);
}

function hbars(body, rows) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const wrap = document.createElement("div");
  wrap.className = "hbars";
  rows.forEach(([label, value, muted]) => {
    // Grey marks "remainder" rows (Other, No team, unmatched) so they don't read as a peer category.
    const row = document.createElement("div");
    row.innerHTML = `<div class="name"></div><div class="track" tabindex="0"><div class="bar${muted ? " muted" : ""}"></div></div><div class="v"></div>`;
    row.querySelector(".name").textContent = label;
    row.querySelector(".name").title = label;
    row.querySelector(".bar").style.width = value ? `${(value / max) * 100}%` : "0";
    row.querySelector(".v").textContent = fmt(value);
    const track = row.querySelector(".track");
    const show = (e) => tip(e, label, [{ color: muted ? "var(--axis)" : "var(--series-1)", label: "Players", value }]);
    track.addEventListener("pointermove", show);
    track.addEventListener("focus", show);
    track.addEventListener("pointerleave", hideTip);
    track.addEventListener("blur", hideTip);
    wrap.append(...row.children);
  });
  body.append(wrap);
}

/* ------------------------------------------------------------ columns (SVG)
   Stacked when given two series. Bars cap at 24px, 4px rounded data-end,
   2px surface gap between stacked segments, hairline grid. */

const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

function niceScale(max, ticks = 4) {
  if (max <= 0) return { top: 1, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return { top: Math.ceil(max / step) * step, step };
}

function roundedTop(x, y, w, h, r) {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function columns(body, cats, series, { height = 220, markers = [], xTitle = "" } = {}) {
  const box = document.createElement("div");
  box.className = "chart";
  body.append(box);
  const W = Math.max(280, box.clientWidth || body.clientWidth || 600);
  const m = { l: 44, r: 8, t: markers.length ? 22 : 10, b: xTitle ? 40 : 26 };
  const w = W - m.l - m.r, h = height - m.t - m.b;
  const totals = cats.map((_, i) => series.reduce((s, se) => s + se.values[i], 0));
  const { top, step } = niceScale(Math.max(...totals, 0));
  const y = (v) => m.t + h - (v / top) * h;
  const band = w / Math.max(cats.length, 1);
  const bw = Math.min(24, band * 0.7);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${height}`, height, role: "img" });
  for (let v = 0; v <= top; v += step) {
    svg.append(svgEl("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v ? "gridline" : "baseline" }));
    const t = svgEl("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end", class: "axis-text" });
    t.textContent = fmt(v);
    svg.append(t);
  }

  const every = Math.max(1, Math.ceil(30 / band));
  cats.forEach((cat, i) => {
    const cx = m.l + band * i + band / 2;
    const g = svgEl("g", { class: "col", tabindex: 0 });
    g.append(svgEl("rect", { class: "hit", x: m.l + band * i, y: m.t, width: band, height: h }));
    let acc = 0;
    const drawn = series.map((se, si) => ({ se, si, v: se.values[i] })).filter((d) => d.v > 0);
    drawn.forEach((d, k) => {
      const y0 = y(acc), y1 = y(acc + d.v);
      acc += d.v;
      const gap = k > 0 ? 2 : 0;                 // surface gap below every upper segment
      const segH = Math.max(0, y0 - y1 - gap);
      if (segH <= 0) return;
      const isTop = k === drawn.length - 1;
      const attrs = { class: "mark", fill: d.se.color };
      g.append(isTop
        ? svgEl("path", { ...attrs, d: roundedTop(cx - bw / 2, y1, bw, segH, 4) })
        : svgEl("rect", { ...attrs, x: cx - bw / 2, y: y1, width: bw, height: segH }));
    });
    // Every nth label only — forcing the last one in makes it collide.
    if (i % every === 0) {
      const t = svgEl("text", { x: cx, y: m.t + h + 16, "text-anchor": "middle", class: "axis-text" });
      t.textContent = cat;
      svg.append(t);
    }
    const show = (e) => tip(e, xTitle ? `${xTitle} ${cat}` : cat, [
      ...series.map((se) => ({ color: se.color, label: se.name, value: se.values[i] })),
      ...(series.length > 1 ? [{ label: "Total", value: totals[i] }] : []),
    ]);
    g.addEventListener("pointermove", show);
    g.addEventListener("focus", show);
    g.addEventListener("pointerleave", hideTip);
    g.addEventListener("blur", hideTip);
    svg.append(g);
  });

  markers.forEach(([cat, label, short]) => {
    const i = cats.indexOf(cat);
    if (i < 0) return;
    const x = m.l + band * i;
    svg.append(svgEl("line", { x1: x, x2: x, y1: m.t - 6, y2: m.t + h, class: "baseline" }));
    const t = svgEl("text", { x, y: m.t - 10, "text-anchor": "middle", class: "axis-text" });
    t.textContent = W < 640 && short ? short : label;
    svg.append(t);
  });

  if (xTitle) {
    const t = svgEl("text", { x: m.l + w / 2, y: height - 4, "text-anchor": "middle", class: "axis-text" });
    t.textContent = xTitle;
    svg.append(t);
  }
  box.append(svg);
}

/* ------------------------------------------------------------ tooltip */

function tip(e, title, rows) {
  const el = $("tip");
  el.replaceChildren();
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = title;
  el.append(t);
  rows.forEach((r) => {
    const row = document.createElement("div");
    row.className = "r";
    const key = document.createElement("i");
    if (r.color) key.style.background = r.color;
    const val = document.createElement("b");
    val.textContent = fmt(r.value);
    const lab = document.createElement("span");
    lab.textContent = r.label;
    row.append(key, val, lab);
    el.append(row);
  });
  let x = e.clientX, y = e.clientY;
  if (x === undefined || e.type === "focus") {
    const r = e.currentTarget.getBoundingClientRect();
    x = r.left + r.width / 2; y = r.top;
  }
  el.classList.add("show");
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x + 14))}px`;
  el.style.top = `${Math.max(8, y - h - 12)}px`;
}
const hideTip = () => $("tip").classList.remove("show");

/* ------------------------------------------------------------ players table */

const PLAYER_COLS = [
  ["player_id", "Player ID"], ["player_name", "Name"], ["sex", "Sex"], ["age", "Age", "num"],
  ["group", "Team"], ["centre", "Centre"], ["district", "District"], ["performance_levels", "Level"],
  ["joining_date", "Joined"], ["source", "Source"],
];

function playerRows() {
  const q = state.search.trim().toLowerCase();
  let rows = q
    ? state.filtered.filter((p) => `${p.player_id} ${p.player_name} ${p.centre} ${p.district} ${p.achievements || ""}`.toLowerCase().includes(q))
    : state.filtered.slice();
  const { key, dir } = state.sort;
  rows.sort((a, b) => {
    const x = a[key] ?? "", y = b[key] ?? "";
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
  });
  return rows;
}

function renderPlayers() {
  const rows = playerRows();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  state.page = Math.min(state.page, pages - 1);
  const slice = rows.slice(state.page * PAGE, state.page * PAGE + PAGE);
  const arrow = (k) => (state.sort.key === k ? (state.sort.dir > 0 ? " ▲" : " ▼") : "");
  $("playersTable").innerHTML = `
    <thead><tr>${PLAYER_COLS.map(([k, l, c]) => `<th data-sort="${k}" class="${c || ""}">${l}${arrow(k)}</th>`).join("")}</tr></thead>
    <tbody>${slice.map((p) => `<tr>
      <td class="pid">${esc(p.player_id)}</td>
      <td>${esc(p.player_name)}</td>
      <td>${p.sex === "M" ? "Boy" : p.sex === "F" ? "Girl" : esc(p.sex)}</td>
      <td class="num">${p.age ?? ""}</td>
      <td><span class="pill">${esc(TEAM_LABEL[p.group] || p.group)}</span></td>
      <td>${esc(p.centre)}</td>
      <td>${esc(p.district)}</td>
      <td>${esc(p.levels.map((l) => LEVEL_LABEL[l] || l).join(", "))}</td>
      <td>${esc(p.joining_date || "")}</td>
      <td>${p.source === "pwa" ? '<span class="pill">App</span>' : "Ledger"}</td>
    </tr>`).join("") || `<tr><td colspan="${PLAYER_COLS.length}">No players match.</td></tr>`}</tbody>`;
  $("playersTable").querySelectorAll("th[data-sort]").forEach((th) => th.onclick = () => {
    const k = th.dataset.sort;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
    renderPlayers();
  });
  $("pager").innerHTML = rows.length > PAGE ? `
    <span>${fmt(state.page * PAGE + 1)}–${fmt(Math.min(rows.length, (state.page + 1) * PAGE))} of ${fmt(rows.length)}</span>
    <button class="btn ghost" id="prevPage" ${state.page ? "" : "disabled"}>Previous</button>
    <button class="btn ghost" id="nextPage" ${state.page < pages - 1 ? "" : "disabled"}>Next</button>` : `<span>${fmt(rows.length)} players</span>`;
  $("prevPage")?.addEventListener("click", () => { state.page--; renderPlayers(); });
  $("nextPage")?.addEventListener("click", () => { state.page++; renderPlayers(); });
}

function exportCsv() {
  const rows = playerRows();
  const cols = ["player_id", "sl_no", "player_name", "sex", "dob", "age", "team", "centre", "district", "performance_levels",
    "height_cm", "joining_date", "achievements", "source", "submitted_at"];
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...rows.map((p) => cols.map((c) => cell(p[c])).join(","))].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
  a.download = `bvl-players-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ------------------------------------------------------------ centres table */

function renderCentres() {
  const d = $("fDistrict").value, c = $("fCentre").value;
  const map = new Map();
  const blank = (name, district) => ({ name, district, players: 0, boys: 0, girls: 0, u12: 0, u16: 0, last: "" });
  state.centres.forEach((ct) => map.set(ct.centre_name, blank(ct.centre_name, ct.district)));
  state.filtered.forEach((p) => {
    if (!map.has(p.centre)) map.set(p.centre, blank(p.centre, p.district));
    const r = map.get(p.centre);
    r.players++;
    if (p.sex === "M") r.boys++;
    if (p.sex === "F") r.girls++;
    if (p.team.startsWith("u12")) r.u12++;
    if (p.team.startsWith("u16")) r.u16++;
    if (p.joining_date && p.joining_date > r.last) r.last = p.joining_date;
  });
  const { key, dir } = state.centreSort;
  const inView = [...map.values()].filter((r) => (!d || r.district === d) && (!c || r.name === c));
  const empty = inView.filter((r) => !r.players).length;
  $("emptyCount").textContent = `(${fmt(empty)})`;
  const rows = inView
    .filter((r) => $("showEmpty").checked || r.players)
    .sort((a, b) => (typeof a[key] === "number" ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key]))) * dir);
  const cols = [["name", "Centre"], ["district", "District"], ["players", "Players", "num"], ["boys", "Boys", "num"],
    ["girls", "Girls", "num"], ["u12", "Under 12", "num"], ["u16", "Under 16", "num"], ["last", "Latest joiner"]];
  const arrow = (k) => (key === k ? (dir > 0 ? " ▲" : " ▼") : "");
  $("centresTable").innerHTML = `
    <thead><tr>${cols.map(([k, l, cl]) => `<th data-sort="${k}" class="${cl || ""}">${l}${arrow(k)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.name)}</td><td>${esc(r.district)}</td>
      <td class="num"><b>${fmt(r.players)}</b></td><td class="num">${fmt(r.boys)}</td><td class="num">${fmt(r.girls)}</td>
      <td class="num">${fmt(r.u12)}</td><td class="num">${fmt(r.u16)}</td><td>${esc(r.last)}</td>
    </tr>`).join("")}</tbody>`;
  $("centresTable").querySelectorAll("th[data-sort]").forEach((th) => th.onclick = () => {
    const k = th.dataset.sort;
    state.centreSort = { key: k, dir: key === k ? -dir : (["players", "boys", "girls", "u12", "u16"].includes(k) ? -1 : 1) };
    renderCentres();
  });
}

/* ------------------------------------------------------------ tabs + boot */

function selectTab(name) {
  state.tab = name;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
  if (name === "overview") render();   // charts measure their width, so draw them visible
}

async function boot() {
  $("loginForm").addEventListener("submit", onLogin);
  $("logoutBtn").addEventListener("click", () => sb.auth.signOut());
  $("refreshBtn").addEventListener("click", load);
  $("fDistrict").addEventListener("change", () => { buildCentreFilter(); apply(); });
  ["fCentre", "fSex", "fTeam"].forEach((id) => $(id).addEventListener("change", apply));
  $("fClear").addEventListener("click", () => {
    ["fDistrict", "fSex", "fTeam"].forEach((id) => ($(id).value = ""));
    buildCentreFilter();
    $("fCentre").value = "";
    apply();
  });
  $("search").addEventListener("input", (e) => { state.search = e.target.value; state.page = 0; renderPlayers(); });
  $("exportBtn").addEventListener("click", exportCsv);
  $("showEmpty").addEventListener("change", renderCentres);
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.players.length && state.tab === "overview") render(); }, 150);
  });

  // Never await Supabase calls inside this callback — it runs under the auth lock.
  // Only react when the dashboard is showing: enter() signs non-admins out
  // itself and has already put its own message on the sign-in screen.
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" && !$("app").hidden) setTimeout(() => showLogin(), 0);
  });

  if (!url || !key) return showLogin("This site has no Supabase project configured (pwa/config.js).");
  const { data: { session } } = await sb.auth.getSession();
  if (session) enter(session); else showLogin();
}

boot();
