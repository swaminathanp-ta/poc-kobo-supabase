// ===========================================================================
// BVL — Kobo webhook receiver
// ===========================================================================
// Receives one submission from a KoboToolbox REST Service and upserts it into
// the `players` table. This is the event-driven path: Kobo POSTs here the
// moment a registration is submitted, so nothing of ours has to stay running.
//
// The transform below is deliberately identical to transform() in
// kobo_to_supabase.py. Both paths write the same row, because the scheduled
// poller is the backstop for whatever this misses.
//
// ---------------------------------------------------------------------------
// DEPLOY
//   supabase functions deploy kobo-webhook --no-verify-jwt
//
// --no-verify-jwt is required: Kobo cannot send a Supabase JWT. The function
// is therefore publicly reachable, so it authenticates callers itself using
// the HTTP Basic credentials Kobo sends. Set those first:
//
//   supabase secrets set KOBO_WEBHOOK_USER=bvl-kobo
//   supabase secrets set KOBO_WEBHOOK_PASSWORD=<long random string>
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// Then in Kobo: project -> Settings -> REST Services -> Register a new service
//   Endpoint URL : https://<project-ref>.supabase.co/functions/v1/kobo-webhook
//   Type         : JSON
//   Username     : the KOBO_WEBHOOK_USER value
//   Password     : the KOBO_WEBHOOK_PASSWORD value
// ===========================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WEBHOOK_USER = Deno.env.get("KOBO_WEBHOOK_USER") ?? "";
const WEBHOOK_PASSWORD = Deno.env.get("KOBO_WEBHOOK_PASSWORD") ?? "";

/** Constant-time comparison, so a wrong password cannot be found by timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authorized(req: Request): boolean {
  // Never run unauthenticated: if the secrets were not set, refuse everything.
  if (!WEBHOOK_USER || !WEBHOOK_PASSWORD) return false;

  const header = req.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("basic ")) return false;

  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;

  return safeEqual(decoded.slice(0, sep), WEBHOOK_USER) &&
    safeEqual(decoded.slice(sep + 1), WEBHOOK_PASSWORD);
}

/** Kobo prefixes answers with their group path ("registration/player_name").
 *  Match on the leaf name so renaming the group cannot break the mapping.
 *  Mirrors _field() in kobo_to_supabase.py. */
export function field(submission: Record<string, unknown>, name: string): unknown {
  for (const [key, value] of Object.entries(submission)) {
    if (key === name || key.endsWith("/" + name)) return value;
  }
  return undefined;
}

function asText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

export interface PlayerRow {
  kobo_id: number;
  kobo_uuid: string | null;
  player_name: string;
  sex: string;
  dob: string;
  height_cm: number | null;
  joining_date: string | null;
  performance_levels: string[];
  achievements: string | null;
  centre_code: string;
  district: string | null;
  guardian_consent: boolean;
  submitted_at: string | null;
  raw_submission: Record<string, unknown>;
}

export function transform(submission: Record<string, unknown>): PlayerRow {
  const koboId = submission["_id"];
  if (typeof koboId !== "number") throw new Error("submission has no numeric _id");

  const name = asText(field(submission, "player_name"));
  const sex = asText(field(submission, "sex"));
  const dob = asText(field(submission, "dob"));
  const centre = asText(field(submission, "centre"));
  if (!name || !sex || !dob || !centre) {
    throw new Error("missing one of: player_name, sex, dob, centre");
  }

  const height = asText(field(submission, "height_cm"));
  // select_multiple answers arrive space-separated: "bvl district"
  const levels = (asText(field(submission, "performance")) ?? "")
    .split(/\s+/).filter(Boolean);

  return {
    kobo_id: koboId,
    kobo_uuid: asText(submission["_uuid"]),
    player_name: name,
    sex,
    dob,
    height_cm: height !== null && height !== "" && !Number.isNaN(Number(height))
      ? Number(height)
      : null,
    joining_date: asText(field(submission, "joining_date")),
    performance_levels: levels,
    achievements: asText(field(submission, "achievements")),
    centre_code: centre,
    district: asText(field(submission, "district")),
    guardian_consent: asText(field(submission, "guardian_consent")) === "yes",
    submitted_at: asText(submission["_submission_time"]),
    raw_submission: submission,
  };
}

async function upsert(row: PlayerRow): Promise<void> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/players?on_conflict=kobo_id`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([row]),
    },
  );
  if (!response.ok) {
    throw new Error(
      `PostgREST ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
}

function json(body: unknown, status: number, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  if (!authorized(req)) {
    return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Basic" });
  }

  let submission: Record<string, unknown>;
  try {
    submission = await req.json();
  } catch {
    // Malformed JSON will never succeed on retry — 400 so Kobo gives up.
    return json({ error: "invalid JSON" }, 400);
  }

  let row: PlayerRow;
  try {
    row = transform(submission);
  } catch (error) {
    console.error("transform failed", {
      id: submission?.["_id"],
      error: String(error),
    });
    // Also permanent: the payload is wrong, not the connection.
    return json({ error: String(error) }, 400);
  }

  try {
    await upsert(row);
  } catch (error) {
    console.error("upsert failed", { id: row.kobo_id, error: String(error) });
    // 500 so Kobo retries (60s, 600s, 6000s). If every retry fails, the
    // scheduled poller picks the row up anyway.
    return json({ error: String(error) }, 500);
  }

  console.log("synced", { kobo_id: row.kobo_id, centre: row.centre_code });
  return json({ ok: true, kobo_id: row.kobo_id }, 200);
}

// Deno.serve is the Edge Function entrypoint. Guarded so the module can be
// imported by tests without starting a server.
if (import.meta.main) Deno.serve(handler);
