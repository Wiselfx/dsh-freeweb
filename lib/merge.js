// Cross-engine consensus merge for dsh-freeweb.
// Ported from oh-my-pi's public.ts aggregate (MIT; see NOTICE).

/**
 * Canonical dedup key: host lowercased without leading `www.`, path without
 * trailing slash, query preserved, fragment dropped. Engines disagree on
 * exactly these variations for the same page.
 */
export function dedupKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `${host}${path}${url.search}`;
  } catch {
    return rawUrl;
  }
}

function mergeSources(merged, engineLabel, sources) {
  for (const [rank, source] of sources.entries()) {
    if (!source?.url) continue;
    const key = dedupKey(source.url);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        source: { ...source },
        engines: [engineLabel],
        bestRank: rank,
        order: merged.size,
      });
      continue;
    }
    existing.engines.push(engineLabel);
    if (rank < existing.bestRank) {
      existing.bestRank = rank;
      existing.source.title = source.title;
      existing.source.url = source.url;
    }
    // Keep the most informative snippet regardless of which engine ranked it best.
    if (source.snippet && source.snippet.length > (existing.source.snippet?.length ?? 0)) {
      existing.source.snippet = source.snippet;
    }
    existing.source.publishedAt ??= source.publishedAt;
  }
}

/**
 * Merge ranked per-engine result lists into one consensus-ranked list:
 * number of agreeing engines first, then best per-engine rank, then a
 * deterministic first-seen tiebreak.
 *
 * @param {Array<{engine: string, sources: Array}>} engineResults
 * @param {number} limit final cap
 */
export function mergeEngineResults(engineResults, limit) {
  const merged = new Map();
  for (const { engine, sources } of engineResults) {
    mergeSources(merged, engine, sources ?? []);
  }
  return [...merged.values()]
    .sort((a, b) => b.engines.length - a.engines.length || a.bestRank - b.bestRank || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.source);
}
