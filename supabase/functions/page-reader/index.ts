// Page reader for the dashboard's "Add a link" explorer.
//
// The dashboard is a static site, so it cannot embed most regulator pages
// (they forbid framing) or see clicks inside another site's page. This
// function fetches one public page and returns:
//   * a script-free copy to show in a sandboxed frame, every link made
//     absolute and numbered so the dashboard can tell which one was clicked;
//   * the links themselves, with their text and the heading they sit under.
//
// It only reads. It never stores anything and never follows a link on its own.
// Safety: public http(s) addresses only (names that resolve to private,
// loopback or link-local addresses are refused, at every redirect), bounded
// size and time, the same origin allowlist as Ask Sentinel, a signed-in or
// visitor identity, and a per-instance request budget.

import { DOMParser } from 'npm:linkedom@0.18.5';

// linkedom's bundled typings are partial; the parsed tree is handled as plain DOM-like objects.
// deno-lint-ignore no-explicit-any
type Node = any;

const ALLOWED_ORIGINS = new Set([
  'https://gauravdarwesh.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
]);
const MAX_BYTES = 3_000_000;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 4;
const MAX_LINKS = 4000;
const WINDOW_MS = 10 * 60 * 1000;
const ACTOR_BUDGET = 400;
const IP_BUDGET = 800;
const USER_AGENT = 'ChangeSentinel page reader (+https://github.com/GauravDarwesh/ChangeSentinel)';

export class PublicError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ---------------------------------------------------------------- addresses */

function ipv4Parts(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return numbers.every(n => n >= 0 && n <= 255) ? numbers : null;
}

function ipv6Words(value: string): number[] | null {
  let input = value.toLowerCase();
  // Convert an IPv4 tail (for example ::ffff:192.0.2.1) to two IPv6 words.
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    const tail = ipv4Parts(input.slice(lastColon + 1));
    if (!tail) return null;
    input = input.slice(0, lastColon + 1) +
      ((tail[0] << 8) | tail[1]).toString(16) + ':' +
      ((tail[2] << 8) | tail[3]).toString(16);
  }
  if ((input.match(/::/g) || []).length > 1) return null;
  const halves = input.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const words = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right].map(part => parseInt(part, 16));
  return words.length === 8 ? words : null;
}

function ipv4FromWords(words: number[]): string {
  const a = words[6], b = words[7];
  return [a >> 8, a & 255, b >> 8, b & 255].join('.');
}

export function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = ipv4Parts(value);
  if (v4) {
    const [a, b, c] = v4;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (value.includes(':')) {
    const words = ipv6Words(value);
    // Fail closed for malformed IPv6 literals.
    if (!words) return true;
    if (words.every(word => word === 0) || words.slice(0, 7).every(word => word === 0) && words[7] === 1) return true;

    // IPv4-mapped, IPv4-compatible, and the well-known NAT64 prefix embed IPv4.
    // Classify the embedded address rather than rejecting every NAT64 result:
    // public destinations translated by DNS64 remain usable, private ones do not.
    const mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff;
    const compatible = words.slice(0, 6).every(word => word === 0);
    const nat64 = words[0] === 0x0064 && words[1] === 0xff9b &&
      words.slice(2, 6).every(word => word === 0);
    if (mapped || compatible || nat64) return isPrivateAddress(ipv4FromWords(words));

    return (words[0] & 0xfe00) === 0xfc00 || // unique-local fc00::/7
      (words[0] & 0xffc0) === 0xfe80 || // link-local fe80::/10
      (words[0] & 0xff00) === 0xff00 || // multicast
      (words[0] === 0x2001 && words[1] === 0x0db8) || // documentation
      (words[0] === 0x2001 && words[1] === 0x0010); // ORCHID
  }
  return false;
}

export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw || '').trim());
  } catch (_) {
    throw new PublicError('Enter a full address beginning with https:// or http://.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new PublicError('Only http:// and https:// pages can be read.');
  if (url.username || url.password) throw new PublicError('Addresses containing a user name or password are not allowed.');
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new PublicError('That port is not allowed.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(host)) {
    throw new PublicError('Local or internal addresses cannot be read.');
  }
  if ((ipv4Parts(host) || host.includes(':')) && isPrivateAddress(host)) {
    throw new PublicError('Private or reserved addresses cannot be read.');
  }
  if (!ipv4Parts(host) && !host.includes(':') && !host.includes('.')) throw new PublicError('Enter a public host name such as www.example.gov.');
  url.hash = '';
  return url;
}

async function checkResolvesPublic(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipv4Parts(host) || host.includes(':')) return;
  const resolve = (Deno as unknown as { resolveDns?: (h: string, t: string) => Promise<string[]> }).resolveDns;
  if (typeof resolve !== 'function') return; // the hosted runtime cannot reach private networks either
  const answers: string[] = [];
  for (const type of ['A', 'AAAA']) {
    try {
      answers.push(...await resolve(host, type));
    } catch (_) {
      // A name with only one address family is normal.
    }
  }
  if (!answers.length) throw new PublicError('That host name could not be found.', 502);
  if (answers.some(isPrivateAddress)) throw new PublicError('That host resolves to a private address and cannot be read.');
}

/* ---------------------------------------------------------------- formats */

const FORMATS: [RegExp, string][] = [
  [/\.pdf$/, 'PDF'], [/\.(xlsx|xls|xlsm|csv)$/, 'Spreadsheet'], [/\.(docx|doc)$/, 'Word'], [/\.(pptx|ppt)$/, 'Slides'],
  [/\.zip$/, 'ZIP'], [/\.(xml|xsd|xbrl)$/, 'XML'], [/\.json$/, 'JSON'], [/\.txt$/, 'Text']
];
export function formatOf(url: string): string {
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch (_) {
    return 'Web page';
  }
  const match = FORMATS.find(([pattern]) => pattern.test(path));
  return match ? match[1] : 'Web page';
}

/* ---------------------------------------------------------------- sanitising */

const REMOVE = 'script, noscript, iframe, frame, frameset, object, embed, applet, base, portal, template, ' +
  'meta[http-equiv], link:not([rel~="stylesheet"]):not([rel~="icon"])';
const URL_ATTRS = ['href', 'src', 'action', 'poster', 'data', 'background', 'cite', 'formaction'];
const clean = (value: unknown, limit: number) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

function absolute(value: string, base: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, base);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    if (url.protocol === 'mailto:' || url.protocol === 'tel:') return url.href;
    if (url.protocol === 'data:' && /^data:image\//i.test(raw)) return raw;
  } catch (_) {
    // Unparseable addresses are dropped below.
  }
  return '';
}

// chrome: the link sits in the site's own header, menu or footer (outside the main content).
export type PageLink = { url: string; text: string; section: string; format: string; chrome: boolean };

export function readHtml(html: string, pageUrl: string): { title: string; html: string; links: PageLink[]; truncated: boolean } {
  const document: Node = new (DOMParser as Node)().parseFromString(html, 'text/html');
  const baseTag = document.querySelector('base[href]');
  const base = (baseTag && absolute(baseTag.getAttribute('href') || '', pageUrl)) || pageUrl;
  const title = clean(document.querySelector('title')?.textContent || document.querySelector('h1')?.textContent || '', 300);

  for (const element of Array.from(document.querySelectorAll(REMOVE)) as Node[]) element.remove();
  for (const element of Array.from(document.querySelectorAll('*')) as Node[]) {
    for (const attribute of Array.from(element.attributes || []) as Node[]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'target' || name === 'ping' || name === 'http-equiv') {
        element.removeAttribute(attribute.name);
      } else if (name === 'href' && String(attribute.value).trim().startsWith('#')) {
        // A jump within the page stays a jump; it is not a link to collect.
      } else if (URL_ATTRS.includes(name) || name === 'xlink:href') {
        const value = absolute(attribute.value, base);
        if (value) element.setAttribute(attribute.name, value);
        else element.removeAttribute(attribute.name);
      } else if (name === 'srcset') {
        const value = String(attribute.value).split(',').map((part: string) => {
          const [candidate, size] = part.trim().split(/\s+/, 2);
          const resolved = absolute(candidate, base);
          return resolved ? resolved + (size ? ' ' + size : '') : '';
        }).filter(Boolean).join(', ');
        if (value) element.setAttribute('srcset', value);
        else element.removeAttribute('srcset');
      } else if (name === 'style' && /expression\(|javascript:|url\(\s*['"]?\s*javascript:/i.test(attribute.value)) {
        element.removeAttribute('style');
      }
    }
  }

  // Number every link in page order, noting the heading above it.
  const links: PageLink[] = [];
  const indexByUrl = new Map<string, number>();
  let section = '';
  let truncated = false;
  const self = pageUrl.split('#')[0];
  for (const node of Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, a[href]')) as Node[]) {
    if (/^h[1-6]$/i.test(node.tagName)) {
      section = clean(node.textContent, 160);
      continue;
    }
    const href = node.getAttribute('href') || '';
    if (!/^https?:/i.test(href)) continue;
    const url = href.split('#')[0];
    if (url === self && href.includes('#')) continue; // a jump within this page
    let index = indexByUrl.get(url);
    if (index === undefined) {
      if (links.length >= MAX_LINKS) {
        truncated = true;
        continue;
      }
      const image = node.querySelector('img[alt]');
      const text = clean(node.textContent, 300) || clean(node.getAttribute('title') || node.getAttribute('aria-label') || image?.getAttribute('alt') || '', 300);
      index = links.length;
      indexByUrl.set(url, index);
      const chrome = !!node.closest('header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"]') && !node.closest('main, article, [role="main"]');
      links.push({ url, text, section: chrome ? '' : section, format: formatOf(url), chrome });
    } else {
      if (!links[index].text) links[index].text = clean(node.textContent, 300);
      // Linked from the content as well as the menu: it is content.
      if (links[index].chrome && !(node.closest('header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"]') && !node.closest('main, article, [role="main"]'))) {
        links[index].chrome = false;
        links[index].section = section;
      }
    }
    node.setAttribute('data-cs-link', String(index));
  }

  // The copy cannot run script even if a page smuggles some past the cleanup:
  // the dashboard shows it in a sandbox without scripts, and this policy agrees.
  const head = document.querySelector('head') || document.documentElement;
  const policy = document.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'");
  head.insertBefore(policy, head.firstChild);
  const charset = document.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  head.insertBefore(charset, head.firstChild);

  return { title, html: '<!doctype html>\n' + document.documentElement.outerHTML, links, truncated };
}

/* ---------------------------------------------------------------- fetching */

function charsetOf(contentType: string, head: Uint8Array): string {
  const declared = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  if (declared) return declared.toLowerCase();
  const sniff = new TextDecoder('latin1').decode(head.subarray(0, 2048));
  return sniff.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]?.toLowerCase() || 'utf-8';
}

async function readBody(response: Response): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

export async function readPage(raw: string, fetcher: typeof fetch = fetch) {
  let url = checkUrl(raw);
  for (let hop = 0; ; hop += 1) {
    await checkResolvesPublic(url);
    let response: Response;
    try {
      response = await fetcher(url.href, {
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      throw new PublicError(timedOut ? 'The page took too long to answer.' : 'The page could not be reached.', 502);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hop >= MAX_REDIRECTS) throw new PublicError('The page redirects too many times.', 502);
      url = checkUrl(new URL(location, url).href);
      continue;
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (response.status >= 400) {
      await response.body?.cancel();
      return { kind: 'error', url: url.href, status: response.status, message: 'The site answered HTTP ' + response.status + '.' };
    }
    if (contentType && !/html|xml/.test(contentType)) {
      await response.body?.cancel();
      return { kind: 'document', url: url.href, contentType: contentType.split(';')[0], format: formatOf(url.href) };
    }
    const body = await readBody(response);
    let text: string;
    try {
      text = new TextDecoder(charsetOf(contentType, body.bytes)).decode(body.bytes);
    } catch (_) {
      text = new TextDecoder('utf-8').decode(body.bytes);
    }
    if (!/<(html|head|body|a\s)/i.test(text.slice(0, 50_000))) {
      return { kind: 'document', url: url.href, contentType: contentType.split(';')[0] || 'unknown', format: formatOf(url.href) };
    }
    const page = readHtml(text, url.href);
    return { kind: 'page', url: url.href, ...page, truncated: page.truncated || body.truncated };
  }
}

/* ---------------------------------------------------------------- request handling */

function cors(req: Request) {
  const origin = req.headers.get('origin') || '';
  const allowed = ALLOWED_ORIGINS.has(origin) || /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin);
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-ask-sentinel-visitor-id',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400'
  };
  if (allowed) headers['Access-Control-Allow-Origin'] = origin;
  return { allowed, headers };
}

function respond(req: Request, payload: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors(req).headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }
  });
}

const budgets = new Map<string, { count: number; reset: number }>();
export function spend(key: string, limit: number, now = Date.now()): boolean {
  const entry = budgets.get(key);
  if (!entry || entry.reset <= now) {
    budgets.set(key, { count: 1, reset: now + WINDOW_MS });
    if (budgets.size > 5000) {
      for (const [name, value] of budgets) if (value.reset <= now) budgets.delete(name);
    }
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

async function actorOf(req: Request): Promise<string> {
  const auth = req.headers.get('authorization') || '';
  if (/^Bearer\s+\S+/i.test(auth)) {
    const base = (Deno.env.get('SUPABASE_URL') || 'https://pysoukwmnwwgilkwafdy.supabase.co').replace(/\/+$/, '');
    let key = Deno.env.get('SUPABASE_ANON_KEY') || '';
    try {
      key = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}').default || key;
    } catch (_) {
      // Fall back to the anon key.
    }
    const response = await fetch(base + '/auth/v1/user', { headers: { apikey: key, Authorization: auth }, signal: AbortSignal.timeout(8000) });
    const user = response.ok ? await response.json() : null;
    if (!user || !/^[0-9a-f-]{36}$/i.test(String(user.id || ''))) throw new PublicError('Your session expired. Refresh the dashboard and retry.', 401);
    return 'user:' + user.id;
  }
  const visitor = req.headers.get('x-ask-sentinel-visitor-id') || '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(visitor)) {
    throw new PublicError('Visitor identity missing. Refresh the dashboard and retry.', 401);
  }
  return 'visitor:' + visitor.toLowerCase();
}

export async function handle(req: Request): Promise<Response> {
  const c = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: c.allowed ? 204 : 403, headers: c.headers });
  if (!c.allowed) return respond(req, { error: 'This origin is not allowed.' }, 403);
  if (req.method !== 'POST') return respond(req, { error: 'Use POST.' }, 405);
  try {
    const actor = await actorOf(req);
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    if (!spend(actor, ACTOR_BUDGET) || !spend('ip:' + ip, IP_BUDGET)) {
      return respond(req, { error: 'Too many pages read in a short time. Wait a few minutes and retry.' }, 429, { 'Retry-After': '120' });
    }
    let body: { url?: string } = {};
    try {
      body = await req.json();
    } catch (_) {
      throw new PublicError('Send a JSON body with a url.');
    }
    return respond(req, await readPage(String(body.url || '')));
  } catch (error) {
    if (error instanceof PublicError) return respond(req, { error: error.message }, error.status);
    console.error('page-reader failed', error);
    return respond(req, { error: 'The page could not be read.' }, 500);
  }
}

Deno.serve(handle);
