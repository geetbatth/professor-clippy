# Professor Clippy: architecture

## Workspace layout

npm workspaces monorepo (Node 24, npm 11, TypeScript strict, ESM, Vitest).

| Path | Package | What it is |
| --- | --- | --- |
| `packages/shared` | `@clippy/shared` | Every shared contract: zod schemas and types, settings, local API routes, data-dir paths, `ClippyClient`, Electron IPC contract, Worker relay protocol. TypeScript source only (no build step). |
| `apps/desktop` | `@clippy/desktop` | Electron + electron-vite + React. Hosts the local API (127.0.0.1), SQLite store, scheduler and Clippy's brain. |
| `apps/mcp` | `@clippy/mcp` | stdio MCP server; forwards agent tool calls to the desktop app through `ClippyClient`. Built by Vite into one `dist/index.js`. |
| `apps/hook` | `@clippy/hook` | Claude Code hook; posts a note when an agent finishes or needs permission. Built like `apps/mcp`. |
| `apps/worker` | `@clippy/worker` | Cloudflare Worker plus one SQLite-backed Durable Object (`ClippyDO`, binding `CLIPPY`) relaying WhatsApp Cloud API traffic. |
| `scripts/` | | Repo scripts (SQLite smoke test, run-in-Electron helper). |

Root scripts: `npm test`, `npm run typecheck`, `npm run build` (each runs in every workspace), `npm run dev` (desktop app).

`@clippy/shared` is consumed as TypeScript source. Vite (desktop, mcp, hook), wrangler (worker) and Vitest bundle or transform it; it is never `require`d from `node_modules` at runtime. Its root entry is Node-only. Renderer, preload and Worker code import the Node-free subpaths (`@clippy/shared/schemas`, `/settings`, `/api`, `/ipc`, `/relay`).

## Storage

**Driver: Node's built-in `node:sqlite` (`DatabaseSync`).** No native module, so there is no `better-sqlite3` and no `@electron/rebuild` step.

Why it works: Electron 45.1.0 bundles Node 24.22.1, where `node:sqlite` is available without a flag. Its bundled SQLite (3.53.4) is compiled with FTS5 (`sqlite_compileoption_used('ENABLE_FTS5') = 1`). Plain Node 24.13 (used by tests and tooling) has it as well, with SQLite 3.50.4 and FTS5.

Evidence: `scripts/sqlite-smoke.mjs` opens an in-memory database, creates an external-content FTS5 table, indexes three rows and runs a prefix `MATCH` query.

```text
$ node scripts/sqlite-smoke.mjs
{"ok":true,"runtime":"node","node":"24.13.0","sqlite":"3.50.4","fts5Hits":[{"id":"01B","body":"Tests failed on the payments service"}]}

$ ELECTRON_RUN_AS_NODE=1 npx electron scripts/sqlite-smoke.mjs     # or: npm run smoke:sqlite:electron
{"ok":true,"runtime":"electron 45.1.0","node":"24.22.1","sqlite":"3.53.4","fts5Hits":[{"id":"01B","body":"Tests failed on the payments service"}]}
```

`apps/desktop/test/sqlite.test.ts` runs both checks on every `npm test`: one in-process under Node and one by spawning Electron as Node. A real Electron main process (`process.type === 'browser'`) was also checked by hand: FTS5 works there too.

Notes for the storage implementation:

- The database file is `paths.dbPath()` (`<app data dir>/clippy.db`).
- Under plain Node 24.13, `node:sqlite` prints an `ExperimentalWarning`. Electron's Node does not. Desktop Vitest runs with `--disable-warning=ExperimentalWarning` to keep test output clean.
- Rows come back as null-prototype objects. Spread them (`{ ...row }`) before using deep-equality assertions.
