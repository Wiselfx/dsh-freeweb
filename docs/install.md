---
summary: 'dsh-freeweb: install, verify, configure, uninstall, troubleshoot'
read_when:
  - Adding or removing dsh-freeweb from a dsh profile
  - Verifying which search provider the web seam uses
  - A config change did not seem to take effect
---

# Installing dsh-freeweb

## Requirements

- [Node.js](https://nodejs.org) ≥ 20.3 (the plugin is pure ESM with zero
  runtime dependencies, so this is the only toolchain requirement).
- A working [dsh](https://github.com/deepseek-ai/deepseek-harness)
  installation (`npx -y @deepseek-ai/dsh`).
- Verified against `@deepseek-ai/dsh 0.1.1-rc.2`; the plugin touches exactly
  three stable surfaces (see [dsh.md](dsh.md)).

All commands below install into the `web` profile — the one the browser UI
uses. Substitute your own profile name if you boot a different one.

> The shortest route is [Path B — straight from GitHub](#path-b--straight-from-github).
> Path A covers source checkouts and offline machines.

## Path A — local directory

1. Get the code onto disk: clone the repository, unzip a release archive, or
   copy the folder across.

   ```sh
   git clone https://github.com/wiselfx/dsh-freeweb.git /opt/dsh-freeweb
   ```

2. Add it to the profile by absolute path:

   ```sh
   npx -y @deepseek-ai/dsh plugin --profile web add /opt/dsh-freeweb
   ```

3. Restart dsh (see [Restart requirement](#restart-requirement)).
4. Verify (see [Verify the install](#verify-the-install)).

The path you pass must contain this package's `package.json`.

## Path B — straight from GitHub

`dsh plugin` forwards install specs verbatim to pnpm, so a GitHub shorthand
installs directly — no npm account, no local clone. Verified against dsh
0.1.1-rc.2 with the npm registry unreachable (resolution goes through
GitHub's codeload tarballs):

```sh
npx -y @deepseek-ai/dsh plugin --profile web add wiselfx/dsh-freeweb
```

Variants that also work: full URLs (`https://github.com/wiselfx/dsh-freeweb.git`),
pinned refs (`wiselfx/dsh-freeweb#v0.1.0`), and the explicit `github:` prefix.
Updates re-run the same command; pin a tag first if you want reproducible
installs.

Two notes: this package declares no build/lifecycle scripts, so pnpm 11's
build gate never applies; and because the install is a real package install,
the profile loads it from its own store — you do not need to keep any clone
around (unlike Path A).

## Path C — from npm (optional)

If the package is ever published, a plain spec installs it without GitHub:

```sh
npx -y @deepseek-ai/dsh plugin --profile web add dsh-freeweb
```

Updates become `plugin add dsh-freeweb@<version>`. Until a publish exists,
use Path A or B.

## What the install changes

The bundle contributes two patch operations to the profile tree:

1. It sets the web seam's `searchProvider` config to `freeweb`.
2. It inserts the package root as the `freeweb` plugin.

Nothing else moves. dsh's built-in `web_search` tool, citation cards, and UI
are untouched; only the backend behind them changes. Any later profile patch
can pin another provider back (see [Switching providers](#switching-providers)).

## Restart requirement

dsh composes its profile tree at startup: plugins are loaded, bundles applied,
and plugin config resolved when the process boots. **Adding, removing,
reinstalling, or reconfiguring dsh-freeweb therefore requires restarting dsh**
before anything changes.

One deliberate exception: Firecrawl credentials are checked per search, not
cached at startup. With `engines.firecrawl: auto` (the default), a key or
self-hosted endpoint present in the environment is picked up on subsequent
searches without touching the config again.

## Verify the install

No model call, no quota spent — this only prints the composed profile tree:

```sh
npx -y @deepseek-ai/dsh --profile web --dump-config
```

Expect the `web` row to carry `searchProvider: freeweb` and an inserted
`freeweb` row to exist:

```yaml
- id: web
  config:
    searchProvider: freeweb

- insert:
    - id: freeweb
      name: 'dsh-freeweb'
```

(Your dump will show the full composed tree; the excerpt above shows the two
rows to look for.)

Also useful:

```sh
npx -y @deepseek-ai/dsh plugin --profile web list --depth 0
```

For an end-to-end check without the harness:

```sh
node /path/to/dsh-freeweb/test/integration.mjs "your query here"
```

## Switching providers

To route the web seam back to another provider (e.g. modsearch), pin the `web`
row again in a later patch layer:

```yaml
- id: web
  config:
    searchProvider: modsearch
```

A later patch replaces the targeted row's whole `config`, so include any other
keys that row needs. For a one-off flip without editing the profile, pass an
overlay file: `npx -y @deepseek-ai/dsh --profile web --patch flip.yaml`
(`--patch` layers apply after the profile). Restart dsh afterwards, then
confirm with `--dump-config`. The freeweb plugin can stay installed while
unselected; it costs nothing unless chosen.

## Uninstall

```sh
npx -y @deepseek-ai/dsh plugin --profile web remove dsh-freeweb
```

(The `plugin` command forwards arguments verbatim to pnpm inside the profile,
so this removes the installed package regardless of which path you used to add
it.) Then restart dsh and re-run `--dump-config`: the `freeweb` rows should be
gone and the `web` row should show whichever provider the remaining layers pin.
If it shows nothing usable, pin one explicitly as shown above.

If you installed from a local directory, removing the directory before
uninstalling leaves the profile pointing at nothing — run the remove first.

## Troubleshooting

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `--dump-config` still shows another provider after install | dsh was not restarted, or a later patch layer overrides the `web` row | restart dsh; check for a later `searchProvider` patch and remove or reorder it |
| New engine/deadline config has no effect | same reason — plugin config is read at boot | restart dsh |
| `web seam has no registerSearchProvider` in the log | the seam surface moved in a newer dsh | check the compatibility list in [dsh.md](dsh.md); the plugin degrades instead of crashing |
| `all keyless engines failed` | every enabled engine was bot-walled or unreachable from this network | retry later; enable more engines; or use a keyed provider for that egress |
| Only `perplexity` appears in "engines answering" | DDG/Startpage challenged your IP (common on datacenter hosts) | expected sometimes; consensus still returns results plus the answer |
| Firecrawl never participates | no credential found (`FIRECRAWL_API_KEY`, explicit key, or non-default base URL) | set one; `auto` mode picks it up per search — see [Restart requirement](#restart-requirement) |
| Firecrawl returns 403 "IP looks suspicious" | the hosted *keyless* tier rejects datacenter/shared egress IPs | use the free API key or a self-hosted endpoint |
