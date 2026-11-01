// Offline checks for CI: no network, no bot walls, no flakiness.
import assert from 'node:assert/strict';

// 1. the query parser port loads and behaves
const q = await import('../lib/query.js');
for (const name of [
  'parseSearchQuery',
  'formatScraperQuery',
  'formatQuery',
  'GOOGLE_QUERY_SYNTAX',
  'applyQueryConstraints',
]) assert.ok(q[name], `query.js must export ${name}`);

const parsed = q.parseSearchQuery('site:example.com "exact phrase" -noise');
assert.equal(parsed.hasConstraints, true);
assert.ok(Array.isArray(parsed.sites) && parsed.sites.includes('example.com'));

// 2. every engine module loads and exports one search function
for (const [file, exportName] of [
  ['startpage', 'searchStartpage'],
  ['duckduckgo', 'searchDuckDuckGo'],
  ['exa', 'searchExa'],
  ['anysearch', 'searchAnySearch'],
  ['keenable', 'searchKeenable'],
  ['degoog', 'searchDegoog'],
]) {
  const mod = await import(`../lib/engines/${file}.js`);
  assert.equal(typeof mod[exportName], 'function', `${file}.js must export ${exportName}()`);
}

// 3. the consensus merge ranks agreement first
const { mergeEngineResults } = await import('../lib/merge.js');
const merged = mergeEngineResults(
  [
    { engine: 'a', sources: [{ title: 'both', url: 'https://x.com/page' }, { title: 'only-a', url: 'https://x.com/solo' }] },
    { engine: 'b', sources: [{ title: 'both-b', url: 'https://www.x.com/page/' }] },
  ],
  10,
);
assert.equal(merged.length, 2);
assert.equal(merged[0].url, 'https://x.com/page', 'cross-engine agreement wins');

// 4. the plugin entry loads and registers into a mock seam
const plugin = await import('../dsh/index.js');
assert.equal(plugin.name, 'freeweb');
let registered;
plugin.apply({ web: { registerSearchProvider(p) { registered = p; } } }, {});
assert.equal(registered?.id, 'freeweb');
assert.equal(registered?.available(), true);

// 5. an empty engine order is rejected locally, without network
await assert.rejects(
  () => plugin.searchFreeWeb({ query: 'x' }, { engineOrder: [] }),
  /no engines configured/i,
);

// 6. rank-budgeted compaction is rendering-only and shrinks snippets
const { compactSources, clipSnippet } = await import('../lib/compact.js');
const long = 'A'.repeat(50) + '. ' + 'B'.repeat(300);
assert.ok(clipSnippet(long, 80).length <= 82, 'clipSnippet respects the budget');
const sample = [
  { title: 't1', url: 'https://a/1', snippet: 'x'.repeat(900) },
  { title: 't2', url: 'https://a/2', snippet: 'y'.repeat(900) },
  { title: 't3', url: 'https://a/3', snippet: 'z'.repeat(900) },
  { title: 't4', url: 'https://a/4', snippet: 'w'.repeat(900) },
  { title: 't5', url: 'https://a/5', snippet: 'v'.repeat(900) },
];
const compacted = compactSources(sample);
assert.equal(compacted.length, sample.length, 'selection is untouched');
assert.deepEqual(compacted.map((s) => s.url), sample.map((s) => s.url), 'ordering is untouched');
assert.ok(compacted[0].snippet.length <= 500 && compacted[1].snippet.length <= 220,
  'per-rank budgets apply');
assert.ok(compacted[4].snippet.length <= 80, 'tail budget applies');

console.log('compaction checks passed');

console.log('offline checks passed');
