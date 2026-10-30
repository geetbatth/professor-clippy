# Tell Clippy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Professor Clippy quiet unless something needs the user, and turn "chat" into telling Clippy to do things: a hotkey box, standing orders, watch-and-nudge, a morning brief and snooze-by-telling.

**Architecture:** Everything lives in the existing Electron app (`apps/desktop`), the shared contracts (`packages/shared`), the MCP server (`apps/mcp`) and the hook (`apps/hook`). New rules (standing orders, watches) are SQLite tables in the existing store, exposed over the existing local API and as **brain-only** MCP tools, so the user manages them by telling Clippy. Alerts are split into loud (needs you) and quiet (FYI); phone mirroring goes through a new gate that holds messages while the user is at the PC.

**Tech Stack:** TypeScript strict, ESM, Node 24, Electron 45, React, zod, `node:sqlite`, Vitest, `@modelcontextprotocol/sdk`.

**Spec:** this plan (the user approved the feature list in chat and asked to skip further questions). The feature list, verbatim from the chat:
1. Two levels of loud: questions, permission requests and due reminders pop up (expand + wiggle + sound); "finished" and plain notes just get a quiet badge.
2. Phone only when away: if you're at the PC, things stay on the desktop; idle for a while, or a question sits unanswered, they go to your phone.
3. Advice quips off.
4. Hotkey "Tell Clippy…" box from anywhere.
5. Standing orders: "if any agent asks about the database, say staging" — Clippy answers those for you.
6. Watch-and-nudge: "when the build agent finishes, remind me to deploy".
7. Morning brief: at 9am, today's reminders plus what the agents did overnight, in one note.
8. Snooze by telling Clippy: "not now, bring it back after lunch".
9. Keep chat, but don't frame it as chat: it is telling Clippy to do things.

Already built before this plan (do not rebuild): away-only "agent finished" notes (`quietIfActive`, `awayThresholdS`, default 180 s), snooze buttons on cards.

## Global Constraints

- Read `docs/ARCHITECTURE.md` and `README.md` first; follow the existing code style (comment density, naming, small pure modules with tests).
- No new npm dependencies; do not touch `package-lock.json`.
- Shared contracts live in `packages/shared` and are imported, never redefined. Renderer/preload code imports only the Node-free subpaths (`@clippy/shared/schemas`, `/settings`, `/api`, `/ipc`).
- Store schema changes are **appended** migrations in `apps/desktop/src/main/core/store.ts` `MIGRATIONS` (never edit an existing one).
- Agent message bodies stay verbatim. Clippy's own generated notes use `sender: 'clippy'`.
- Brain-only MCP tools are registered only when `env.CLIPPY_SENDER === BRAIN_SENDER` (`'clippy-brain'`); agents never see them.
- Every task: `npm run typecheck` and `npm test` pass at the repo root before committing. Update `README.md` / `docs/ARCHITECTURE.md` for the user-visible behaviour the task adds (short, same tone).
- Commit messages: imperative sentence, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Windows 11 target. Copy is plain English, no jargon; Clippy's lines keep his pompous-professor tone.

## Review Focus

1. **Hotkey already taken by another app** → registration fails without crashing; Settings shows "Couldn't register Ctrl+Alt+Space (another app uses it)"; changing it re-registers. (Task 3 test.)
2. **Standing-order matcher slow, failing, or `claude` missing** → the question is posted normally after at most 20 s; an auto-answer is never a value outside the ask's `options`. (Task 5 tests.)
3. **User dismisses or answers a held message on the desk before going away** → it is never mirrored to the phone afterwards. (Task 2 test.)
4. **PC asleep / app started late at brief time** → at most one brief per day; started after 12:00 local → no catch-up brief that day; weekend skipped when weekdays-only. (Task 7 tests.)
5. **Watch project name in different case or partial** ("Clippy" vs "professor-clippy") → still fires, exactly once. (Task 6 test.)

---

### Task 1: Quiet by default (two alert levels, quips off)

**Files:**
- Create: `apps/desktop/src/renderer/src/note/alertLevel.ts`, `apps/desktop/test/renderer/alertLevel.test.ts`
- Modify: `packages/shared/src/settings.ts`, `apps/desktop/src/main/settings.ts`, `apps/desktop/src/renderer/src/App.tsx`, `apps/desktop/src/renderer/src/note/SettingsTab.tsx`, `apps/desktop/src/renderer/src/mock/mockBackend.ts` (if it builds settings), tests in `packages/shared/test/settings.test.ts`, `apps/desktop/test/settings.test.ts`

**Interfaces:**
- Produces: settings `popUpFor: 'important' | 'everything'` (default `'important'`), `quietDefaultsApplied: boolean` (default `false`, not in `SettingsPatch`), `unsolicitedAdvice` default `false`.
- Produces: `alertLevel(m: Message, popUpFor: 'important' | 'everything'): 'loud' | 'quiet'`. Later tasks rely on: **`sender === 'clippy'` notes are loud** (nudges, the morning brief).

- [ ] **Step 1: Failing tests.** `alertLevel.test.ts`: ask → loud; reminder → loud; urgent note → loud; note from `sender: 'clippy'` → loud; plain note (`sender: 'claude-code'`, not urgent) → quiet; plain note with `popUpFor: 'everything'` → loud. Shared settings test: `Settings.parse({}).unsolicitedAdvice === false`, `popUpFor === 'important'`, `quietDefaultsApplied === false`; `SettingsPatch` rejects/omits `quietDefaultsApplied`. Desktop settings test: loading a file `{"unsolicitedAdvice": true}` (no `quietDefaultsApplied`) yields `unsolicitedAdvice: false, quietDefaultsApplied: true` and writes that back; loading `{"unsolicitedAdvice": true, "quietDefaultsApplied": true}` keeps `true`.
- [ ] **Step 2: Run, see them fail.** `npm test -w apps/desktop -- alertLevel settings` and `npm test -w packages/shared`.
- [ ] **Step 3: Implement.** Settings fields as above. In `SettingsStore.load`, a one-time migration: if `quietDefaultsApplied` is false, set `unsolicitedAdvice: false, quietDefaultsApplied: true` and save (the user asked for quips off; this runs once, after which their own toggle wins). `alertLevel` as tested. In `App.tsx` `onNewMessage`: loud → today's behaviour (ding, quip, wiggle, open); quiet → nothing but the unread badge/count (no sound, quip, wiggle, mood jump or open). Settings tab: a "Pop up for" control ("Questions, reminders & urgent" / "Everything") near the sound toggle.
- [ ] **Step 4: Run tests + typecheck, all pass.**
- [ ] **Step 5: Commit** "Pop up only for things that need you; advice quips off".

### Task 2: Phone only when away

**Files:**
- Create: `apps/desktop/src/main/phoneGate.ts`, `apps/desktop/test/phoneGate.test.ts`
- Modify: `apps/desktop/src/main/core/bus.ts`, `apps/desktop/src/main/startup.ts`, `apps/desktop/src/main/relay/relay.ts` (outbound mirror subscription only), `apps/desktop/src/main/telegram/telegram.ts` (same), `packages/shared/src/settings.ts`, `SettingsTab.tsx`, `apps/desktop/test/startup.test.ts`, relay/telegram tests that post notes and expect a mirror

**Interfaces:**
- Produces: bus event `'message:mirror': Message` (CoreEventMap). Relay and Telegram mirror outbound notes/asks/reminders on `message:mirror` instead of `message:new`; their existing per-channel filters (kinds, done/answered checks) stay.
- Produces: setting `phoneWhen: 'away' | 'always'` (default `'away'`).
- Produces: `class PhoneGate { constructor(o: { bus: Bus; store: Store; isUserAway: () => boolean; mode: () => 'away' | 'always'; clock?: Clock; tickMs?: number /* 30_000 */ }); start(): void; stop(): void; readonly heldIds: string[] }`.

- [ ] **Step 1: Failing tests** (`phoneGate.test.ts`, FakeClock from `test/core/fakeClock.ts`, in-memory Store): note arrives while away → one `message:mirror` at once; arrives while active → none, `heldIds` contains it; user goes away → next tick mirrors it once and `heldIds` is empty; held note marked done (or ask answered) before going away → never mirrored; held note snoozed → stays held, mirrored on a tick after it wakes (unread) and the user is away; `mode: 'always'` → mirrored at once even while active; messages with `state: 'done'` on arrival (quiet hook notes, chat lines) → never mirrored. `startup.test.ts`: with `idleSeconds: () => 0`, an agent note posted through the API is not sent to the fake Telegram/Worker; with `idleSeconds: () => 10_000` it is.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** Gate subscribes `message:new` (kinds note/ask/reminder, not done) and `message:updated` (drop held ids that became done/answered). Tick (`clock.setTimeout` loop, `tickMs`): if away, re-read each held message from the store and mirror the ones still unread (asks: still unanswered), then forget all non-snoozed held ids. In `startServices`: `isUserAway = idleSeconds ? () => settings.get().awayThresholdS === 0 || idleSeconds() >= settings.get().awayThresholdS : () => true`; create and start the gate before the relay/Telegram (same synchronous block); stop it in `index.ts` shutdown. Telegram's startup `replay(early)` stays as is (missed reminders while the PC was off). Settings: "Send to my phone" — "Only when I'm away" / "Always", next to the away threshold field. README: say WhatsApp reminders are still sent by the Worker on time.
- [ ] **Step 4: Run tests + typecheck, all pass** (fix relay/telegram tests by giving them an always-mirror gate or emitting `message:mirror`).
- [ ] **Step 5: Commit** "Send notes to the phone only when the user is away".

### Task 3: "Tell Clippy" box and global hotkey

**Files:**
- Create: `apps/desktop/src/main/window/hotkey.ts`, `apps/desktop/test/window/hotkey.test.ts`, `apps/desktop/src/renderer/src/note/TellBox.tsx`, `TellBox.css`
- Modify: `apps/desktop/src/main/window/windowApi.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/runtime.ts` (browser shell stub), `apps/desktop/src/main/index.ts`, `packages/shared/src/settings.ts`, `packages/shared/src/ipc.ts`, `apps/desktop/src/main/backend.ts`, `apps/desktop/src/main/window/registerIpc.ts`, `mockBackend.ts`, `App.tsx`, `NotesTab.tsx`, `StickyNote.tsx`, `ChatTab.tsx`, `apps/desktop/src/main/brain/persona.ts`, `apps/desktop/test/window/preload.test.ts`, `registerIpc.test.ts`

**Interfaces:**
- Produces: setting `tellHotkey: string` (Electron accelerator, max 60 chars, default `'Control+Alt+Space'`, `''` = off).
- Produces: `registerTellHotkey(accelerator: string, onPress: () => void, shortcuts?: Pick<Electron.GlobalShortcut, 'register' | 'unregister'>): { ok: boolean; error?: string; dispose(): void }` (`''` → `{ ok: true }` and nothing registered; `register` returning false or throwing → `{ ok: false, error: "Couldn't register <accel> (another app may be using it)" }`).
- Produces: `ClippyBackend.hotkeyStatus(): Promise<{ accelerator: string; ok: boolean; error?: string }>` (IpcInvoke `'clippy:hotkeyStatus'`).
- Produces: `WindowChannels.tell = 'window:tell'` (main → renderer), `WindowChannels.blur = 'window:blur'` (renderer → main); `ClippyWindowShell.onTell(cb: () => void): () => void` and `ClippyWindowShell.blur(): void`.

- [ ] **Step 1: Failing tests.** `hotkey.test.ts` with a fake `shortcuts`: registers the accelerator and calls `onPress`; `''` registers nothing; `register` → false gives `ok: false` with the error text; `dispose()` unregisters. `preload.test.ts` / `registerIpc.test.ts`: the new channel/method are exposed and validated (follow the existing tests' pattern).
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** Main: register at startup and again when `tellHotkey` changes; on press: `win.show()`, `win.focus()`, `setMode('expanded')`, send `window:tell`. `window:blur` → `win.blur()`. Renderer: `TellBox` is a one-line input pinned under the Notes tab content (both the empty and the stacked state), placeholder `Tell Clippy… (e.g. remind me at 3 to call Dave)`. Enter sends through `chat.send`; under the box it shows Clippy's streamed reply to that line (and errors), with a × to clear. Escape clears, collapses to mini and calls `shell.blur()`. On `onTell`: switch to Notes, focus the box. Auto-collapse must not fire while the box has focus or text. The `chat` tab keeps its id but is labelled **Clippy**; its placeholder becomes `Tell Clippy what to do…` and its empty hint lists 3 examples ("remind me at 3 to call Dave", "what are my agents waiting on?", "when the build finishes, remind me to deploy"). Settings: "Tell Clippy hotkey" text field + the status/error line. Persona: one line saying the user mostly gives Clippy instructions; do the thing with the tools and confirm in one short sentence.
- [ ] **Step 4: Run tests + typecheck, all pass.** Also `npm run build` succeeds.
- [ ] **Step 5: Commit** "Add the Tell Clippy box and a global hotkey".

### Task 4: Brain tools for notes (snooze by telling, catch-up)

**Files:**
- Modify: `packages/shared/src/index.ts` or a Node-free module (export `BRAIN_SENDER = 'clippy-brain'`), `apps/desktop/src/main/brain/mcpConfig.ts` (import it), `apps/mcp/src/server.ts`, `apps/mcp/test/server.test.ts`, `apps/mcp/test/fake-api.ts`, `apps/desktop/src/main/brain/brain.ts` (`BRAIN_CLIPPY_TOOLS`), `persona.ts`, `apps/desktop/test/brain/*.test.ts` as needed

**Interfaces:**
- Consumes: existing `ClippyClient.listMessages`, `markDone`, `snooze`.
- Produces (brain-only MCP tools, used by Tasks 5–6 as the pattern): a helper in `server.ts` that registers a tool only when `env.CLIPPY_SENDER === BRAIN_SENDER`.
  - `list_notes {}` → unread and snoozed note/ask/reminder messages: `id, kind, title, body (≤300 chars), sender, project, state, snoozedUntil (ISO), created (ISO)`.
  - `recent_activity { since?: IsoDateTime, limit?: int 1..100 = 30 }` → non-chat messages created since `since` (default 24 h ago), newest first, with `state`, `answer`, `answeredVia`.
  - `snooze_note { id, until: IsoDateTime }` → snoozes; `until` not in the future → tool error "That time has already passed".
  - `dismiss_note { id }` → marks done.

- [ ] **Step 1: Failing tests** in `server.test.ts`: with `CLIPPY_SENDER=clippy-brain` the four tools are listed; without it they are not; `snooze_note` calls the fake API's snooze with `Date.parse(until)`; a past `until` returns an error result; `recent_activity` excludes chat lines and older messages.
- [ ] **Step 2: Run, see them fail.** `npm test -w apps/mcp`
- [ ] **Step 3: Implement.** Add the tools to `BRAIN_CLIPPY_TOOLS`. Persona lines: "not now / bring it back after lunch" → `snooze_note` on the note they most likely mean (the newest unread one; ask if two are equally likely); "what happened while I was away / at lunch" → `recent_activity` and summarise by project in a few lines; "what's waiting on me" → `list_notes` + `list_pending_asks`.
- [ ] **Step 4: Run tests + typecheck, all pass.**
- [ ] **Step 5: Commit** "Let Clippy snooze, dismiss and summarise notes when told".

### Task 5: Standing orders

**Files:**
- Create: `apps/desktop/src/main/orders.ts`, `apps/desktop/test/orders.test.ts`, `apps/desktop/src/renderer/src/note/RulesSection.tsx` (Settings section; Task 6 adds to it)
- Modify: `packages/shared/src/schemas.ts`, `api.ts`, `client.ts`, `ipc.ts`; `apps/desktop/src/main/core/store.ts` (migration + methods), `asks.ts`, `api.ts`, `core.ts`; `startup.ts`; `backend.ts`; `registerIpc.ts`; `mockBackend.ts`; `SettingsTab.tsx`; `AskCard.tsx`/`HistoryTab.tsx` (label); `apps/mcp/src/server.ts`; `brain.ts`; `persona.ts`; tests in `packages/shared/test`, `apps/desktop/test/core/{store,asks,api}.test.ts`, `apps/mcp/test/server.test.ts`

**Interfaces:**
- Produces (shared): `StandingOrder = { id: ulid, text: string, active: boolean, createdAt: Timestamp }`; `NewStandingOrderInput = { text: string (1..500) }`; `Message.orderId?: string` (the order that auto-answered this ask).
- Produces (routes): `listOrders GET /orders` → active `StandingOrder[]` oldest first; `addOrder POST /orders` → `StandingOrder` (201); `cancelOrder DELETE /orders/:id` → 204. Client: `listOrders()`, `addOrder(text)`, `cancelOrder(id)`.
- Produces (store): migration adding `standing_orders (id TEXT PRIMARY KEY, text TEXT NOT NULL, active INTEGER NOT NULL, created_at INTEGER NOT NULL)` and `messages.order_id TEXT`; `insertOrder(text): StandingOrder`, `listActiveOrders(): StandingOrder[]`, `cancelOrder(id): StandingOrder | undefined`.
- Produces (`orders.ts`): `buildOrderPrompt(question: string, options: string[] | undefined, orders: StandingOrder[]): string`; `parseOrderReply(text: string, orders: StandingOrder[], options: string[] | undefined): { orderId: string; answer: string } | undefined`; `createOrderMatcher(o: { runner?: ClaudeRunner; env?: NodeJS.ProcessEnv; cwd?: string; settingsPath?: string; timeoutMs?: number /* 20_000 */ }): OrderMatcher` where `type OrderMatcher = (question: string, options: string[] | undefined, orders: StandingOrder[]) => Promise<{ orderId: string; answer: string } | undefined>`.
- Produces: `ApiDeps.matchOrder?: (input: NewAskInput) => Promise<{ orderId: string; answer: string } | undefined>`; `Asks.create(input, auto?: { orderId: string; answer: string })`.
- Produces (IPC): `listOrders()`, `addOrder(text)`, `cancelOrder(id)` on `ClippyBackend`.
- Produces (brain-only MCP): `add_standing_order { text }`, `list_standing_orders {}`, `cancel_standing_order { id }`.

- [ ] **Step 1: Failing tests.** `orders.test.ts`: `parseOrderReply('{"order":"<id>","answer":"staging"}', …)` → match; `{"order":null}` → undefined; unknown id → undefined; garbage / prose around the JSON → still parsed if a JSON object is present, else undefined; with `options: ['yes','no']` an answer `"Yes"` → `"yes"` (option's own casing), `"maybe"` → undefined. Matcher with a fake runner: times out after `timeoutMs` → undefined and the run is killed; spawn error → undefined; runner args include `-p`, `--model haiku`, `--tools ''`, `--strict-mcp-config`, `--output-format json`. `asks.test.ts`: `create(input, auto)` stores state `done`, `answer`, `answeredVia: 'clippy'`, `orderId`, and `wait` resolves answered immediately. `api.test.ts`: `POST /asks` with a `matchOrder` returning a match → 201 with the answered ask; `matchOrder` rejecting or taking > 20 s (fake) → normal unanswered ask; no `matchOrder` → unchanged. Store test for the order CRUD and the migration on an existing v4 database.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** The matcher runs a one-shot `claude -p` (reuse `createSpawnRunner` / `ClaudeRunner` from `brain/runner.ts`), no `--resume`, no tools, `--settings <brain-settings.json>` (hooks off), env with `CLIPPY_BRAIN=1`, prompt = `buildOrderPrompt` asking for exactly `{"order": "<id>" | null, "answer": "<text>"}` and to match only when an order clearly covers the question. In `startServices`, `matchOrder` = no active orders → `undefined` without running anything; else `matcher(question, options, orders)` raced against 20 s. The API's `createAsk` awaits it and passes the match to `Asks.create`. Ask cards in History show "Answered by standing order: <text>" when `orderId` is set. Settings → new "Standing orders" section (`RulesSection`): list with × (cancel), an add field. Persona: when the user says something like "if/whenever an agent asks about X, say Y", save it with `add_standing_order` phrased "When an agent asks about X, answer: Y", and confirm.
- [ ] **Step 4: Run tests + typecheck, all pass.**
- [ ] **Step 5: Commit** "Add standing orders that answer agents' questions for the user".

### Task 6: Watch-and-nudge

**Files:**
- Create: `apps/desktop/src/main/watches.ts`, `apps/desktop/test/watches.test.ts`
- Modify: `packages/shared/src/schemas.ts`, `api.ts`, `client.ts`, `ipc.ts`; `store.ts` (migration + methods); `api.ts` (core); `startup.ts`; `backend.ts`; `registerIpc.ts`; `mockBackend.ts`; `RulesSection.tsx`; `apps/hook/src/hook.ts` + `apps/hook/test/hook.test.ts`; `apps/mcp/src/server.ts`; `brain.ts`; `persona.ts`

**Interfaces:**
- Produces (shared): `AgentEvent = z.enum(['agent-finished', 'agent-needs-permission'])`; `NewMessageInput.event?: AgentEvent`; `Message.event?: AgentEvent`; `WatchEvent = z.enum(['finished', 'any'])`; `Watch = { id, project?: string, event: WatchEvent, nudge: string, active: boolean, createdAt, firedAt?: Timestamp }`; `NewWatchInput = { project?: string (1..200), event?: WatchEvent (default 'finished'), nudge: string (1..500) }`.
- Produces (routes/client/IPC): `GET /watches` (active), `POST /watches`, `DELETE /watches/:id`; `listWatches()`, `addWatch(input)`, `cancelWatch(id)`.
- Produces (store): migration adding `watches (id TEXT PRIMARY KEY, project TEXT, event TEXT NOT NULL, nudge TEXT NOT NULL, active INTEGER NOT NULL, created_at INTEGER NOT NULL, fired_at INTEGER)` and `messages.event TEXT`.
- Produces (`watches.ts`): `matchWatches(watches: Watch[], m: Pick<Message, 'kind' | 'project' | 'event' | 'sender'>): Watch[]`; `class Watcher { constructor(o: { bus: Bus; store: Store; clock?: Clock }); start(): void; stop(): void }`.
- Produces (brain-only MCP): `watch_for { project?, event?, nudge }`, `list_watches {}`, `cancel_watch { id }`.

- [ ] **Step 1: Failing tests.** `watches.test.ts`: `matchWatches` — project `"Clippy"` matches message project `"professor-clippy"` (case-insensitive substring); no project matches any; `finished` matches only `event: 'agent-finished'`; `any` matches any note or ask from the project but not reminders or chat; messages from `sender: 'clippy'` never match. `Watcher`: a finished note (even one stored `done` by the away-only rule) fires the watch once: creates a note `{ sender: 'clippy', title: '⏰ Nudge', body: '<nudge>\n(<project> agent finished)' }`, sets the watch inactive with `firedAt`; a second finished note creates nothing. Hook test: Stop notes carry `event: 'agent-finished'`, permission notes `event: 'agent-needs-permission'`. API/store tests for the routes and migration.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** The Watcher listens to `message:new`. Start it in `startServices` with the other bus subscribers. Settings `RulesSection`: a "Waiting for" list (project, event, nudge, ×). Persona: "when X finishes / when I hear from X, remind me to Y" → `watch_for` (look up the project name with `recent_activity` if unsure), confirm in one sentence.
- [ ] **Step 4: Run tests + typecheck, all pass.**
- [ ] **Step 5: Commit** "Nudge the user when a watched agent finishes".

### Task 7: Morning brief

**Files:**
- Create: `apps/desktop/src/main/brief.ts`, `apps/desktop/test/brief.test.ts`
- Modify: `packages/shared/src/settings.ts`, `startup.ts`, `index.ts` (resume + shutdown), `SettingsTab.tsx`, settings tests

**Interfaces:**
- Produces: settings `briefEnabled: boolean` (default `true`), `briefTime: string` matching `/^([01]\d|2[0-3]):[0-5]\d$/` (default `'09:00'`), `briefWeekdaysOnly: boolean` (default `true`).
- Produces: `composeBrief(i: { now: number; reminders: Reminder[]; pendingAsks: Message[]; unread: Message[]; activity: Message[] }): { title: string; body: string }`; `class BriefScheduler { constructor(o: { store: Store; clock?: Clock; settings: () => Pick<Settings, 'briefEnabled' | 'briefTime' | 'briefWeekdaysOnly'> }); start(): void; stop(): void; onResume(): void; reschedule(): void }`.

- [ ] **Step 1: Failing tests** (`brief.test.ts`, FakeClock, fixed TZ via local Date math): `composeBrief` lists today's reminders as `• HH:MM <body>` sorted, omits tomorrow's; "Waiting on you: 2 questions (a, b)"; "Unread: 3 notes"; overnight activity grouped per project ("professor-clippy: agent finished 3×, 1 note"), excluding chat and `sender: 'clippy'`; with nothing at all the body is one line: `Clear day: no reminders, nothing waiting on you.`; title `☀️ Morning brief`. Scheduler: fires at 09:00 once and creates a note `{ sender: 'clippy', title, body }`; `start()` at 10:30 with no brief today → sends now; at 12:30 → none until tomorrow; second `start()`/`onResume()` the same day → no duplicate (kv `briefLastDate` = local `YYYY-MM-DD`); Saturday with weekdays-only → none; `briefEnabled: false` → none; `reschedule()` after a time change arms the new time. Activity window = since kv `briefLastAt`, else 16 h before now.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** One timer (cap at 1 h like the reminder scheduler, re-arm). Start in `startServices`; `reschedule()` on settings change; `onResume()` from `powerMonitor` resume; stop on quit. Settings: "Morning brief" toggle, time field, "Weekdays only" toggle.
- [ ] **Step 4: Run tests + typecheck, all pass.**
- [ ] **Step 5: Commit** "Add a morning brief note".

### Task 8: Wrap-up (controller)

- [ ] Append a "Tell Clippy — 2026-10-30" section to `DECISIONS.md` (the feature list and the calls made in this plan: hotkey default, haiku matcher with 20 s cap, brief defaults, phone-when-away default, quips migration).
- [ ] Bump `apps/desktop/package.json` version to `0.3.0`.
- [ ] `npm run typecheck`, `npm test`, `npm run build` all pass; commit.
