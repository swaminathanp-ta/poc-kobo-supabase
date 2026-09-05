/* =========================================================================
   BVL Registration — offline-first logic
   =========================================================================
   Everything a registration needs happens locally first:

     save  ->  IndexedDB  ->  (whenever there is signal)  ->  Supabase

   Nothing is ever lost because the network was absent. The queue is the
   source of truth on the device until a row is confirmed accepted.
   ========================================================================= */

const DB_NAME = "bvl-registration";
const DB_VERSION = 1;
const STORE_QUEUE = "queue";     // registrations waiting to be sent
const STORE_META = "meta";       // cached centre list, sentinel, misc

const state = {
  db: null,
  centres: [],
  districts: [],
  pending: [],
  syncing: false,
};

/* ---------------------------------------------------------------- storage */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: "source_id" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = state.db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const queuePut = (rec) => tx(STORE_QUEUE, "readwrite", (s) => s.put(rec));
const queueDelete = (id) => tx(STORE_QUEUE, "readwrite", (s) => s.delete(id));
const queueAll = () => tx(STORE_QUEUE, "readonly", (s) => s.getAll());
const metaPut = (key, value) => tx(STORE_META, "readwrite", (s) => s.put({ key, value }));
const metaGet = async (key) => (await tx(STORE_META, "readonly", (s) => s.get(key)))?.value;

/* ------------------------------------------------------- persistent storage
   Without this, Android may evict everything this app has stored when the
   phone runs low on space — taking unsent registrations with it. With it
   granted, only the user can clear the data. */

async function requestPersistence() {
  if (!navigator.storage?.persist) return null;
  try {
    let granted = await navigator.storage.persisted();
    if (!granted) granted = await navigator.storage.persist();
    await metaPut("persisted", granted);
    return granted;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- config */

function config() {
  const c = window.BVL_CONFIG || {};
  const saved = JSON.parse(localStorage.getItem("bvl_config") || "{}");
  return {
    url: (saved.url || c.SUPABASE_URL || "").replace(/\/+$/, ""),
    key: saved.key || c.SUPABASE_PUBLISHABLE_KEY || "",
  };
}

function configured() {
  const { url, key } = config();
  return Boolean(url && key);
}

/* ------------------------------------------------------------- centres
   Cached in IndexedDB so the district -> centre picker keeps working with no
   signal, which is the whole point. */

async function loadCentres() {
  state.centres = (await metaGet("centres")) || [];
  rebuildDistricts();
  if (navigator.onLine && configured()) refreshCentres();
}

async function refreshCentres() {
  const { url, key } = config();
  try {
    const resp = await fetch(
      `${url}/rest/v1/centres?select=centre_code,centre_name,district&order=centre_name`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!resp.ok) return;
    const rows = await resp.json();
    if (Array.isArray(rows) && rows.length) {
      state.centres = rows;
      await metaPut("centres", rows);
      rebuildDistricts();
      renderDistricts();
    }
  } catch {
    /* offline — the cached list stands */
  }
}

function rebuildDistricts() {
  state.districts = [...new Set(state.centres.map((c) => c.district))].sort();
}

/* ---------------------------------------------------------------- sync */

async function syncPending({ silent = false } = {}) {
  if (state.syncing) return;
  if (!configured()) {
    if (!silent) toast("Not set up yet — open Settings.", "warn");
    return;
  }
  const rows = await queueAll();
  const waiting = rows.filter((r) => r.status !== "sent");
  if (!waiting.length) {
    if (!silent) toast("Nothing waiting to send.");
    return;
  }
  if (!navigator.onLine) {
    if (!silent) toast("No connection. It will send itself when you're online.", "warn");
    return;
  }

  state.syncing = true;
  render();
  const { url, key } = config();
  let sent = 0, failed = 0;

  for (const rec of waiting) {
    const { status, error, savedAt, ...row } = rec;
    try {
      const resp = await fetch(`${url}/rest/v1/players`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify([row]),
      });

      if (resp.ok) {
        await queueDelete(rec.source_id);
        sent++;
      } else if (resp.status === 409) {
        // Already accepted on an earlier attempt — the unique (source,
        // source_id) index makes retrying safe rather than duplicating.
        await queueDelete(rec.source_id);
        sent++;
      } else {
        const text = (await resp.text()).slice(0, 200);
        await queuePut({ ...rec, status: "error", error: `${resp.status}: ${text}` });
        failed++;
      }
    } catch (err) {
      // Network died mid-run: stop, keep everything, try again later.
      break;
    }
  }

  state.syncing = false;
  await render();
  if (!silent || sent || failed) {
    if (failed) toast(`Sent ${sent}. ${failed} rejected — check Settings.`, "warn");
    else if (sent) toast(`Sent ${sent} registration${sent === 1 ? "" : "s"}.`, "ok");
  }
}

/* --------------------------------------------------------------- export
   The safety net that survives anything: a file in the phone's Downloads
   folder, outside the browser's evictable storage. */

async function exportBackup() {
  const rows = await queueAll();
  if (!rows.length) return toast("Nothing to export.");
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const name = `bvl-registrations-${stamp}.json`;

  if (navigator.canShare?.({ files: [new File([blob], name, { type: "application/json" })] })) {
    try {
      await navigator.share({
        files: [new File([blob], name, { type: "application/json" })],
        title: "BVL registrations",
        text: "Unsent BVL registrations",
      });
      return;
    } catch { /* user cancelled — fall through to download */ }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("Saved to your Downloads folder.", "ok");
}

/* ------------------------------------------------------------ rendering */

const $ = (id) => document.getElementById(id);

function renderDistricts() {
  const sel = $("district");
  const chosen = sel.value;
  sel.innerHTML = '<option value="">Choose district…</option>' +
    state.districts.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
  if (chosen) sel.value = chosen;
  renderCentres();
}

function renderCentres() {
  const district = $("district").value;
  const sel = $("centre");
  const list = state.centres.filter((c) => c.district === district);
  sel.disabled = !district;
  sel.innerHTML = district
    ? '<option value="">Choose centre…</option>' +
      list.map((c) => `<option value="${esc(c.centre_code)}">${esc(c.centre_name)}</option>`).join("")
    : '<option value="">Choose a district first</option>';
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

async function render() {
  const rows = await queueAll();
  state.pending = rows;
  const waiting = rows.filter((r) => r.status !== "sent");
  const errored = rows.filter((r) => r.status === "error");

  $("pendingCount").textContent = waiting.length;
  $("statusStrip").dataset.state = waiting.length ? (errored.length ? "error" : "waiting") : "clear";

  let detail = "All registrations sent";
  if (waiting.length) {
    const oldest = Math.min(...waiting.map((r) => new Date(r.savedAt).getTime()));
    const days = Math.floor((Date.now() - oldest) / 86400000);
    detail = `waiting to send${days >= 1 ? ` · oldest ${days} day${days === 1 ? "" : "s"}` : ""}`;
    if (errored.length) detail += ` · ${errored.length} rejected`;
  }
  $("pendingDetail").textContent = detail;
  $("syncBtn").disabled = state.syncing || !waiting.length;
  $("syncBtn").textContent = state.syncing ? "Sending…" : "Send now";

  $("netDot").className = "dot " + (navigator.onLine ? "on" : "off");
  $("netLabel").textContent = navigator.onLine ? "Online" : "Offline";

  const list = $("queueList");
  if (list) {
    list.innerHTML = rows.length
      ? rows.slice().reverse().map((r) => `
          <li class="${r.status === 'error' ? 'bad' : ''}">
            <strong>${esc(r.player_name)}</strong>
            <span>${esc(r.district || "")}</span>
            ${r.status === "error" ? `<em>${esc(r.error)}</em>` : "<em>waiting</em>"}
          </li>`).join("")
      : "<li class='muted'>Nothing waiting.</li>";
  }
}

let toastTimer;
function toast(msg, kind = "") {
  const el = $("toast");
  el.textContent = msg;
  el.className = "show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), 3800);
}

/* ------------------------------------------------------------- the form */

function ageFrom(dobValue) {
  if (!dobValue) return null;
  const dob = new Date(dobValue);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

function updateAge() {
  const age = ageFrom($("dob").value);
  const hint = $("ageHint");
  if (age === null) { hint.textContent = ""; hint.className = "hint"; return; }
  hint.textContent = `Age ${age}`;
  hint.className = "hint " + (age >= 5 && age <= 25 ? "ok" : "bad");
}

function collect() {
  const levels = [...document.querySelectorAll("input[name=level]:checked")].map((i) => i.value);
  const height = $("height").value.trim();
  return {
    source: "pwa",
    source_id: crypto.randomUUID(),
    player_name: $("name").value.trim(),
    sex: (document.querySelector("input[name=sex]:checked") || {}).value || "",
    dob: $("dob").value,
    height_cm: height ? Number(height) : null,
    joining_date: $("joining").value || null,
    performance_levels: levels,
    achievements: $("achievements").value.trim() || null,
    district: $("district").value || null,
    centre_code: $("centre").value,
    guardian_consent: $("consent").checked,
    submitted_at: new Date().toISOString(),
  };
}

function validate(rec) {
  const problems = [];
  if (rec.player_name.length < 3) problems.push(["name", "Enter the player's full name"]);
  if (!rec.sex) problems.push(["sexField", "Choose male or female"]);
  const age = ageFrom(rec.dob);
  if (age === null) problems.push(["dob", "Enter the date of birth"]);
  else if (age < 5 || age > 25) problems.push(["dob", "Age must be between 5 and 25"]);
  if (rec.height_cm !== null && (rec.height_cm < 100 || rec.height_cm > 220))
    problems.push(["height", "Height should be between 100 and 220 cm"]);
  if (!rec.district) problems.push(["district", "Choose the district"]);
  if (!rec.centre_code) problems.push(["centre", "Choose the centre"]);
  if (!rec.performance_levels.length) problems.push(["levelField", "Choose at least one level"]);
  if (!rec.guardian_consent) problems.push(["consentField", "Guardian consent is required"]);
  if (rec.joining_date && rec.dob && rec.joining_date < rec.dob)
    problems.push(["joining", "Joining date cannot be before the date of birth"]);
  return problems;
}

function showProblems(problems) {
  document.querySelectorAll(".field.invalid").forEach((e) => e.classList.remove("invalid"));
  document.querySelectorAll(".err").forEach((e) => (e.textContent = ""));
  problems.forEach(([id, message]) => {
    const field = $(id)?.closest(".field") || $(id);
    field?.classList.add("invalid");
    const err = field?.querySelector(".err");
    if (err) err.textContent = message;
  });
  if (problems.length) {
    const first = $(problems[0][0]);
    (first?.closest(".field") || first)?.scrollIntoView({ behavior: "smooth", block: "center" });
    first?.focus?.({ preventScroll: true });
  }
}

function resetForm() {
  const keepDistrict = $("district").value;
  const keepCentre = $("centre").value;
  const keepJoining = $("joining").value;
  $("regForm").reset();
  // An in-charge registers many children from the same centre in one sitting.
  // Keeping these saves a dozen taps per child.
  $("district").value = keepDistrict;
  renderCentres();
  $("centre").value = keepCentre;
  $("joining").value = keepJoining;
  $("ageHint").textContent = "";
  document.querySelectorAll(".field.invalid").forEach((e) => e.classList.remove("invalid"));
  document.querySelectorAll(".err").forEach((e) => (e.textContent = ""));
  $("name").focus();
}

async function onSubmit(event) {
  event.preventDefault();
  const rec = collect();
  const problems = validate(rec);
  showProblems(problems);
  if (problems.length) return;

  await requestPersistence();
  await queuePut({ ...rec, status: "pending", savedAt: new Date().toISOString() });
  await render();
  toast(`Saved. ${rec.player_name.split(" ")[0]} is registered on this phone.`, "ok");
  resetForm();

  if (navigator.onLine) syncPending({ silent: true });
}

/* ------------------------------------------------------------ settings */

async function openSettings() {
  const { url, key } = config();
  $("cfgUrl").value = url;
  $("cfgKey").value = key;

  let storageLine = "not supported on this browser";
  if (navigator.storage?.persisted) {
    const persisted = await navigator.storage.persisted();
    storageLine = persisted
      ? "Granted — Android will not clear this app's data automatically."
      : "Not granted — data could be cleared if the phone runs very low on space.";
  }
  $("storageStatus").textContent = storageLine;

  if (navigator.storage?.estimate) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    $("storageUsage").textContent =
      `Using ${(usage / 1024).toFixed(0)} KB of ${(quota / 1048576).toFixed(0)} MB available.`;
  }
  await render();
  $("settings").showModal();
}

function saveSettings(event) {
  event.preventDefault();
  localStorage.setItem("bvl_config", JSON.stringify({
    url: $("cfgUrl").value.trim().replace(/\/+$/, ""),
    key: $("cfgKey").value.trim(),
  }));
  $("settings").close();
  toast("Saved.", "ok");
  refreshCentres();
  updateSetupBanner();
}

function updateSetupBanner() {
  $("setupBanner").hidden = configured();
}

/* ---------------------------------------------------------------- boot */

async function boot() {
  state.db = await openDB();
  await loadCentres();
  renderDistricts();
  await render();
  updateSetupBanner();

  $("regForm").addEventListener("submit", onSubmit);
  $("district").addEventListener("change", renderCentres);
  $("dob").addEventListener("change", updateAge);
  $("dob").addEventListener("input", updateAge);
  $("syncBtn").addEventListener("click", () => syncPending());
  $("settingsBtn").addEventListener("click", openSettings);
  $("settingsForm").addEventListener("submit", saveSettings);
  $("exportBtn").addEventListener("click", exportBackup);
  $("closeSettings").addEventListener("click", () => $("settings").close());

  window.addEventListener("online", () => { render(); syncPending({ silent: true }); });
  window.addEventListener("offline", render);

  if (navigator.onLine) syncPending({ silent: true });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

boot();
