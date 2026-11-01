import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/*
 * review-api: record a change review decision from the dashboard.
 *
 * A team member signs in with the same account as Cadence (Supabase Auth, on
 * the regulatory_calendar_members team list). An admin or editor can record a
 * decision; every member can read them. Decisions are append-only rows in
 * change_review_decisions. The Review Sync workflow reads the rows not yet
 * copied into data/reviews/ledger.json (sync-pending) and marks them done
 * (sync-done), authenticated by REVIEW_SYNC_TOKEN, so GitHub never holds the
 * database key.
 */

const DEFAULT_URL = "https://pysoukwmnwwgilkwafdy.supabase.co";
export const DECISIONS: Record<string, string> = {
  material: "Material", not_material: "Not material", acknowledged: "Acknowledged", action_required: "Action required"
};
const MAX_EVENTS = 50;
const MAX_TEXT = 600;
const ALLOWED_ORIGINS = new Set([
  "https://gauravdarwesh.github.io", "http://localhost:5173", "http://127.0.0.1:5173",
  "http://localhost:5500", "http://127.0.0.1:5500"
]);

function objectEnv(name: string): Record<string, string> {
  try { const v = Deno.env.get(name); return v ? JSON.parse(v) : {}; } catch (_) { return {}; }
}
function config() {
  const pub = objectEnv("SUPABASE_PUBLISHABLE_KEYS"), secret = objectEnv("SUPABASE_SECRET_KEYS");
  return {
    url: (Deno.env.get("SUPABASE_URL") || DEFAULT_URL).replace(/\/+$/, ""),
    publishable: pub.default || Deno.env.get("SUPABASE_ANON_KEY") || "",
    service: secret.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    syncToken: Deno.env.get("REVIEW_SYNC_TOKEN") || ""
  };
}
export function originAllowed(origin: string, extra = Deno.env.get("ASK_SENTINEL_EXTRA_ORIGINS") || ""): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return extra.split(",").map(v => v.trim().replace(/\/+$/, "")).filter(Boolean).includes(origin);
}
function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = originAllowed(origin);
  const headers: Record<string, string> = {
    "Vary": "Origin", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400"
  };
  if (allowed) headers["Access-Control-Allow-Origin"] = origin;
  return { allowed, headers };
}
function respond(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors(req).headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
export class PublicError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }

function serviceHeaders(extra: Record<string, string> = {}) {
  const key = config().service;
  if (!key) throw new Error("Review service database key is not configured.");
  const h = new Headers({ apikey: key, "Content-Type": "application/json", ...extra });
  if (!key.startsWith("sb_secret_")) h.set("Authorization", "Bearer " + key);
  return h;
}
async function restJson(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(config().url + "/rest/v1/" + path, {
    ...init, headers: serviceHeaders(Object.fromEntries(new Headers(init.headers || {}).entries())), signal: AbortSignal.timeout(12000)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error("Review database request failed (" + response.status + "): " + raw.slice(0, 180));
  return raw ? JSON.parse(raw) : null;
}

function oneLine(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}
function isoOrNull(value: unknown): string | null {
  const text = String(value ?? "");
  if (!text) return null;
  const t = Date.parse(text);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function httpUrl(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || /[\u0000-\u001f\u007f\s]/.test(text)) return "";
  try { const u = new URL(text); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password ? u.href : ""; } catch (_) { return ""; }
}

// The same rules regmon/reviews.py applies to a GitHub review request.
export function normalizeDecision(body: any) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PublicError("The decision must be an object.");
  const decision = String(body.decision || "");
  if (!Object.prototype.hasOwnProperty.call(DECISIONS, decision)) throw new PublicError("Choose material, not material, acknowledged or action required.");
  const rationale = oneLine(body.rationale), owner = oneLine(body.owner), ticketRaw = oneLine(body.ticket);
  if (decision === "not_material" && rationale.length < 10) throw new PublicError("A not-material decision needs a rationale of at least 10 characters.");
  const ticket = ticketRaw ? httpUrl(ticketRaw) : "";
  if (ticketRaw && !ticket) throw new PublicError("Ticket must be a link (https://…).");
  const list = Array.isArray(body.events) ? body.events : [];
  if (!list.length) throw new PublicError("Choose at least one change.");
  if (list.length > MAX_EVENTS) throw new PublicError("At most " + MAX_EVENTS + " changes can be decided at once.");
  const seen = new Set<string>();
  const events = list.map((item: any) => {
    const id = String(item?.event_id || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new PublicError("A change id is not valid.");
    if (seen.has(id)) throw new PublicError("A change is listed more than once.");
    seen.add(id);
    return {
      event_id: id,
      event_type: oneLine(item?.event_type).slice(0, 40),
      url: httpUrl(item?.url).slice(0, 2000),
      detected_at: isoOrNull(item?.detected_at)
    };
  });
  return { decision, rationale, owner, ticket, events };
}

export function displayName(member: { email: string; display_name?: string }): string {
  const name = oneLine(member.display_name).slice(0, 120);
  return name || member.email.split("@")[0];
}

// The ledger record the dashboard and the sync both use.
export function ledgerRecord(row: Record<string, any>) {
  return {
    event_id: row.event_id, decision: row.decision, label: DECISIONS[row.decision] || row.decision,
    rationale: row.rationale || "", owner: row.owner || "", ticket: row.ticket || "",
    reviewed_by: row.reviewed_by_name || "", reviewed_at: row.reviewed_at, request: "dashboard " + String(row.id).slice(0, 8),
    event_type: row.event_type || null, url: row.url || null, detected_at: row.detected_at || null,
    app_id: row.id, synced: !!row.synced_at
  };
}

async function authenticatedMember(req: Request) {
  const cfg = config(), auth = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+/i.test(auth)) throw new PublicError("Sign in with your team email to record a decision.", 401);
  if (!cfg.publishable) throw new Error("Supabase publishable key is not configured.");
  const res = await fetch(cfg.url + "/auth/v1/user", { headers: { apikey: cfg.publishable, Authorization: auth }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new PublicError("Your session has expired. Sign in again.", 401);
  const user = await res.json(), email = String(user?.email || "").trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(String(user?.id || "")) || user?.is_anonymous === true || !email) throw new PublicError("Decisions need a team email account.", 403);
  if (!(user.email_confirmed_at || user.confirmed_at)) throw new PublicError("Confirm your team email address first.", 403);
  const rows = await restJson("regulatory_calendar_members?" + new URLSearchParams({ select: "email,role,active,display_name", email: "eq." + email, limit: "1" }));
  const member = Array.isArray(rows) ? rows[0] : null;
  if (!member || member.active !== true) throw new PublicError("This email is not on the team list yet. Ask an admin to add it.", 403);
  return { user, email, role: String(member.role || "viewer"), display_name: String(member.display_name || "") };
}

export function tokensMatch(supplied: string, expected: string) {
  const a = new TextEncoder().encode(supplied), b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
function requireSyncToken(req: Request, body: any) {
  const expected = config().syncToken, supplied = String(body?.token || "");
  if (!expected || supplied.length < 24 || !tokensMatch(supplied, expected)) throw new PublicError("Sync authorization failed.", 401);
}

async function decide(member: any, body: any) {
  if (member.role !== "admin" && member.role !== "editor") throw new PublicError("Your team role is read-only.", 403);
  const input = normalizeDecision(body);
  const batch = crypto.randomUUID(), name = displayName(member);
  const rows = input.events.map((event: any) => ({
    ...event, decision: input.decision, rationale: input.rationale, owner: input.owner, ticket: input.ticket,
    reviewed_by_email: member.email, reviewed_by_name: name, reviewed_by_user: member.user.id, batch_id: batch
  }));
  const saved = await restJson("change_review_decisions", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(rows) });
  return (Array.isArray(saved) ? saved : []).map(ledgerRecord);
}

Deno.serve(async (req: Request) => {
  const c = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: c.allowed ? 204 : 403, headers: c.headers });
  if (req.headers.get("origin") && !c.allowed) return respond(req, { error: "Origin not allowed." }, 403);
  if (!["GET", "POST"].includes(req.method)) return respond(req, { error: "Method not allowed." }, 405);
  try {
    if (req.method === "POST") {
      const raw = await req.text();
      if (raw.length > 60000) throw new PublicError("Request body is too large.", 413);
      let body: any = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { throw new PublicError("Request body must be valid JSON."); }
      if (body.action === "sync-pending") {
        requireSyncToken(req, body);
        const rows = await restJson("change_review_decisions?" + new URLSearchParams({ select: "*", synced_at: "is.null", order: "reviewed_at.asc", limit: "500" }));
        return respond(req, { ok: true, decisions: (Array.isArray(rows) ? rows : []).map(ledgerRecord) });
      }
      if (body.action === "sync-done") {
        requireSyncToken(req, body);
        const done = (Array.isArray(body.done) ? body.done : []).filter((x: any) => /^[0-9a-f-]{36}$/i.test(String(x?.id || ""))).slice(0, 500);
        const now = new Date().toISOString();
        for (const item of done) {
          await restJson("change_review_decisions?" + new URLSearchParams({ id: "eq." + item.id, synced_at: "is.null" }), {
            method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ synced_at: now, sync_note: oneLine(item.note).slice(0, 300) })
          });
        }
        return respond(req, { ok: true, marked: done.length });
      }
      const member = await authenticatedMember(req);
      if (body.action === "decide") return respond(req, { ok: true, decisions: await decide(member, body) });
      throw new PublicError("Unknown review action.");
    }
    const member = await authenticatedMember(req);
    const url = new URL(req.url);
    if (url.searchParams.get("action") !== "list") throw new PublicError("Use ?action=list to read decisions.");
    // The last 90 days: older decisions are in the committed ledger.
    const since = new Date(Date.now() - 90 * 86400000).toISOString();
    const rows = await restJson("change_review_decisions?" + new URLSearchParams({ select: "*", reviewed_at: "gte." + since, order: "reviewed_at.asc", limit: "2000" }));
    return respond(req, { ok: true, member: { email: member.email, role: member.role, name: displayName(member) }, decisions: (Array.isArray(rows) ? rows : []).map(ledgerRecord) });
  } catch (error) {
    const status = error instanceof PublicError ? error.status : 503;
    if (!(error instanceof PublicError)) console.error(JSON.stringify({ event: "review_api_error", error: String((error as Error)?.message || error).slice(0, 220) }));
    return respond(req, { error: error instanceof PublicError ? error.message : "Decisions are temporarily unavailable. Please retry." }, status);
  }
});
