# dsh-freeweb

Keyless web search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
No API keys. No signup. No quota owner.

# ⚠️ This plugin was made by an AI

> **This plugin was designed, ported, and tested end-to-end by an artificial
> intelligence — Lantern (`ox-alpha`), an AI coding agent — with light human
> supervision. No human wrote the search logic.**
>
> The engines, the consensus merge, the deadline controller, and this
> documentation were all produced by the model working against a live network.
> Judge the code accordingly: it is unusually well tested and entirely without
> ego.

**Status: personal artifact / proof of concept.** This exists because its author
wanted keyless search inside dsh, and now it does that. It may or may not
receive updates. It is provided as-is. If you want a maintained version, fork
it — forks are welcome, and PRs are read when life allows.

---

## What it is

A [`WebSearchProvider`](docs/dsh.md) plugin for dsh's web capability seam
(`ctx.web`). It keeps dsh's built-in `web_search` tool, citation cards, and UI
exactly as they are, and swaps only the engine behind them. Queries fan out to
three independent keyless engines — plus an optional fourth — and come back as
one consensus-ranked answer.

| Engine | Kind | Needs |
| --- | --- | --- |
| **DuckDuckGo** (`html.duckduckgo.com`) | HTML scraper; POST with automatic GET fallback | nothing |
| **Startpage** (`startpage.com/sp/search`) | Google's index behind a privacy proxy; solves its Anubis SHA-256 proof-of-work in pure Node | nothing |
| **Perplexity** (`perplexity.ai/rest/sse/perplexity_ask`, anonymous) | synthesized answer + cited sources over SSE | nothing |
| **Firecrawl** (`api.firecrawl.dev/v2/search`, optional) | SERP-backed results, native Google operators | API key (env `FIRECRAWL_API_KEY`) or self-hosted endpoint; **auto-skipped without one** |

## Install

Requires [Node.js](https://nodejs.org) ≥ 20.3 and dsh. Nothing else.

**Straight from GitHub — no npm account needed:**

```sh
npx -y @deepseek-ai/dsh plugin --profile web add wiselfx/dsh-freeweb
```

`dsh plugin` forwards install specs to pnpm verbatim, so `owner/repo`, full
`https://github.com/…​.git` URLs, and pinned refs (`owner/repo#v0.1.0`) all
work — the package is fetched from GitHub and activated because it declares a
dsh bundle.

**Local checkout:**

```sh
npx -y @deepseek-ai/dsh plugin --profile web add /path/to/dsh-freeweb
```

**npm (if ever published):**

```sh
npx -y @deepseek-ai/dsh plugin --profile web add dsh-freeweb
```

Restart dsh, then verify composition without spending anything:

```sh
npx -y @deepseek-ai/dsh --profile web --dump-config   # expect searchProvider: freeweb
```

See [docs/install.md](docs/install.md) for all three paths in detail,
uninstall steps, and troubleshooting.

## Configuration

Defaults live on the plugin entry; every value is optional:

```yaml
- id: freeweb
  name: 'dsh-freeweb'
  config:
    engines:
      duckduckgo: true
      startpage: true
      perplexity: true
      firecrawl: auto      # auto = only when a key/endpoint exists; true|false also accepted
    firecrawlApiKey: ''    # or env FIRECRAWL_API_KEY; free tier at firecrawl.dev, no card
    softDeadlineMs: 6000    # early-return once ≥1 engine answered
    hardDeadlineMs: 27000   # absolute cap; stragglers aborted
    engineTimeoutMs: 25000  # per-engine transport timeout
```

The deadlines bound each call: engines get 25 s individually, the whole
fan-out returns early at 6 s once something has answered, and nothing outlives
27 s. Config changes take effect after a dsh restart.

## How it works

The provider fires every enabled engine concurrently and merges whatever comes
back by cross-engine agreement: URLs are deduplicated on a canonical key, then
ranked by how many engines returned them, then by best per-engine position. One
blocked or slow engine never fails a search — single-engine walls are absorbed
silently — and only every engine failing at once is an error. The full design,
including failure semantics and how to add an engine, is in
[docs/architecture.md](docs/architecture.md).

## Testing

```sh
node test/integration.mjs
```

Live end-to-end suite: exercises the real engines over the network and checks
the plugin wiring with a mock harness context. It passes. An optional argument
runs your own query:

```sh
node test/integration.mjs "your query here"
```

## Credits & thank-yous

- [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT) — substantial portions
  of this package are ported from its web-search subsystem, file mapping in
  [NOTICE](NOTICE). It helped a LOT.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — an
  excellent, plugin-friendly harness; genuinely pleasant to extend. One polite
  nudge while we're here: built-in keyless web search would make it even
  better.
- **Lantern** (`ox-alpha`), the AI that wrote this — a trace of its author
  lives in every regex.

## License

[MIT](LICENSE). Substantial portions are ported from oh-my-pi's MIT-licensed
web-search subsystem; see [NOTICE](NOTICE) for the copyright lines and the
file-by-file mapping.
