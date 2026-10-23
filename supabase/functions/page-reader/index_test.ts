// Tests for the page reader. Network calls go to a fake fetcher; nothing leaves the machine.
(Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {}, addr: { hostname: 'test', port: 0 } });
const { checkUrl, isPrivateAddress, readHtml, readPage, formatOf, spend, handle, PublicError } = await import('./index.ts');

function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }
function eq(a: unknown, b: unknown, message: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(message + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }

Deno.test('private and internal addresses are refused', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '0.0.0.0', '192.0.2.1', '2001:db8::1']) {
    assert(isPrivateAddress(address), address + ' should be private or reserved');
  }
  for (const address of ['8.8.8.8', '151.101.1.1', '2606:4700::1111', '64:ff9b::808:808']) {
    assert(!isPrivateAddress(address), address + ' should be public');
  }
  for (const raw of ['http://localhost/', 'http://intranet.local/x', 'http://10.0.0.1/', 'ftp://example.gov/', 'https://user:pw@example.gov/', 'https://example.gov:22/', 'http://[::1]/']) {
    let refused = false;
    try { checkUrl(raw); } catch (error) { refused = error instanceof PublicError; }
    assert(refused, raw + ' should be refused');
  }
  eq(checkUrl('https://www.example.gov/a#b').href, 'https://www.example.gov/a', 'fragments are dropped');
});

Deno.test('the copy has no script and every link is absolute, numbered and sectioned', () => {
  const html = `<html><head><title>TIC forms</title><base href="https://home.example.gov/data/tic/"><script>steal()</script>
    <meta http-equiv="refresh" content="0;url=https://evil.example"></head><body onload="x()">
    <h2>Current forms</h2><a href="forms/BC.pdf" onclick="y()" target="_blank">Form BC</a>
    <a href="javascript:alert(1)">bad</a><a href="#top">top</a>
    <h3>Historical forms</h3><a href="https://docs.example.gov/BC-2019.pdf"><img src="i.png" alt="Form BC 2019"></a>
    <a href="forms/BC.pdf">Form BC again</a><iframe src="https://evil.example"></iframe><img src="x.png" srcset="a.png 1x, b.png 2x">
    <form action="post"><button formaction="javascript:z()">go</button></form></body></html>`;
  const page = readHtml(html, 'https://home.example.gov/data/tic/forms');
  eq(page.title, 'TIC forms', 'title');
  eq(page.links, [
    { url: 'https://home.example.gov/data/tic/forms/BC.pdf', text: 'Form BC', section: 'Current forms', format: 'PDF', chrome: false },
    { url: 'https://docs.example.gov/BC-2019.pdf', text: 'Form BC 2019', section: 'Historical forms', format: 'PDF', chrome: false }
  ], 'links');
  for (const banned of ['<script', 'onload', 'onclick', 'javascript:', '<iframe', 'refresh', 'target=', '<base']) {
    assert(!page.html.toLowerCase().includes(banned), 'copy still contains ' + banned);
  }
  assert(page.html.includes("script-src 'none'"), 'policy forbids script');
  assert(page.html.includes('data-cs-link="1"'), 'links are numbered');
  assert((page.html.match(/data-cs-link="0"/g) || []).length === 2, 'the same address keeps one number');
  assert(page.html.includes('src="https://home.example.gov/data/tic/x.png"'), 'images are absolute');
  assert(page.html.includes('https://home.example.gov/data/tic/b.png 2x'), 'srcset is absolute');
});

Deno.test('redirects are re-checked and documents are not parsed', async () => {
  const calls: string[] = [];
  const fake = (async (url: string) => {
    calls.push(url);
    if (url === 'https://8.8.8.8/start') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
    if (url === 'https://8.8.8.8/form.pdf') return new Response('%PDF', { headers: { 'content-type': 'application/pdf' } });
    if (url === 'https://8.8.8.8/page') return new Response('<html><body><a href="/a">A</a></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  let refused = false;
  try { await readPage('https://8.8.8.8/start', fake); } catch (error) { refused = error instanceof PublicError; }
  assert(refused, 'a redirect to a private address is refused');
  assert(!calls.includes('http://127.0.0.1/admin'), 'the private address is never requested');
  eq((await readPage('https://8.8.8.8/form.pdf', fake) as any).kind, 'document', 'PDF is reported as a document');
  const page = await readPage('https://8.8.8.8/page', fake) as any;
  eq(page.kind, 'page', 'html page');
  eq(page.links[0].url, 'https://8.8.8.8/a', 'link resolved');
  eq((await readPage('https://8.8.8.8/missing', fake) as any).status, 404, 'errors are reported, not thrown');
});

Deno.test('requests need an allowed origin, an identity and stay within budget', async () => {
  const visitor = '12345678-1234-4123-8123-123456789abc';
  const request = (origin: string, headers: Record<string, string> = {}) => new Request('https://fn.test/page-reader', {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ url: 'http://localhost/' })
  });
  eq((await handle(request('https://evil.example'))).status, 403, 'unknown origin');
  eq((await handle(request('https://gauravdarwesh.github.io'))).status, 401, 'no identity');
  const refused = await handle(request('https://gauravdarwesh.github.io', { 'x-ask-sentinel-visitor-id': visitor }));
  eq(refused.status, 400, 'local address refused before any fetch');
  assert(spend('budget-test', 2) && spend('budget-test', 2) && !spend('budget-test', 2), 'budget runs out');
  eq(formatOf('https://x.gov/a/b.XLSX'), 'Spreadsheet', 'format');
});

Deno.test('site navigation links are flagged, not dropped', () => {
  const page = readHtml(`<html><body><header><nav><a href="/">Home</a><a href="/forms">Forms</a></nav></header>
    <main><h2>Forms</h2><a href="/forms">All forms</a><a href="/a.pdf">A</a></main><footer><a href="/privacy">Privacy</a></footer></body></html>`, 'https://x.example.gov/p');
  const byUrl = Object.fromEntries(page.links.map(link => [link.url, link]));
  eq(byUrl['https://x.example.gov/'].chrome, true, 'header link is chrome');
  eq(byUrl['https://x.example.gov/privacy'].chrome, true, 'footer link is chrome');
  eq(byUrl['https://x.example.gov/forms'].chrome, false, 'a link also in the content is content');
  eq(byUrl['https://x.example.gov/forms'].section, 'Forms', 'and takes its content heading');
  eq(byUrl['https://x.example.gov/a.pdf'].chrome, false, 'content link');
  assert(page.html.includes('data-cs-link'), 'chrome links stay clickable in the copy');
});
