/**
 * degoog search adapter — keyless by default.
 *
 * Port of pi-web-access (MIT, https://github.com/nicobailon/pi-web-access)
 * `degoog.ts`. degoog is a self-hosted metasearch frontend; the public
 * instance at https://degoog.org serves search without a credential, and
 * `DEGOOG_URL` / `degoogApiKey` are only needed for a private deployment.
 * Live-tested keyless from a datacenter IP (29 results on one query).
 *
 * Only Node builtins + global fetch are used.
 *
 * @param {object} p
 * @param {string} p.query
 * @param {number} [p.limit=10]
 * @param {'day'|'week'|'month'|'year'} [p.recency]
 * @param {number} [p.timeoutMs]
 * @param {AbortSignal} [p.signal]
 * @param {string} [p.apiKey]
 * @param {string} [p.baseUrl]
 * @returns {Promise<{engine: string, sources: Array}>}
 */
export async function searchDegoog({ query, limit = 10, recency, timeoutMs = 25_000, signal, apiKey, baseUrl }) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) throw new Error('degoog: a non-empty query string is required');
  const cap = Math.max(1, Math.min(50, limit));
  const base = normalizeBaseUrl(baseUrl ?? process.env.DEGOOG_URL) ?? 'https://degoog.org';
  const timeout = AbortSignal.timeout(timeoutMs);
  const linked = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const body = { query: q, type: 'web', page: 1 };
  if (recency) body.time = recency;

  try {
    const response = await fetch(`${base}/api/search`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: linked,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      if (response.status === 401) {
        throw new Error(`degoog search error 401: this instance protects search routes; set DEGOOG_API_KEY. ${detail}`);
      }
      throw new Error(`degoog search error ${response.status}: ${detail}`);
    }
    const data = await response.json();
    const raw = Array.isArray(data?.results) ? data.results : [];
    return {
      engine: 'degoog',
      sources: raw.filter((r) => typeof r?.url === 'string' && r.url).slice(0, cap).map((r) => ({
        title: text(r.title) || r.url,
        url: r.url,
        ...(text(r.snippet) ? { snippet: text(r.snippet) } : {}),
      })),
    };
  } catch (error) {
    throw normalizeError(error);
  }
}

function text(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function normalizeError(error) {
  const raw = error instanceof Error ? error : new Error(String(error));
  if (raw.name === 'AbortError' || raw.name === 'TimeoutError') {
    const err = new Error(raw.name === 'TimeoutError' ? 'degoog timed out' : 'degoog was aborted');
    err.name = raw.name;
    err.cause = raw;
    return err;
  }
  if (/degoog/i.test(raw.message)) return raw;
  const wrapped = new Error(`degoog: ${raw.message}`);
  wrapped.cause = raw;
  return wrapped;
}
