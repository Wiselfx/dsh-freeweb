/**
 * Rank-budgeted snippet compaction — rendering-only, applied as the last step
 * before the merged sources are handed back to dsh.
 *
 * Ported from the `patch-web-search.mjs` helper the author ran against
 * pi-web-access: keep the selection and ordering untouched, but give each
 * source a snippet budget by rank (500 / 220 / 150 / 80 chars), clipped on a
 * sentence boundary where possible. Once dsh trims to its own display cap
 * (8 by default), the tail budgets are tiny, so a search costs far fewer
 * tokens without losing the top results' substance.
 *
 * Node builtins only; no imports.
 */

const BUDGETS = [500, 220, 150, 80];

function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Clip to `max` chars, preferring a sentence boundary past the halfway mark. */
export function clipSnippet(value, max) {
  const text = normalize(value);
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (sentence > max * 0.5) return window.slice(0, sentence + 1);
  const space = window.lastIndexOf(' ');
  const cut = (space > 0 ? window.slice(0, space) : window).replace(/[,;:]$/, '');
  return `${cut.slice(0, Math.max(0, max - 2))} …`;
}

/**
 * Apply the per-rank snippet budgets. Selection, order, titles and URLs are
 * untouched; only `snippet` lengths change.
 * @param {Array<{snippet?: string}>} sources
 * @returns {Array} new source array with compacted snippets
 */
export function compactSources(sources) {
  return sources.map((source, rank) => {
    if (typeof source.snippet !== 'string' || source.snippet.length === 0) return source;
    const budget = BUDGETS[Math.min(rank, BUDGETS.length - 1)];
    const snippet = clipSnippet(source.snippet, budget);
    return snippet ? { ...source, snippet } : { ...source, snippet: undefined };
  });
}
