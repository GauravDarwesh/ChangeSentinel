// Tests for the page reader. Network calls go to a fake fetcher; nothing leaves the machine.
(Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {}, addr: { hostname: 'test', port: 0 } });
const { checkUrl, isPrivateAddress, readHtml, readPage, formatOf, spend, handle, PublicError, absoluteCssUrls, clientRedirect, botCheck, USER_AGENT, BROWSER_USER_AGENT, documentFormat, MAX_FILE_BYTES } = await import('./index.ts');

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

Deno.test('large inline header does not hide links beyond the former 3 MB cap', async () => {
  const filler = '.mega-menu{margin:0;padding:0}\n'.repeat(115_000);
  const html = '<!doctype html><html><head><title>Regulator guides</title><style>' + filler +
    '</style></head><body><main><h1>Guides</h1><a href="/files/guide.pdf">Download guide</a></main></body></html>';
  const bytes = new TextEncoder().encode(html);
  assert(bytes.length > 3_000_000 && bytes.length < 8_000_000, 'fixture crosses old cap but stays under new cap');
  const fake = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        controller.enqueue(bytes.slice(offset, Math.min(offset + 64 * 1024, bytes.length)));
      }
      controller.close();
    }
  }), { headers: { 'content-type': 'text/html; charset=utf-8' } })) as typeof fetch;
  const page = await readPage('https://8.8.8.8/large-page', fake) as any;
  eq(page.kind, 'page', 'large page is parsed');
  eq(page.links[0]?.url, 'https://8.8.8.8/files/guide.pdf', 'body link beyond former cap is available');
  eq(page.links[0]?.text, 'Download guide', 'body link text is preserved');
  eq(page.truncated, false, 'response within the new cap is not marked truncated');
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

Deno.test('loading screens, hidden-until-script content and lazy media are undone', () => {
  const page = readHtml(`<html><head><title>Financial Return Template</title>
    <link rel="preload" as="style" href="/css/site.css" onload="this.rel='stylesheet'">
    <link rel="stylesheet" href="/css/print-trick.css" media="print" onload="this.media='all'">
    <style>.hero{background:url(../img/hero.png)} @import "/css/more.css"; .x{filter:url(#f)}</style></head>
    <body class="loading"><div id="preloader" class="page-loader"><img src="/img/loader.gif" alt=""></div>
    <div class="spinner"></div>
    <main><h1>Financial Return Template v2.12</h1><div data-aos="fade-up"><p>Published August 2025.</p>
    <a href="https://cdn.example.org/doc.xlsx">Download</a></div>
    <img src="data:image/gif;base64,R0lGOD" data-src="/img/chart.png" alt="chart">
    <div data-bg="/img/banner.jpg">Banner</div>
    <noscript><img src="/img/fallback.png" alt="fallback"></noscript>
    <noscript><p>Please enable JavaScript to use this site.</p></noscript></main></body></html>`, 'https://www.example.org/forms/template');
  const html = page.html;
  assert(!html.includes('preloader') && !html.includes('loader.gif'), 'the loading screen is removed');
  assert(!/class="spinner"/.test(html), 'an empty spinner is removed');
  assert(html.includes('class="loading"'), 'a body class is left alone');
  assert(html.includes('Financial Return Template v2.12') && html.includes('data-aos'), 'the content stays');
  assert(html.includes('data-cs-reveal') && html.includes('[data-aos]'), 'content waiting for a scroll animation is revealed');
  assert(/<link[^>]+rel="stylesheet"[^>]+href="https:\/\/www\.example\.org\/css\/site\.css"|<link[^>]+href="https:\/\/www\.example\.org\/css\/site\.css"[^>]+rel="stylesheet"/.test(html), 'a preloaded stylesheet applies');
  assert(/print-trick\.css"[^>]*media="all"|media="all"[^>]*print-trick\.css"/.test(html), 'a print-media stylesheet switched on by script applies');
  assert(html.includes('url("https://www.example.org/img/hero.png")'), 'relative url() in a style block is absolute');
  assert(html.includes('@import "https://www.example.org/css/more.css"'), '@import is absolute');
  assert(html.includes('url(#f)'), 'fragment references are kept');
  assert(html.includes('src="https://www.example.org/img/chart.png"'), 'a lazy image gets its real address');
  assert(html.includes("background-image:url('https://www.example.org/img/banner.jpg')"), 'a lazy background is applied');
  assert(html.includes('https://www.example.org/img/fallback.png'), 'noscript images are shown');
  assert(!/enable JavaScript/i.test(html), 'noscript notices are dropped');
  eq(page.links.map(link => link.url), ['https://cdn.example.org/doc.xlsx'], 'links');
  assert(!page.notice, 'an ordinary page carries no notice');
});

Deno.test('links that only exist in script handlers are collected', () => {
  const page = readHtml(`<html><body><main><h2>Forms</h2>
    <a href="javascript:openWindow('/forms/BC.pdf')">Form BC</a>
    <a href="javascript:void(0)" onclick="window.open('https://docs.example.gov/annual.xlsx')">Annual return</a>
    <button onclick="location.href='/guidance/notes'">Guidance notes</button>
    <tr data-href="/forms/archive"><td>Archive</td></tr>
    <a href="javascript:__doPostBack('ctl00','')">Postback</a></main></body></html>`, 'https://www.example.gov/forms/');
  const urls = page.links.map(link => link.url);
  assert(urls.includes('https://www.example.gov/forms/BC.pdf'), 'javascript: href keeps the address it opens');
  assert(urls.includes('https://docs.example.gov/annual.xlsx'), 'onclick window.open is a link');
  assert(urls.includes('https://www.example.gov/guidance/notes'), 'onclick location.href is a link');
  eq(page.links.find(link => link.url.endsWith('/notes'))?.text, 'Guidance notes', 'its text is kept');
  assert(!page.html.includes('javascript:'), 'no javascript: address survives');
  assert(!page.html.includes('onclick'), 'no handler survives');
  assert((page.html.match(/data-cs-link=/g) || []).length >= 3, 'scripted links are numbered so they can be picked');
});

Deno.test('a page built with script lists the addresses in its data and says so', () => {
  const page = readHtml(`<html><head><title>Rules</title></head><body><div id="__next"></div>
    <script id="__NEXT_DATA__" type="application/json">{"props":{"items":[{"href":"/rules/2026-01"},{"href":"https:\\/\\/www.example.gov\\/rules\\/2026-02"},
    {"file":"https://cdn.other.org/forms/q1.pdf"},{"chunk":"/_next/static/chunks/main.js"},{"img":"/images/logo.png"},{"ext":"https://tracker.other.org/page"}]}}</script></body></html>`, 'https://www.example.gov/rules');
  const urls = page.links.map(link => link.url);
  assert(urls.includes('https://www.example.gov/rules/2026-01'), 'relative address in data');
  assert(urls.includes('https://www.example.gov/rules/2026-02'), 'escaped absolute address in data');
  assert(urls.includes('https://cdn.other.org/forms/q1.pdf'), 'a document on another host');
  assert(!urls.some(url => /_next|logo\.png|tracker\.other/.test(url)), 'assets and other sites\' pages are skipped');
  assert(/builds its content with script/.test(page.notice || ''), 'the reader says why the copy looks empty');
});

Deno.test('client-side redirects and bot checks are recognised', () => {
  eq(clientRedirect('<html><head><meta http-equiv="refresh" content="0; URL=\'/new/home\'"></head></html>', 'https://x.gov/old'), 'https://x.gov/new/home', 'meta refresh');
  eq(clientRedirect('<html><head><meta http-equiv="Refresh" content="600"></head><body>Page</body></html>', 'https://x.gov/'), '', 'a periodic reload is not a redirect');
  eq(clientRedirect('<html><body><script>window.location.href = "https://x.gov/en/";</script></body></html>', 'https://x.gov/'), 'https://x.gov/en/', 'script redirect on an empty page');
  eq(clientRedirect('<html><body>' + '<p>Real content here.</p>'.repeat(40) + '<script>if (a) location.href="/x"</script></body></html>', 'https://x.gov/'), '', 'not on a page with content');
  assert(botCheck('<html><head><title>Just a moment...</title></head><body></body></html>'), 'Cloudflare interstitial');
  eq(botCheck('<html><head><title>Rules</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body>' + '<p>Rule text.</p>'.repeat(200) + '</body></html>'), '', 'an ordinary page served through Cloudflare');
  eq(absoluteCssUrls("a{b:url('x.png')} c{d:url(javascript:alert)}", 'https://x.gov/css/s.css'), 'a{b:url("https://x.gov/css/x.png")} c{d:none}', 'css urls');
});

Deno.test('a refusal is retried once as a browser, refresh pages and cookies are followed', async () => {
  const seen: { url: string; agent: string; cookie: string }[] = [];
  const headerOf = (init: RequestInit | undefined, name: string) => String((init?.headers as Record<string, string> || {})[name] || '');
  const fake = (async (url: string, init?: RequestInit) => {
    seen.push({ url, agent: headerOf(init, 'User-Agent'), cookie: headerOf(init, 'Cookie') });
    if (url === 'https://8.8.8.8/guarded') {
      return headerOf(init, 'User-Agent') === BROWSER_USER_AGENT
        ? new Response('<html><body><main><a href="/a.pdf">A</a></main></body></html>', { headers: { 'content-type': 'text/html' } })
        : new Response('denied', { status: 403 });
    }
    if (url === 'https://8.8.8.8/old') return new Response('<html><head><meta http-equiv="refresh" content="0;url=/new"></head></html>', { headers: { 'content-type': 'text/html' } });
    if (url === 'https://8.8.8.8/new') return new Response('<html><body><main><a href="/b">B</a></main></body></html>', { headers: { 'content-type': 'text/html' } });
    if (url === 'https://8.8.8.8/always') return new Response('x', { status: 403 });
    if (url === 'https://8.8.8.8/check') return new Response('<html><head><title>Just a moment...</title></head><body></body></html>', { headers: { 'content-type': 'text/html' } });
    if (url === 'https://8.8.8.8/session') {
      return headerOf(init, 'Cookie').includes('sid=1')
        ? new Response('<html><body><main><a href="/c">C</a></main></body></html>', { headers: { 'content-type': 'text/html' } })
        : new Response(null, { status: 302, headers: { location: '/session', 'set-cookie': 'sid=1; Path=/; HttpOnly' } });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  assert(USER_AGENT.startsWith('Mozilla/5.0 (compatible; ChangeSentinel'), 'the reader names itself like the monitor');
  const guarded = await readPage('https://8.8.8.8/guarded', fake) as any;
  eq(guarded.kind, 'page', 'a 403 is retried as a browser');
  eq(seen.filter(call => call.url === 'https://8.8.8.8/guarded').map(call => call.agent === BROWSER_USER_AGENT), [false, true], 'first as itself, then once as a browser');
  const moved = await readPage('https://8.8.8.8/old', fake) as any;
  eq([moved.kind, moved.url, moved.links[0].url], ['page', 'https://8.8.8.8/new', 'https://8.8.8.8/b'], 'meta refresh followed');
  const refused = await readPage('https://8.8.8.8/always', fake) as any;
  eq(refused.kind, 'error', 'still refused');
  assert(/full browser/.test(refused.message), 'the refusal is explained: ' + refused.message);
  const check = await readPage('https://8.8.8.8/check', fake) as any;
  assert(check.kind === 'error' && /bot check/.test(check.message), 'a bot check is reported, not shown');
  // Runtimes that hide Set-Cookie on constructed responses (browsers) cannot exercise the jar.
  if (new Response(null, { headers: { 'set-cookie': 'a=b' } }).headers.get('set-cookie')) {
    const session = await readPage('https://8.8.8.8/session', fake) as any;
    eq(session.kind, 'page', 'a cookie set on a redirect is sent back');
  }
});

Deno.test('documents can be read whole for the dashboard viewers', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7 fake');
  const fake = (async (url: string) => {
    if (url === 'https://8.8.8.8/form.pdf') return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
    if (url === 'https://8.8.8.8/DownloadAttachment?guid=1') return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
    if (url === 'https://8.8.8.8/page') return new Response('<html><body><a href="/a">A</a></body></html>', { headers: { 'content-type': 'text/html' } });
    if (url === 'https://8.8.8.8/huge.xlsx') return new Response(new Uint8Array(MAX_FILE_BYTES + 10), { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const file = await readPage('https://8.8.8.8/form.pdf', fake, { file: true }) as any;
  eq([file.kind, file.format, file.bytes.length], ['file', 'PDF', pdf.length], 'a PDF comes back whole');
  eq((await readPage('https://8.8.8.8/DownloadAttachment?guid=1', fake, { file: true }) as any).format, 'PDF', 'by content type when the address has no extension');
  eq((await readPage('https://8.8.8.8/form.pdf', fake) as any).kind, 'document', 'without file mode a document is only described');
  eq((await readPage('https://8.8.8.8/page', fake, { file: true }) as any).kind, 'page', 'a web page is still read as a page');
  let refused = '';
  try { await readPage('https://8.8.8.8/huge.xlsx', fake, { file: true }); } catch (error) { refused = (error as Error).message; }
  assert(/larger than 25 MB/.test(refused), 'oversized documents are refused: ' + refused);
  eq([documentFormat('https://x.gov/a.xlsx', ''), documentFormat('https://x.gov/a.csv', 'text/csv'), documentFormat('https://x.gov/a.docx', ''),
      documentFormat('https://x.gov/a', 'application/zip'), documentFormat('https://x.gov/page', 'text/html')], ['Spreadsheet', 'CSV', 'Word', 'ZIP', ''], 'formats');
});
