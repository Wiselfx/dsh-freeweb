// Integration test for dsh-freeweb. Run: node test/integration.mjs [query]
// Exercises the real engines (network required) and the plugin wiring with a
// mock cordis context.

const query = process.argv[2] ?? 'dhl canada pay schedule';
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ---- 1. plugin wiring: mock cordis ctx ------------------------------------
const { name, inject, apply, searchFreeWeb } = await import('../dsh/index.js');
check('exports name=freeweb', name === 'freeweb');
check('injects web seam', Array.isArray(inject) && inject.includes('web'));

let captured;
const fakeCtx = {
  web: {
    registerSearchProvider(p) {
      captured = p;
      return () => {};
    },
  },
};
apply(fakeCtx, {});
check('apply() registers provider', !!captured);
check('provider id is freeweb', captured?.id === 'freeweb');
check('available() cheap+true', captured?.available() === true);

// missing seam degrades loudly instead of throwing
let degraded = false;
const origErr = console.error;
console.error = (...a) => {
  degraded = String(a[0]).includes('freeweb');
};
apply({}, {});
console.error = origErr;
check('missing seam degrades without throw', degraded);

// ---- 2. live end-to-end through the registered provider --------------------
if (captured) {
  const t0 = Date.now();
  try {
    const result = await Promise.race([
      captured.search({ query, maxResults: 10 }, AbortSignal.timeout(40000)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('overall timeout 40s')), 41000)),
    ]);
    const ms = Date.now() - t0;
    const srcs = result.sources ?? [];
    check('search returns sources', srcs.length > 0, `${srcs.length} sources in ${ms}ms`);
    check('respects maxResults', srcs.length <= 10);
    check('sources well-formed', srcs.every((s) => typeof s.url === 'string' && s.url.startsWith('http')));
    check('content present (answer/notes)', typeof result.content === 'string' && result.content.length > 0);
    check('truncated flag boolean', typeof result.truncated === 'boolean');
    console.log('--- top 5 merged sources ---');
    for (const s of srcs.slice(0, 5)) console.log(' •', s.title?.slice(0, 60), '→', s.url.slice(0, 75));
    console.log('--- content head ---');
    console.log(result.content.split('\n\n')[0].slice(0, 300));
  } catch (err) {
    check('live search', false, err.message);
  }
}

// ---- 3. operator handling --------------------------------------------------
try {
  const r = await searchFreeWeb({ query: 'site:indeed.com DHL pay weekly', maxResults: 8 });
  const urls = r.sources.map((s) => s.url);
  const hits = urls.filter((u) => u.includes('indeed.com')).length;
  check('site: constraint biases results', r.sources.length > 0 && (hits > 0 || r.content.includes('relaxed')), `${hits}/${urls.length} indeed`);
} catch (err) {
  check('site: constraint search', false, err.message);
}

// ---- 4. cancellation cleanliness -------------------------------------------
try {
  const ac = new AbortController();
  ac.abort();
  await searchFreeWeb({ query: 'test', maxResults: 5 }, {}, ac.signal);
  check('pre-aborted signal handled', true); // resolving fast is acceptable
} catch (err) {
  check('pre-aborted signal rejects cleanly', err.name === 'AbortError' || /abort/i.test(err.message));
}

// ---- 4b. firecrawl auto-mode skips without credentials ---------------------
delete process.env.FIRECRAWL_API_KEY;
try {
  const r = await searchFreeWeb({ query: 'test query', maxResults: 5 });
  const engines = (r.content.match(/\[freeweb engines answering: ([^\]]+)\]/) ?? [])[1] ?? '';
  check('firecrawl auto-skipped without key', !engines.includes('firecrawl'), `answered: ${engines || 'none'}`);
} catch (err) {
  // all-failed also proves firecrawl did not hang the call
  check('firecrawl auto-skipped without key', !/firecrawl/.test(err.message), err.message.slice(0, 80));
}

// ---- 4c. firecrawl engine reachable + graceful failure ----------------------
try {
  const fc = await import('../lib/engines/firecrawl.js');
  await fc.searchFirecrawl({ query: 'test', limit: 3, timeoutMs: 12000 });
  check('firecrawl call handled', true, 'keyless succeeded or failed gracefully');
} catch (err) {
  check('firecrawl failure is descriptive', /401|403|Firecrawl/i.test(err.message), err.message.slice(0, 90));
}

// ---- 5. all-engines-disabled throws descriptively ---------------------------
try {
  await searchFreeWeb({ query: 'x' }, { engines: { duckduckgo: false, startpage: false, perplexity: false } });
  check('disabled engines throw', false);
} catch (err) {
  check('disabled engines throw', /disabled/i.test(err.message));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
