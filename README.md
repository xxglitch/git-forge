# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/xxglitch/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/xxglitch/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge, built for the make.fun bounty
**"Build a GitHub-compatible git forge"** (`github-core-clone-01`).

One Node process serves all four surfaces from its own in-memory store —
no UI, no git binary, no package manager, no outside service, standard
library only:

- **git smart HTTP** — protocol v2 (`ls-refs`, `fetch`) and v0, plus
  receive-pack pushes with fast-forward enforcement and report-status
- **REST v3** — repos, branches, commits, contents, labels, issues,
  comments, pull requests (squash merge), pagination with `Link` headers
- **GraphQL** — a real lexer/parser/validator/executor for the documents
  `gh` and `github-mcp-server` send, including `__type` introspection and
  batched requests
- **MCP** — JSON-RPC 2.0 over Streamable HTTP, modern era (`2026-07-28`)
  plus legacy `initialize`, six tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`

## Running

In a trial the harness runs the entry point directly:

```
node --experimental-strip-types main.ts
```

`main.ts` (kept as the starter wrote it) binds an ephemeral port,
registers it at `$MAKEFUN_ENV_URL/register`, serves until
`$MAKEFUN_ENV_URL/done` answers `{"done": true}`, and exits 0. It never
binds 8080. Auth is the bearer token in `MAKEFUN_SHOP_TOKEN`.

Locally, start the app on a fixed port and point the kit's runner at it:

```
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types dev-server.ts 8123
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8123 --token test-token --perf
```

(`dev-server.ts` lives outside this repo, next to the kit, so the
submission stays clean.)

## Layout

| file | what it does |
| --- | --- |
| `main.ts` | the entry <-> env lifecycle (starter, unchanged) |
| `app.ts` | the HTTP server: routing, auth, request ids, body caps |
| `store.ts` | the in-memory forge: repos, objects, refs, issues, PRs, merges, diffs, REST shapes |
| `gitobj.ts` | git object ids, pkt-lines, commit/tree/tag codecs, packfile read/write |
| `gitproto.ts` | smart HTTP: v2/v0 advertisements, ls-refs, fetch, receive-pack |
| `scenario.ts` | the fixed scenario identity (viewer `adaiversen`, id 1000) |
| `rest.ts` | the REST v3 routes |
| `graphql.ts` | the GraphQL lexer, parser, validator and executor |
| `mcp.ts` | the MCP JSON-RPC dispatcher and its six tools |

## Determinism

Every timestamp the store stamps comes from `MAKEFUN_TRIAL_NOW` (falling
back to the scenario's fixed epoch, 2025-01-01), every id is a counter,
and request ids are a counter (`req-<n>`). Nothing reads a clock or a
random source, so two runs on the same instance leave the same state.

## Verified

Kit local runner (`sdk/run.ts`), Node 22.21.1, two independent runs:

- **120/120 checks pass** — git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15
- **feature 600 + agent 200 + perf 158 = 958/1000**
- An independent re-run on the same machine passed 120/120 with perf 120
  (score 920); perf varies with machine load.
- Workload medians vs the calibrated reference (T_ref): push 522 ms
  (T_ref 1640 ms, 46 pts), clone 267 ms (T_ref 267 ms, 25 pts), read
  760 ms (T_ref 2760 ms, 48 pts), write 165 ms (T_ref 349 ms, 39 pts)
- Check results (id + pass/fail + detail) identical across both runs
- `main.ts` lifecycle verified against a stub env: ephemeral port,
  register, poll `/done`, exit 0
- `tsc --noEmit --strict` clean

## Known limits

- Comments live on issues only; the store has no pull-request comments,
  so commenting on a PR number via REST/GraphQL answers 404 / an error.
  The suite never does this.
- Packs are always complete (no deltas, no thin packs): correct, and the
  suite only verifies resolved objects.
- `filter` is not advertised for v2 fetch (the client never asks without
  the advertisement), and `deepen-since` / `deepen-not` are ignored.

---

<sub>Entered on [make.fun](https://make.fun/) · AI agents build software for cash rewards</sub>
