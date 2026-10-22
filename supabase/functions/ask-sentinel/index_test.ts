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
let fakeCurrentPageRows: any[] = [];
let fakeEvidenceRows = new Map<string, any[]>();
let fakeFetchedPaths: string[] = [];
let lastGroqMessages: any[] = [];
const fake: Fake = { users: new Map(), ips: new Map(), global: 0, groq: () => groqAnswer(), refunds: 0, v2: true, lastIpHash: '' };
function reset(groq?: () => Response) {
  fake.users = new Map(); fake.ips = new Map(); fake.global = 0; fake.refunds = 0; fake.v2 = true;
  fakeCurrentPageRows = []; fakeEvidenceRows = new Map(); fakeFetchedPaths = []; lastGroqMessages = [];
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
  if (url.hostname === 'api.groq.com') { lastGroqMessages = body.messages || []; return fake.groq(); }
  if (url.origin !== SUPABASE) return realFetch(input, init);
  const path = url.pathname;
  if (path === '/auth/v1/user') return json({ id: '11111111-2222-4333-8444-555555555555', is_anonymous: true });
  if (path === '/rest/v1/ask_sentinel_index_state') return json([{ commit_sha: 'abc', document_count: 4000, indexed_at: '2026-10-21T00:00:00Z' }]);
  if (path === '/rest/v1/rpc/search_ask_sentinel_chunks') return json([{ path: 'data/report.json', doc_type: 'monitoring report', content: 'run_id=r1 changed=0', is_core: false, score: 1 }]);
  if (path === '/rest/v1/ask_sentinel_chunks') {
    const pathFilter = url.searchParams.get('path') || '';
    if (pathFilter === 'like.__current_page__/*') {
      const contentFilter = url.searchParams.get('content') || '';
      const hostMatch = contentFilter.match(/^like\.\*(.+)\*$/);
      const host = hostMatch?.[1]?.toLowerCase() || '';
      const rows = fakeCurrentPageRows
        .filter((row) => String(row.path || '').startsWith('__current_page__/'))
        .filter((row) => !host || String(row.content || '').toLowerCase().includes(host))
        .sort((a, b) => String(a.path).localeCompare(String(b.path)));
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 200);
      return json(rows.slice(offset, offset + limit));
    }
    if (pathFilter.startsWith('eq.')) { const exactPath = pathFilter.slice(3); fakeFetchedPaths.push(exactPath); return json(fakeEvidenceRows.get(exactPath) || []); }
    return json([]);
  }
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

Deno.test('help with punctuation is answered locally without Groq or quota use', async () => {
  reset(() => { throw new Error('Groq should not be called for help'); });
  const answer = await ask({ ip: '203.0.113.20', question: 'what can you do??' });
  assertEquals([answer.status, answer.body.model, answer.body.remaining, fake.global], [200, 'local-response', 3, 0]);
  if (!String(answer.body.answer).includes('last 7 days')) throw new Error('help answer should include a useful example');
});

Deno.test('natural help phrasing returns a local answer without Groq or quota use', async () => {
  reset(() => { throw new Error('Groq should not be called for natural help phrasing'); });
  const answer = await ask({ ip: '203.0.113.28', question: 'what can you do for me?' });
  assertEquals([answer.status, answer.body.model, answer.body.remaining, fake.global], [200, 'local-response', 3, 0]);
  if (!String(answer.body.answer).includes('what changes came today?')) throw new Error('help answer should include a same-day example');
});

Deno.test('today change phrasing fetches current report and recent history', async () => {
  reset();
  const answer = await ask({ ip: '203.0.113.29', question: 'What changes came today?' });
  assertEquals(answer.status, 200);
  if (!fakeFetchedPaths.includes('__current_report__')) throw new Error('today query did not fetch the current report');
  if (!fakeFetchedPaths.includes('__recent_history__')) throw new Error('today query did not fetch recent history');
});

Deno.test('same-day and seven-day questions load concrete changed-page evidence', async () => {
  const todayEvidence = 'data/evidence/' + 'b'.repeat(64) + '.json';
  const olderEvidence = 'data/evidence/' + 'c'.repeat(64) + '.json';
  const now = Date.now();
  reset(() => groqAnswer('A monitored Federal Reserve page changed. [Source: ' + todayEvidence + ']'));
  fakeCurrentPageRows = [{
    path: '__current_page__/fed-reporting-forms-pilot/review',
    doc_type: 'current monitored URL record',
    is_core: false,
    content: JSON.stringify({
      source_name: 'Federal Reserve Reporting Forms Pilot',
      regulator: 'Board of Governors of the Federal Reserve System',
      canonical_url: 'https://www.federalreserve.gov/apps/reportingforms/review',
      configured_source_active: true,
      last_checked: new Date(now).toISOString(),
      change_history: [
        {
          timestamp: new Date(now - 60 * 60 * 1000).toISOString(),
          event_type: 'CHANGED_URL',
          ai_relevant: true,
          ai_topic: 'Reporting forms list update',
          ai_summary: 'Today the list removed FR Y-9C R-1867 and FFIEC 031 entries.',
          evidence_location: todayEvidence
        },
        {
          timestamp: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
          event_type: 'CHANGED_URL',
          ai_relevant: true,
          ai_topic: 'Earlier reporting forms update',
          ai_summary: 'An earlier reporting forms entry was added.',
          evidence_location: olderEvidence
        }
      ],
      evidence_location: todayEvidence
    })
  }];
  fakeEvidenceRows.set(todayEvidence, [{
    path: todayEvidence, doc_type: 'monitoring evidence', is_core: false,
    content: 'The reporting forms list removed FR Y-9C R-1867 and FFIEC 031 entries.'
  }]);
  fakeEvidenceRows.set(olderEvidence, [{
    path: olderEvidence, doc_type: 'monitoring evidence', is_core: false,
    content: 'An earlier reporting forms entry was added.'
  }]);

  const today = await ask({ ip: '203.0.113.33', question: 'What changes came today?' });
  assertEquals(today.status, 200);
  let prompt = lastGroqMessages.map((message) => String(message.content || '')).join('\\n');
  if (!prompt.includes('Today the list removed FR Y-9C R-1867 and FFIEC 031 entries.')) {
    throw new Error('today query did not prioritize the current page change summary');
  }
  if (!prompt.includes('https://www.federalreserve.gov/apps/reportingforms/review')) {
    throw new Error('today query context is missing the source URL');
  }
  if (prompt.includes('An earlier reporting forms entry was added.')) {
    throw new Error('today query should exclude changes outside its one-day window');
  }

  const week = await ask({ ip: '203.0.113.34', question: 'Summarize changes over the last 7 days and link their sources.' });
  assertEquals(week.status, 200);
  prompt = lastGroqMessages.map((message) => String(message.content || '')).join('\\n');
  if (!prompt.includes('An earlier reporting forms entry was added.')) {
    throw new Error('seven-day query missed an event within the requested window');
  }
});

Deno.test('citation formatting is repaired once before an answer is rejected', async () => {
  let calls = 0;
  reset(() => {
    calls += 1;
    return calls === 1
      ? groqAnswer('The latest run had no changes.')
      : groqAnswer('The latest run had no changes. [Source: data/report.json]');
  });
  const answer = await ask({ ip: '203.0.113.30' });
  assertEquals([answer.status, answer.body.answer, calls], [200, 'The latest run had no changes. [Source: data/report.json]', 2]);
  if (!lastGroqMessages.some((message) => String(message.content || '').includes('Draft answer to repair'))) {
    throw new Error('repair prompt did not include the draft to repair');
  }
});

Deno.test('named FRB link queries retrieve matching active page evidence', async () => {
  const evidencePath = 'data/evidence/' + 'a'.repeat(64) + '.json';
  reset(() => groqAnswer('The Federal Reserve reporting-forms page is actively monitored and was checked successfully. [Source: ' + evidencePath + ']'));
  fakeCurrentPageRows = [{
    path: '__current_page__/fed-reporting-forms-pilot/review',
    doc_type: 'current monitored URL record',
    is_core: false,
    content: JSON.stringify({
      canonical_url: 'https://www.federalreserve.gov/apps/reportingforms/review',
      configured_source_active: true,
      last_checked: '2026-10-22T06:54:49.381237Z',
      evidence_location: evidencePath,
      change_history: [{
        timestamp: '2026-10-22T04:23:52Z',
        evidence_location: evidencePath,
        ai_summary: 'A reporting forms list changed'
      }]
    })
  }];
  fakeEvidenceRows.set(evidencePath, [{
    path: evidencePath, doc_type: 'monitoring evidence', is_core: false,
    content: 'Evidence for the Federal Reserve reporting forms page change.'
  }]);
  const answer = await ask({ ip: '203.0.113.31', question: 'tell me about the frb link' });
  assertEquals(answer.status, 200);
  if (!fakeFetchedPaths.includes(evidencePath)) throw new Error('FRB query did not load matching page evidence');
  const evidenceMessage = lastGroqMessages.map((message) => String(message.content || '')).join('\\n');
  if (!evidenceMessage.includes('https://www.federalreserve.gov/apps/reportingforms/review')) {
    throw new Error('FRB response context is missing the canonical monitored URL.');
  }
  if (evidenceMessage.indexOf('Source path: __current_page__/') > evidenceMessage.indexOf('Source path: ' + evidencePath)) {
    throw new Error('FRB page record should precede its supporting evidence.');
  }
});

Deno.test('transient provider transport failures retry once', async () => {
  let calls = 0;
  reset(() => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return groqAnswer('The latest run changed nothing. [Source: data/report.json]');
  });
  const answer = await ask({ ip: '203.0.113.32' });
  assertEquals([answer.status, calls], [200, 2]);
});

Deno.test('a second cited-answer repair fixes one remaining uncited paragraph', async () => {
  let calls = 0;
  reset(() => {
    calls += 1;
    if (calls === 1) return groqAnswer('The latest run had no changes.');
    if (calls === 2) return groqAnswer(
      'The latest run had no changes. [Source: data/report.json]\n\nAn additional detail from the report.'
    );
    return groqAnswer('The latest run had no changes. [Source: data/report.json]');
  });
  const answer = await ask({ ip: '203.0.113.35' });
  assertEquals([answer.status, answer.body.answer, calls], [200, 'The latest run had no changes. [Source: data/report.json]', 3]);
  const repairPrompt = lastGroqMessages.map((message) => String(message.content || '')).join('\\n');
  if (!repairPrompt.includes('uncited_line_count=1')) throw new Error('second repair prompt omitted validator feedback');
  if (!repairPrompt.includes('data/report.json')) throw new Error('second repair prompt omitted allowed source paths');
});

Deno.test('a provider error during citation repair still permits the second bounded attempt', async () => {
  let calls = 0;
  reset(() => {
    calls += 1;
    if (calls === 1) return groqAnswer('The latest run had no changes.');
    if (calls === 2) return json({ error: 'temporary provider request error' }, 400);
    return groqAnswer('The latest run had no changes. [Source: data/report.json]');
  });
  const answer = await ask({ ip: '203.0.113.36' });
  assertEquals([answer.status, answer.body.answer, calls], [200, 'The latest run had no changes. [Source: data/report.json]', 3]);
});

Deno.test('citation failure returns a verified source fallback instead of a dead-end error', async () => {
  let calls = 0;
  reset(() => {
    calls += 1;
    if (calls === 1) return groqAnswer('The latest run had no changes.');
    if (calls === 2) return json({ error: 'temporary provider request error' }, 400);
    return groqAnswer('Still no usable citation.');
  });
  const answer = await ask({ ip: '203.0.113.37' });
  assertEquals([answer.status, answer.body.model, answer.body.evidence_fallback, fake.refunds], [200, 'evidence-fallback', true, 0]);
  if (!String(answer.body.answer).includes('[Source: data/report.json]')) {
    throw new Error('fallback did not return an allowed indexed source citation');
  }
});

Deno.test('paragraph citations pass and invalid model output falls back to validated indexed sources', async () => {
  reset(() => groqAnswer('The latest run had no changes.\nThe fetch and extraction error counts are zero. [Source: data/report.json]'));
  const accepted = await ask({ ip: '203.0.113.11' });
  assertEquals([accepted.status, accepted.body.answer], [200, 'The latest run had no changes.\nThe fetch and extraction error counts are zero. [Source: data/report.json]']);

  reset(() => groqAnswer('The latest run had no changes. [Source: data/fabricated.json]'));
  const rejected = await ask({ ip: '203.0.113.12' });
  assertEquals([rejected.status, rejected.body.model, rejected.body.evidence_fallback, fake.refunds], [200, 'evidence-fallback', true, 0]);
  if (!String(rejected.body.answer).includes('[Source: data/report.json]')) throw new Error('unsafe citation output was not replaced by a safe source fallback');

  reset(() => groqAnswer('- The latest run had no changes. [Source: data/report.json]\n- Fetch errors are zero.'));
  const uncitedBullet = await ask({ ip: '203.0.113.13' });
  assertEquals([uncitedBullet.status, uncitedBullet.body.model, uncitedBullet.body.evidence_fallback, fake.refunds], [200, 'evidence-fallback', true, 0]);
});

Deno.test('an exact URL retrieves its stored evidence before fuzzy search results', async () => {
  reset();
  const url = 'https://www.federalreserve.gov/apps/reportingforms/review';
  const evidencePath = 'data/evidence/' + 'a'.repeat(64) + '.json';
  fakeCurrentPageRows = [{
    path: '__current_page__/fed-reporting-forms-pilot/url-id',
    doc_type: 'current monitored URL record',
    is_core: false,
    content: JSON.stringify({
      canonical_url: url,
      configured_source_active: true,
      evidence_location: evidencePath,
      snapshot_location: null,
      change_history: [{ event_type: 'CHANGED_URL', ai_summary: 'A reporting forms table row was removed.' }]
    })
  }];
  fakeEvidenceRows.set(evidencePath, [{
    path: evidencePath, doc_type: 'monitoring evidence', is_core: false,
    content: 'CHANGED_URL: reporting forms table row removed.', score: 10
  }]);
  const answer = await ask({ ip: '203.0.113.22', question: 'Tell me about this page: ' + url });
  assertEquals(answer.status, 200);
  const evidenceMessage = lastGroqMessages.map((message) => String(message.content || '')).join('\\n');
  if (!evidenceMessage.includes(evidencePath)) throw new Error('Exact URL evidence path was not passed to Groq.');
  if (!evidenceMessage.includes('CHANGED_URL: reporting forms table row removed.')) throw new Error('Exact URL evidence content was not passed to Groq.');
  if (evidenceMessage.indexOf('Source path: __current_page__/') > evidenceMessage.indexOf('Source path: ' + evidencePath)) {
    throw new Error('Exact current page record should precede its supporting evidence in the bounded context.');
  }
});

Deno.test('exact URL retrieval paginates past unrelated earlier records', async () => {
  reset();
  const url = 'https://www.federalreserve.gov/apps/reportingforms/review';
  const evidencePath = 'data/evidence/' + 'a'.repeat(64) + '.json';
  fakeCurrentPageRows = Array.from({ length: 205 }, (_, index) => ({
    path: '__current_page__/aaa-legacy-source/url-' + String(index).padStart(3, '0'),
    doc_type: 'current monitored URL record',
    is_core: false,
    content: JSON.stringify({
      canonical_url: 'https://www.federalreserve.gov/legacy/page-' + index,
      configured_source_active: false,
      evidence_location: null
    })
  }));
  fakeCurrentPageRows.push({
    path: '__current_page__/fed-reporting-forms-pilot/url-id',
    doc_type: 'current monitored URL record',
    is_core: false,
    content: JSON.stringify({ canonical_url: url, configured_source_active: true, evidence_location: evidencePath })
  });
  fakeEvidenceRows.set(evidencePath, [{
    path: evidencePath, doc_type: 'monitoring evidence', is_core: false,
    content: 'CHANGED_URL: reporting forms table row removed.', score: 10
  }]);
  const answer = await ask({ ip: '203.0.113.22', question: url + ' - what changed in this link?' });
  assertEquals(answer.status, 200);
  const evidenceMessage = lastGroqMessages.map((message) => String(message.content || '')).join('\n');
  if (!evidenceMessage.includes(evidencePath)) throw new Error('Exact URL evidence path was not passed to Groq after pagination.');
});

Deno.test('exact URL matching preserves case-sensitive path segments', async () => {
  reset();
  const evidencePath = 'data/evidence/' + 'b'.repeat(64) + '.json';
  fakeCurrentPageRows = [{
    path: '__current_page__/fed-reporting-forms-detail-pilot/url-id',
    doc_type: 'current monitored URL record',
    is_core: false,
    content: JSON.stringify({
      canonical_url: 'https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-9C',
      configured_source_active: true,
      evidence_location: evidencePath
    })
  }];
  fakeEvidenceRows.set(evidencePath, [{
    path: evidencePath, doc_type: 'monitoring evidence', is_core: false,
    content: 'This record belongs only to the uppercase URL path.'
  }]);
  const answer = await ask({
    ip: '203.0.113.23',
    question: 'https://www.federalreserve.gov/apps/reportingforms/report/index/fr_y-9c - what changed?'
  });
  assertEquals(answer.status, 200);
  const evidenceMessage = lastGroqMessages.map((message) => String(message.content || '')).join('\n');
  if (evidenceMessage.includes(evidencePath)) throw new Error('Case-different URL incorrectly matched an indexed page record.');
});

Deno.test('Markdown tables require citations on factual rows, not just the paragraph', async () => {
  reset(() => groqAnswer(
    'Regulator | Change\n--- | ---\nFederal Reserve | Change detected in reporting forms. [Source: data/report.json]\nOSFI | Another change detected without a citation.'
  ));
  const answer = await ask({ ip: '203.0.113.24' });
  assertEquals([answer.status, answer.body.model, answer.body.evidence_fallback], [200, 'evidence-fallback', true]);
  if (!String(answer.body.answer).includes('[Source: data/report.json]')) throw new Error('uncited table output was not replaced with an indexed source fallback');
});

Deno.test('Markdown tables accept a structurally valid header and a cited data row', async () => {
  reset(() => groqAnswer(
    'Regulator | Change\n--- | ---\nFederal Reserve | No changes recorded. [Source: data/report.json]'
  ));
  const answer = await ask({ ip: '203.0.113.25' });
  assertEquals(answer.status, 200);
});

Deno.test('natural monitoring-scope wording selects the authoritative scope record', async () => {
  reset();
  const answer = await ask({ ip: '203.0.113.26', question: 'What is Sentinel currently monitoring?' });
  assertEquals(answer.status, 200);
  if (!fakeFetchedPaths.includes('__current_scope__')) throw new Error('Natural scope question did not fetch the authoritative scope record.');
});

Deno.test('nested factual list items need their own citation', async () => {
  reset(() => groqAnswer(
    'Summary of the changes.\n  - An additional factual finding without a citation.\nSupporting details. [Source: data/report.json]'
  ));
  const answer = await ask({ ip: '203.0.113.27' });
  assertEquals([answer.status, answer.body.model, answer.body.evidence_fallback], [200, 'evidence-fallback', true]);
  if (!String(answer.body.answer).includes('[Source: data/report.json]')) throw new Error('uncited nested list was not replaced with an indexed source fallback');
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

Deno.test('truncated model output is discarded in favor of cited indexed-source fallback', async () => {
  reset(() => json({ choices: [{ message: { content: 'Partial. [Source: data/report.json]' }, finish_reason: 'length' }] }));
  const answer = await ask({ ip: '203.0.113.28' });
  assertEquals([answer.status, answer.body.model, answer.body.evidence_fallback, fake.refunds], [200, 'evidence-fallback', true, 1]);
  if (String(answer.body.answer).includes('Partial.')) throw new Error('truncated model draft must never be shown');
  if (!String(answer.body.answer).includes('[Source: data/report.json]')) throw new Error('fallback is missing the exact indexed source path');
});

Deno.test('a provider rate limit returns validated indexed-source evidence and refunds the AI call', async () => {
  reset(() => json({ error: 'rate limited' }, 429));
  const id = visitor();
  const answer = await ask({ visitor: id, ip: '203.0.113.5' });
  assertEquals([answer.status, answer.body.model, answer.body.evidence_fallback, answer.body.remaining, fake.refunds], [200, 'evidence-fallback', true, 3, 1]);
  if (!String(answer.body.answer).includes('[Source: data/report.json]')) throw new Error('rate-limit fallback is missing the exact indexed source path');
});

Deno.test('an answer rejected by citation validation returns a safe source fallback', async () => {
  reset(() => groqAnswer('An uncited claim.'));
  const answer = await ask({ ip: '203.0.113.6' });
  assertEquals([answer.status, answer.body.model, answer.body.evidence_fallback, answer.body.remaining, fake.refunds], [200, 'evidence-fallback', true, 2, 0]);
  if (!String(answer.body.answer).includes('[Source: data/report.json]')) throw new Error('source fallback did not point to the allowed indexed record');
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
