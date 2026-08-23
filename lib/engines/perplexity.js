// Perplexity anonymous ask-endpoint engine for dsh-freeweb.
//
// Uses Perplexity's consumer SSE endpoint WITHOUT any account, cookie, or API
// key — the same unauthenticated fallback oh-my-pi's adapter ships. Returns a
// synthesized answer plus cited sources. Independent implementation informed
// by MIT-licensed code in oh-my-pi (see NOTICE).
//
// Self-contained on purpose: node builtins + global fetch only.

const ASK_URL = 'https://www.perplexity.ai/rest/sse/perplexity_ask';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const RECENCY_TO_FILTER = { day: 'day', week: 'week', month: 'month', year: 'year' };

function buildPayload(query, recency) {
  const params = {
    query_str: query,
    search_focus: 'internet',
    mode: 'copilot',
    model_preference: 'experimental',
    sources: ['web'],
    attachments: [],
    frontend_uuid: crypto.randomUUID(),
    frontend_context_uuid: crypto.randomUUID(),
    version: '2.18',
    language: 'en-US',
    timezone: 'UTC',
    // Absolute date bounds would take precedence over recency upstream; we
    // support neither here yet, so this stays null unless recency is set.
    search_recency_filter: RECENCY_TO_FILTER[recency] ?? null,
    is_incognito: true,
    use_schematized_api: true,
    // Always retrieve: without these the backend classifier sometimes answers
    // from memory, ungrounded, and then refuses that it lacks live access.
    skip_search_enabled: false,
    always_search_override: true,
    prompt_source: 'user',
    source: 'default',
    local_search_enabled: false,
    // Declare no tool-approval UI / local browser agent so the stream never
    // stalls waiting for a confirmation we cannot render.
    should_ask_for_mcp_tool_confirmation: false,
    supports_tool_approval_modal: false,
    force_enable_browser_agent: false,
    is_local_browser_available: false,
    is_local_browser_allowed: false,
    // Anonymous streams need this to include the final text payload.
    send_back_text_in_streaming_api: true,
  };
  return { query_str: query, params };
}

/** One dispatch attempt. Throws on HTTP failure; returns the merged event. */
async function askOnce(query, recency, signal) {
  const res = await fetch(ASK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Origin: 'https://www.perplexity.ai',
      Referer: 'https://www.perplexity.ai/',
      'User-Agent': UA,
      'X-Request-ID': crypto.randomUUID(),
    },
    body: JSON.stringify(buildPayload(query, recency)),
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Perplexity anonymous endpoint error (${res.status}) ${detail}`);
  }
  // Buffer the whole stream: we only need the final merged state, and naive
  // incremental SSE splitting breaks when \r\n pairs straddle chunk bounds.
  const full = await res.text();
  const events = [];
  for (const line of full.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // partial/garbled line — the final usable event still parses below
    }
  }
  // Fields accumulate across events; later events supersede earlier ones.
  // The last event can be an empty terminator, so keep the last one that
  // actually carries blocks/text/sources.
  let ev = null;
  for (const e of events) {
    if ((e.blocks?.length ?? 0) > 0 || typeof e.text === 'string' || e.sources_list?.length) ev = e;
  }
  if (!ev) throw new Error('Perplexity anonymous stream carried no content events');
  return ev;
}

function extractAnswer(ev) {
  const mdBlock = ev.blocks?.find((b) => b.intended_usage === 'ask_text')?.markdown_block;
  if (mdBlock) {
    if (Array.isArray(mdBlock.chunks) && mdBlock.chunks.length > 0) return mdBlock.chunks.join('');
    if (typeof mdBlock.answer === 'string' && mdBlock.answer.length > 0) return mdBlock.answer;
  }
  return typeof ev.text === 'string' ? ev.text : '';
}

function extractSources(ev) {
  const webResults =
    ev.blocks?.find((b) => b.intended_usage === 'web_results')?.web_result_block?.web_results ?? [];
  const raw = webResults.length > 0 ? webResults : (ev.sources_list ?? []);
  const sources = [];
  for (const s of raw) {
    if (typeof s.url !== 'string' || s.url.length === 0) continue;
    sources.push({
      title: s.name ?? s.title ?? s.url,
      url: s.url,
      snippet: typeof s.snippet === 'string' ? s.snippet : undefined,
      publishedAt: webResults.length > 0 ? s.timestamp : s.date,
    });
  }
  return sources;
}

/**
 * Search via Perplexity's anonymous ask endpoint.
 * @returns {Promise<{engine: string, sources: Array, answer: string}>}
 */
export async function searchPerplexity({ query, limit = 10, recency, timeoutMs = 25000, signal }) {
  const cap = Math.max(1, Math.min(30, limit));
  const timeout = AbortSignal.timeout(timeoutMs);
  const linked = signal ? AbortSignal.any([signal, timeout]) : timeout;

  // The consumer endpoint intermittently drops the socket before sending an
  // HTTP response (observed upstream too). Retry the transport exactly once;
  // once an HTTP response arrives, its outcome is final — never retried.
  let ev;
  try {
    ev = await askOnce(query, recency, linked);
  } catch (err) {
    if (linked.aborted) throw err;
    ev = await askOnce(query, recency, linked);
  }

  const sources = extractSources(ev).slice(0, cap);
  return { engine: 'perplexity', sources, answer: extractAnswer(ev) };
}
