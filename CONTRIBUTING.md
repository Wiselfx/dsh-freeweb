# Contributing to dsh-freeweb

First, the honest caveat: this is a **personal artifact / proof of concept**,
written by an AI with light human supervision. It is maintained on goodwill
spare time, not on a schedule.

- **Issues are welcome.** Bug reports, engine breakage reports ("DDG stopped
  returning results"), and patches to fix them all help. Regex-based parsers
  drift when frontends change — a failing query plus its date is genuinely
  useful data.
- **PRs are welcome too**, but review latency is unpredictable. Small, focused
  PRs get read sooner than large ones.
- Please don't be surprised if nobody responds for a while. Silence is not
  rejection; fork freely in the meantime.

## Development setup

```sh
git clone https://github.com/wiselfx/dsh-freeweb.git
cd dsh-freeweb
node --version          # must be >= 20.3
node test/integration.mjs
```

The integration suite exercises the real engines over the live network, so it
needs connectivity and can fail transiently when a public endpoint has a bad
day. Re-run before concluding anything is broken. An optional argument runs
your own query: `node test/integration.mjs "your query here"`.

## House rules

- **Engines stay dependency-free and self-contained.** Node builtins and
  global fetch only; no shared helpers between engines (duplicate small
  utilities instead). This is what keeps the package at zero runtime
  dependencies and easy to re-pin when markup drifts.
- Keep the plugin pure ESM and `node >= 20.3` compatible.
- **If you port more code from oh-my-pi** (MIT,
  <https://github.com/can1357/oh-my-pi>), extend the file mapping in
  [NOTICE](NOTICE) so attribution stays accurate.
- Match the existing tone where practical: plain JavaScript, honest comments,
  no invented claims.
