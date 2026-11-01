/**
 * Keenable search adapter — keyless by default.
 *
 * Port of pi-web-access (MIT, https://github.com/nicobailon/pi-web-access)
 * `keenable.ts`. Without a key it calls the public endpoint and identifies the
 * client with `X-Keenable-Title`; a key only raises the rate limit.
 * Live-tested keyless from a datacenter IP (fastest of the keyless set).
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
export async function searchKeenable({ query, limit = 10, timeoutMs = 25_000, signal, apiKey }) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) throw new Error('keenable: a non-empty query string is required');
  const cap = Math.max(1, Math.min(50, limit));
  const timeout = AbortSignal.timeout(timeoutMs);
  const linked = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const url = apiKey
    ? 'https://api.keenable.ai/v1/search'
    : 'https://api.keenable.ai/v1/search/public';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Keenable-Title': 'dsh-freeweb',
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
      },
      body: JSON.stringify({ query: q, max_results: cap, snippet_max_length: 500 }),
      signal: linked,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      const hint = response.status === 429 && !apiKey ? ' (keyless rate limit; set KEENABLE_API_KEY to raise it)' : '';
      throw new Error(`Keenable error ${response.status}: ${detail}${hint}`);
    }
    const data = await response.json();
    const raw = Array.isArray(data?.results) ? data.results : [];
    return {
      engine: 'keenable',
      sources: raw.filter((r) => typeof r?.url === 'string' && r.url).slice(0, cap).map((r) => {
        // The page text lives in `snippet`; `description` is usually empty.
        const snippet = text(r.snippet) || text(r.description);
        return {
          title: text(r.title) || r.url,
          url: r.url,
          ...(snippet ? { snippet } : {}),
        };
      }),
    };
  } catch (error) {
    throw normalizeError(error);
  }
}

function text(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function normalizeError(error) {
  const raw = error instanceof Error ? error : new Error(String(error));
  if (raw.name === 'AbortError' || raw.name === 'TimeoutError') {
    const err = new Error(raw.name === 'TimeoutError' ? 'Keenable timed out' : 'Keenable was aborted');
    err.name = raw.name;
    err.cause = raw;
    return err;
  }
  if (/keenable/i.test(raw.message)) return raw;
  const wrapped = new Error(`keenable: ${raw.message}`);
  wrapped.cause = raw;
  return wrapped;
}
