# Professor Clippy: architecture

## Workspace layout

npm workspaces monorepo (Node 24, npm 11, TypeScript strict, ESM, Vitest).

| Path | Package | What it is |
| --- | --- | --- |
| `packages/shared` | `@clippy/shared` | Every shared contract: zod schemas and types, settings, local API routes, data-dir paths, `ClippyClient`, Electron IPC contract, Worker relay protocol. TypeScript source only (no build step). |
| `apps/desktop` | `@clippy/desktop` | Electron + electron-vite + React. Hosts the local API (127.0.0.1), SQLite store, scheduler and Clippy's brain. The character (`src/renderer/src/clippy/`) is a set of painted robot sprites driven by a pure mood state machine (`mood.ts`): `poses.ts` maps moods to sprites and aligns them on one stage, CSS does the motion, and clicks pass through his transparent pixels (alpha masks built when the sprites are preloaded). |
| `apps/mcp` | `@clippy/mcp` | stdio MCP server; forwards agent tool calls to the desktop app through `ClippyClient`. Built by Vite into one `dist/index.js`. |
| `apps/hook` | `@clippy/hook` | Claude Code hook; posts a note when an agent finishes or needs permission. Built like `apps/mcp`. |
| `apps/worker` | `@clippy/worker` | Cloudflare Worker plus one SQLite-backed Durable Object (`ClippyDO`, binding `CLIPPY`) relaying WhatsApp Cloud API traffic. |
| `scripts/` | | Repo scripts: the Claude Code wiring (`install-claude-wiring.ts`, also bundled into the app for "Connect Claude Code"), SQLite smoke test, run-in-Electron helper. |

Root scripts: `npm test`, `npm run typecheck`, `npm run build` (each runs in every workspace), `npm run dev` (desktop app), `npm run package` (build, then the NSIS installer from `apps/desktop/electron-builder.yml` into `apps/desktop/release/`; the built MCP server and hook ship as `resources/mcp` and `resources/hook`).

`@clippy/shared` is consumed as TypeScript source. Vite (desktop, mcp, hook), wrangler (worker) and Vitest bundle or transform it; it is never `require`d from `node_modules` at runtime. Its root entry is Node-only. Renderer, preload and Worker code import the Node-free subpaths (`@clippy/shared/schemas`, `/settings`, `/api`, `/ipc`, `/relay`).

## Phone channels: WhatsApp and Telegram

Both are optional and independent; either, both or neither can be configured. Both subscribe
to the core `Bus` and share one brain session with the desk chat. Neither listens on the
network.

| | WhatsApp (`src/main/relay/`) | Telegram (`src/main/telegram/`) |
| --- | --- | --- |
| Transport | WebSocket + REST to your Cloudflare Worker, which talks to Meta | `fetch` long-poll of the Bot API (`getUpdates`, 50 s), `sendMessage` etc. |
| Configured by | `workerUrl` + `workerSecret` | `telegramBotTokenEnc` (+ `telegramChatId`) |
| Mirrors | new `note` and `ask` Messages | new `note`, `ask` and fired `reminder` Messages (missed ones combined) |
| Reminders | synced to the Worker, which sends them on time even with the PC off | sent by the desktop when its scheduler fires them |
| Answers an ask | quote-reply (`answeredVia: 'whatsapp'`) | inline button tap or Telegram reply (`answeredVia: 'telegram'`) |
| Reply routing id | `Message.waId` | `Message.tgMsgId` (column `tg_msg_id`, schema version 3) |
| Dedupe | Worker frame ids (kv `relaySeenInbound`) | update offset + recent update ids (kv `telegramOffset:<bot id>`, `telegramSeenUpdates:<bot id>`) |
| Brain channel | `whatsapp` (`[via WhatsApp]` prefix) | `telegram` (`[via Telegram]` prefix) |

Telegram's parts:

- `api.ts`: a dependency-free Bot API client over `fetch` (base URL injectable; tests use a fake
  HTTP server). Every error has the token redacted (it is part of each URL).
- `format.ts`: HTML formatting with escaping, the 4096-character cut/split, ask keyboards.
- `telegram.ts`: one `Telegram` per token: the poll loop (backoff 1 s → 60 s; the first poll after
  a start or an error has `timeout=0`, so the status is known at once), inbound handling (pairing,
  chat-id filter, commands, button taps, reply-to answers, brain turns with "typing…"), and the
  serial send queue (retries 1 s, 5 s, 30 s, 2 min; a 429 waits `retry_after`).
- `index.ts`: `TelegramManager` starts the channel when a token appears, retargets it when the
  (decrypted) token changes (the poll restarts with the new bot; queued sends go out with it),
  and stops it when the token is cleared. Pairing doesn't restart it: the chat id is read live.
  It owns the pairing code (kv `telegramPairingCode`), forgets every `tgMsgId` when the bot or
  chat changes (kv `telegramRoute` = `<bot id>:<chat id>`), and backs the `telegramStatus` /
  `setTelegramToken` / `telegramUnpair` / `telegramSendTest` IPC methods.
- Every part of a message (title, sender, project, answer) is capped, and a last check
  (`ensureFits`) runs on every send, so nothing is ever refused for being over 4096 characters.

The token is encrypted at rest by `SettingsStore` through a `SecretBox` (Electron `safeStorage`
in the app, `src/main/secrets.ts`); a plaintext `telegramBotToken` in `settings.json` is
encrypted on load and removed. The renderer never receives the token (`forRenderer` in
`backend.ts`).

Startup ordering (`startup.ts`): `startCore`'s scheduler catch-up fires reminders missed while
the app was off before any channel exists, so `startServices` collects the messages created
during `startCore` and hands them to Telegram once it is subscribed, in the same synchronous
block that subscribes the relay. `test/startup.test.ts` checks both channels see an agent's
first note and Telegram sends the catch-up.

## Quiet by default

`alertLevel(message, popUpFor)` (renderer, `note/alertLevel.ts`) decides how a new message
announces itself. Loud (ding, quip, wiggle, note opens) for questions, reminders, urgent notes
(permission requests) and `sender: "clippy"` notes; quiet (just the unread badge and the stack)
for a plain agent note, unless the `popUpFor` setting is `everything`. `unsolicitedAdvice` now
defaults to off, and `SettingsStore.load` runs a one-time migration that switches it off for
existing files and sets `quietDefaultsApplied` (never patchable), after which the user's own
toggle wins.

## Away-only notes

`NewMessageInput.quietIfActive` (the hook sets it on its Stop "agent finished" notes, never on
permission requests) means "only interrupt if the user is away". `POST /messages` asks
`isUserActive()` (from `startServices`: `powerMonitor.getSystemIdleTime()` under the
`awayThresholdS` setting, default 180 s). Active: the note is stored as `done` straight away (in
History, `quietIfActive: true`); the renderer only reacts to unread notes and both phone channels
skip notes already done, so there is no pop-up, sound, quip, badge or mirror. Away: a normal
unread note. Without an idle source every note interrupts.

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
