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

// 2. the merge module ranks consensus first
const { mergeEngineResults } = await import('../lib/merge.js');
const merged = mergeEngineResults(
  [
    {
      engine: 'a',
      sources: [
        { title: 'both', url: 'https://x.com/page' },
        { title: 'only-a', url: 'https://x.com/solo' },
      ],
    },
    { engine: 'b', sources: [{ title: 'both-b', url: 'https://www.x.com/page/' }] },
  ],
  10,
);
// www./trailing-slash variants dedup to one entry; tie on rank keeps first-seen
assert.equal(merged.length, 2);
assert.equal(merged[0].url, 'https://x.com/page', 'cross-engine agreement wins');
assert.ok(merged.some((s) => s.url.endsWith('/solo')));

// 3. firecrawl credential detection reacts to env
const fc = await import('../lib/engines/firecrawl.js');
delete process.env.FIRECRAWL_API_KEY;
assert.equal(fc.hasFirecrawlCredential(), false);
process.env.FIRECRAWL_API_KEY = 'fc-x';
assert.equal(fc.hasFirecrawlCredential(), true);
delete process.env.FIRECRAWL_API_KEY;

// 4. the plugin entry loads and registers into a mock seam
const plugin = await import('../dsh/index.js');
assert.equal(plugin.name, 'freeweb');
let registered;
plugin.apply({ web: { registerSearchProvider(p) { registered = p; } } }, {});
assert.equal(registered?.id, 'freeweb');
assert.equal(registered?.available(), true);

console.log('offline checks passed');
