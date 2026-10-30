# Professor Clippy — implementation tasks

Spec: `DECISIONS.md` (27 decisions, "Professor Clippy — 2026-10-30"). Visual plan: `Plans/professor-clippy-plan.html`.
This file is the executable breakdown of that plan.

## Global Constraints

- Windows 11, Node 24, npm 11 (no pnpm). **npm workspaces** monorepo. TypeScript strict everywhere. Tests: **Vitest**. ESM.
- Layout: `packages/shared` (`@clippy/shared`), `apps/desktop` (Electron + electron-vite + React), `apps/mcp` (`@clippy/mcp`), `apps/hook` (`@clippy/hook`), `apps/worker` (`@clippy/worker`, Cloudflare Worker), `scripts/`.
- **All shared contracts live in `packages/shared`** and are imported by every other package. Never redefine a type that shared exports.
- **Dependencies are declared in Task 1 only.** Later tasks must not add or change dependencies or `package-lock.json` unless unavoidable; if they must, say so in the report (lockfile conflicts across parallel tasks are resolved by the controller).
- App data dir: `process.env.CLIPPY_HOME` if set, else `%APPDATA%/professor-clippy/`. Files: `token` (random 32-byte hex, created on first app run), `port` (local API port), `clippy.db`, `settings.json`.
- Local API binds **127.0.0.1 only**, random free port written to `port`; every request requires `Authorization: Bearer <token>` (401 otherwise). Nothing on the PC listens on a public interface.
- Agent messages are shown **verbatim** (never rewritten). Each message carries `sender` (agent/client name) and `project` (folder name) and an `urgent` flag.
- `ask_user` default timeout **600 s**, overridable per call. On timeout returns `{status:"pending", id}`.
- Reminder `when` is an **ISO 8601** timestamp (agents convert natural language themselves); recurring uses an RFC 5545 **RRULE** string.
- Clippy brain = headless Claude Code CLI (`claude -p`, `--resume`), user's Claude Code login, no API key. Allowed tools: Read, Glob, Grep, WebSearch, WebFetch, `mcp__clippy__*`. Disallowed: Edit, Write, Bash, NotebookEdit.
- WhatsApp: Meta WhatsApp Cloud API, test number, via a Cloudflare Worker + one SQLite-backed Durable Object. Mirror **every** message. Inside 24h of the user's last inbound WA message → free-form text; outside → utility template `clippy_note` with one body param `{{1}}` = text truncated to 1000 chars ending `…more on desktop` when cut. Quote-reply (`context.id` == an ask's `waId`) answers that ask; other inbound text goes to the brain as chat.
- Character is an **original** paperclip professor (googly eyes, mortarboard with tassel, round glasses, bow tie) — no Microsoft Clippy assets, sprites or sounds.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Shared contracts (defined in Task 1, binding for all tasks)

`@clippy/shared` exports (zod schemas + inferred types):

- `Message`: `{ id: string (ulid), kind: 'note'|'reminder'|'ask'|'chat', body: string, title?: string, sender: string, project?: string, urgent: boolean, state: 'unread'|'done'|'snoozed', createdAt: number, doneAt?: number, snoozedUntil?: number, waId?: string, options?: string[], answer?: string, answeredVia?: 'desk'|'whatsapp'|'clippy', role?: 'user'|'clippy', missed?: boolean }` (`role` only for `chat`; `missed` = reminder fired while PC was off).
- `Reminder`: `{ id, body, sender, project?, dueAt: number, rrule?: string, active: boolean, createdAt: number, lastFiredAt?: number }`.
- Inputs: `NewMessageInput {body, title?, sender, project?, urgent?}`, `NewReminderInput {body, when: string(ISO), rrule?, sender, project?}`, `NewAskInput {question, options?, sender, project?, urgent?}`, `AskResult {id, status:'answered'|'pending', answer?, answeredVia?}`.
- `Settings`: `{ hookEnabled: true, soundEnabled: true, unsolicitedAdvice: true, askTimeoutDefaultS: 600, hideOnFullscreen: true, autoStart: true, workerUrl?: string, workerSecret?: string, windowPos?: {x,y,displayId} }` (defaults shown).
- `paths`: `appDataDir()`, `tokenPath()`, `portPath()`, `dbPath()`, `settingsPath()`.
- `ClippyClient` (fetch-based, Node): `new ClippyClient({baseUrl, token})`, `static fromAppData()` (reads port+token files; throws `ClippyNotRunningError` if missing/unreachable), methods: `health()`, `postMessage(NewMessageInput)`, `listMessages({state?, kind?, q?})`, `createReminder(NewReminderInput)`, `listReminders()`, `cancelReminder(id)`, `createAsk(NewAskInput)`, `waitAsk(id, waitSeconds)`, `answerAsk(id, answer, via)`, `listPendingAsks()`.
- Local HTTP API routes (implemented in Task 2, consumed by the client):
  `GET /health` · `POST /messages` · `GET /messages?state=&kind=&q=` (q = FTS search) · `POST /messages/:id/done` · `POST /messages/:id/snooze {until}` · `POST /reminders` · `GET /reminders` · `DELETE /reminders/:id` · `POST /asks` · `GET /asks/pending` · `GET /asks/:id?wait=<s>` (long-poll, returns AskResult) · `POST /asks/:id/answer {answer, via}`.
- IPC (`ipc.ts`): channel constants and `interface ClippyBackend` — `listMessages(filter)`, `markDone(id)`, `snooze(id, until)`, `answerAsk(id, answer)`, `sendChat(text)`, `newChat()`, `searchHistory(q)`, `getSettings()`, `setSettings(patch)`, plus events `message:new`, `message:updated`, `chat:delta`, `chat:done`, `brain:state ('idle'|'thinking')`. Preload exposes `window.clippy: ClippyBackend & { on(event, cb): () => void }`.
- Relay protocol (`relay.ts`, Worker ↔ PC): PC→Worker REST with `Authorization: Bearer <workerSecret>`: `POST /send {text, kind, urgent?}` → `{waId, mode:'freeform'|'template'}`; `PUT /reminders/:id {body, dueAt, rrule?, tz?, startAt?}` (tz = IANA zone for floating-local RRULE evaluation; startAt = recurrence anchor); `DELETE /reminders/:id`; `GET /ws` (WebSocket upgrade). Worker→PC over WS: `{type:'inbound', id, text, contextWaId?, ts}` and `{type:'reminder-fired', id, firedAt, waId?, nextDueAt?}`; PC→Worker over WS: `{type:'ack', ids: string[]}`. Unacked items are redelivered on reconnect.

---

## Task 1: Scaffold the workspace and shared contracts

Create the npm-workspaces monorepo exactly per Global Constraints and implement `packages/shared` fully (all contracts above, with unit tests for the schemas, `paths` (honours `CLIPPY_HOME`), and `ClippyClient` against a tiny in-test HTTP server).

- Root: `package.json` (workspaces, scripts `build`, `test`, `typecheck`, `dev` → desktop), `tsconfig.base.json`, `.gitignore` (node_modules, out, dist, .wrangler, *.log, .superpowers/), `.editorconfig`, `vitest.workspace` or per-package vitest configs.
- Declare **every dependency all later tasks need** (pin current stable versions): electron, electron-vite, vite, react, react-dom, @vitejs/plugin-react, electron-builder, zod, ulid, rrule, ws, @modelcontextprotocol/sdk, wrangler, @cloudflare/workers-types, @cloudflare/vitest-pool-workers (only if it installs cleanly; otherwise skip and note), typescript, vitest, @types/node, @types/react, @types/react-dom, @types/ws, plus the SQLite driver below.
- **SQLite driver decision (you decide and verify):** prefer `node:sqlite` if the pinned Electron's bundled Node supports it unflagged with FTS5; otherwise `better-sqlite3` + `@electron/rebuild`. Prove the choice with a smoke script that opens an in-memory DB, creates an FTS5 table and queries it **both** under plain Node (vitest) and under Electron (`ELECTRON_RUN_AS_NODE=1 npx electron smoke.mjs`). Record the decision and the evidence in the report and in a short `docs/ARCHITECTURE.md` ("Storage" section).
- `apps/desktop`: electron-vite skeleton that launches a window saying "Professor Clippy" (main, preload, renderer with React). `npm run dev -w apps/desktop` must start without errors (launch it briefly, then kill it). Single-instance lock.
- Empty-but-building skeletons for `apps/mcp`, `apps/hook`, `apps/worker` (worker: `wrangler.toml` with a Durable Object binding `CLIPPY` class `ClippyDO`, SQLite-backed migration `new_sqlite_classes`).
- `npm test` and `npm run typecheck` pass at the root.

## Task 2: Core service (Electron main: store, local API, scheduler, bus)

In `apps/desktop/src/main/core/` implement, with Vitest tests runnable under plain Node:

- `store.ts`: SQLite (driver from Task 1) with migrations; tables `messages`, `reminders`, `kv`; FTS5 index on message body+title for `q` search. CRUD matching the shared schemas.
- `bus.ts`: typed event emitter (`message:new`, `message:updated`, `reminder:fired`, `ask:answered`).
- `scheduler.ts`: single timer armed for the earliest due reminder; one-off and RRULE recurring (via `rrule`); when a reminder fires it creates a `reminder` Message and emits; on `start()` and on an injected `onResume()` it catches up reminders whose due time passed while stopped, creating messages with `missed: true` (one per reminder, not one per missed recurrence) and advancing recurring ones to the next future occurrence. Injectable clock for tests.
- `asks.ts`: create ask → Message(kind 'ask'); long-poll wait with timeout returning `AskResult`; answer resolves all waiters and emits `ask:answered`; answering twice is rejected (409).
- `api.ts`: Node `http` server on 127.0.0.1, port 0 → actual port written to `portPath()`; token generated on first run into `tokenPath()` (reuse if present); bearer check (401); JSON routes exactly per the contract; zod validation (400 with message); long-poll for `GET /asks/:id?wait=`.
- `core.ts`: `startCore({dataDir?, clock?}) → { store, bus, scheduler, asks, api, port, token, stop() }`.
- Tests: store CRUD + FTS search, scheduler (one-off, recurring next-fire, catch-up marks missed), ask long-poll answered vs timeout, API auth 401, validation 400, end-to-end via `ClippyClient` from shared.

Do not touch `src/renderer`, `src/preload`, or `src/main/index.ts` beyond what is needed to compile.

## Task 3: Sticky note window + Professor Clippy character (renderer, preload, window)

Own `apps/desktop/src/renderer/**`, `apps/desktop/src/preload/**`, `apps/desktop/src/main/window/**`. Build against the shared `ClippyBackend` interface; ship a **mock backend** (`renderer/mock/`) used when `window.clippy` is absent or `?mock=1`, with sample notes, a reminder, an ask with options and a chat, so the UI can be developed and screenshotted standalone (`npm run dev:renderer` or vite preview).

- `main/window/createClippyWindow.ts`: frameless, transparent, `skipTaskbar`, `setAlwaysOnTop(true,'screen-saver')`, two sizes (mini ≈140×160, expanded ≈380×560), switch on IPC `window:mode`, draggable via a drag handle, position persisted through an injected `savePos/loadPos`, clamped to a visible display. Transparent areas click-through (`setIgnoreMouseEvents(true,{forward:true})` toggled on hover of opaque regions). Hide when another app is fullscreen if `hideOnFullscreen`.
- `preload`: `contextBridge.exposeInMainWorld('clippy', …)` implementing `ClippyBackend` over `ipcRenderer.invoke` + event subscription. `main/window/registerIpc.ts`: `registerIpc(backend: ClippyBackend, win)` wiring every channel.
- Clippy SVG rig (`renderer/clippy/`): original paperclip professor — wire body, googly eyes with pupils that follow the cursor, eyebrows, mortarboard with swinging tassel, round glasses, bow tie; parts as separate groups animated by CSS keyframes. States: `idle, blink, read, sleep, wake, jump, tapGlass, think, celebrate`, driven by a small state machine (`useClippyMood`): sleep after 10 min idle, wake+jump on new message, tapGlass after 2 min ignored, bigger antics after 10 min or immediately for urgent, think while `brain:state` = thinking, celebrate when the unread stack empties. Respect `prefers-reduced-motion`.
- UI: mini mode = Clippy + unread badge; expanded = yellow sticky note with Clippy clipped on top, tabs **Notes** (unread stack newest-first; Done; Snooze 10m/1h/tomorrow 9:00; ask cards with option buttons + free-text answer), **Chat** (streaming bubbles from `chat:delta`/`chat:done`, input box, "New chat"), **History** (search box → `searchHistory`), **Settings** (all `Settings` toggles).
- Quips: `renderer/quips/quips.json` (≥60 original one-liners tagged `build|error|reminder|ask|lateNight|generic|advice`); a speech bubble shows one canned quip per new message (picked by tag heuristics on body); unsolicited advice at random 30–90 min when enabled.
- Sounds: generate small original sounds with WebAudio (ding, boing, tap) — no audio files from elsewhere; respect `soundEnabled`.
- Tests: Vitest + @testing-library/react if available in deps (else pure-logic tests): mood state machine transitions, quip picker, snooze time computation, mock backend. Capture at least two screenshots (mini + expanded with notes) of the mock UI to `docs/screenshots/` using electron or a headless browser if feasible; if not feasible, say so.

## Task 4: MCP server, Claude Code hook, wiring script

Own `apps/mcp/**`, `apps/hook/**`, `scripts/install-claude-wiring.ts` (+ tests). Talk to the app only through `ClippyClient` from shared.

- `apps/mcp`: stdio server via `@modelcontextprotocol/sdk`, server name `clippy`. Tools: `leave_message {body, title?, urgent?}`, `remind_me {body, when (ISO 8601), repeat? (RRULE)}`, `ask_user {question, options?, timeout_s? (default from settings or 600), urgent?}`, `check_reply {id}`, `list_reminders {}`, `cancel_reminder {id}`, `list_pending_asks {}`, `answer_pending {id, answer}` (via `'clippy'`). `sender` = MCP client name from initialize (`clientInfo.name`) or `CLIPPY_SENDER` env; `project` = basename of `process.cwd()`. Tool descriptions must tell agents when to use them ("when the user asks you to leave a message / remind / notify / check with them"). `ask_user` long-polls in ≤55 s slices until `timeout_s`, sending MCP progress notifications between slices when the client supplied a progressToken. If the app is unreachable: try launching `CLIPPY_APP_PATH` or `%LOCALAPPDATA%/Programs/professor-clippy/Professor Clippy.exe` if it exists, wait up to 15 s, retry; else return a clear tool error "Professor Clippy isn't running".
- `apps/hook`: CLI reading Claude Code hook JSON on stdin. `Stop` → note "✅ <project> agent finished" + last assistant line from `transcript_path` (if readable, ≤300 chars); `Notification` → urgent note "🔐 <project>: <message>". Respect `settings.json` `hookEnabled`. Collapse duplicate Stop posts for the same project within 60 s (state file in app data dir). Never fail the hook: always exit 0 quickly; if the app isn't running, do nothing.
- `scripts/install-claude-wiring.ts` (`install` | `uninstall` | `--dry-run`): `claude mcp add --scope user clippy -- node <abs path to built mcp>`; merge `Stop` and `Notification` hooks running `node <abs path to built hook>` into `~/.claude/settings.json` (preserve everything else; idempotent; back up the file first); append to `~/.claude/CLAUDE.md` once: "When the user asks you to leave a message, remind them, notify them, or check with them, use the Professor Clippy MCP tools (leave_message / remind_me / ask_user)." Uninstall reverses all three. Honour `CLAUDE_CONFIG_DIR`/a `--home` override so tests run against a temp dir. **Tests must never touch the real `~/.claude`; do not run `install` for real.**
- Tests: MCP tools against a fake API server (use the SDK's in-memory transport or spawn over stdio), ask slicing/timeout, hook dedupe and disabled flag, wiring idempotency + uninstall on a temp home.

## Task 5: Cloudflare Worker relay (WhatsApp Cloud API)

Own `apps/worker/**`. Single Durable Object `ClippyDO` (SQLite storage) holds: inbound queue (unacked), reminders, `lastInboundAt`, wamid→kind map. Worker routes forward to the DO.

- `GET /webhook`: Meta verify handshake (`hub.mode=subscribe`, `hub.verify_token == VERIFY_TOKEN` → echo `hub.challenge`, else 403).
- `POST /webhook`: verify `X-Hub-Signature-256` = HMAC-SHA256(APP_SECRET, raw body) with constant-time compare (403 on mismatch); accept only messages from `MY_NUMBER`; for each text message store `{id, text, contextWaId?, ts}`, update `lastInboundAt`, push to connected PC sockets; always 200 quickly on valid signatures.
- PC routes (bearer `PC_SECRET`, 401 otherwise): `POST /send`, `PUT /reminders/:id`, `DELETE /reminders/:id`, `GET /ws` (WebSocket via DO hibernation API). On connect, redeliver every unacked inbound and reminder-fired item; `ack` deletes them.
- Sending: `POST https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages` with `META_TOKEN`; free-form text if `now - lastInboundAt < 24h`, else template `clippy_note` (language `en`, body param = truncated text per Global Constraints). Return `{waId, mode}`.
- Reminders: DO **alarm** set to the earliest `dueAt`; on alarm send each due reminder to WhatsApp (prefix "⏰ "), record `firedAt`, push/queue a `reminder-fired` item, advance RRULE reminders (use `rrule` if it bundles for Workers; else implement the RRULE subset FREQ=DAILY|WEEKLY|MONTHLY with INTERVAL, BYDAY, BYHOUR, BYMINUTE and document it), delete one-offs, re-arm.
- Secrets (document in `apps/worker/README.md`, never commit values): `META_TOKEN, APP_SECRET, VERIFY_TOKEN, PC_SECRET, PHONE_NUMBER_ID, MY_NUMBER`. Include the exact `clippy_note` template definition to submit to Meta, and the step-by-step Meta setup (app, test number, verified recipient, system user permanent token, webhook subscription to `messages`).
- Tests: pure-function tests (signature verification incl. tamper, 24h window choice, truncation, RRULE next occurrence) plus route/DO tests with `@cloudflare/vitest-pool-workers` if it was installed in Task 1 (mock `fetch` to graph.facebook.com). `npx wrangler deploy --dry-run` must succeed. **Do not deploy.**

## Task 6: Clippy brain, relay client, and main-process integration

Integrate Tasks 2–5 into a working app. Own `apps/desktop/src/main/index.ts`, `src/main/brain/**`, `src/main/relay/**`, `src/main/backend.ts`.

- `brain/`: spawns `claude -p <text> --output-format stream-json --verbose --resume <sessionId?> --append-system-prompt <persona> --mcp-config <generated json pointing at built apps/mcp with env CLIPPY_SENDER=clippy-brain> --allowedTools "Read Glob Grep WebSearch WebFetch mcp__clippy__*" --disallowedTools "Edit Write Bash NotebookEdit"`, cwd = user home. Parses stream-json: emits `chat:delta`, final text, stores new `session_id` in `kv`. Serialised turn queue (one at a time). `newChat()` clears the session. Persona: smug, helpful, slightly pompous paperclip professor; short replies; on WhatsApp ≤ 3 short paragraphs; may answer pending agent asks via `answer_pending` when the user clearly answers one. Clear error message in chat if `claude` is missing or not logged in. Make the CLI runner injectable and unit-test the stream parser and queue with recorded fixtures (do not call the real CLI in tests; one optional manual smoke script is fine).
- `relay/`: WS client to `${workerUrl}/ws` with bearer, exponential backoff reconnect (1 s → 60 s), acks; `send(text, kind, urgent)` → stores returned `waId` on the message; reminder create/cancel → `PUT/DELETE /reminders/:id`. Disabled cleanly when `workerUrl`/`workerSecret` unset. Inbound: `contextWaId` matching an open ask's `waId` → `asks.answer(id, text, 'whatsapp')`; else → brain turn whose final reply is sent back via `/send` (kind 'chat'). `reminder-fired` from Worker → mark that reminder's desktop message as already-sent (desktop must not re-send to WA). Mirror rule: every new note/reminder/ask message → `/send` (decision 15). Tests with a fake WS server.
- `backend.ts`: implements `ClippyBackend` over core + brain + settings; `main/index.ts`: single-instance, `startCore`, settings load/save, `createClippyWindow`, `registerIpc`, relay start, `powerMonitor.on('resume')` → scheduler catch-up, `app.setLoginItemSettings({openAtLogin: settings.autoStart})`, tray icon with Show / Mute / Quit.
- Verify end-to-end locally (no WhatsApp): build everything, launch the app, use `ClippyClient` (or the built MCP server over stdio) to post a note, create a reminder 1 min out, create an ask and answer it via the API; confirm via API state and a screenshot of the window. Record evidence in the report.

## Task 7: Packaging, first-run, docs

- electron-builder NSIS per-user config (`apps/desktop/electron-builder.yml`), app id `com.professorclippy.app`, product name `Professor Clippy`, icon generated from an SVG of the Clippy head (create `build/icon.png` 512 px and `.ico`). Bundle built `apps/mcp` and `apps/hook` as `extraResources` so the wiring script can point at installed paths.
- First-run wizard in the note (renderer): Worker URL + secret (or "Skip WhatsApp for now"), sounds, unsolicited advice, "Connect Claude Code" button that runs the wiring script (shows the dry-run diff first, then installs).
- Root `README.md`: what it is, dev setup, build/package (`npm run package`), Claude wiring, WhatsApp/Worker setup (link `apps/worker/README.md`), troubleshooting. `docs/USER-TODO.md`: the exact checklist the user must do by hand (Meta app + test number + verified recipient + system user token + template approval, Cloudflare account + `wrangler login` + secrets + deploy, set webhook URL, run installer, connect Claude Code).
- Run `npm run package` and confirm an installer `.exe` is produced (do not install it). Full `npm test` + `npm run typecheck` green.
