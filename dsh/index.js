// dsh-freeweb — a keyless WebSearchProvider for the DeepSeek Harness web seam.
//
// Plugin contract (stable across dsh 0.1.x): a cordis plugin module exporting
// `name`, `inject`, `apply`. We register ONE provider into `ctx.web`; dsh's
// built-in web_search tool, citation cards, and UI keep working unchanged —
// only the backend behind them changes.
//
// The provider fans the query out to three independent keyless engines
// concurrently and merges results by cross-engine consensus (oh-my-pi's
// public-aggregate strategy, MIT; see NOTICE):
//
//   - duckduckgo   HTML frontend scraper        (fast, ranked snippets)
//   - startpage    Google index via proxy       (needs homepage token dance)
//   - perplexity   anonymous ask endpoint       (slower, synthesized answer)
//
// Deadline model (from public.ts): return at the earliest of
//   a) every engine settled,
//   b) soft deadline elapsed with ≥1 success in hand,
//   c) hard deadline elapsed regardless.
// One slow engine can never pin the tool call past the hard cap, and one
// blocked engine never fails the call while others answer.

import { mergeEngineResults } from '../lib/merge.js';
import {
  parseSearchQuery,
  formatScraperQuery,
  formatQuery,
  GOOGLE_QUERY_SYNTAX,
  applyQueryConstraints,
} from '../lib/query.js';
import { searchDuckDuckGo } from '../lib/engines/duckduckgo.js';
import { searchStartpage } from '../lib/engines/startpage.js';
import { searchPerplexity } from '../lib/engines/perplexity.js';
import { searchFirecrawl, hasFirecrawlCredential } from '../lib/engines/firecrawl.js';

export const name = 'freeweb';

/** The web capability seam is the only harness service we touch. */
export const inject = ['web'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveConfig(config = {}) {
  const engines = { duckduckgo: true, startpage: true, perplexity: true, firecrawl: 'auto', ...config.engines };
  return {
    engines,
    softDeadlineMs: config.softDeadlineMs ?? 6_000,
    hardDeadlineMs: config.hardDeadlineMs ?? 27_000,
    engineTimeoutMs: config.engineTimeoutMs ?? 25_000,
    firecrawlApiKey: config.firecrawlApiKey,
  };
}

/**
 * Whether the firecrawl engine participates in this call.
 * - `true`         → always (hosted keyless attempt if no key)
 * - `'auto'`       → only when a key or self-hosted endpoint is configured
 *                    (the hosted keyless tier rejects many datacenter IPs)
 * - falsy          → never
 */
function firecrawlParticipates(setting, apiKey) {
  if (setting === true) return true;
  if (setting === false || setting == null) return false;
  return setting === 'auto' ? hasFirecrawlCredential(apiKey) : Boolean(setting);
}

/**
 * Fan-out search across the enabled keyless engines.
 * Exported for standalone testing; `apply()` wires this into ctx.web.
 *
 * @param {{query: string, maxResults?: number}} request
 * @param {Partial<ReturnType<typeof resolveConfig>>} [config]
 * @param {AbortSignal} [signal]
 */
export async function searchFreeWeb(request, config, signal) {
  const cfg = resolveConfig(config);
  const maxResults = Math.max(1, Math.min(30, request.maxResults ?? 15));

  // Google-style operators: scrapers natively understand most of them, but
  // path-carrying site: values and inurl: zero-match on HTML frontends, so we
  // rebuild through the lenient scraper formatter (ported from oh-my-pi).
  let parsed;
  try {
    parsed = parseSearchQuery(request.query);
  } catch {
    parsed = undefined;
  }
  let scraperQuery = request.query;
  if (parsed) {
    try {
      scraperQuery = formatScraperQuery(request.query, parsed);
    } catch {
      /* formatting is best-effort; the raw query always works */
    }
  }

  const tasks = [];
  if (cfg.engines.duckduckgo) {
    tasks.push(['duckduckgo', () => searchDuckDuckGo({ query: scraperQuery, limit: maxResults, recency: request.recency, timeoutMs: cfg.engineTimeoutMs, signal })]);
  }
  if (cfg.engines.startpage) {
    tasks.push(['startpage', () => searchStartpage({ query: scraperQuery, limit: maxResults, recency: request.recency, timeoutMs: cfg.engineTimeoutMs, signal })]);
  }
  if (cfg.engines.perplexity) {
    tasks.push(['perplexity', () => searchPerplexity({ query: request.query, limit: maxResults, recency: request.recency, timeoutMs: cfg.engineTimeoutMs, signal })]);
  }
  if (firecrawlParticipates(cfg.engines.firecrawl, cfg.firecrawlApiKey)) {
    // Firecrawl is SERP-backed and honors Google operators natively, so it
    // gets the full operator set; absolute date bounds move to its native
    // tbs parameter (same split oh-my-pi makes).
    let fcQuery = scraperQuery;
    let fcDates;
    if (parsed?.hasDirectives && (parsed.after || parsed.before)) {
      fcDates = { after: parsed.after, before: parsed.before };
      try {
        fcQuery = formatQuery(parsed, { ...GOOGLE_QUERY_SYNTAX, dateRange: false });
      } catch {
        /* fall back to the shared scraper formatting */
      }
    }
    tasks.push(['firecrawl', () => searchFirecrawl({ query: fcQuery, dates: fcDates, limit: maxResults, recency: request.recency, timeoutMs: cfg.engineTimeoutMs, signal, apiKey: cfg.firecrawlApiKey })]);
  }
  if (tasks.length === 0) throw new Error('freeweb: every engine is disabled by configuration');

  // Straggler controller: once this orchestrator decides to return, engines
  // still running are cancelled so nothing outlives the call.
  const straggler = new AbortController();
  const linked = signal ? AbortSignal.any([signal, straggler.signal]) : straggler.signal;

  const successes = [];
  const failures = [];
  let settledCount = 0;
  let firstSuccess;
  const firstSuccessPromise = new Promise((resolve) => {
    firstSuccess = resolve;
  });

  const all = Promise.all(
    tasks.map(async ([label, run]) => {
      try {
        const result = await run();
        successes.push(result);
        firstSuccess();
      } catch (err) {
        failures.push(`${label}: ${err?.message ?? err}`);
      } finally {
        settledCount += 1;
      }
    }),
  );

  await Promise.race([all, sleep(cfg.softDeadlineMs)]);
  if (successes.length === 0 && settledCount < tasks.length) {
    // Soft deadline fired before any engine answered — wait (up to the hard
    // cap) for the FIRST success so a slow field degrades to fewer engines
    // rather than an empty answer.
    await Promise.race([all, firstSuccessPromise, sleep(Math.max(0, cfg.hardDeadlineMs - cfg.softDeadlineMs))]);
  }
  if (settledCount < tasks.length) straggler.abort();
  await Promise.race([all, sleep(2_000)]); // give cancelled engines a moment to settle

  if (successes.length === 0) {
    throw new Error(`freeweb: all keyless engines failed — ${failures.join('; ')}`);
  }

  // Consensus merge across whatever answered.
  let sources = mergeEngineResults(successes, maxResults);

  // Lenient post-filter for constraints the HTML frontends cannot enforce
  // natively (before:/after:/site: with paths). A dimension that would wipe
  // out all results is relaxed instead of returning an empty page.
  const notes = [];
  if (parsed?.hasConstraints && sources.length > 0) {
    try {
      const applied = applyQueryConstraints(sources, parsed);
      if (Array.isArray(applied?.sources)) {
        sources = applied.sources;
        if (Array.isArray(applied.dropped) && applied.dropped.length > 0) {
          notes.push(`no results matched ${applied.dropped.join(', ')}; the constraint was relaxed`);
        }
      }
    } catch {
      /* filtering must never break the search */
    }
  }

  // Perplexity contributes a synthesized answer when it participated; the
  // contributing-engine summary rides along as context, not noise.
  const pplx = successes.find((s) => s.engine === 'perplexity');
  const contentParts = notes.map((n) => `Note: ${n}`);
  if (pplx?.answer) contentParts.push(pplx.answer.trim());
  contentParts.push(`[freeweb engines answering: ${successes.map((s) => s.engine).join(', ')}]`);

  return {
    content: contentParts.filter(Boolean).join('\n\n'),
    sources,
    truncated: false,
  };
}

/**
 * Cordis plugin entry. Registers the freeweb provider into the web seam.
 * Mirrors modsearch's degradation behavior: if the seam surface moves, log
 * loudly and skip registration instead of crashing the profile.
 */
export function apply(ctx, config = {}) {
  if (typeof ctx.web?.registerSearchProvider !== 'function') {
    console.error('[freeweb] web seam has no registerSearchProvider; search provider skipped');
    return;
  }
  ctx.web.registerSearchProvider({
    id: 'freeweb',
    // Cheap local check only — engines verify reachability at execution time.
    available: () => true,
    async search(request, signal) {
      return searchFreeWeb(request, config, signal);
    },
  });
}
