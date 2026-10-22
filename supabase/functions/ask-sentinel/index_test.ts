// Behavioural tests for the Ask Sentinel Edge Function, run with `deno test`.
//
// The function is imported with Deno.serve captured (no port is opened) and
// fetch routed to in-memory fakes of the Supabase REST API and Groq, so the
// request handling, quota decisions, refunds and error wording are exercised
// exactly as deployed. The SQL quota functions themselves are covered by the
// migration and checked against the live database separately.

type Handler = (req: Request) => Response | Promise<Response>;
let handler: Handler | null = null;
(Deno as any).serve = (fn: Handler) => {
  handler = fn;
  return { finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {}, addr: { hostname: 'test', port: 0 } };
};

const SUPABASE = 'https://fake.supabase.test';
Deno.env.set('SUPABASE_URL', SUPABASE);
Deno.env.set('SUPABASE_PUBLISHABLE_KEYS', JSON.stringify({ default: 'sb_publishable_test' }));
Deno.env.set('SUPABASE_SECRET_KEYS', JSON.stringify({ default: 'sb_secret_test' }));
Deno.env.set('GROQ_API', 'gsk_test');
Deno.env.set('ASK_SENTINEL_IP_DAILY_LIMIT', '5');
Deno.env.set('ASK_SENTINEL_GLOBAL_DAILY_LIMIT', '8');

type Fake = {
  users: Map<string, number>; ips: Map<string, number>; global: number;
  groq: () => Response; refunds: number; v2: boolean; lastIpHash: string;
};
const fake: Fake = { users: new Map(), ips: new Map(), global: 0, groq: () => groqAnswer(), refunds: 0, v2: true, lastIpHash: '' };
function reset(groq?: () => Response) {
  fake.users = new Map(); fake.ips = new Map(); fake.global = 0; fake.refunds = 0; fake.v2 = true;
  fake.groq = groq || (() => groqAnswer());
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function groqAnswer(text = 'The latest run changed nothing. [Source: data/report.json]') {
  return json({ choices: [{ message: { content: text } }] });
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url.hostname === 'api.groq.com') return fake.groq();
  if (url.origin !== SUPABASE) return realFetch(input, init);
  const path = url.pathname;
  if (path === '/auth/v1/user') return json({ id: '11111111-2222-4333-8444-555555555555', is_anonymous: true });
  if (path === '/rest/v1/ask_sentinel_index_state') return json([{ commit_sha: 'abc', document_count: 4000, indexed_at: '2026-10-21T00:00:00Z' }]);
  if (path === '/rest/v1/rpc/search_ask_sentinel_chunks') return json([{ path: 'data/report.json', doc_type: 'monitoring report', content: 'run_id=r1 changed=0', is_core: false, score: 1 }]);
  if (path === '/rest/v1/ask_sentinel_chunks') return json([]);
  if (path === '/rest/v1/ask_sentinel_usage') return json([]);
  if (path === '/rest/v1/rpc/consume_ask_sentinel_request_v2') {
    if (!fake.v2) return json({ code: 'PGRST202', message: 'Could not find the function' }, 404);
    fake.lastIpHash = body.p_ip_hash;
    if (fake.global >= body.p_global_limit) return json([{ allowed: false, remaining: 0, reason: 'global_limit' }]);
    const ip = fake.ips.get(body.p_ip_hash) || 0;
    if (ip >= body.p_ip_limit) return json([{ allowed: false, remaining: 0, reason: 'ip_limit' }]);
    const used = fake.users.get(body.p_user_id) || 0;
    if (used >= 3) return json([{ allowed: false, remaining: 0, reason: 'user_limit' }]);
    fake.global += 1; fake.ips.set(body.p_ip_hash, ip + 1); fake.users.set(body.p_user_id, used + 1);
    return json([{ allowed: true, remaining: 3 - (used + 1), reason: 'ok' }]);
  }
  if (path === '/rest/v1/rpc/consume_ask_sentinel_request') {
    const used = fake.users.get(body.p_user_id) || 0;
    if (used >= 3) return json([{ allowed: false, remaining: 0 }]);
    fake.users.set(body.p_user_id, used + 1);
    return json([{ allowed: true, remaining: 3 - (used + 1) }]);
  }
  if (path === '/rest/v1/rpc/refund_ask_sentinel_request') {
    fake.refunds += 1;
    const used = Math.max(0, (fake.users.get(body.p_user_id) || 0) - 1);
    fake.users.set(body.p_user_id, used);
    return json(3 - used);
  }
  return json({ message: 'unexpected ' + path }, 500);
}) as typeof fetch;

await import('./index.ts');
if (!handler) throw new Error('the function did not register a handler');

let visitorCounter = 0;
function visitor() {
  visitorCounter += 1;
  return '00000000-0000-4000-8000-' + String(visitorCounter).padStart(12, '0');
}
async function ask(options: { visitor?: string; ip?: string; bearer?: string; question?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', origin: 'https://gauravdarwesh.github.io' };
  if (options.bearer) headers.authorization = 'Bearer ' + options.bearer;
  else headers['x-ask-sentinel-visitor-id'] = options.visitor || visitor();
  if (options.ip) headers['cf-connecting-ip'] = options.ip;
  const response = await handler!(new Request('https://fn.test/ask-sentinel', {
    method: 'POST', headers, body: JSON.stringify({ question: options.question || 'What happened in the latest scan run?', conversation: [] })
  }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}
function assertEquals(actual: unknown, expected: unknown, message = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message + ' expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
}

Deno.test('greetings return a friendly answer without a provider call or quota use', async () => {
  reset(() => { throw new Error('Groq should not be called for a greeting'); });
  const answer = await ask({ ip: '203.0.113.10', question: 'hi' });
  assertEquals([answer.status, answer.body.model, answer.body.remaining, fake.global], [200, 'local-response', 3, 0]);
  if (!String(answer.body.answer).includes('Hello! I’m Ask Sentinel')) throw new Error('greeting response was missing');
});

Deno.test('paragraph-level citations are accepted while invalid paths still fail closed', async () => {
  reset(() => groqAnswer('The latest run had no changes.\nThe fetch and extraction error counts are zero. [Source: data/report.json]'));
  const accepted = await ask({ ip: '203.0.113.11' });
  assertEquals([accepted.status, accepted.body.answer], [200, 'The latest run had no changes.\nThe fetch and extraction error counts are zero. [Source: data/report.json]']);

  reset(() => groqAnswer('The latest run had no changes. [Source: data/fabricated.json]'));
  const rejected = await ask({ ip: '203.0.113.12' });
  assertEquals([rejected.status, rejected.body.error_code, fake.refunds], [422, 'citation_validation_failed', 1]);
});

Deno.test('a visitor gets three questions a day', async () => {
  reset();
  const id = visitor();
  for (const expected of [2, 1, 0]) {
    const answer = await ask({ visitor: id, ip: '203.0.113.1' });
    assertEquals([answer.status, answer.body.remaining], [200, expected]);
  }
  const refused = await ask({ visitor: id, ip: '203.0.113.1' });
  assertEquals([refused.status, refused.body.error_code], [429, 'user_daily_limit']);
});

Deno.test('fresh visitor IDs cannot get past the network limit', async () => {
  reset();
  const statuses: number[] = [];
  for (let i = 0; i < 7; i += 1) statuses.push((await ask({ ip: '198.51.100.7' })).status);
  assertEquals(statuses, [200, 200, 200, 200, 200, 429, 429]);
  const refused = await ask({ ip: '198.51.100.7' });
  assertEquals(refused.body.error_code, 'network_daily_limit');
  if (!refused.headers.get('Retry-After')) throw new Error('a refused request should say when to retry');
  // Another network is unaffected.
  assertEquals((await ask({ ip: '198.51.100.8' })).status, 200);
});

Deno.test('the service stops at its daily ceiling whatever the identity or network', async () => {
  reset();
  for (let i = 0; i < 8; i += 1) assertEquals((await ask({ ip: '192.0.2.' + i })).status, 200);
  const refused = await ask({ ip: '192.0.2.200' });
  assertEquals([refused.status, refused.body.error_code], [503, 'service_daily_limit']);
});

Deno.test('the network bucket is a keyed hash, never the address', async () => {
  reset();
  await ask({ ip: '203.0.113.99' });
  if (fake.lastIpHash.includes('203.0.113') || !/^[0-9a-f]{32}$/.test(fake.lastIpHash)) throw new Error('unexpected bucket ' + fake.lastIpHash);
});

Deno.test('a provider outage gives the question back', async () => {
  reset(() => json({ error: 'rate limited' }, 429));
  const id = visitor();
  const answer = await ask({ visitor: id, ip: '203.0.113.5' });
  assertEquals([answer.status, answer.body.error_code, answer.body.remaining, fake.refunds], [503, 'provider_rate_limited', 3, 1]);
  assertEquals(answer.headers.get('Retry-After'), '60');
});

Deno.test('an answer rejected by citation validation gives the question back', async () => {
  reset(() => groqAnswer('An uncited claim.'));
  const answer = await ask({ ip: '203.0.113.6' });
  assertEquals([answer.status, answer.body.error_code, answer.body.remaining, fake.refunds], [422, 'citation_validation_failed', 3, 1]);
});

Deno.test('internal failures are not echoed to the browser', async () => {
  reset();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.includes('search_ask_sentinel_chunks')) return new Response('secret database detail', { status: 500 });
    return original(input, init);
  }) as typeof fetch;
  try {
    const answer = await ask({ ip: '203.0.113.7' });
    assertEquals(answer.status, 503);
    if (JSON.stringify(answer.body).includes('secret database detail')) throw new Error('internal error text leaked');
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test('signed-in sessions use the same limits', async () => {
  reset();
  for (const expected of [2, 1, 0]) assertEquals((await ask({ bearer: 'token', ip: '203.0.113.8' })).body.remaining, expected);
  assertEquals((await ask({ bearer: 'token', ip: '203.0.113.8' })).body.error_code, 'user_daily_limit');
});

Deno.test('before the migration is applied the original per-user quota still applies', async () => {
  reset();
  fake.v2 = false;
  const id = visitor();
  assertEquals((await ask({ visitor: id, ip: '203.0.113.9' })).body.remaining, 2);
});
