// Unit and handler tests for the review-api Edge Function.
type Handler = (req: Request) => Response | Promise<Response>;
let handler: Handler | null = null;
(Deno as any).serve = (fn: Handler) => { handler = fn; return { finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {}, addr: { hostname: "test", port: 0 } }; };
const SUPABASE = "https://fake.supabase.test";
const TOKEN = "review-sync-token-with-at-least-32-chars";
Deno.env.set("SUPABASE_URL", SUPABASE);
Deno.env.set("SUPABASE_PUBLISHABLE_KEYS", JSON.stringify({ default: "sb_publishable_test" }));
Deno.env.set("SUPABASE_SECRET_KEYS", JSON.stringify({ default: "sb_secret_test" }));
Deno.env.set("REVIEW_SYNC_TOKEN", TOKEN);
const fake: { role: string | null; anonymous: boolean; rows: any[]; next: number } = { role: "editor", anonymous: false, rows: [], next: 1 };
function reset() { fake.role = "editor"; fake.anonymous = false; fake.rows = []; fake.next = 1; }
function json(v: unknown, status = 200) { return new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } }); }
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = String(init?.method || "GET").toUpperCase(), path = u.pathname, body = init?.body ? JSON.parse(String(init.body)) : {};
  if (u.origin !== SUPABASE) return realFetch(input, init);
  if (path === "/auth/v1/user") return json({ id: "11111111-2222-4333-8444-555555555555", is_anonymous: fake.anonymous, email: "Reviewer@Example.test", email_confirmed_at: "2026-01-01T00:00:00Z" });
  if (path === "/rest/v1/regulatory_calendar_members") return json(fake.role ? [{ email: "reviewer@example.test", role: fake.role, active: true, display_name: "" }] : []);
  if (path === "/rest/v1/change_review_decisions") {
    if (method === "POST") {
      const saved = (Array.isArray(body) ? body : [body]).map((row: any) => ({ id: "00000000-0000-4000-8000-" + String(fake.next++).padStart(12, "0"), reviewed_at: "2026-11-01T10:00:00.000Z", synced_at: null, ...row }));
      fake.rows.push(...saved);
      return json(saved, 201);
    }
    if (method === "GET") return json(u.searchParams.get("synced_at") === "is.null" ? fake.rows.filter(r => !r.synced_at) : fake.rows);
    if (method === "PATCH") {
      const id = u.searchParams.get("id")?.replace(/^eq\./, "");
      fake.rows.filter(r => r.id === id && !r.synced_at).forEach(r => Object.assign(r, body));
      return new Response(null, { status: 204 });
    }
  }
  return json({ message: "unexpected " + method + " " + path }, 500);
}) as typeof fetch;
const api = await import("./index.ts");
if (!handler) throw new Error("review-api did not register a handler");
function assertEquals(actual: unknown, expected: unknown, message = "") { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message + " expected " + JSON.stringify(expected) + " got " + JSON.stringify(actual)); }
const EVENT = "a".repeat(64);
const ORIGIN = "https://gauravdarwesh.github.io";
function post(body: unknown, auth = "Bearer user") {
  return handler!(new Request("https://fn.test/review-api", { method: "POST", headers: { "Content-Type": "application/json", origin: ORIGIN, authorization: auth }, body: JSON.stringify(body) }));
}

Deno.test("decisions follow the ledger's rules", () => {
  assertEquals(api.normalizeDecision({ decision: "material", events: [{ event_id: EVENT }] }).decision, "material");
  const bad = [
    { decision: "maybe", events: [{ event_id: EVENT }] },
    { decision: "not_material", rationale: "short", events: [{ event_id: EVENT }] },
    { decision: "material", ticket: "javascript:alert(1)", events: [{ event_id: EVENT }] },
    { decision: "material", events: [] },
    { decision: "material", events: [{ event_id: "not-a-hash" }] },
    { decision: "material", events: [{ event_id: EVENT }, { event_id: EVENT }] },
    { decision: "material", events: Array.from({ length: 51 }, (_, i) => ({ event_id: i.toString(16).padStart(64, "0") })) }
  ];
  for (const input of bad) {
    let rejected = false;
    try { api.normalizeDecision(input); } catch (_) { rejected = true; }
    if (!rejected) throw new Error("invalid decision accepted: " + JSON.stringify(input).slice(0, 120));
  }
});

Deno.test("a signed-in editor records a decision under their own name", async () => {
  reset();
  const res = await post({ action: "decide", decision: "action_required", rationale: "Land ADC rows change our capital schedule.", owner: "Capital reporting", ticket: "https://tracker.example.test/REG-1", events: [{ event_id: EVENT, event_type: "CHANGED_URL", url: "https://www.osfi-bsif.gc.ca/x", detected_at: "2026-10-30T16:51:00Z" }] });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals([body.decisions.length, body.decisions[0].decision, body.decisions[0].label, body.decisions[0].reviewed_by], [1, "action_required", "Action required", "reviewer"]);
  assertEquals([fake.rows[0].reviewed_by_email, fake.rows[0].reviewed_by_user], ["reviewer@example.test", "11111111-2222-4333-8444-555555555555"]);
});

Deno.test("visitors, unknown emails and viewers cannot record decisions", async () => {
  reset();
  let res = await handler!(new Request("https://fn.test/review-api", { method: "POST", headers: { "Content-Type": "application/json", origin: ORIGIN }, body: JSON.stringify({ action: "decide", decision: "material", events: [{ event_id: EVENT }] }) }));
  assertEquals(res.status, 401);
  fake.anonymous = true;
  res = await post({ action: "decide", decision: "material", events: [{ event_id: EVENT }] });
  assertEquals(res.status, 403);
  fake.anonymous = false; fake.role = null;
  res = await post({ action: "decide", decision: "material", events: [{ event_id: EVENT }] });
  assertEquals(res.status, 403);
  fake.role = "viewer";
  res = await post({ action: "decide", decision: "material", events: [{ event_id: EVENT }] });
  assertEquals([res.status, fake.rows.length], [403, 0]);
});

Deno.test("the sync reads pending decisions and marks them done only with its token", async () => {
  reset();
  await post({ action: "decide", decision: "material", events: [{ event_id: EVENT }] });
  let res = await post({ action: "sync-pending", token: "wrong-token-wrong-token-wrong" }, "");
  assertEquals(res.status, 401);
  res = await post({ action: "sync-pending", token: TOKEN }, "");
  const pending = (await res.json()).decisions;
  assertEquals([res.status, pending.length, pending[0].synced], [200, 1, false]);
  res = await post({ action: "sync-done", token: TOKEN, done: [{ id: pending[0].app_id }] }, "");
  assertEquals(res.status, 200);
  res = await post({ action: "sync-pending", token: TOKEN }, "");
  assertEquals((await res.json()).decisions.length, 0);
});

Deno.test("only listed origins are answered", async () => {
  const res = await handler!(new Request("https://fn.test/review-api?action=list", { method: "GET", headers: { origin: "https://evil.example", authorization: "Bearer user" } }));
  assertEquals(res.status, 403);
});
