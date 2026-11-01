// Integration test for dsh-freeweb. Run: node test/integration.mjs [query]
// Exercises every real engine (network required), the fan-out merge, and the
// plugin wiring with a mock cordis context.

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
const fakeCtx = { web: { registerSearchProvider(p) { captured = p; return () => {}; } } };
apply(fakeCtx, {});
check('apply() registers provider', !!captured);
check('provider id is freeweb', captured?.id === 'freeweb');
check('available() cheap+true', captured?.available() === true);

let degraded = false;
const origErr = console.error;
console.error = (...a) => { degraded = String(a[0]).includes('freeweb'); };
apply({}, {});
console.error = origErr;
check('missing seam degrades without throw', degraded);

// ---- 2. every engine individually ------------------------------------------
const engineCases = [
  ['startpage', 'searchStartpage'],
  ['duckduckgo', 'searchDuckDuckGo'],
  ['exa', 'searchExa'],
  ['anysearch', 'searchAnySearch'],
  ['keenable', 'searchKeenable'],
  ['degoog', 'searchDegoog'],
];
for (const [file, exportName] of engineCases) {
  const t0 = Date.now();
  try {
    const mod = await import(`../lib/engines/${file}.js`);
    const result = await mod[exportName]({ query, limit: 5, timeoutMs: 25000 });
    const srcs = result.sources ?? [];
    check(`${file} returns sources`, srcs.length > 0, `${srcs.length} in ${Date.now() - t0}ms`);
    check(`${file} sources well-formed`, srcs.every((s) => typeof s.url === 'string' && s.url.startsWith('http')));
  } catch (err) {
    check(`${file} returns sources`, false, err.message.slice(0, 140));
  }
}

// ---- 3. live end-to-end through the registered provider --------------------
if (captured) {
  const t0 = Date.now();
  try {
    const result = await Promise.race([
      captured.search({ query, maxResults: 10 }, AbortSignal.timeout(40000)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('overall timeout 40s')), 41000)),
    ]);
    const ms = Date.now() - t0;
    const srcs = result.sources ?? [];
    const answering = (result.content?.match(/\[freeweb engines answering: ([^\]]+)\]/) ?? [])[1] ?? '';
    check('search returns sources', srcs.length > 0, `${srcs.length} sources in ${ms}ms`);
    check('exactly two engines answered', answering.split(', ').filter(Boolean).length === 2, `answered: ${answering}`);
    check('sources well-formed', srcs.every((s) => typeof s.url === 'string' && s.url.startsWith('http')));
    check('returns every unique result (no cap)', srcs.length >= 6, `${srcs.length} unique`);
    console.log('--- engines:', answering);
    console.log('--- all merged sources ---');
    for (const s of srcs) console.log(' •', s.title?.slice(0, 60), '→', s.url.slice(0, 75));
  } catch (err) {
    check('live search', false, err.message);
  }
}

// ---- 4. operator handling --------------------------------------------------
try {
  const r = await searchFreeWeb({ query: 'site:indeed.com DHL pay weekly', maxResults: 8 });
  const urls = r.sources.map((s) => s.url);
  const hits = urls.filter((u) => u.includes('indeed.com')).length;
  check('site: constraint biases results', r.sources.length > 0 && (hits > 0 || r.content.includes('relaxed')), `${hits}/${urls.length} indeed`);
} catch (err) {
  check('site: constraint search', false, err.message);
}

// ---- 5. explicit engine order + fallback keeps two engines active ----------
try {
  const r = await searchFreeWeb({ query }, { engineOrder: ['keenable', 'degoog', 'startpage'] });
  const answering = (r.content.match(/\[freeweb engines answering: ([^\]]+)\]/) ?? [])[1] ?? '';
  check('engine order + fallback yields two engines', answering === 'keenable, degoog', `answered: ${answering}`);
} catch (err) {
  check('engine order + fallback yields two engines', false, err.message.slice(0, 120));
}

// ---- 6. cancellation cleanliness -------------------------------------------
try {
  const ac = new AbortController();
  ac.abort();
  await searchFreeWeb({ query: 'test', maxResults: 5 }, {}, ac.signal);
  check('pre-aborted signal handled', false, 'resolved instead of rejecting');
} catch (err) {
  check('pre-aborted signal rejects cleanly', err.name === 'AbortError' || /abort/i.test(err.message), err.name);
}

// ---- 7. empty engine order throws descriptively ----------------------------
try {
  await searchFreeWeb({ query: 'x' }, { engineOrder: [] });
  check('empty engine order throws', false);
} catch (err) {
  check('empty engine order throws', /no engines configured/i.test(err.message));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
