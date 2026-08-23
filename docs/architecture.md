---
summary: 'dsh-freeweb internals: seam wiring, engines, consensus merge, deadlines'
read_when:
  - Changing the fan-out/merge, or adding or debugging an engine module
---

# Architecture

## The seam

dsh's model-facing surface is the built-in `web_search` tool; behind it sits the
web capability seam (`ctx.web`), which accepts registered search providers:

```text
model tool call  web_search(query)
        │
        ▼
dsh web seam  ctx.web.registerSearchProvider({ id, available(), search() })
        │
        ▼
freeweb provider                                   dsh/index.js
   ├─ parseSearchQuery()      operator parsing     lib/query.js
   ├─ formatScraperQuery()    lenient rebuild      lib/query.js
   │        concurrent fan-out ── straggler AbortController
   ├──► duckduckgo.js    HTML scraper
   ├──► startpage.js     Google-via-proxy scraper
   ├──► perplexity.js    anonymous ask SSE
   └──► firecrawl.js     keyed REST (auto-skipped)
        │
        ▼
mergeEngineResults()          consensus ranking    lib/merge.js
applyQueryConstraints()       lenient post-filter  lib/query.js
        │
        ▼
{ content, sources, truncated }
```

The bundle patch pins `searchProvider: freeweb` on the `web` row and mounts
the package root as a plugin; nothing else about dsh changes.

## Engines

| Engine | Transport | Notes |
| --- | --- | --- |
| `duckduckgo` | POST to the no-JS HTML frontend `html.duckduckgo.com/html/`, static-page scrape | requires browser-like navigation headers over Node's fetch (undici TLS fingerprint); curl-style clients get 403. On HTTP-layer failure it automatically retries once via the **GET variant** of the same frontend, which some throttle states keep serving. Recency maps to the `df` param. |
| `startpage` | GET homepage → regex-lift hidden form inputs (session token `sc`) → POST with a per-call cookie jar | a stale/absent token 302s to the CAPTCHA shell. This deployment fronts the homepage with an **Anubis proof-of-work gate**: the module fetches the `anubis_challenge` JSON, solves the SHA-256 challenge with `node:crypto` exactly as a browser would, collects the clearance cookie, then performs the token dance. Degrades to a tokenless GET if the lift fails. |
| `perplexity` | anonymous consumer SSE endpoint (`rest/sse/perplexity_ask`), no account/cookie/key | returns a synthesized answer plus cited sources. Undocumented consumer API — treat as best-effort coverage, not a contract. Receives the raw query (not the scraper rebuild). |
| `firecrawl` | REST v2 `/search`; Bearer key, or no auth against a self-hosted/base URL | SERP-backed, so it honors Google operators natively and gets absolute date bounds as its native `tbs` parameter. The hosted **keyless** tier is IP-reputation gated and frequently 403s datacenter IPs, so `auto` mode participates only when a credential exists. |

## Consensus ranking

`mergeEngineResults()` (lib/merge.js) folds per-engine ranked lists into one:

1. **Dedup** on a canonical key: hostname lowercased without leading `www.`,
   trailing slash stripped, query string preserved, fragment dropped.
2. **Rank** by agreeing-engine count (descending), then best per-engine
   position, then deterministic first-seen order.
3. **Enrich**: keep the longest snippet and the earliest `publishedAt`.

After the merge, constraints the HTML frontends could not enforce natively
(`before:`/`after:` dates, path-carrying `site:` values) go through a lenient
post-filter that relaxes a dimension instead of returning an empty page; the
relaxation surfaces as a `Note:` in the content, which otherwise carries the
Perplexity synthesized answer plus an `[freeweb engines answering: …]` summary.

## Deadline model

Three independent bounds govern one search call:

| Bound | Default | Effect |
| --- | --- | --- |
| `engineTimeoutMs` | 25000 | hard timeout for each individual engine call |
| `softDeadlineMs` | 6000 | return early once ≥1 engine has answered and the rest have had their chance |
| `hardDeadlineMs` | 27000 | absolute cap; stragglers are aborted |

Precisely: the orchestrator returns when every engine settles, or when the soft
deadline elapses with at least one success in hand. If the soft deadline fires
with *zero* successes and engines still running, it keeps waiting up to the hard
cap for a first success — a slow field degrades to fewer engines rather than an
empty answer. Once a return path is chosen, still-running engines are cancelled
via a linked `AbortSignal`, with a short grace period to settle.

## Failure semantics

- A single engine failing or being bot-walled is tolerated silently; consensus
  ranks whatever answered, so one blocked engine never fails the call.
- Every engine failing throws one descriptive error listing each engine's
  message (`freeweb: all keyless engines failed — …`). No keyless approach
  helps against a network that walls all of them persistently.
- Disabling every engine in config throws immediately.
- If the harness seam lacks `registerSearchProvider`, registration logs loudly
  and skips instead of crashing the profile (mirrors modsearch degradation).

## Adding an engine

Each engine is a single self-contained ESM module exporting one async function:

```js
export async function searchMyEngine({ query, limit, recency, timeoutMs, signal }) {
  // honor signal (AbortSignal) and timeoutMs throughout
  return {
    engine: 'myengine',
    sources: [{ title, url, snippet /* , publishedAt */ }],
    // answer: '...'  ← optional, for engines that synthesize answers
  };
}
```

Rules of the house:

- Node builtins and global fetch only — zero dependencies, no shared helpers;
  duplicate small utilities rather than importing across engines.
- Throw a descriptive error that names the engine when blocked or failed; the
  orchestrator catches it into the all-engines-failed report.
- Clamp `limit` inside the module (the scrapers accept 1–20).

Wire-up lives in `dsh/index.js`: add the default to `resolveConfig().engines`
and push a task onto the fan-out list. Templates, in ascending complexity:
`duckduckgo.js`, `firecrawl.js`, `startpage.js`, `perplexity.js`. If you port
more code from oh-my-pi, extend the mapping in [NOTICE](../NOTICE).
