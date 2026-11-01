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
   │        2 active slots ── ordered fallback on failure
   ├──► exa.js           public MCP endpoint        (default slot 1)
   ├──► keenable.js      public REST API            (default slot 2)
   ├──► degoog.js        public metasearch instance (fallback)
   ├──► startpage.js     Google-via-proxy scraper   (fallback)
   ├──► duckduckgo.js    no-JS HTML scraper         (fallback)
   └──► anysearch.js     public REST API            (fallback)
        │
        ▼
mergeEngineResults()          consensus ranking    lib/merge.js
compactSources()              token budgeting      lib/compact.js
applyQueryConstraints()       lenient post-filter  lib/query.js
        │
        ▼
{ content, sources, truncated }
```

The bundle patch pins `searchProvider: freeweb` on the `web` row and mounts
the package root as a plugin; nothing else about dsh changes.

## Engines

All six are keyless. Optional keys exist only to raise rate limits.

| Engine | Transport | Notes |
| --- | --- | --- |
| `startpage` | GET homepage → regex-lift hidden form inputs (session token `sc`) → POST with a per-call cookie jar | This deployment fronts the homepage with an **Anubis proof-of-work gate**: the module fetches the `anubis_challenge` JSON, solves the SHA-256 challenge with `node:crypto` exactly as a browser would, collects the clearance cookie, then performs the token dance. Degrades to a tokenless GET if the lift fails. |
| `duckduckgo` | GET `html.duckduckgo.com/html/?q=…` (POST form as fallback) | Live-tested from datacenter egress: GET keeps serving results while the POST form is challenged, so GET is primary. Parses `result__a` / `result__snippet`, unwraps `uddg=` redirects, follows the `s`/`vqd` continuation form. |
| `exa` | JSON-RPC `tools/call` against `mcp.exa.ai/mcp?tools=web_search_exa` | The free MCP endpoint needs no credential; it signals its rate limit both as HTTP 429 and as HTTP 200 with `_meta["ai.exa/rateLimited"]`. With `EXA_API_KEY`, switches to the REST `/search` API. |
| `anysearch` | POST `api.anysearch.com/v1/search` | `Authorization: Bearer` is sent only when a key exists; the public endpoint answers keyless. |
| `keenable` | POST `api.keenable.ai/v1/search/public` | Without a key it calls the `/public` path and identifies the client with `X-Keenable-Title`; a key switches to `/v1/search` with `X-API-Key`. The page text arrives in `snippet` (`description` is the fallback). |
| `degoog` | POST `degoog.org/api/search` | Public metasearch instance. `DEGOOG_URL` points it at a private deployment; `DEGOOG_API_KEY` adds a bearer token for instances that protect search routes. Recency maps to `time`. |

## Active pair + fallback

Two engines are active per query, in `engineOrder` priority (default Exa,
Keenable, degoog, Startpage, DuckDuckGo, AnySearch). Each is asked for 5
results. If one fails, the next candidate takes its slot and the batch is
retried, so two live engines are kept for as long as candidates remain. Only
when every candidate has failed is the call an error.

## Consensus ranking

`mergeEngineResults()` (lib/merge.js) folds the answering engines' ranked lists
into one. There is no post-merge cap: every unique result is returned, and dsh
applies its own display limit.

1. **Dedup** on a canonical key: hostname lowercased without leading `www.`,
   trailing slash stripped, query string preserved, fragment dropped.
2. **Rank** by agreeing-engine count (descending), then best per-engine
   position, then deterministic first-seen order.
3. **Enrich**: keep the longest snippet and the earliest `publishedAt`.

## Snippet compaction

After the merge and the lenient constraint pass, `compactSources()`
(lib/compact.js) applies a rendering-only pass ported from the author's
pi-web-access patch script: snippets are clipped by rank to 500 / 220 / 150 /
80 characters (tail sources share the last budget), preferring a sentence
boundary past the halfway point. Selection, order, titles and URLs are
untouched — only how many characters of each snippet reach dsh change. This
keeps a typical search near ~650 tokens instead of ~1,500.

After the merge, constraints the HTML frontends could not enforce natively
(`before:`/`after:` dates, path-carrying `site:` values) go through a lenient
post-filter that relaxes a dimension instead of returning an empty page; the
relaxation surfaces as a `Note:` in the content, which also carries an
`[freeweb engines answering: …]` summary.

## Deadline model

Three independent bounds govern one search call:

| Bound | Default | Effect |
| --- | --- | --- |
| `engineTimeoutMs` | 25000 | hard timeout for each individual engine call |
| `hardDeadlineMs` | 27000 | absolute cap for the whole call; stragglers are aborted |

The two active calls run concurrently and the orchestrator waits for both. The
hard cap cancels anything still running via a linked `AbortSignal`, so a hung
engine can never pin the tool call.

## Failure semantics

- A failing engine is replaced by the next candidate in `engineOrder`, so one
  blocked or bot-walled engine never fails the call.
- Every candidate failing throws one descriptive error listing each engine's
  message (`freeweb: all keyless engines failed — …`).
- A caller abort surfaces as `AbortError`, not as an engine outage.
- An empty `engineOrder` throws immediately (`no engines configured`).
- If the harness seam lacks `registerSearchProvider`, registration logs loudly
  and skips instead of crashing the profile (mirrors modsearch degradation).

## Adding an engine

Each engine is a single self-contained ESM module exporting one async function:

```js
export async function searchMyEngine({ query, limit, recency, timeoutMs, signal, apiKey, baseUrl }) {
  // honor signal (AbortSignal) and timeoutMs throughout
  return {
    engine: 'myengine',
    sources: [{ title, url, snippet /* , publishedAt */ }],
  };
}
```

Rules of the house:

- Node builtins and global fetch only — zero dependencies, no shared helpers;
  duplicate small utilities rather than importing across engines.
- Throw a descriptive error that names the engine when blocked or failed; the
  orchestrator catches it into the all-engines-failed report.
- Clamp `limit` inside the module.

Wire-up lives in `dsh/index.js`: add the id to `DEFAULT_ENGINE_ORDER` and a
runner to the `runners` table. Keep the file shaped like its upstream
counterpart in `reference/pi-web-access` where one exists, so future upstream
fixes are a diff away. If you port more code from pi-web-access or oh-my-pi, extend the mapping
in [NOTICE](../NOTICE).
