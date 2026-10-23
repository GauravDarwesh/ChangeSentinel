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
// Some regulator pages ship several MB of inline CSS before <body>; keep a firm cap,
// but don't truncate the response before the document's actual links.
const MAX_BYTES = 8_000_000;
// Smaller regulators' servers are often slow; one hop may take up to 20 s, and the
// whole read (redirects, a retry, a meta refresh) stays inside the dashboard's 40 s.
const FETCH_TIMEOUT_MS = 20_000;
const TOTAL_BUDGET_MS = 34_000;
const MAX_REDIRECTS = 6;
const MAX_LINKS = 4000;
const MAX_DATA_LINKS = 400;
const WINDOW_MS = 10 * 60 * 1000;
const ACTOR_BUDGET = 400;
const IP_BUDGET = 800;
// The same identity as the monitor's own fetcher. Many web application firewalls
// refuse any agent that does not start with "Mozilla/5.0".
export const USER_AGENT = 'Mozilla/5.0 (compatible; ChangeSentinel/0.6 page reader; +https://github.com/GauravDarwesh/ChangeSentinel)';
// When a site still answers "forbidden" or "unavailable", one retry looks like an
// ordinary browser visit. The reader only ever fetches the one page a person asked for.
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const RETRY_STATUSES = new Set([401, 403, 406, 409, 429, 503]);

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
      (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19)) ||
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


function decodeFallbackEntities(value: string): string {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, digits) => {
      const code = Number(digits);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, digits) => {
      const code = parseInt(digits, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function extractRawHtmlLinks(html: string, pageUrl: string): { links: PageLink[]; truncated: boolean } {
  const visibleSource = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|iframe|object|svg|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const events: Array<{ position: number; kind: 'heading' | 'anchor'; attributes?: string; content: string }> = [];
  const headingPattern = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi;
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let match: RegExpExecArray | null;

  while ((match = headingPattern.exec(visibleSource)) !== null) {
    events.push({ position: match.index, kind: 'heading', content: match[1] || '' });
  }
  while ((match = anchorPattern.exec(visibleSource)) !== null) {
    events.push({ position: match.index, kind: 'anchor', attributes: match[1] || '', content: match[2] || '' });
  }
  events.sort((a, b) => a.position - b.position);

  const links: PageLink[] = [];
  const byUrl = new Set<string>();
  let section = '';
  let truncated = false;
  const self = pageUrl.split('#')[0];

  for (const event of events) {
    const textContent = decodeFallbackEntities(event.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
    if (event.kind === 'heading') {
      section = textContent.slice(0, 160);
      continue;
    }

    const hrefMatch = (event.attributes || '').match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/i);
    if (!hrefMatch) continue;
    const rawHref = decodeFallbackEntities(hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '');
    const resolved = absolute(rawHref, pageUrl);
    if (!/^https?:\/\//i.test(resolved)) continue;

    const normalized = resolved.split('#')[0];
    if (!normalized || (normalized === self && resolved.includes('#'))) continue;
    if (byUrl.has(normalized)) continue;
    if (links.length >= MAX_LINKS) {
      truncated = true;
      continue;
    }

    byUrl.add(normalized);
    links.push({
      url: normalized,
      text: textContent.slice(0, 300) || rawHref.slice(0, 300) || normalized,
      section,
      format: formatOf(normalized),
      chrome: false
    });
  }
  return { links, truncated };
}

function escapeFallbackHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildFallbackPreview(title: string, links: PageLink[]): string {
  const cards = links.map((link, index) =>
    '<li><a data-cs-link="' + index + '" href="' + escapeFallbackHtml(link.url) + '">' +
    escapeFallbackHtml(link.text || link.url) + '</a>' +
    (link.section ? '<small>' + escapeFallbackHtml(link.section) + '</small>' : '') +
    '<span>' + escapeFallbackHtml(link.format) + '</span></li>'
  ).join('');
  const body = links.length
    ? '<p>The original page layout could not be safely reconstructed. These links were extracted from its HTML.</p><ol>' + cards + '</ol>'
    : '<p>The reader could not reconstruct this page safely, and no standard HTML links were available.</p>';
  return '<!doctype html>\n<html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: https:; script-src \'none\'; object-src \'none\'; base-uri \'none\'">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeFallbackHtml(title || 'Page preview') + '</title>' +
    '<style>body{font:16px/1.5 system-ui,-apple-system,sans-serif;color:#27231f;background:#fff;margin:0;padding:20px}h1{font-size:1.25rem;overflow-wrap:anywhere}p{color:#6f665d}ol{padding-left:1.5rem}li{padding:.6rem .25rem;border-bottom:1px solid #eee;overflow-wrap:anywhere}a{color:#9b4e16}small{display:block;color:#72695f;margin-top:.15rem}li span{display:block;color:#8a8177;font-size:.8rem}</style>' +
    '</head><body><h1>' + escapeFallbackHtml(title || 'Page preview') + '</h1>' +
    body + '</body></html>';
}

/* ---------------------------------------------------------------- readable without script
 *
 * The copy is shown with scripting off, so anything the site's own script would
 * have done on load has to be undone here, or the page looks broken or empty:
 *   * loading screens and splash overlays that script removes once the page is ready;
 *   * content hidden until a scroll animation or an anti-flicker snippet reveals it;
 *   * images whose real address waits in data-src for a lazy loader;
 *   * stylesheets loaded as "preload" or media="print" and switched on by an onload handler;
 *   * links that only exist as onclick="location.href=…" or javascript:open('…');
 *   * relative url() references inside inline styles, which a copy without <base> would lose.
 */

const OVERLAY_NAME = /(?:^|[\s_-])(?:pre-?loader|page-?loader|site-?loader|loader-?(?:wrap|wrapper|overlay|container|bg|backdrop|mask|screen|page|outer|inner)|loading-?(?:overlay|screen|wrapper|mask|page|container|bg)|load-?screen|splash-?screen|page-?loading|spinner-?(?:wrap|wrapper|overlay|container|bg))(?:$|[\s_-])/i;
const OVERLAY_TOKEN = /^(?:loader|loading|spinner|preload|pageload|page-load|pace)$/i;
const OVERLAY_KEEP = new Set(['html', 'body', 'main', 'article', 'header', 'footer', 'nav', 'form', 'table', 'ul', 'ol', 'section']);
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-echo', 'data-hi-res-src', 'data-full-src'];
const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset', 'data-original-set'];
const LAZY_BG = ['data-bg', 'data-background', 'data-bg-src', 'data-background-image'];
const PLACEHOLDER_SRC = /^data:|blank|placeholder|spacer|1x1|pixel|transparent|loading|lazy|grey\.gif|gray\.gif/i;
const NAV_SCRIPT = /(?:location(?:\.href)?\s*=|location\.(?:assign|replace)\s*\(|window\.open\s*\(|open(?:Window|Popup|Win|Doc|Document|File|Link)?\s*\(|popup\w*\s*\()\s*['"]([^'"]+)['"]/i;
const JS_HREF_URL = /['"]((?:https?:\/\/|\/|\.\.?\/)[^'"\s]+|[^'"\s]+\.(?:pdf|xlsx?|xlsm|docx?|pptx?|zip|csv|xml|aspx?|html?|php|jsp)(?:\?[^'"]*)?)['"]/i;
const ENABLE_JS_TEXT = /enable javascript|javascript (?:is )?(?:disabled|required|turned off|must be enabled)|turn on javascript|requires javascript|browser does not support javascript/i;

export const REVEAL_CSS = 'html,body{opacity:1!important;visibility:visible!important;overflow-y:auto!important}' +
  '.async-hide,[data-aos],.aos-init,.wow,.animate__animated,.animated,[data-animate],[data-animation],[data-scroll],' +
  '[data-sal],.sal-animate,.reveal-on-scroll,.js-reveal,.fade-in,.fadeIn,.lazyload,.lazyloading,.lazyloaded,.lazy' +
  '{opacity:1!important;visibility:visible!important;transform:none!important;animation:none!important;transition:none!important}';

export function absoluteCssUrls(css: string, base: string): string {
  return String(css || '')
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole: string, _quote: string, value: string) => {
      const raw = String(value || '').trim();
      if (!raw || raw.startsWith('#') || /^data:/i.test(raw)) return whole;
      const resolved = absolute(raw, base);
      return resolved && /^https?:/i.test(resolved) ? 'url("' + resolved.replace(/"/g, '%22') + '")' : 'none';
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_whole: string, _quote: string, value: string) => {
      const resolved = absolute(value, base);
      return resolved && /^https?:/i.test(resolved) ? '@import "' + resolved.replace(/"/g, '%22') + '"' : '';
    });
}

function isOverlay(element: Node): boolean {
  const tag = String(element.tagName || '').toLowerCase();
  if (OVERLAY_KEEP.has(tag)) return false;
  const names = (String(element.getAttribute('id') || '') + ' ' + String(element.getAttribute('class') || '')).trim();
  if (!names) return false;
  if (!OVERLAY_NAME.test(names) && !names.split(/\s+/).some(token => OVERLAY_TOKEN.test(token))) return false;
  // A loading screen carries a logo or a spinner, not the page's content.
  if (element.querySelector('a[href], input, select, textarea, table, h1, h2, h3')) return false;
  return clean(element.textContent, 200).length <= 80;
}

function wakeLazyMedia(element: Node, base: string) {
  const tag = String(element.tagName || '').toLowerCase();
  if (tag === 'img' || tag === 'source' || tag === 'video' || tag === 'audio') {
    const current = String(element.getAttribute('src') || '').trim();
    const lazy = LAZY_SRC.map(name => element.getAttribute(name)).find(value => value && String(value).trim());
    if (lazy && (!current || PLACEHOLDER_SRC.test(current))) {
      const resolved = absolute(String(lazy), base);
      if (resolved) element.setAttribute('src', resolved);
    }
    const lazySet = LAZY_SRCSET.map(name => element.getAttribute(name)).find(value => value && String(value).trim());
    if (lazySet && !element.getAttribute('srcset')) element.setAttribute('srcset', String(lazySet));
    if (element.getAttribute('loading') === 'lazy') element.removeAttribute('loading');
  }
  const background = LAZY_BG.map(name => element.getAttribute(name)).find(value => value && String(value).trim());
  if (background) {
    const resolved = absolute(String(background).replace(/^url\(\s*['"]?|['"]?\s*\)$/g, ''), base);
    if (resolved && /^https?:/i.test(resolved)) {
      const style = String(element.getAttribute('style') || '');
      element.setAttribute('style', (style ? style.replace(/;?\s*$/, ';') : '') + "background-image:url('" + resolved.replace(/'/g, '%27') + "')");
    }
  }
}

// Stylesheets that wait for script before they apply: rel=preload as=style, and
// the media="print" onload="this.media='all'" trick.
function enableDeferredStylesheets(document: Node) {
  for (const link of Array.from(document.querySelectorAll('link')) as Node[]) {
    const rel = String(link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    const as = String(link.getAttribute('as') || '').toLowerCase();
    const onload = String(link.getAttribute('onload') || '');
    if (rel.includes('preload') && as === 'style') {
      link.setAttribute('rel', 'stylesheet');
      link.removeAttribute('as');
    } else if (rel.includes('stylesheet') && /media/i.test(onload) && /^\s*(print|none|only x)\s*$/i.test(String(link.getAttribute('media') || ''))) {
      link.setAttribute('media', 'all');
    }
  }
}

// <noscript> is what a browser shows with scripting off, so its images and
// stylesheets belong in the copy; "please enable JavaScript" notices do not.
function unwrapNoscript(document: Node) {
  for (const element of Array.from(document.querySelectorAll('noscript')) as Node[]) {
    const useful = element.querySelector && element.querySelector('img, picture, link[rel~="stylesheet"], a[href]');
    if (!useful || ENABLE_JS_TEXT.test(clean(element.textContent, 600))) { element.remove(); continue; }
    const parent = element.parentNode;
    if (!parent) continue;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    element.remove();
  }
}

// Pages that build their content with script still carry their addresses in
// embedded data (Next.js, Nuxt, JSON-LD, inline configuration).
export function extractDataLinks(html: string, pageUrl: string, known: Set<string>): PageLink[] {
  let host = '';
  try {
    host = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return [];
  }
  const links: PageLink[] = [];
  const seen = new Set(known);
  const blocks = String(html || '').match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi) || [];
  const pattern = /["']((?:https?:)?\\?\/\\?\/[^"'\s<>]{3,400}|\\?\/[A-Za-z0-9][^"'\s<>]{1,300})["']/g;
  for (const block of blocks) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(block)) !== null) {
      if (links.length >= MAX_DATA_LINKS) return links;
      const raw = match[1].replace(/\\\//g, '/');
      const resolved = absolute(raw, pageUrl);
      if (!/^https?:\/\//i.test(resolved)) continue;
      let url: URL;
      try {
        url = new URL(resolved);
      } catch (_) {
        continue;
      }
      url.hash = '';
      const path = url.pathname.toLowerCase();
      if (/\.(?:m?js|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|json|mp4|webm|mp3)$/.test(path)) continue;
      if (/\/(?:_next|_nuxt|static|assets|api|wp-json|wp-includes|cdn-cgi|graphql)\//.test(path)) continue;
      const sameSite = url.hostname.toLowerCase().replace(/^www\./, '').endsWith(host);
      const format = formatOf(url.href);
      if (!sameSite && format === 'Web page') continue;
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const slug = decodeURIComponent(path.split('/').filter(Boolean).pop() || url.hostname).replace(/[-_]+/g, ' ').replace(/\.\w{2,5}$/, '');
      links.push({ url: url.href, text: clean(slug, 300) || url.href, section: "Found in the page's script data", format, chrome: false });
    }
  }
  return links;
}

export function readHtml(html: string, pageUrl: string): { title: string; html: string; links: PageLink[]; truncated: boolean; notice?: string } {
  const document: Node = new (DOMParser as Node)().parseFromString(html, 'text/html');
  const baseTag = document.querySelector('base[href]');
  const base = (baseTag && absolute(baseTag.getAttribute('href') || '', pageUrl)) || pageUrl;
  const title = clean(document.querySelector('title')?.textContent || document.querySelector('h1')?.textContent || '', 300);

  enableDeferredStylesheets(document);
  unwrapNoscript(document);
  for (const element of Array.from(document.querySelectorAll(REMOVE)) as Node[]) element.remove();
  for (const element of Array.from(document.querySelectorAll('[id], [class]')) as Node[]) {
    if (element.isConnected !== false && isOverlay(element)) element.remove();
  }
  for (const style of Array.from(document.querySelectorAll('style')) as Node[]) {
    const css = String(style.textContent || '');
    if (/url\(|@import/i.test(css)) style.textContent = absoluteCssUrls(css, base);
  }
  for (const element of Array.from(document.querySelectorAll('*')) as Node[]) {
    wakeLazyMedia(element, base);
    const tag = String(element.tagName || '').toLowerCase();
    if (tag !== 'a' && tag !== 'img' && tag !== 'source' && !element.getAttribute('data-cs-href')) {
      const target = element.getAttribute('data-href') || element.getAttribute('data-link') || (tag === 'tr' || tag === 'li' || tag === 'div' || tag === 'button' ? element.getAttribute('data-url') : '');
      const resolved = target ? absolute(String(target), base) : '';
      if (/^https?:/i.test(resolved)) element.setAttribute('data-cs-href', resolved);
    }
    for (const attribute of Array.from(element.attributes || []) as Node[]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) {
        // onclick="location.href='/forms/x.pdf'" is a link in everything but name.
        const nav = String(attribute.value || '').match(NAV_SCRIPT);
        if (nav && !(tag === 'a' && /^https?:/i.test(absolute(element.getAttribute('href') || '', base)))) {
          const resolved = absolute(nav[1], base);
          if (/^https?:/i.test(resolved)) element.setAttribute('data-cs-href', resolved);
        }
        element.removeAttribute(attribute.name);
      } else if (name === 'srcdoc' || name === 'target' || name === 'ping' || name === 'http-equiv') {
        element.removeAttribute(attribute.name);
      } else if (name === 'href' && String(attribute.value).trim().startsWith('#')) {
        // A jump within the page stays a jump; it is not a link to collect.
      } else if (name === 'href' && /^\s*javascript:/i.test(String(attribute.value))) {
        // href="javascript:openWindow('/forms/x.pdf')": keep the address it opens.
        const inner = String(attribute.value).match(NAV_SCRIPT) || String(attribute.value).match(JS_HREF_URL);
        const resolved = inner ? absolute(inner[1], base) : '';
        if (/^https?:/i.test(resolved)) element.setAttribute('href', resolved);
        else element.removeAttribute(attribute.name);
      } else if (name === 'style') {
        if (/expression\(|javascript:|url\(\s*['"]?\s*javascript:/i.test(attribute.value)) element.removeAttribute('style');
        else if (/url\(/i.test(attribute.value)) element.setAttribute('style', absoluteCssUrls(attribute.value, base).replace(/url\("([^"]*)"\)/g, "url('$1')"));
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
      }
    }
  }

  // Number every link in page order, noting the heading above it.
  const links: PageLink[] = [];
  const indexByUrl = new Map<string, number>();
  let section = '';
  let truncated = false;
  const self = pageUrl.split('#')[0];
  for (const node of Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, a[href], area[href], [data-cs-href]')) as Node[]) {
    if (/^h[1-6]$/i.test(node.tagName)) {
      section = clean(node.textContent, 160);
      continue;
    }
    const scripted = node.getAttribute('data-cs-href') || '';
    const href = (/^(a|area)$/i.test(node.tagName) && /^https?:/i.test(node.getAttribute('href') || '') ? node.getAttribute('href') : scripted) || '';
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
      const text = clean(node.textContent, 300) || clean(node.getAttribute('title') || node.getAttribute('aria-label') || node.getAttribute('alt') || node.getAttribute('value') || image?.getAttribute('alt') || '', 300);
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

  // linkedom can return a title/head yet fail to build body descendants for some large HTML pages.
  // Extract standard anchors and render a newly constructed preview rather than a blank frame.
  const parsedBodyElements = Array.from(document.querySelectorAll('body *')).length;
  const rawHasLinkedAnchors = /<a\b[^>]*\bhref\s*=/i.test(html);
  if (parsedBodyElements === 0 || (links.length === 0 && rawHasLinkedAnchors)) {
    const fallback = extractRawHtmlLinks(html, pageUrl);
    console.warn('page-reader safe link-index fallback', JSON.stringify({
      url: pageUrl,
      title,
      inputHtmlLength: html.length,
      parsedBodyElements,
      rawAnchorTags: (html.match(/<a\b/gi) || []).length,
      rawHrefAttributes: (html.match(/\bhref\s*=/gi) || []).length,
      fallbackLinks: fallback.links.length
    }));
    if (fallback.links.length > 0 || parsedBodyElements === 0) {
      return {
        title,
        html: buildFallbackPreview(title, fallback.links),
        links: fallback.links,
        truncated: fallback.truncated
      };
    }
  }

  // A page that builds itself with script arrives nearly empty. Say so, and list the
  // addresses its embedded data carries so there is still something to pick from.
  let notice = '';
  const visibleText = clean(document.querySelector('body')?.textContent || '', 2000);
  const contentLinks = links.filter(link => !link.chrome).length;
  const scriptBuilt = /id=["'](?:root|app|__next|__nuxt|main-app|application|svelte)["']|data-reactroot|ng-app|ng-version|data-server-rendered|<app-root|<script\b[^>]*type=["']module["']/i.test(html) ||
    (String(html).match(/<script\b/gi) || []).length >= 5;
  if (contentLinks < 5 && visibleText.length < 250 && scriptBuilt) {
    const known = new Set(links.map(link => link.url));
    const dataLinks = extractDataLinks(html, base, known).slice(0, Math.max(0, MAX_LINKS - links.length));
    links.push(...dataLinks);
    notice = dataLinks.length
      ? 'This page builds its content with script, which the reader does not run. ' + dataLinks.length + ' address' + (dataLinks.length === 1 ? '' : 'es') + ' found in its data are listed under “On this page”.'
      : 'This page builds its content with script, which the reader does not run, so it may look empty here. Open it in a new tab, or go back and use “Follow links by level”.';
  }

  const head = document.querySelector('head') || document.documentElement;
  const reveal = document.createElement('style');
  reveal.setAttribute('data-cs-reveal', '');
  reveal.textContent = REVEAL_CSS;
  head.appendChild(reveal);

  // The copy cannot run script even if a page smuggles some past the cleanup:
  // the dashboard shows it in a sandbox without scripts, and this policy agrees.
  const policy = document.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'");
  head.insertBefore(policy, head.firstChild);
  const charset = document.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  head.insertBefore(charset, head.firstChild);

  const page: { title: string; html: string; links: PageLink[]; truncated: boolean; notice?: string } =
    { title, html: '<!doctype html>\n' + document.documentElement.outerHTML, links, truncated };
  if (notice) page.notice = notice;
  return page;
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

// Session cookies some sites set on the first response and require on the redirect
// that follows (otherwise they redirect forever). Kept for this one read only.
type Cookie = { domain: string; hostOnly: boolean; name: string; value: string };
function storeCookies(jar: Cookie[], response: Response, url: URL) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const lines = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const line of lines) {
    const [pair, ...attributes] = String(line || '').split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const domainAttribute = attributes.map(part => part.trim()).find(part => /^domain=/i.test(part));
    const host = url.hostname.toLowerCase();
    let domain = domainAttribute ? domainAttribute.slice(7).trim().toLowerCase().replace(/^\./, '') : host;
    if (domain !== host && !host.endsWith('.' + domain)) domain = host;
    const index = jar.findIndex(cookie => cookie.name === name && cookie.domain === domain);
    if (index >= 0) jar.splice(index, 1);
    if (value && jar.length < 40) jar.push({ domain, hostOnly: !domainAttribute, name, value: value.slice(0, 4096) });
  }
}
function cookieHeader(jar: Cookie[], url: URL): string {
  const host = url.hostname.toLowerCase();
  return jar.filter(cookie => host === cookie.domain || (!cookie.hostOnly && host.endsWith('.' + cookie.domain)))
    .map(cookie => cookie.name + '=' + cookie.value).join('; ');
}

// A page whose only job is to send the browser elsewhere: <meta http-equiv="refresh">
// or a one-line location assignment in an otherwise empty page.
export function clientRedirect(html: string, pageUrl: string): string {
  const head = String(html || '').slice(0, 60_000);
  const meta = head.match(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/i);
  if (meta) {
    const content = meta[0].match(/content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const value = content ? (content[1] ?? content[2] ?? content[3] ?? '') : '';
    const parts = value.match(/^\s*(\d+(?:\.\d+)?)\s*[;,]?\s*(?:url\s*=\s*)?['"]?([^'"]*)['"]?\s*$/i);
    if (parts && Number(parts[1]) <= 15 && parts[2].trim()) return absolute(decodeFallbackEntities(parts[2].trim()), pageUrl);
  }
  if (head.length < 20_000) {
    const text = head.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const script = head.match(/(?:window\.|document\.|top\.|self\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']|location\.(?:replace|assign)\(\s*["']([^"']+)["']/i);
    if (script && text.length < 300) return absolute(script[1] || script[2], pageUrl);
  }
  return '';
}

// Signs that a site answered with a bot check rather than the page.
export function botCheck(html: string): string {
  const head = String(html || '').slice(0, 80_000);
  // Cloudflare and others also inject their scripts into ordinary pages, so a marker
  // only counts when the page has next to no text of its own.
  const text = head.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/<title>\s*(just a moment|attention required|checking your browser|ddos-guard|please wait while we verify)/i.test(head) ||
      (text.length < 1500 && /cf-chl|cf_chl_opt|_Incapsula_Resource|incapsula incident|px-captcha|captcha-delivery|sec-if-cpt|<title>\s*(access denied|request rejected|security check)/i.test(head))) {
    return 'The site answered with a bot check instead of the page, and the reader cannot pass it without a full browser. Open it in a new tab.';
  }
  return '';
}

const STATUS_WORDS: Record<number, string> = {
  401: 'The site asks for a sign-in before showing this page.',
  403: 'The site refused the reader (HTTP 403). Some sites only answer people using a full browser; open it in a new tab.',
  404: 'The site says this page does not exist (HTTP 404).',
  410: 'The site says this page has been removed (HTTP 410).',
  429: 'The site is limiting requests right now (HTTP 429). Wait a minute and try again.',
  451: 'The site will not serve this page in the reader\'s region (HTTP 451).',
  503: 'The site is unavailable or refused the reader (HTTP 503). Try again, or open it in a new tab.'
};
function statusMessage(status: number): string {
  return STATUS_WORDS[status] || (status >= 500 ? 'The site had a problem answering (HTTP ' + status + '). Try again shortly.' : 'The site answered HTTP ' + status + '.');
}

function requestHeaders(browser: boolean, cookies: string): Record<string, string> {
  const headers: Record<string, string> = browser
    ? {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1'
    }
    : { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en;q=0.9,*;q=0.5' };
  if (cookies) headers.Cookie = cookies;
  return headers;
}

export async function readPage(raw: string, fetcher: typeof fetch = fetch) {
  let url = checkUrl(raw);
  const started = Date.now();
  const jar: Cookie[] = [];
  let browser = false;
  let retried = false;
  const visited = new Set<string>();
  for (let hop = 0; ; hop += 1) {
    await checkResolvesPublic(url);
    const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
    if (remaining < 1500) throw new PublicError('The page took too long to answer.', 504);
    let response: Response;
    try {
      response = await fetcher(url.href, {
        redirect: 'manual',
        headers: requestHeaders(browser, cookieHeader(jar, url)),
        signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remaining))
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
      if (!timedOut && !retried) {
        // Some servers drop connections from unfamiliar agents instead of refusing them.
        retried = true;
        browser = true;
        hop -= 1;
        continue;
      }
      throw new PublicError(timedOut ? 'The page took too long to answer.' : 'The page could not be reached.', 502);
    }
    storeCookies(jar, response, url);
    visited.add(url.href);
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
      if (RETRY_STATUSES.has(response.status) && !retried) {
        retried = true;
        browser = true;
        hop -= 1;
        continue;
      }
      return { kind: 'error', url: url.href, status: response.status, message: statusMessage(response.status) };
    }
    const looksLikeFile = formatOf(url.href) !== 'Web page';
    if (contentType && !/html|xml/.test(contentType) && (looksLikeFile || !/text\/plain|octet-stream|unknown/.test(contentType))) {
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
    const next = clientRedirect(text, url.href);
    if (next && /^https?:/i.test(next) && !visited.has(next.split('#')[0]) && hop < MAX_REDIRECTS) {
      url = checkUrl(next);
      continue;
    }
    const blocked = botCheck(text);
    if (blocked) {
      if (!retried) {
        retried = true;
        browser = true;
        hop -= 1;
        continue;
      }
      return { kind: 'error', url: url.href, status: response.status, message: blocked };
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
