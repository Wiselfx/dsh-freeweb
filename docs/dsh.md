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
two-active-engine keyless fan-out with ordered fallback (Exa + Keenable by
default; degoog, Startpage, DuckDuckGo, AnySearch as fallbacks).

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
| `[freeweb fallback used: …]` in content | the preferred engine failed and the next slot took over | expected occasionally; the call still returns results |
| `all keyless engines failed` | every enabled engine was bot-walled or unreachable | retry later, or use another network |
| `web seam has no registerSearchProvider` in log | surface moved in a newer dsh | check compatibility above |
