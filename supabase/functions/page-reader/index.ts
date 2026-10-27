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
// Documents (PDF, workbooks, Word, CSV, ZIP) can be read whole for the dashboard's viewers.
export const MAX_FILE_BYTES = 25_000_000;
const FILE_BUDGET = 80;
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

// Sent with every answer. The dashboard compares it with the version it was
// built for and says so when the deployed reader is older (its styles, live
// view and reading view then do not arrive).
export const READER_VERSION = '2026-10-27';

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

// The document formats the dashboard can show, from the address or the content type.
export function documentFormat(url: string, contentType: string): string {
  const type = String(contentType || '').toLowerCase();
  const byName = formatOf(url);
  if (/pdf/.test(type) || byName === 'PDF') return 'PDF';
  if (/spreadsheetml|ms-excel|\bcsv\b/.test(type) || byName === 'Spreadsheet') return /csv/.test(type) || /\.csv(\?|$)/i.test(url) ? 'CSV' : 'Spreadsheet';
  if (/wordprocessingml|msword/.test(type) || byName === 'Word') return 'Word';
  if (/zip/.test(type) || byName === 'ZIP') return 'ZIP';
  if (byName === 'XML' && !/html/.test(type)) return 'XML';
  if (byName === 'JSON' || /json/.test(type)) return 'JSON';
  if (byName === 'Text') return 'Text';
  return '';
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

// React and Next.js stream a page: the server sends a placeholder (a skeleton,
// a spinner) inside <!--$?--><template id="B:1"></template>…<!--/$-->, and the
// finished part later as <div hidden id="S:1">…</div> plus a tiny script that
// swaps them. With scripting off the swap never happens, so it is done here.
export function resolveStreamedBoundaries(document: Node): number {
  let swapped = 0;
  for (const hidden of Array.from(document.querySelectorAll('div[hidden][id^="S:"]')) as Node[]) {
    const id = String(hidden.getAttribute('id') || '').slice(2);
    if (!/^[\w:.-]{1,40}$/.test(id)) continue;
    const marker = document.querySelector('template[id="B:' + id + '"]');
    if (!marker || !marker.parentNode) continue;
    let node = marker.nextSibling;
    while (node && !(node.nodeType === 8 && String(node.data || node.textContent || '').trim() === '/$')) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
    while (hidden.firstChild) marker.parentNode.insertBefore(hidden.firstChild, marker);
    marker.remove();
    hidden.remove();
    swapped += 1;
  }
  return swapped;
}

// How much of the page its own script draws. A page can carry its whole
// content as data for a script (Next.js flight data, Nuxt state, JSON) while
// its HTML holds only a skeleton; the dashboard then offers the live page.
export function scriptBuiltScore(html: string, visibleTextLength: number): { scripted: boolean; reason: string } {
  const source = String(html || '');
  let inlineScript = 0;
  const scriptPattern = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(source)) !== null) inlineScript += match[1].length;
  const skeletons = (source.match(/class=["'][^"']*\b(?:animate-pulse|skeleton|shimmer|placeholder-glow|loading-placeholder)\b/gi) || []).length;
  const clientOnly = (source.match(/<!--\$!-->/g) || []).length;
  if (inlineScript > 40_000 && inlineScript > visibleTextLength * 4) return { scripted: true, reason: 'data' };
  if (skeletons >= 4 || (clientOnly >= 1 && skeletons >= 1)) return { scripted: true, reason: 'skeleton' };
  return { scripted: false, reason: '' };
}

export type ReadCopy = { title: string; html: string; links: PageLink[]; truncated: boolean; notice?: string; scripted?: boolean; reader?: string };
export function readHtml(html: string, pageUrl: string): ReadCopy {
  const document: Node = new (DOMParser as Node)().parseFromString(html, 'text/html');
  const baseTag = document.querySelector('base[href]');
  const base = (baseTag && absolute(baseTag.getAttribute('href') || '', pageUrl)) || pageUrl;
  const title = clean(document.querySelector('title')?.textContent || document.querySelector('h1')?.textContent || '', 300);

  resolveStreamedBoundaries(document);
  // Sites mark <html class="no-js"> and swap it for "js" from script; their
  // stylesheets hide menus and whole layouts under .no-js (Foundation,
  // Modernizr, Drupal and WordPress themes). The copy is the page as script
  // would have left it, so it carries "js".
  const rootElement = document.documentElement;
  if (rootElement && /(?:^|\s)no-?js(?:\s|$)/i.test(String(rootElement.getAttribute('class') || ''))) {
    rootElement.setAttribute('class', String(rootElement.getAttribute('class')).replace(/(^|\s)no-?js(?=\s|$)/gi, '$1js'));
  }
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
  const bodyText = clean(document.querySelector('body')?.textContent || '', 200_000);
  const visibleText = bodyText.slice(0, 2000);
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

  const page: ReadCopy = { title, html: '<!doctype html>\n' + document.documentElement.outerHTML, links, truncated };
  if (notice) page.notice = notice;
  const scripted = notice ? { scripted: true } : scriptBuiltScore(html, bodyText.length);
  if (scripted.scripted) page.scripted = true;
  // A plain reading view of the same content, for when the site's own layout
  // cannot be drawn without its scripts or its styles.
  page.reader = readerView(document, title, pageUrl);
  return page;
}

/* ---------------------------------------------------------------- reading view
 *
 * The page's text, headings, lists, tables, images and links (keeping their
 * numbers, so selecting works the same) without the site's own layout. It is
 * what the dashboard shows when the copy comes out blank.
 */

const READER_KEEP = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'caption', 'blockquote', 'pre', 'code', 'strong', 'b', 'em', 'i', 'u', 'small', 'sub', 'sup', 'br', 'hr', 'figure', 'figcaption', 'a', 'img', 'span', 'time', 'abbr', 'mark']);
const READER_BLOCK = new Set(['div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'form', 'fieldset', 'details', 'summary', 'address', 'center', 'label']);
const READER_SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed', 'select', 'input', 'textarea', 'button', 'link', 'meta', 'head', 'title']);
const READER_LIMIT = 1_500_000;

function escapeText(value: string): string {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function readerHidden(element: Node): boolean {
  if (element.hasAttribute && (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true')) return true;
  const style = String(element.getAttribute && element.getAttribute('style') || '');
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}

export function readerView(document: Node, title: string, pageUrl: string): string {
  const body = document.querySelector('body');
  if (!body) return '';
  let size = 0;
  const out: string[] = [];
  const push = (value: string) => { if (size < READER_LIMIT) { out.push(value); size += value.length; } };
  const walk = (node: Node) => {
    if (size >= READER_LIMIT) return;
    if (node.nodeType === 3) { push(escapeText(node.textContent || '')); return; }
    if (node.nodeType !== 1) return;
    const tag = String(node.tagName || '').toLowerCase();
    if (READER_SKIP.has(tag) || readerHidden(node)) return;
    if (tag === 'img') {
      const src = String(node.getAttribute('src') || '');
      if (/^(https?:|data:image\/)/i.test(src)) push('<img src="' + escapeAttr(src) + '" alt="' + escapeAttr(String(node.getAttribute('alt') || '')) + '" loading="lazy">');
      return;
    }
    const keep = READER_KEEP.has(tag);
    const block = READER_BLOCK.has(tag);
    if (keep) {
      let attributes = '';
      if (tag === 'a') {
        const href = String(node.getAttribute('href') || '');
        if (/^https?:/i.test(href)) attributes += ' href="' + escapeAttr(href) + '"';
      }
      const number = node.getAttribute('data-cs-link');
      if (number !== null && number !== undefined && /^\d+$/.test(String(number))) attributes += ' data-cs-link="' + number + '"';
      for (const name of ['colspan', 'rowspan']) {
        const value = node.getAttribute(name);
        if (value && /^\d{1,3}$/.test(value)) attributes += ' ' + name + '="' + value + '"';
      }
      push('<' + tag + attributes + '>');
      if (tag !== 'br' && tag !== 'hr') {
        for (const child of Array.from(node.childNodes || []) as Node[]) walk(child);
        push('</' + tag + '>');
      }
      return;
    }
    // A clickable block that is not a link (onclick, data-href) keeps its number.
    const number = node.getAttribute('data-cs-link');
    if (number !== null && number !== undefined && /^\d+$/.test(String(number))) {
      push('<div class="cs-r-link" data-cs-link="' + number + '">');
      for (const child of Array.from(node.childNodes || []) as Node[]) walk(child);
      push('</div>');
      return;
    }
    if (block) push('<div class="cs-r-' + tag + '">');
    for (const child of Array.from(node.childNodes || []) as Node[]) walk(child);
    if (block) push('</div>');
  };
  walk(body);
  const content = out.join('');
  let host = '';
  try { host = new URL(pageUrl).hostname; } catch (_) { /* shown without a host */ }
  return '<!doctype html>\n<html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeText(title || host || 'Page') + '</title>' +
    '<style>' +
    'html{background:#fbfaf7}body{max-width:980px;margin:0 auto;padding:22px 26px 60px;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#26221e;overflow-wrap:anywhere}' +
    '.cs-r-head{margin:0 0 18px;padding:0 0 12px;border-bottom:1px solid #e6e0d6;color:#8a8177;font-size:12px;letter-spacing:.04em;text-transform:uppercase}' +
    'h1{font-size:1.6rem;line-height:1.25}h2{font-size:1.3rem}h3{font-size:1.1rem}h1,h2,h3,h4{margin:1.4em 0 .5em}' +
    'a{color:#a3510f}img{max-width:100%;height:auto}table{border-collapse:collapse;margin:12px 0;font-size:14px;display:block;overflow-x:auto}' +
    'th,td{border:1px solid #e1dacf;padding:5px 9px;vertical-align:top;text-align:left}th{background:#f2ede5}' +
    '.cs-r-nav,.cs-r-header,.cs-r-footer{font-size:13px;color:#6b635a}.cs-r-nav a,.cs-r-header a,.cs-r-footer a{margin-right:10px}' +
    '.cs-r-nav ul,.cs-r-header ul,.cs-r-footer ul{display:flex;flex-wrap:wrap;gap:2px 12px;padding-left:0;list-style:none}' +
    '.cs-r-link{cursor:pointer;text-decoration:underline;color:#a3510f}pre{white-space:pre-wrap}' +
    '</style></head><body><div class="cs-r-head">Reading view · ' + escapeText(host) + '</div>' + content + '</body></html>';
}

/* ---------------------------------------------------------------- styles and images inside the copy
 *
 * The copy is shown from an opaque origin, so a site that refuses requests
 * from other sites (Cross-Origin-Resource-Policy: same-site, hotlink or
 * Referer checks, session cookies) sends no stylesheets or images, and the
 * copy looks like bare HTML. The reader fetches them as the page itself would
 * and writes them into the copy: stylesheets always, images when the site
 * refuses cross-site requests. Bounded in count, size and time.
 */

export type AssetFetcher = (url: string, accept: string, limit: number) => Promise<{ type: string; bytes: Uint8Array } | null>;
const STYLE_LIMIT = 40, STYLE_BYTES = 1_500_000, STYLE_TOTAL = 6_000_000;
const IMAGE_LIMIT = 80, IMAGE_BYTES = 300_000, IMAGE_TOTAL = 4_000_000;
const ASSET_CONCURRENCY = 6;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
async function pool<T>(items: T[], worker: (item: T) => Promise<void>, deadline: number) {
  let next = 0;
  const run = async () => {
    while (next < items.length && Date.now() < deadline) await worker(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(ASSET_CONCURRENCY, items.length) }, run));
}
function sameSite(a: string, b: string): boolean {
  try {
    const x = new URL(a).hostname.split('.').slice(-2).join('.');
    const y = new URL(b).hostname.split('.').slice(-2).join('.');
    return x === y;
  } catch (_) {
    return false;
  }
}

export async function inlineAssets(html: string, pageUrl: string, fetchAsset: AssetFetcher, options: { images: boolean; deadline: number }): Promise<string> {
  const document: Node = new (DOMParser as Node)().parseFromString(html, 'text/html');
  let styleTotal = 0;
  const links = (Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]')) as Node[])
    .filter(link => !/^\s*print\s*$/i.test(String(link.getAttribute('media') || '')))
    .slice(0, STYLE_LIMIT);
  await pool(links, async link => {
    const href = String(link.getAttribute('href') || '');
    if (!/^https?:/i.test(href)) return;
    const asset = await fetchAsset(href, 'text/css,*/*;q=0.1', STYLE_BYTES).catch(() => null);
    if (!asset || /html/i.test(asset.type) || styleTotal + asset.bytes.length > STYLE_TOTAL) return;
    styleTotal += asset.bytes.length;
    let css = new TextDecoder('utf-8').decode(asset.bytes);
    css = absoluteCssUrls(css, href).replace(/<\/style/gi, '<\\/style');
    const style = document.createElement('style');
    style.setAttribute('data-cs-from', href);
    const media = link.getAttribute('media');
    if (media) style.setAttribute('media', media);
    style.textContent = css;
    link.parentNode && link.parentNode.replaceChild(style, link);
  }, options.deadline);

  if (options.images) {
    let imageTotal = 0;
    const cache = new Map<string, string>();
    const images = (Array.from(document.querySelectorAll('img[src]')) as Node[])
      .filter(img => /^https?:/i.test(String(img.getAttribute('src') || '')) && sameSite(String(img.getAttribute('src')), pageUrl))
      .slice(0, IMAGE_LIMIT);
    await pool(images, async img => {
      const src = String(img.getAttribute('src'));
      let data = cache.get(src);
      if (data === undefined) {
        const asset = await fetchAsset(src, 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8', IMAGE_BYTES).catch(() => null);
        data = asset && /^image\//i.test(asset.type) && imageTotal + asset.bytes.length <= IMAGE_TOTAL
          ? 'data:' + asset.type.split(';')[0] + ';base64,' + toBase64(asset.bytes) : '';
        if (data) imageTotal += asset!.bytes.length;
        cache.set(src, data);
      }
      if (data) { img.setAttribute('src', data); img.removeAttribute('srcset'); }
    }, options.deadline);
  }
  return '<!doctype html>\n' + document.documentElement.outerHTML;
}

// The original page, for the dashboard's "live" view: the site's own scripts
// run in the dashboard's sandbox (an opaque origin with no access to the
// dashboard), with a <base> so its relative addresses resolve.
export function liveDocument(html: string, pageUrl: string): string {
  let doc = String(html || '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?(?:content-security-policy|refresh)["']?[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '');
  const base = '<base href="' + escapeAttr(pageUrl) + '">';
  doc = /<head\b[^>]*>/i.test(doc) ? doc.replace(/<head\b[^>]*>/i, match => match + base) : base + doc;
  return doc;
}

/* ---------------------------------------------------------------- fetching */

function charsetOf(contentType: string, head: Uint8Array): string {
  const declared = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  if (declared) return declared.toLowerCase();
  const sniff = new TextDecoder('latin1').decode(head.subarray(0, 2048));
  return sniff.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]?.toLowerCase() || 'utf-8';
}

async function readBody(response: Response, limit = MAX_BYTES): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
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

// With { file: true } a document comes back whole as { kind: 'file', bytes } for the
// dashboard's viewers instead of { kind: 'document' }. A web page is still read as a page.
export async function readPage(raw: string, fetcher: typeof fetch = fetch, options: { file?: boolean; live?: boolean; assets?: boolean } = {}) {
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
    const fileFormat = documentFormat(url.href, contentType);
    if (options.file && fileFormat) {
      const file = await readBody(response, MAX_FILE_BYTES);
      if (file.truncated) throw new PublicError('The document is larger than 25 MB, too large to show here. Open it in a new tab.', 413);
      return { kind: 'file', url: url.href, contentType: contentType.split(';')[0] || 'application/octet-stream', format: fileFormat, bytes: file.bytes };
    }
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
    if (options.live) return { kind: 'live', url: url.href, html: liveDocument(text, url.href) };
    const page = readHtml(text, url.href);
    if (options.assets !== false) {
      // Fetch the copy's stylesheets (and, for sites that refuse cross-site
      // requests, its images) the way the page itself would, within the time left.
      const pageUrl = url.href;
      const corp = String(response.headers.get('cross-origin-resource-policy') || '').toLowerCase();
      const deadline = started + TOTAL_BUDGET_MS - 2500;
      const fetchAsset: AssetFetcher = async (asset, accept, limit) => {
        let target = checkUrl(asset);
        for (let hop = 0; hop < 4; hop += 1) {
          await checkResolvesPublic(target);
          const left = deadline - Date.now();
          if (left < 800) return null;
          const headers: Record<string, string> = { ...requestHeaders(true, cookieHeader(jar, target)), Accept: accept, Referer: pageUrl,
            'Sec-Fetch-Dest': /css/.test(accept) ? 'style' : 'image', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Site': sameSite(target.href, pageUrl) ? 'same-site' : 'cross-site' };
          delete headers['Sec-Fetch-User'];
          delete headers['Upgrade-Insecure-Requests'];
          const reply = await fetcher(target.href, { redirect: 'manual', headers, signal: AbortSignal.timeout(Math.min(6000, left)) });
          if ([301, 302, 303, 307, 308].includes(reply.status)) {
            const location = reply.headers.get('location');
            await reply.body?.cancel();
            if (!location) return null;
            target = checkUrl(new URL(location, target).href);
            continue;
          }
          if (!reply.ok) { await reply.body?.cancel(); return null; }
          const content = await readBody(reply, limit);
          if (content.truncated) return null;
          return { type: String(reply.headers.get('content-type') || ''), bytes: content.bytes };
        }
        return null;
      };
      try {
        page.html = await inlineAssets(page.html, pageUrl, fetchAsset, { images: /same-(site|origin)/.test(corp), deadline });
      } catch (error) {
        console.warn('page-reader asset inlining skipped', String(error));
      }
    }
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
    'Access-Control-Expose-Headers': 'Retry-After, X-CS-Kind, X-CS-Format, X-CS-Url, X-CS-Reader',
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
    let body: { url?: string; mode?: string } = {};
    try {
      body = await req.json();
    } catch (_) {
      throw new PublicError('Send a JSON body with a url.');
    }
    const wantFile = body.mode === 'file';
    if (wantFile && !spend('file:' + actor, FILE_BUDGET)) {
      return respond(req, { error: 'Too many documents opened in a short time. Wait a few minutes and retry.' }, 429, { 'Retry-After': '120' });
    }
    // "links": following links by level needs only the links, not the page's styles.
    const result = await readPage(String(body.url || ''), fetch, { file: wantFile, live: body.mode === 'live', assets: body.mode !== 'links' }) as Record<string, unknown>;
    if (result.kind === 'file') {
      // Bytes for the dashboard's script to read, never a document to render: always
      // octet-stream, with the detected format in a header.
      const bytes = result.bytes as Uint8Array;
      return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
        status: 200,
        headers: {
          ...cors(req).headers,
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'X-CS-Kind': 'file',
          'X-CS-Format': String(result.format),
          'X-CS-Url': encodeURI(String(result.url)),
          'X-CS-Reader': READER_VERSION
        }
      });
    }
    return respond(req, { ...result, reader_version: READER_VERSION });
  } catch (error) {
    if (error instanceof PublicError) return respond(req, { error: error.message }, error.status);
    console.error('page-reader failed', error);
    return respond(req, { error: 'The page could not be read.' }, 500);
  }
}

Deno.serve(handle);
