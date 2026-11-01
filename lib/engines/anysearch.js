/**
 * AnySearch search adapter — keyless by default.
 *
 * Bytes-for-bytes port of the request/response shape in pi-web-access (MIT,
 * https://github.com/nicobailon/pi-web-access) `anysearch.ts`. That provider
 * sends `Authorization` only when a key exists, so the public endpoint answers
 * without one; live-tested keyless from a datacenter IP.
 *
 * Only Node builtins + global fetch are used.
 *
 * @param {object} p
 * @param {string} p.query
 * @param {number} [p.limit=10]
 * @param {number} [p.timeoutMs]
 * @param {AbortSignal} [p.signal]
 * @param {string} [p.apiKey]
 * @returns {Promise<{engine: string, sources: Array}>}
 */
export async function searchAnySearch({ query, limit = 10, timeoutMs = 25_000, signal, apiKey }) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) throw new Error('anysearch: a non-empty query string is required');
  const cap = Math.max(1, Math.min(50, limit));
  const timeout = AbortSignal.timeout(timeoutMs);
  const linked = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const response = await fetch('https://api.anysearch.com/v1/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ query: q, max_results: cap }),
      signal: linked,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`AnySearch API error ${response.status}: ${detail}`);
    }
    const data = await response.json();
    const raw = Array.isArray(data?.data?.results) ? data.data.results : [];
    return {
      engine: 'anysearch',
      sources: raw.filter((r) => typeof r?.url === 'string' && r.url).slice(0, cap).map((r) => ({
        title: typeof r.title === 'string' && r.title ? r.title : r.url,
        url: r.url,
        ...(typeof r.snippet === 'string' && r.snippet ? { snippet: r.snippet } : {}),
      })),
    };
  } catch (error) {
    throw normalizeError(error);
  }
}

function normalizeError(error) {
  const raw = error instanceof Error ? error : new Error(String(error));
  if (raw.name === 'AbortError' || raw.name === 'TimeoutError') {
    const err = new Error(raw.name === 'TimeoutError' ? 'AnySearch timed out' : 'AnySearch was aborted');
    err.name = raw.name;
    err.cause = raw;
    return err;
  }
  if (/anysearch/i.test(raw.message)) return raw;
  const wrapped = new Error(`anysearch: ${raw.message}`);
  wrapped.cause = raw;
  return wrapped;
}
