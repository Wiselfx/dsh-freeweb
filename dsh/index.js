// dsh-freeweb — a keyless WebSearchProvider for the DeepSeek Harness web seam.
//
// Plugin contract (stable across dsh 0.1.x): a cordis plugin module exporting
// `name`, `inject`, `apply`. We register ONE provider into `ctx.web`; dsh's
// built-in web_search tool, citation cards, and UI keep working unchanged —
// only the backend behind them changes.
//
// Two engines are active at a time, in priority order. Each is asked for
// RESULTS_PER_ENGINE results. If one fails, the next engine in the order takes
// its slot, so two live engines are kept active for as long as candidates
// remain. Whatever answers is merged by cross-engine agreement and everything
// unique is returned (dsh applies its own display cap).
//
// All engines are keyless. Optional keys only raise rate limits.

import { mergeEngineResults } from '../lib/merge.js';
import { compactSources } from '../lib/compact.js';
import {
  parseSearchQuery,
  formatScraperQuery,
  applyQueryConstraints,
} from '../lib/query.js';
import { searchStartpage } from '../lib/engines/startpage.js';
import { searchDuckDuckGo } from '../lib/engines/duckduckgo.js';
import { searchExa } from '../lib/engines/exa.js';
import { searchAnySearch } from '../lib/engines/anysearch.js';
import { searchKeenable } from '../lib/engines/keenable.js';
import { searchDegoog } from '../lib/engines/degoog.js';

export const name = 'freeweb';

/** The web capability seam is the only harness service we touch. */
export const inject = ['web'];

/** Results requested from each active engine. */
const RESULTS_PER_ENGINE = 5;

/** Active slots: two engines run concurrently. */
const ACTIVE_ENGINES = 2;

/** Priority order. The first two live engines fill the two active slots. */
const DEFAULT_ENGINE_ORDER = ['exa', 'keenable', 'degoog', 'startpage', 'duckduckgo', 'anysearch'];

function resolveConfig(config = {}) {
  return {
    engineOrder: config.engineOrder ?? DEFAULT_ENGINE_ORDER,
    engineTimeoutMs: config.engineTimeoutMs ?? 25_000,
    hardDeadlineMs: config.hardDeadlineMs ?? 27_000,
    apiKeys: {
      exa: config.exaApiKey ?? process.env.EXA_API_KEY,
      anysearch: config.anysearchApiKey ?? process.env.ANYSEARCH_API_KEY,
      keenable: config.keenableApiKey ?? process.env.KEENABLE_API_KEY,
      degoog: config.degoogApiKey ?? process.env.DEGOOG_API_KEY,
    },
    degoogBaseUrl: config.degoogBaseUrl,
  };
}

/**
 * Search with two active engines plus ordered fallback.
 * Exported for standalone testing; `apply()` wires this into ctx.web.
 *
 * @param {{query: string, maxResults?: number, recency?: string}} request
 * @param {object} [config]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{content: string, sources: Array, truncated: boolean}>}
 */
export async function searchFreeWeb(request, config, signal) {
  const cfg = resolveConfig(config);

  // HTML frontends need the lenient operator rebuild; natural-language APIs
  // get the raw query instead (see the runner table below).
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

  // One hard cap for the whole call. Engines still running when it fires are
  // aborted, so the tool call can never outlive hardDeadlineMs.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), cfg.hardDeadlineMs);
  const linked = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const common = { timeoutMs: cfg.engineTimeoutMs, signal: linked, recency: request.recency };

  const runners = {
    startpage: () => searchStartpage({ ...common, query: scraperQuery, limit: RESULTS_PER_ENGINE }),
    duckduckgo: () => searchDuckDuckGo({ ...common, query: scraperQuery, limit: RESULTS_PER_ENGINE }),
    exa: () => searchExa({ ...common, query: request.query, limit: RESULTS_PER_ENGINE, apiKey: cfg.apiKeys.exa }),
    anysearch: () => searchAnySearch({ ...common, query: request.query, limit: RESULTS_PER_ENGINE, apiKey: cfg.apiKeys.anysearch }),
    keenable: () => searchKeenable({ ...common, query: request.query, limit: RESULTS_PER_ENGINE, apiKey: cfg.apiKeys.keenable }),
    degoog: () => searchDegoog({ ...common, query: request.query, limit: RESULTS_PER_ENGINE, apiKey: cfg.apiKeys.degoog, baseUrl: cfg.degoogBaseUrl }),
  };

  const queue = cfg.engineOrder.filter((id) => typeof runners[id] === 'function');
  if (queue.length === 0) throw new Error('freeweb: no engines configured');

  const successes = [];
  const failures = [];
  try {
    // Fill the active slots. A failed engine is replaced by the next candidate
    // until two engines have answered or the order is exhausted.
    while (successes.length < ACTIVE_ENGINES && queue.length > 0) {
      if (linked.aborted) break;
      const need = ACTIVE_ENGINES - successes.length;
      const batch = queue.splice(0, need);
      const settled = await Promise.allSettled(batch.map((id) => runners[id]()));
      settled.forEach((outcome, i) => {
        if (outcome.status === 'fulfilled') successes.push(outcome.value);
        else failures.push(`${batch[i]}: ${outcome.reason?.message ?? outcome.reason}`);
      });
    }
  } finally {
    clearTimeout(timer);
  }

  if (successes.length === 0) {
    if (signal?.aborted) {
      const err = new Error('freeweb: search was aborted');
      err.name = 'AbortError';
      throw err;
    }
    throw new Error(`freeweb: all keyless engines failed — ${failures.join('; ')}`);
  }

  // Merge by consensus. No cap here: every unique result survives.
  let sources = mergeEngineResults(successes, Number.POSITIVE_INFINITY);

  // Lenient post-filter for constraints the HTML frontends cannot enforce
  // natively. A dimension that would wipe out all results is relaxed.
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

  // Rendering-only final step: rank-budgeted snippets keep the token cost down
  // after dsh applies its own display cap. Selection and ordering are untouched.
  sources = compactSources(sources);

  const contentParts = notes.map((n) => `Note: ${n}`);
  contentParts.push(`[freeweb engines answering: ${successes.map((s) => s.engine).join(', ')}]`);
  if (failures.length > 0) contentParts.push(`[freeweb fallback used: ${failures.join('; ')}]`);

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
