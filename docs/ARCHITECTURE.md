# Professor Clippy: architecture

## Workspace layout

npm workspaces monorepo (Node 24, npm 11, TypeScript strict, ESM, Vitest).

| Path | Package | What it is |
| --- | --- | --- |
| `packages/shared` | `@clippy/shared` | Every shared contract: zod schemas and types, settings, local API routes, data-dir paths, `ClippyClient`, Electron IPC contract, Worker relay protocol. TypeScript source only (no build step). |
| `apps/desktop` | `@clippy/desktop` | Electron + electron-vite + React. Hosts the local API (127.0.0.1), SQLite store, scheduler and Clippy's brain. The character (`src/renderer/src/clippy/`) is a set of painted robot sprites driven by a pure mood state machine (`mood.ts`): `poses.ts` maps moods to sprites and aligns them on one stage, CSS does the motion, and clicks pass through his transparent pixels (alpha masks built when the sprites are preloaded). |
| `apps/mcp` | `@clippy/mcp` | stdio MCP server; forwards agent tool calls to the desktop app through `ClippyClient`. Built by Vite into one `dist/index.js`. Twelve extra tools (`list_notes`, `recent_activity`, `snooze_note`, `dismiss_note`, `set_look`, `add_standing_order`, `list_standing_orders`, `cancel_standing_order`, `watch_for`, `list_watches`, `cancel_watch`, `archive_page`) are registered only when `CLIPPY_SENDER` is `BRAIN_SENDER` (`clippy-brain`, from `@clippy/shared`), so only Clippy's brain sees them. Three more (`list_open_apps`, `restart_app`, `restart_computer`) need env `CLIPPY_POWER_TOOLS=1`, also set only for the brain (see "Restarting apps and the PC"). |
| `apps/hook` | `@clippy/hook` | Claude Code hook; posts a note when an agent finishes or needs permission, and (away, opt-in) turns a `PermissionRequest` into a phone approval. Built like `apps/mcp`. |
| `apps/worker` | `@clippy/worker` | Cloudflare Worker plus one SQLite-backed Durable Object (`ClippyDO`, binding `CLIPPY`) relaying WhatsApp Cloud API traffic. |
| `scripts/` | | Repo scripts: the Claude Code wiring (`install-claude-wiring.ts`, also bundled into the app for "Connect Claude Code"), SQLite smoke test, run-in-Electron helper. |

Root scripts: `npm test`, `npm run typecheck`, `npm run build` (each runs in every workspace), `npm run dev` (desktop app), `npm run package` (build, then the NSIS installer from `apps/desktop/electron-builder.yml` into `apps/desktop/release/`; the built MCP server and hook ship as `resources/mcp` and `resources/hook`).

`@clippy/shared` is consumed as TypeScript source. Vite (desktop, mcp, hook), wrangler (worker) and Vitest bundle or transform it; it is never `require`d from `node_modules` at runtime. Its root entry is Node-only. Renderer, preload and Worker code import the Node-free subpaths (`@clippy/shared/schemas`, `/settings`, `/theme`, `/brain`, `/api`, `/ipc`, `/relay`).

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

## Phone only when away

Nothing mirrors to the phone on `message:new`. `PhoneGate` (`main/phoneGate.ts`) watches
`message:new` for notes, asks and fired reminders that are not already `done`, and emits
`message:mirror`, which the relay (notes and asks) and Telegram (also reminders) subscribe to
instead. Away (or the `phoneWhen` setting is `always`): at once. At the PC: the id is held, and a
`tickMs` (30 s) timer re-reads held messages from the store; once the user is away the ones still
unread are mirrored, once. Dismissed or answered ones are dropped, a
snoozed one stays held until it wakes. Each held id records when it started waiting (when held; reset when it wakes from a snooze).
Going away flushes only notes and reminders that have waited at most `FLUSH_MAX_AGE_MS` (60 min); older ones are
dropped from the hold and stay on the desk. A held ask still unanswered `askEscalateMs()` after it started
waiting goes anyway on the next tick, even at the PC; `startServices` wires it to half of `askTimeoutDefaultS`
(5 min by default, read each tick so a settings change applies), so a question escalates before `ask_user` gives up.
Notes and reminders never escalate. `isUserAway` is built in `startServices`: idle time at or
over `awayThresholdS` (0 = always away); without an idle source, always away. Telegram's startup
replay of missed reminders skips the gate, and WhatsApp reminders still come from the Worker.
`test/phoneGate.test.ts` covers the rules; relay/Telegram tests use `test/alwaysMirror.ts`.

## Tell Clippy

`TellBox` (renderer, `note/TellBox.tsx`) sends through the same `useChat` as the Clippy tab, so
both share one brain session; its reply is the first Clippy chat line created after the send
(`tellReply`). The global hotkey is the `tellHotkey` setting (an Electron accelerator, `''` =
off): `registerTellHotkey` (`main/window/hotkey.ts`) wraps `globalShortcut` and turns a malformed
or taken accelerator into `ok: false` plus a message, which `ClippyBackend.hotkeyStatus` hands to
Settings. `main/index.ts` re-registers it when the setting changes. On press, main shows and
focuses the window (the only place Clippy takes focus; he is otherwise `showInactive`), expands
it and sends `window:tell`; the renderer switches to Notes and focuses the box. `window:blur`
gives focus back on Escape. Auto-collapse is held off while the box has focus or text.

## Standing orders

A standing order (`StandingOrder`, table `standing_orders`, schema version 5; routes `GET/POST
/orders`, `DELETE /orders/:id`; IPC `listOrders` / `addOrder` / `cancelOrder`) is a sentence the user
gave Clippy ("When an agent asks about X, answer: Y"), saved by the brain's `add_standing_order` tool
or typed into Settings → Standing orders & watches (`RulesSection`). `POST /asks` awaits `ApiDeps.matchOrder` before storing the
ask; a match goes to `Asks.create(input, { orderId, answer })`, which stores the ask already
`done`, `answeredVia: 'clippy'` with `Message.orderId` (column `order_id`), so it never pops up,
isn't mirrored to a phone (both channels skip answered asks) and the agent's long-poll answers
at once. No match, a rejection, or more than 20 s (`MATCH_ORDER_TIMEOUT_MS`) posts a normal ask.
`startServices` builds the matcher (`main/orders.ts`) with the brain's runner, folder and
hooks-off `brain-settings.json`, and gives `startCore` a closure that reads the active orders from
the core once it exists (no orders: nothing is run). The matcher is one `claude -p --model haiku
--tools ''` run (no MCP, no session, `--output-format json`); `parseOrderReply` trusts only a known
order id, and with options only an answer that is one of them (the option's own casing). The empty
`--tools ''` argument survives both spawn paths (an args array, and `cmdQuote` -> `""` for
`claude.cmd`).

## Watches

A watch (`Watch`, table `watches`, schema version 6; routes `GET/POST /watches`, `DELETE
/watches/:id`; IPC `listWatches` / `addWatch` / `cancelWatch`) is "when this agent finishes, remind
me to Y": an optional project (matched as a case-insensitive substring of a message's `project`),
an event (`finished` or `any`) and a nudge. The brain sets one with `watch_for`; Settings →
Standing orders & watches (`RulesSection`, "Waiting for") lists and cancels them. The hook now tags its notes with
`Message.event` (`agent-finished` for Stop, `agent-needs-permission` for Notification; column
`messages.event`), which is what `finished` waits for; `any` takes any note or question from the
project, never a reminder or chat line. `Watcher` (`main/watches.ts`, started in `startServices`
beside the phone gate, stopped on quit) listens to `message:new`, so a finished note stored `done`
by the away-only rule still counts. `matchWatches` picks the watches a message triggers (never one
from `sender: 'clippy'`, so a nudge cannot set off another watch); each is claimed with
`Store.fireWatch` (active -> inactive, `firedAt`; it can only fire once) and answered with a note
`{ sender: 'clippy', title: '⏰ Nudge', body: '<nudge>\n(<project> agent finished)' }`
(the fire and the note are stored in one transaction, so the watch is only spent if the nudge is).
That note is loud on the desk (alert level) and is mirrored to the phone by the phone gate like any
other note. Clippy's brain (`BRAIN_SENDER`) and `clippy` notes never trigger a watch.

## Morning brief

Once a day (settings `briefEnabled`, `briefTime` `HH:MM` local, default 09:00, `briefWeekdaysOnly`)
`BriefScheduler` (`main/brief.ts`, started at the end of `startServices`, `reschedule()` on a brief
settings change, `onResume()` from the power monitor's resume, stopped on quit) creates a note
`{ sender: 'clippy', title: '☀️ Morning brief' }`, loud on the desk and sent to the phone by the
phone gate when away like any Clippy note. The pure `composeBrief` writes the body: today's
reminders (`• HH:MM body`), "Waiting on you" (pending asks), "Unread" (notes) and "Overnight" (notes
and questions since the last brief, or the last 16 h, grouped by project; the hook's
`agent-finished` notes count as "agent finished N×" even when stored `done`; chat, `clippy` and
`clippy-brain` messages never count). With nothing to say it is one "Clear day" line. One timer,
capped at an hour and re-armed (like the reminder scheduler); kv `briefLastDate` (local date) means
at most one brief a day, `briefLastAt` starts the next overnight window. A start or wake sends a
missed brief if it is due today, not yet sent, and now is before 12:00 local or within 2 h after
the brief time (so a late brief time still works); otherwise the day is skipped. `reschedule()`
(a settings change) only re-arms the timer for the new time and never sends on the spot; if today's
brief is unsent and still inside the catch-up window, the next timer tick (at most an hour away) or a
wake from sleep may send it. "Waiting on you" counts only asks that are unanswered and not done
(one dismissed on the desk is not waiting). Unread notes from `clippy` / `clippy-brain` are not counted
either, so yesterday's unread brief cannot stop a "Clear day" line.

## Restarting apps and the PC

Opt-in (setting `allowPowerActions`, default off), requested by the brain, confirmed by the user.
`PowerActions` (`main/power/actions.ts`) is created in `startCore` next to `Asks` (as
`core.power`) and serves `POST /power/restart-app` `{name, reason?}`, `POST /power/restart-pc`
`{reason?}` and `GET /power/apps` (`ClippyClient.restartApp` / `restartPc` / `listOpenApps`). With
the setting off each is a `ForbiddenError` (403). A request never runs anything: it posts an urgent
ask from `Professor Clippy` with options Restart / Cancel and answers 202 `{ id, status:
'awaiting-confirmation', question }` at once (brain turns are queued, so nothing may wait for the
user). On `ask:answered` for one of its asks: Restart (or yes / y / ok, trimmed, any case) runs it,
anything else cancels, a request over 10 minutes old only leaves an "expired" note, and an answer
`via: 'clippy'` is ignored. Every outcome is a `🔁 Restart` note from `clippy`.

Only the user confirms. An `Asks` guard (`Asks.guard`) refuses `via: 'clippy'` for an open
confirmation (`ForbiddenError`, "Only you can confirm a restart: …"), so the brain's
`answer_pending` gets a 403; `POST /asks/:id/answer` also refuses any answer to one, whatever `via`
it claims, since the user's own taps all arrive in-process (desk IPC, Telegram, WhatsApp). Pending
requests are kept in kv `powerRequests`; each has an expiry timer, and `startServices` calls
`core.power.expireLeftovers()` once Telegram is subscribed, which answers the leftovers "Expired"
(after forgetting them, so nothing runs) and so updates the desk note and the phone copies.

The machine side is a `PowerExecutor` (`main/power/executor.ts`), injected so tests use an
in-memory fake (`test/power/fakeExecutor.ts`); `startCore`'s default refuses everything, and
`main/index.ts` passes `createWindowsExecutor()`. It runs `%SystemRoot%` PowerShell with
`-NoProfile -NonInteractive -EncodedCommand` (constant scripts; the exe name, validated against
`^[\w .()+-]{1,100}$`, goes in env `CLIPPY_POWER_TARGET`) for `Get-Process` (windowed apps) and
`Get-CimInstance Win32_Process` (pid, parent pid, path, command line, file description), and
`shutdown.exe /r /t 60 /c …` / `/a` via `execFile`. `power/apps.ts` restarts an app: it refuses
Windows' critical processes, Clippy's own tree and a process without an `ExecutablePath` (elevated
or system), terminates every match with `process.kill`, waits 1.5 s, and unless new instances
appeared by themselves (Explorer) relaunches the root instance (whose parent is not a match) with
`spawn` (detached, `stdio: 'ignore'`, `windowsVerbatimArguments`, `argv0` = the quoted path, the
rest of its command line verbatim, no `ELECTRON_*` / `CLIPPY_*` variables). A confirmed PC restart
posts a second ask, "Restarting your PC in 60 seconds." with option Cancel restart; answering it
from anywhere (Clippy included) runs `shutdown /a`.

The MCP server registers `list_open_apps`, `restart_app` and `restart_computer` only when env
`CLIPPY_POWER_TOOLS` is `1`, which `buildMcpConfig` sets for the brain alone; they are in
`BRAIN_CLIPPY_TOOLS`. The brain still has no Bash or PowerShell.

## Phone approvals

Opt-in (setting `phoneApprovals`, default off, and `hookEnabled`), only while the user is away,
answered only by the user. The installer adds a `PermissionRequest` hook entry (`matcher: "*"`,
the usual Clippy command, `"timeout": 1800`). On that event the hook (`apps/hook/src/permission.ts`)
posts `POST /approvals` `{ sessionId, cwd, project, tool, input, sender }`
(`ClippyClient.requestApproval`). `Approvals` (`main/approvals/approvals.ts`, created in `startCore`
as `core.approvals`) answers `{status: 'off'}` (setting or hook off), `{status: 'at-desk'}`
(`isUserActive`, the same idle check as away-only notes) or `{status: 'waiting', id}` after
`Asks.create` of an urgent ask from the agent's sender and project, options Allow / Deny,
`event: 'agent-permission-request'`, and a body from the pure `approvalQuestion`
(`approvals/question.ts`: a "🔐 <project> wants permission" line, then "Run: <command>", "Edit
<file>", "Use <tool> (<server>)" plus compact JSON, ...; each part cut at 700 characters). Only
the app sets that `event`: `NewAskInput` has no `event` and `NewMessageInput.event` is `NoteEvent`,
which excludes it.

The hook long-polls the ask (`ClippyClient.waitAsk`) for up to `APPROVAL_WAIT_S` (1740 s), then
withdraws it (`POST /approvals/:id/withdraw`) and makes no decision. The pure `decisionFor` maps
the answer: Allow / allow / yes / y / ok / approve (trimmed, any case) → `allow`; Deny / no →
`deny` "The user denied this from their phone."; Expired / Withdrawn / Dismissed, or any answer
`via: 'clippy'` → no decision; any other text → `deny` "The user replied from their phone instead
of allowing it: <text>". No decision (exit 0, no stdout) is also what the app not running, any
error, `off`, `at-desk` and `AskUserQuestion` give; Claude Code then shows its own prompt. The CLI
wrapper's last-resort exit is re-armed for `PermissionRequest` to 1785 s.

Only the user answers. An `Asks` guard refuses `via: 'clippy'` for an open approval (403, "Only you
can approve an agent's permission request: …"), and `POST /asks/:id/answer` refuses every answer to
one (`Approvals.isOpen`), whatever `via` it claims. Standing orders never see one: approvals are
created in-process, not through `POST /asks`, where `matchOrder` runs. `matchWatches` ignores
approval asks. `PhoneGate` mirrors one at once even if the user's idle time has since dropped under
the threshold (it was only posted because they were away, and its agent is blocked); on the desk
it is loud like any question. Telegram shows the heading in bold and the rest in `<pre>`.

Clippy closes an approval itself, answering via `clippy` after first forgetting it (so its own
guard lets that through): "Withdrawn" (the hook gave up), "Expired" after `APPROVAL_TTL_MS` (the
wait plus 60 s) or for leftovers from before a restart (open approvals are kept in kv
`approvalRequests`; `startServices` calls `core.approvals.expireLeftovers()` after the power ones),
and "Dismissed" when the desk note is dismissed (state `done` with no answer). Each edits the
Telegram copy like any answered ask.

## Colour themes

Seven themes (`THEMES` in `@clippy/shared/theme`: classic, mint, blush, sky, peach, and the dark night
and chalkboard). The settings `theme`, `followSystemDark` (default off) and `darkTheme` (default
night) choose one; `resolveTheme(settings, systemDark)` says which one is painted. Colours live
only in `renderer/src/styles/theme.css`, one `:root[data-theme="<id>"]` block per theme defining
the same tokens (`--paper-1`, `--ink`, `--card`, `--btn`, `--bubble`, ...; `classic` is also the
`:root` default and reproduces the original yellow exactly), and every other stylesheet uses
`var(--token)`, with `color-mix(in srgb, var(--ink) N%, transparent)` for see-through shades.
`test/renderer/theme.test.ts` checks every theme defines every token. Left as literal colours on
purpose: Clippy's own artwork and shadows, drop shadows, the white on the red badges, the switch
knob while off (on, it takes `--btn-ink`), the dark wiring-log panel, the "Clippy is missing"
screen and the dev gallery. Settings → Look picks the three settings with paper chips
(`ThemeSwatches`, `note/settings/LookSection.tsx`), saved and painted at once.

`hooks/useTheme.ts` sets `data-theme` and `data-dark` on `<html>` (`themeAttrs`, `theme.ts`). Under
`data-dark="true"` Clippy's sprite gets a rim light, and native controls turn dark. Windows' mode
comes from the `systemDark()` IPC method (`nativeTheme.shouldUseDarkColors`) and the `theme:system`
event: `forwardSystemTheme` (`main/window/systemTheme.ts`) listens to `nativeTheme` `updated` once
and sends it to every `BrowserWindow`. `POST /look` (`Routes.setLook`, body `LookPatch`, only the
three theme keys, at least one) saves through `ApiDeps.setLook`, which `startServices` backs with
`SettingsStore.update`; `ClippyClient.setLook` and the brain-only MCP tool `set_look` use it, so
"go dark" works. The renderer re-reads the settings when the brain finishes a turn
(`brain:state` idle), since that is when `set_look` may have changed them, and on
`settings:changed`, which main sends to every window whenever the settings change.

## Settings

The note's tabs are Notes · Pad · Clippy · ⚙ Settings. Settings (`note/SettingsTab.tsx`) opens on
`settings/SettingsMenu.tsx`: History, then the sections grouped How I behave (`alerts`, `phone`,
`brief`), Agents (`claude`, `rules`) and This PC (`look`, `pc`), one component each in
`note/settings/`. Each row's one-line summary is `sectionSummary(section, ctx)` (`summaries.ts`,
pure and tested) over the settings plus what the menu reads when it opens: Telegram's status, the
order, watch and History counts (the same `listMessages({state: 'done'})` History shows, chat left
out; over 50 reads "50+", as History lists the latest 50) and the hotkey status. No IPC was added.
The open section lives in `App` (`settingsSection`), so `openSettings(section?)` can deep-link
from anywhere: the empty Notes tab's "History ›" opens `history`, which is the old History tab
(`HistoryTab`). The ⚙ tab itself always opens on the menu. Each section keeps its own input state
and commit helpers (ask wait, away time, hotkey, relay fields). In the Phone section, Telegram and
the WhatsApp relay are rows that unfold their setup in place. "Run the welcome again" (Windows &
hotkeys) calls `restartWelcome` (below), which brings back the welcome; the version shown
there is `apps/desktop/package.json`'s, imported at build time. Preview: `?mock=1&tab=settings&section=look`
(`tab=history` still works, as Settings → History; `&telegram=1` pairs the mock's Telegram).

## Welcome, Getting started and tips

**The welcome** (`note/FirstRunWizard.tsx`, shown while `firstRunDone` is false; steps in
`note/firstRun.ts`: `claude`, `look`, `phone`, `tour`). Every step can be skipped. Connect Claude
Code is the existing `ConnectClaude` (with "Later" / "Next" in its row); How should I look? reuses
Settings' `ThemeSwatches` and `ToggleSetting` (saved and painted at once); Want me on your phone?
unfolds `TelegramSetup` or the Phone section's `RelayFields`. Try it renders `demoQuestion`
(`note/welcome/tour.ts`) with the real `AskCard`; the answer only changes that local copy and ticks
`answer` through `markOnboarding`: it is never stored, mirrored or sent to an agent. Finish saves
`firstRunDone: true` and opens the Pad. An install that already had `firstRunDone` never sees it.

**Getting started.** `Onboarding` (`main/onboarding.ts`, started in `startServices` after the
watcher and before the morning brief, stopped on quit) keeps kv `onboarding` = `OnboardingState`
(`@clippy/shared/schemas`: `startedAt`, `done: ChecklistItem[]`, `dismissed`, `tipsShown: TipId[]`,
`lastTipAt`). Its first start sets `startedAt`, for new and existing installs alike. Items tick from
the bus: `ask:answered` not `via: 'clippy'` → `answer`; `message:updated` to `snoozed` → `snooze`;
`order:added` (now emitted by `Store.insertOrder`, so Settings and the brain both count) → `order`;
`page:changed` with `popped` → `popout`; a new morning brief note (`isBriefNote`) → `brief`. The
backend ticks `connect` when `connectClaude('install')` succeeds, and `main/index.ts` at start when
`claudeHooksInstalled()` finds the hook's `--professor-clippy` marker in Claude Code's
`settings.json`. The renderer ticks `hotkey` on any Tell box send. IPC: `onboarding`,
`markOnboarding`, `dismissChecklist`, `markTipShown`, `restartWelcome` (the list back, ticks kept,
then `firstRunDone: false`); every change is `onboarding:changed` to the note. The Pad
(`PadTab`) shows a "Getting started 📎 N/7" row above the pages while `showChecklist` (not
dismissed, not all done); it opens `note/welcome/GettingStarted.tsx`, the seven items on lined
paper, ticked ones struck through, the rest with a one-line `howTo` and, where Settings has it, a
"Show me ›" into that section.

**Tips** (`note/welcome/tips.ts`, pure). `nextTip({ now, state, showTips, event })` gives a tip only
with `showTips` on, before `startedAt` + 14 days, an hour after `lastTipAt`, and once each:
`quiet-history` (an `agent-finished` note arrives already `done`), `standing-order` (exactly the
third question the user answered today, `answeredToday`, with no standing orders), `pin-out` (the
user's own pages go to two or more, unless a page was pinned out already) and `pad-jot` (a Tell box
line that is not about the Pad, `aboutPage`). `hooks/useTips.ts` feeds it from `message:new`,
`message:updated` and App (pages made, Tell box sends) and shows the tip in the speech bubble for
12 s (`TIP_SHOW_MS`) only on the open note with no quip up and not in the welcome; otherwise it is
not recorded, so a later moment can say it. A quip that arrives replaces a tip. Shown tips go back
through `markTipShown`. Preview: `?mock=1&firstrun=1`, and `&done=connect,answer` to tick items.

## Pages (the Pad)

A page (`Page`, table `pages`, schema version 7, index `pages_list` on `(archived_at, pinned,
updated_at)`; `pop_bounds` is JSON) is a note the user keeps: title (1–120), body (at most
100 000 characters), colour (`PageColor` or `null` = the theme's paper), pinned, popped (open as its
own window, with `popBounds`), author, project, unseen, and created / updated / archived times.
`Pages` (`core/pages.ts`, created in `startCore` as `core.pages`) holds the rules; the store only
stores. Every change emits `page:changed` (the page) and a delete `page:deleted` (`{ id }`), which
`main/index.ts` sends to every `BrowserWindow`.

- **Authors.** The user writes as `'you'` (`PAGE_USER_AUTHOR`), only through IPC. The routes take
  the body's `sender`, and refuse `you` in any case or spacing (400, `PageSender`), so no caller of
  the local API gets the user's powers. The user and the brain (`BRAIN_SENDER`) may change any page;
  any other sender only pages whose `author` is itself, else `ForbiddenError` (403) "Only the person
  who wrote this page (or you) can change it." That covers `archivePage` too.
- **Conflicts.** `write(id, change, author)` with a `baseUpdatedAt` that is not the stored
  `updatedAt` throws `ConflictError` with `details.page` = the page as it is now, and changes
  nothing. The API answers 409 `{ error, page }` (the error handler spreads a `ConflictError`'s
  `details` into the body); IPC `writePage` resolves to `{ ok: false, conflict }` instead of
  rejecting, so the editor can keep the user's text and offer both versions. `updatedAt` strictly
  increases (`max(now, previous + 1)`), so two writes in one millisecond still conflict. A change
  that alters nothing is not stored and emits nothing.
- **Unseen.** A page created or changed by anyone but the user is `unseen` until `markSeen` (the
  user opening it); the user's own change clears it. `markSeen` and `setPopped` leave `updatedAt`
  alone.
- **Append** adds a newline first unless the body is empty or already ends in one
  (`appendToBody`). **Finding by title** (`findPageByTitle`, shared so the MCP server matches the
  same way): an exact title in any case (the most recently changed of several), else the only title
  that starts with it; archived pages are not searched. **Search** (`q`) is `LIKE` over title and
  body with `%`, `_` and `\` escaped.
- **Archive.** `archive` also un-pops the page, and `setPopped(id, true)` on an archived page is
  refused (`ConflictError`, "Restore the page before pinning it out."), so it never opens a window; `restore` counts as a change (`updatedAt` = now) so
  the page is not archived again at once; `remove` takes only archived pages (IPC only, no route).
  `startStaleArchiver` (`startServices`, at start and every 6 h; `Services.pageArchiver`, stopped on
  quit) archives pages that are not pinned, popped or archived and unchanged for
  `PAGE_ARCHIVE_AFTER_MS` (30 days).

Routes: `GET /pages?q=&archived=true|false`, `GET /pages/:id`, `POST /pages` (`NewPageBody`), `POST
/pages/:id` (`PageChangeBody`: title, body or append, colour, pinned, baseUpdatedAt; nothing else),
`POST /pages/:id/archive` (`{ sender }`), with `ClippyClient` methods of the same names. IPC (as the
user): `listPages`, `getPage`, `createPage`, `writePage`, `markPageSeen`, `archivePage`,
`restorePage`, `deletePage`, `popPage(id, popped)` (`setPopped`; the page windows follow, below).
MCP, for every agent: `write_page` (`title`, `text`, `mode` new / append (default) / replace,
`page_id`; append and replace write `page_id` or the page the title finds and create one if there
is none; an agent's title only finds pages whose `author` is its sender, the brain's any page),
`read_page` (`page_id` or `title`), `list_pages` (`query`; id, title, first line, author,
time; at most 50); brain-only: `archive_page`. The persona maps "jot down" to `write_page` new, "add
X to my Y page" to append, "what did I write about" to `list_pages` + `read_page`, and never
replaces a page the user wrote unless told to. The CLAUDE.md hint tells agents to leave a page to
keep (a checklist, a summary) instead of a note; installing over an older hint replaces it in place
(`LEGACY_CLAUDE_MD_HINTS`), and uninstall removes either. The browser preview keeps pages in memory
(`mockBackend.pushPage` simulates Clippy writing one).

**The Pad tab** (renderer, `note/PadTab.tsx`). `usePages` (in `App`, for the tab's "new" dot) loads
the Pad's and the archived pages and keeps them live from `page:changed` / `page:deleted`
(`applyPage` / `removePage` in `note/padList.ts`, with `padSections`, search and the row text:
"📎 Clippy" / "🤖 sender · project" badges, "made by ..." / "edited ..."). `note/PageEditor.tsx` is one
page, self-contained (props: the page, the api, callbacks) so a page window can reuse it. Its text
goes through `createSaveController` (`note/pageSave.ts`, pure, injectable timer): saves wait 400 ms
after the last keystroke but at most 2 s after the first unsaved one (`SAVE_MAX_WAIT_MS`, so steady
typing saves too), `flush()` saves at once (blur, unmount on page / tab switch or collapse,
`beforeunload`), and every save sends `baseUpdatedAt`. A refusal whose page has the same text as the
editor last saved (only the title, colour or pin moved) is retried on the new base; otherwise the
state is `conflict`: the typed text stays, nothing saves, and the banner's Keep mine saves it on top
of theirs, Use theirs takes theirs. Leaving in `conflict` (unmount, or `beforeunload` on quit or
window close, where React does not unmount) keeps the typed text as a new page "<title> (your
version)", once per text (`leave(onCopy)`), so a quit and the unmount after it make one copy; so
does a last save that `leave` starts and that comes back refused after the editor has gone. Someone else's change while nothing is unsaved shows at once. Title,
colour and pin are separate `writePage` calls without a base, after a `flush()`. Opening a page (or
a change arriving while it is open) calls `markPageSeen`. While a page has focus or a conflict,
auto-collapse waits (`onActive`, the Tell box's rule). A page's own colour is `data-page-color` on
its paper: `theme.css` gives `[data-page-color="<id>"]` the tokens of that light theme (yellow is
classic), so it keeps light paper and ink inside a dark theme. The mock starts with sample pages
(`samplePages`: Scratch pinned, Call Dave by Clippy not opened yet, an agent's Deploy steps, one
archived).

**Pages popped out on the desktop** (`main/window/pageWindows.ts`, `createPageWindows` in
`index.ts`). The windows follow the store: `page:changed` with `popped` and not archived opens one
(if none is open), anything else (un-popped, archived) or `page:deleted` closes it, so "📌 Pin out"
(which turns into "Un-pin"), the window's "×" and archiving only change the page. `restoreAll()`
runs after the Clippy window is made and opens every popped page. Each is a frameless, transparent
`BrowserWindow`, not always-on-top, `skipTaskbar`, min 180 × 120, loading the renderer with
`?page=<id>` (`loadRenderer`, shared with `createClippyWindow`). Where it opens: `popBounds` through
`clampBounds` (`main/window/pageBounds.ts`, pure: displays primary first; a window at least 80 %
visible stays put, taking the id of the display it overlaps most if its own is gone; one less
visible is pulled in on its own display, or onto the primary work area if that display is gone,
the size kept unless bigger than the work area), else `defaultPageBounds(index, workArea)`
(260 × 220, cascading 24 px down and left from the top-right). `move` / `resize` save `popBounds`
(`setPopped(id, true, bounds)`) 500 ms after the last one. Closing a window any other way (Alt+F4)
un-pops it like "×"; while the app quits (`before-quit`) or Windows ends the session
(`session-end`), windows close but stay popped. Windows gives a transparent window no resizable
border, so the renderer's corner grip sends `pageWindow:resizeStart/Move/End` and main follows the
cursor; "—" sends `pageWindow:collapse` and main shrinks the window to the 30 px header (Windows
keeps it at its smallest, 39 px; the rest is see-through), saving the full height meanwhile. Those
channels act only for the page window that sent them (`window.clippyPageWindow` in the preload).
`registerIpc(backend, win, { allowSender })` accepts backend calls from the Clippy window and from
any page window (`pageWindows.owns`, a `WeakSet` of their web contents, so the last save on
`beforeunload` still lands while one closes); any other sender is refused. `index.ts` passes
`disposeOnClose: false`, so the handlers outlive the Clippy window (on quit all windows close at
once) and are removed in `will-quit` only after `core.stop()`. `page:changed`,
`page:deleted`, `theme:system` and `settings:changed` (every settings change, without the
encrypted Telegram token) go to every window; the rest only to the Clippy window.

The renderer picks the view in `main.tsx`: `?page=<id>` is `views/PageWindow.tsx`, a sticky in the
page's colour (or the theme's paper) with a drag header (`-webkit-app-region: drag`: title, "—",
"×") over `PageEditor` with `compact` (no title field, only the save state below the text; colour,
keep at top and archive stay in the Pad), the same save controller, kept mounted while collapsed.
It runs `useSettings` + `useTheme` like `App`, and `useSettings` also listens to `settings:changed`,
so a theme picked in the note reaches every page at once. In the browser preview
`?mock=1&page=Scratch` shows one (the mock's sample ids change every load, so there `page` may be
a title).

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
