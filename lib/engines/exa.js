/**
 * Exa search adapter — keyless path via Exa's public MCP endpoint.
 *
 * Ported from pi-web-access (MIT, https://github.com/nicobailon/pi-web-access)
 * `exa.ts`: `callExaMcp()` + `parseMcpResults()`. When `EXA_API_KEY` /
 * `exaApiKey` is absent, pi uses the free `web_search_exa` MCP tool, which
 * needs no credential (it is rate-limited instead). That is the path here.
 *
 * Only Node builtins + global fetch are used.
 *
 * @param {object} p
 * @param {string} p.query
 * @param {number} [p.limit=10]
 * @param {number} [p.timeoutMs]
 * @param {AbortSignal} [p.signal]
 * @param {string} [p.apiKey] optional; when set, uses the REST /search API
 * @returns {Promise<{engine: string, sources: Array}>}
 */
export async function searchExa({ query, limit = 10, timeoutMs = 25_000, signal, apiKey }) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) throw new Error('exa: a non-empty query string is required');
  const cap = Math.max(1, Math.min(30, limit));
  const timeout = AbortSignal.timeout(timeoutMs);
  const linked = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const sources = apiKey ? await searchRest(q, cap, apiKey, linked) : await searchMcp(q, cap, linked);
    return { engine: 'exa', sources };
  } catch (error) {
    throw normalizeError(error);
  }
}

const EXA_MCP_URL = 'https://mcp.exa.ai/mcp';
const EXA_API_BASE_URL = 'https://api.exa.ai';

/** One MCP tools/call over SSE or plain JSON (pi's `callExaMcp`). */
async function callExaMcp(toolName, args, signal) {
  const response = await fetch(`${EXA_MCP_URL}?tools=${toolName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-exa-source': 'dsh-freeweb',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    if (response.status === 429) {
      throw new Error(`Exa free MCP rate limit reached (429): ${detail}`);
    }
    throw new Error(`Exa MCP error ${response.status}: ${detail}`);
  }

  const body = await response.text();
  let parsed;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const candidate = JSON.parse(payload);
      if (candidate?.result || candidate?.error) { parsed = candidate; break; }
    } catch { /* partial line */ }
  }
  if (!parsed) {
    try {
      const candidate = JSON.parse(body);
      if (candidate?.result || candidate?.error) parsed = candidate;
    } catch { /* not JSON */ }
  }
  if (!parsed) throw new Error('Exa MCP returned an empty response');
  if (parsed.error) {
    const code = typeof parsed.error.code === 'number' ? ` ${parsed.error.code}` : '';
    throw new Error(`Exa MCP error${code}: ${parsed.error.message || 'Unknown error'}`);
  }
  // The free endpoint answers a rate limit with HTTP 200 plus this flag.
  if (parsed.result?._meta?.['ai.exa/rateLimited'] === true) {
    throw new Error("Exa's free MCP search hit its rate limit");
  }
  if (parsed.result?.isError) {
    const message = parsed.result.content?.find((i) => i.type === 'text' && typeof i.text === 'string')?.text?.trim();
    throw new Error(message || 'Exa MCP returned an error');
  }
  const text = parsed.result?.content?.find((i) => i.type === 'text' && typeof i.text === 'string' && i.text.trim())?.text;
  if (!text) throw new Error('Exa MCP returned empty content');
  return text;
}

/** Split Exa's formatted MCP text into per-result blocks (pi's `parseMcpResults`). */
function parseMcpResults(text) {
  const blocks = text.split(/(?=^Title: )/m).filter((b) => b.trim().length > 0);
  const parsed = blocks.map((block) => {
    const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? '';
    const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? '';
    let content = '';
    let contentStart = block.length;
    const textStart = block.indexOf('\nText: ');
    if (textStart >= 0) {
      content = block.slice(textStart + 7).trim();
      contentStart = textStart;
    } else {
      const hl = block.match(/\nHighlights:\s*\n/);
      if (hl?.index != null) {
        content = block.slice(hl.index + hl[0].length).trim();
        contentStart = hl.index;
      }
    }
    content = content.replace(/\n---\s*$/, '').trim();
    const header = block.slice(0, contentStart);
    const published = header.match(/^Published: (.+)/m)?.[1]?.trim();
    return { title, url, content, publishedAt: published && published !== 'N/A' ? published : undefined };
  }).filter((r) => r.url.length > 0);
  return parsed.length > 0 ? parsed : null;
}

function toSource(result) {
  const snippet = result.content.replace(/\s+/g, ' ').trim().slice(0, 500);
  return {
    title: result.title || result.url,
    url: result.url,
    ...(snippet ? { snippet } : {}),
    ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
  };
}

async function searchMcp(query, limit, signal) {
  const text = await callExaMcp('web_search_exa', { query, numResults: limit }, signal);
  const results = parseMcpResults(text);
  if (!results) throw new Error(`Exa MCP returned no parseable results: ${text.trim().slice(0, 200)}`);
  return results.slice(0, limit).map(toSource);
}

async function searchRest(query, limit, apiKey, signal) {
  const response = await fetch(`${EXA_API_BASE_URL}/search`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, numResults: limit, contents: { highlights: true } }),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`Exa API error ${response.status}: ${detail}`);
  }
  const data = await response.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.filter((r) => typeof r?.url === 'string' && r.url).slice(0, limit).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    ...(Array.isArray(r.highlights) && r.highlights.length ? { snippet: r.highlights.join(' ').slice(0, 500) } : {}),
    ...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
  }));
}

function normalizeError(error) {
  const raw = error instanceof Error ? error : new Error(String(error));
  if (raw.name === 'AbortError' || raw.name === 'TimeoutError') {
    const err = new Error(raw.name === 'TimeoutError' ? 'Exa search timed out' : 'Exa search was aborted');
    err.name = raw.name;
    err.cause = raw;
    return err;
  }
  if (/exa/i.test(raw.message)) return raw;
  const wrapped = new Error(`exa: ${raw.message}`);
  wrapped.cause = raw;
  return wrapped;
}
