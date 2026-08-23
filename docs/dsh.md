---
summary: 'dsh-freeweb dsh plugin: install, configure, verify, troubleshoot'
read_when:
  - Installing or updating dsh-freeweb in a dsh profile
  - Changing which search provider the web seam uses
  - Verifying web_search works keylessly
---

# DeepSeek Harness plugin

dsh-freeweb is a native dsh bundle. It keeps dsh's built-in `web_search` tool
and citation cards, and replaces only the search provider behind them with a
three-engine keyless consensus fan-out (DuckDuckGo scraper + Startpage proxy +
Perplexity anonymous ask).

## Compatibility

Uses exactly three stable surfaces, unchanged through `@deepseek-ai/dsh
0.1.1-rc.2`:

- npm bundles declare `dsh.bundle.patch` (`package.json` → `dsh.bundle.patch`).
- The web seam accepts `ctx.web.registerSearchProvider(...)`.
- Provider selection reads the `web` row's `searchProvider` config.

Composition check (no model, no quota):

```sh
npx -y @deepseek-ai/dsh --version
npx -y @deepseek-ai/dsh --profile web --dump-config   # expect searchProvider: freeweb
```

## Install

```sh
npx -y @deepseek-ai/dsh plugin --profile web add dsh-freeweb@<version>   # or a local path
# restart dsh
npx -y @deepseek-ai/dsh plugin --profile web list --depth 0
```

The bundle contributes two patch operations:

1. Sets the web seam's `searchProvider` to `freeweb`.
2. Mounts the package root as the `freeweb` plugin.

## Standalone smoke test

No harness needed — the orchestrator exports its search directly:

```sh
node test/integration.mjs "your query here"
```

## Troubleshooting

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `all keyless engines failed` | every engine bot-walled or offline this egress | retry later; or disable none / add a keyed provider for that network |
| Only `perplexity` answering | DDG/Startpage challenged from your IP | expected on some datacenter IPs; consensus still returns results+answer |
| `web seam has no registerSearchProvider` in log | surface moved in a newer dsh | check compatibility above |
