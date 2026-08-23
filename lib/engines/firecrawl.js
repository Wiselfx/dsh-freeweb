// Firecrawl search engine for dsh-freeweb.
//
// Calls Firecrawl's v2 /search API (SERP-backed: native Google operators).
// Works three ways, mirroring oh-my-pi's adapter (MIT; see NOTICE):
//   - API key      → Bearer auth (env FIRECRAWL_API_KEY or per-call option)
//   - self-hosted  → FIRECRAWL_BASE_URL without a key
//   - hosted keyless → no Authorization header at all (IP-reputation gated;
//     frequently 403s from datacenter IPs, so the orchestrator only calls it
//     here when a key/endpoint is configured, or when forced via config)
//
// Self-contained: node builtins + global fetch only.

const DEFAULT_BASE_URL = 'https://api.firecrawl.dev';
const MAX_NUM_RESULTS = 100;

const RECENCY_TBS = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' };

/**
 * True when this engine can plausibly run right now WITHOUT relying on the
 * hosted keyless tier: an env key, an explicit key, or a self-hosted endpoint.
 */
export function hasFirecrawlCredential(explicitKey) {
  if (explicitKey && explicitKey.trim()) return true;
  if ((process.env.FIRECRAWL_API_KEY ?? '').trim()) return true;
  const base = process.env.FIRECRAWL_BASE_URL ?? process.env.FIRECRAWL_API_URL;
  // A non-default base URL means self-hosted/proxied — no key needed there.
  if (base?.trim()) {
    try {
      return new URL(base.trim()).origin !== new URL(DEFAULT_BASE_URL).origin;
    } catch {
      return false;
    }
  }
  return false;
}

function resolveSearchUrl(baseUrl) {
  const raw = baseUrl?.trim() || process.env.FIRECRAWL_BASE_URL?.trim() || process.env.FIRECRAWL_API_URL?.trim() || DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Firecrawl base URL is not a valid URL');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Firecrawl base URL must be http(s)');
  if (url.username || url.password) throw new Error('Firecrawl base URL must not contain credentials');
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!/\/v[12]$/i.test(url.pathname)) url.pathname += '/v2';
  url.pathname += '/search';
  return url.toString();
}

/** ISO YYYY-MM-DD → Google MM/DD/YYYY for tbs=cdr custom ranges. */
function toGoogleDate(iso) {
  const [year, month, day] = iso.split('-');
  return `${month}/${day}/${year}`;
}

/** Absolute after:/before: bounds → Firecrawl tbs param; undefined if none. */
export function buildDateTbs(dates) {
  if (!dates?.after && !dates?.before) return undefined;
  const parts = ['cdr:1'];
  if (dates.after) parts.push(`cd_min:${toGoogleDate(dates.after)}`);
  if (dates.before) parts.push(`cd_max:${toGoogleDate(dates.before)}`);
  return parts.join(',');
}

function getWebResults(data) {
  if (Array.isArray(data.data)) return data.data;
  if (data.data && Array.isArray(data.data.web)) return data.data.web;
  return data.results ?? [];
}

/**
 * Search Firecrawl.
 * @param {object} p
 * @param {string} p.query   query string (Google operators pass through)
 * @param {{after?: string, before?: string}} [p.dates]  ISO dates moved to native tbs
 * @param {number} [p.limit=10]
 * @param {'day'|'week'|'month'|'year'} [p.recency]
 * @param {number} [p.timeoutMs=25000]
 * @param {AbortSignal} [p.signal]
 * @param {string} [p.apiKey]
 * @returns {Promise<{engine: 'firecrawl', sources: Array<{title,url,snippet?}>, authMode: string}>}
 */
export async function searchFirecrawl({
  query,
  dates,
  limit = 10,
  recency,
  timeoutMs = 25000,
  signal,
  apiKey,
}) {
  const cap = Math.max(1, Math.min(MAX_NUM_RESULTS, limit));
  const body = { query, limit: cap, sources: [{ type: 'web' }] };
  const tbs = dates ? buildDateTbs(dates) : undefined;
  if (tbs) body.tbs = tbs;
  else if (recency && RECENCY_TBS[recency]) body.tbs = RECENCY_TBS[recency];

  const key = apiKey?.trim() || process.env.FIRECRAWL_API_KEY?.trim() || '';
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;

  const timeout = AbortSignal.timeout(timeoutMs);
  const linked = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(resolveSearchUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: linked,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Firecrawl API error (${res.status}): ${detail}`);
  }
  const data = await res.json();
  if (data.success === false) {
    throw new Error(`Firecrawl request failed: ${(data.error ?? '').trim() || 'unknown error'}`);
  }

  const sources = [];
  for (const result of getWebResults(data)) {
    if (!result.url) continue;
    // markdown bodies can be huge; keep snippets merge-friendly
    let snippet = result.description ?? result.snippet ?? undefined;
    if (!snippet && typeof result.markdown === 'string') {
      snippet = result.markdown.slice(0, 300);
    }
    sources.push({ title: result.title ?? result.url, url: result.url, snippet });
  }
  return { engine: 'firecrawl', sources: sources.slice(0, cap), authMode: key ? 'api_key' : 'keyless' };
}
