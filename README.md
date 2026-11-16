# iron-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/poyobi/iron-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/poyobi/iron-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process, built on the standard library alone — no git binary, no npm dependencies, no external services. One in-memory store backs all four surfaces: git smart HTTP (upload-pack protocol v2 with ls-refs and shallow fetch, v0 fallback, receive-pack with report-status and fast-forward-only ref updates), the REST v3 API (repositories, contents, branches, commits, labels, issues, comments, pull requests with squash merges), the GraphQL v4 API (queries, mutations, cursor connections, global ids, introspection), and an MCP endpoint (server/discover, tools/list, tools/call) exposing the same objects. Git objects are stored and served byte-exactly; packs are read with full OFS/REF delta resolution and written plain.

## Run it

```sh
MAKEFUN_ENV_URL=<env origin> MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=sfcm9bvc&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
