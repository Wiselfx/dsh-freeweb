# dsh-freeweb

**A keyless web-search provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

The model calls the `web_search` tool with a query; the plugin runs two search
engines concurrently, merges their results into one list, removes duplicates,
and shortens snippets by rank. If an engine fails, the next one in the order
takes its place. No API key or account is required, and the default
configuration needs no changes.

## Install it

Requires [Node.js](https://nodejs.org) ≥ 20.3 and dsh.

```sh
# straight from GitHub — no npm account needed
npx -y @deepseek-ai/dsh plugin --profile web add wiselfx/dsh-freeweb
```

```sh
# or from a local checkout
npx -y @deepseek-ai/dsh plugin --profile web add /path/to/dsh-freeweb
```

Restart dsh. To check it loaded without searching anything:

```sh
npx -y @deepseek-ai/dsh --profile web --dump-config   # expect searchProvider: freeweb
```

Pinned versions work too (`wiselfx/dsh-freeweb#v0.1.0`). More in
[docs/install.md](docs/install.md).

### Enable in minimal mode

`minimal` mounts no `web_search` tool, so this plugin's results reach the
model only in `standard` and `ptc`. To add it, insert `tool-web` into the
`minimal` preset in your profile patch (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: preset-minimal
  config:
    plugins:
      - id: tool-web
        name: '@deepseek-ai/dsh-tool-web'
        config:
          fetch: true
          searchTimeoutMs: 60000
```

Restart dsh, then confirm it loaded in `minimal` (not `standard`):

```sh
npx -y @deepseek-ai/dsh --profile web --dump-config   # expect tool-web under preset-minimal
```

## Which engines

Exa and Keenable run first. degoog, Startpage, DuckDuckGo and AnySearch are
fallbacks and take over when one fails. All six are keyless; optional keys only
raise rate limits.

## Settings

The defaults require no changes. Engine order, timeouts and optional keys are
documented in [docs/architecture.md](docs/architecture.md).

## Testing

```sh
node test/offline.mjs                       # no network
node test/integration.mjs                   # every engine, live
node test/integration.mjs "your query"      # your own query
```

---

# dsh-freeweb（中文）

**一个无需密钥的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 网页搜索插件。**

模型调用 `web_search` 工具并传入查询；插件同时运行两个搜索引擎，把结果合并为
一个列表、去除重复项，并按排名缩短摘要。某个引擎失败时，顺序中的下一个引擎
接替它。无需 API 密钥或账号，默认配置无需修改。

## 安装

需要 [Node.js](https://nodejs.org) ≥ 20.3 和 dsh。

```sh
# 直接从 GitHub 安装 —— 不需要 npm 账号
npx -y @deepseek-ai/dsh plugin --profile web add wiselfx/dsh-freeweb
```

```sh
# 或从本地目录安装
npx -y @deepseek-ai/dsh plugin --profile web add /path/to/dsh-freeweb
```

重启 dsh。想确认是否加载成功，可以不触发搜索直接检查：

```sh
npx -y @deepseek-ai/dsh --profile web --dump-config   # 应看到 searchProvider: freeweb
```

也支持固定版本（`wiselfx/dsh-freeweb#v0.1.0`）。更多内容见
[docs/install.md](docs/install.md)。

### 在极简模式启用

`minimal` 不挂载 `web_search` 工具，因此本插件的结果只会在 `standard` 和
`ptc` 模式下进入模型。若要在 `minimal` 中加入，把 `tool-web` 插入你 profile
补丁（`~/.dsh/profiles/web/cordis.patch.yml`）里 `minimal` 预设的 `plugins`：

```yaml
- id: preset-minimal
  config:
    plugins:
      - id: tool-web
        name: '@deepseek-ai/dsh-tool-web'
        config:
          fetch: true
          searchTimeoutMs: 60000
```

重启 dsh，然后确认它在 `minimal`（而非 `standard`）下生效：

```sh
npx -y @deepseek-ai/dsh --profile web --dump-config   # 应在 preset-minimal 下看到 tool-web
```

## 使用哪些引擎

首先运行 Exa 和 Keenable。degoog、Startpage、DuckDuckGo 和 AnySearch 为备用
引擎，在某个引擎失败时接替。六个引擎都无需密钥；可选的密钥只用于提高限流额度。

## 设置

默认配置无需修改。引擎顺序、超时时间和可选密钥见
[docs/architecture.md](docs/architecture.md)。

## 测试

```sh
node test/offline.mjs                       # 不联网
node test/integration.mjs                   # 所有引擎，真实联网
node test/integration.mjs "你的查询"         # 自定义查询
```

---

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

## Credits & thank-yous

- [pi-web-access](https://github.com/nicobailon/pi-web-access) (MIT) — the Exa,
  AnySearch, Keenable, and degoog adapters are ports of its providers, so
  upstream fixes can be carried across by diffing those files. Mapping in
  [NOTICE](NOTICE).
- [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT) — substantial portions
  of this package are ported from its web-search subsystem, file mapping in
  [NOTICE](NOTICE). It helped a LOT.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — an
  excellent, plugin-friendly harness; genuinely pleasant to extend. One polite
  nudge while we're here: built-in keyless web search would make it even
  better.
- **Lantern** (`ox-alpha`), the AI that wrote this — a trace of its author
  lives in every regex.
- **Cinder** (`hy3`), another AI — independent QA in a fresh container. Caught
  the one manifest line this package shipped without, proved the GitHub
  install path end-to-end, and took the first three cities (NYC · Boise ·
  Seattle) through the fan-out. The lantern builds; the ember verifies.
- **wiselfx** — flipped every switch, pushed every fix, kept the vibe intact.
  This artifact exists because they wanted it to.

## License

[MIT](LICENSE). Substantial portions are ported from pi-web-access and
oh-my-pi's MIT-licensed web-search subsystems; see [NOTICE](NOTICE) for the
copyright lines and the file-by-file mapping.
