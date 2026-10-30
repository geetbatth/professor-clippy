<img src="apps/desktop/build/icon.png" width="96" height="96" alt="Professor Clippy">

# Professor Clippy

A Windows desktop sticky note with a paperclip professor on it. Your AI agents (Claude Code and
any other MCP client on this PC) leave him notes, reminders and questions; he pops up, wiggles,
and waits until you deal with them. Every note and question is mirrored to your WhatsApp, and
you can answer, or just chat with him, from your phone.

<img src="docs/screenshots/expanded-notes.png" width="300" alt="The sticky note with agent messages"> <img src="docs/screenshots/first-run.png" width="300" alt="The first-run wizard">

- **Agents talk to Clippy through an MCP server** (`clippy`): `leave_message`, `remind_me`
  (ISO time, optional RRULE), `ask_user` (blocks until you answer, 10 minutes by default),
  `check_reply`, `list_reminders`, `cancel_reminder`, `list_pending_asks`, `answer_pending`.
- **A Claude Code hook** leaves a note when an agent finishes or needs your permission.
- **Clippy's own chat brain** is Claude Code running headless with your Claude Code login (no
  API key). It can read files and search the web, manage your messages and reminders, and
  answer agents' questions for you; it cannot edit files or run commands. Of the `clippy` tools
  it gets all but `ask_user` and `check_reply` (a brain turn waiting for your answer would hold
  up every chat turn behind it), so when it needs something from you it simply asks in its reply.
- **WhatsApp** goes through Meta's WhatsApp Cloud API and a small Cloudflare Worker you deploy
  yourself. Nothing on your PC listens on the network: the app's local API binds to 127.0.0.1
  with a bearer token, and the PC connects out to the Worker.
- Messages from agents are shown verbatim, with the sender and project. Dismissed messages go to
  a searchable history (SQLite).

Design decisions are in [DECISIONS.md](DECISIONS.md); the architecture is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Setting it up for real?** Follow [docs/USER-TODO.md](docs/USER-TODO.md), the short checklist
of everything you do by hand (Meta, Cloudflare, install, Claude Code).

## Requirements

- Windows 11.
- **Node.js 24 or later on PATH**, also on the machine you install on: Claude Code starts the
  Clippy MCP server and the hook with `node`. (npm 11 for building.)
- **Claude Code**, installed and signed in (`claude` once). It is Clippy's brain and where the
  MCP server and hook get registered.
- For WhatsApp only: a Meta developer account and a free Cloudflare account.

## Build and install

```powershell
npm ci
npm run package
```

`npm run package` builds every workspace, then runs electron-builder and writes the installer to
**`apps/desktop/release/Professor-Clippy-Setup-<version>.exe`** (about 120 MB, mostly Electron).
`apps/desktop/release/win-unpacked/` is the same app, unpacked.

- It is a per-user NSIS installer: no admin prompt. It installs to
  `%LOCALAPPDATA%\Programs\professor-clippy\` (the MCP server looks for
  `Professor Clippy.exe` there, to start the app if it isn't running), adds Start menu and
  desktop shortcuts, and starts the app when done.
- **The installer is not code-signed.** Windows SmartScreen will say "Windows protected your
  PC": click **More info → Run anyway**. (To sign, set `CSC_LINK` / `CSC_KEY_PASSWORD` for
  electron-builder before packaging.)
- The built MCP server and hook ship inside the app, in `resources\mcp\index.js` and
  `resources\hook\index.js`; "Connect Claude Code" registers those installed paths.
- On first start the note opens on a **first-run wizard**:
  1. WhatsApp: paste your Worker URL and relay secret, or **Skip WhatsApp for now**.
  2. Sounds, unsolicited advice and start with Windows.
  3. **Connect Claude Code**: shows exactly what would change (a dry run) and installs only when
     you click **Looks good, install**. You can skip this and do it later from Settings.
- Uninstall from Windows Settings → Apps. To clean Claude Code up too, run
  `node scripts/install-claude-wiring.ts uninstall` from a checkout first (see below; it finds
  the entries by name and marker, wherever they point). Your notes and settings in
  `%APPDATA%\professor-clippy\` are kept.

Electron-builder may download its NSIS and signing tools on the first run (into its cache); that
is normal. The app icon is `apps/desktop/build/icon.svg`, rasterised to `icon.png` (512 px) and
`icon.ico` (16–256 px) by
`node apps/desktop/scripts/launch-electron.mjs apps/desktop/scripts/make-icons.mjs`; rerun that
only after editing the SVG.

## Connecting Claude Code

The wiring does three things, all at user scope:

1. `claude mcp add --scope user clippy -- node <path>\mcp\index.js` (the CLI writes
   `~/.claude.json`; the wiring never edits that file itself).
2. Adds `Stop` and `Notification` hooks running `node "<path>\hook\index.js" --professor-clippy`
   to `~/.claude/settings.json`, keeping everything else (a timestamped backup is made first).
3. Appends a one-line hint to `~/.claude/CLAUDE.md` telling agents to use the Clippy tools.

From the app: the first-run wizard, or Settings → Claude Code → **Connect Claude Code…**. It
always shows the dry run first.

From a checkout (registers the repo's `apps/*/dist` builds instead; run `npm run build` first):

```powershell
node scripts/install-claude-wiring.ts install --dry-run   # show the plan, change nothing
node scripts/install-claude-wiring.ts install
node scripts/install-claude-wiring.ts uninstall           # reverses all three
```

Add `--home <dir>` to work on `<dir>\.claude` instead of your real config (for trying it out).
Start a new Claude Code session afterwards so it picks up the MCP server and the hint. The hook
can be switched off in Clippy's Settings without uninstalling it.

## WhatsApp (Meta + Cloudflare Worker)

The relay lives in [`apps/worker`](apps/worker). **Its [README](apps/worker/README.md) has the
full Meta setup, the `clippy_note` template, the secrets and the deploy steps**;
[docs/USER-TODO.md](docs/USER-TODO.md) is the ordered checklist. In short: create a Meta app with
the free test number, verify your phone, make a permanent system-user token, get the template
approved, `wrangler login`, set six secrets, `wrangler deploy`, point Meta's webhook at
`<worker>/webhook`, then give the app the Worker URL and `PC_SECRET`.

How it behaves once connected:

- Every agent note and question is sent to your WhatsApp. Within 24 h of your last WhatsApp
  message to Clippy it is plain text; otherwise it goes out as the approved `clippy_note`
  template (cut at 1000 characters, "…more on desktop").
- **Quote-reply** to a question to answer it. Any other message goes to Clippy's brain, which
  replies on WhatsApp (and can answer pending questions for you).
- Reminders are synced to the Worker, which sends them on time even when the PC is off; the
  desktop shows them later as "missed while you were away". Reminders that already exist when you
  connect WhatsApp (or fix a wrong secret, or switch to another Worker) are synced then; any the
  Worker hasn't confirmed are filled in the next time the app starts.
- **Disconnect** (Settings) or a new Worker URL takes your reminders off the old Worker: the app
  deletes each one there (for up to 10 seconds) before letting go of it. See the limitations
  below for when that can't work.

## Development

```powershell
npm ci
npm run build              # desktop (electron-vite), mcp + hook (vite), worker (wrangler --dry-run)
npm run dev                # the app with hot reload (electron-vite dev)
npm test                   # every workspace (Vitest)
npm run typecheck
npm run e2e -w apps/desktop   # full local smoke test of the built app (~70 s)
npm run dev:renderer -w apps/desktop   # the UI alone in a browser, on a mock backend
```

In the browser preview, add `?mock=1` for the mock backend, `&firstrun=1` for the wizard,
`?mode=expanded&tab=chat` and so on for a given view, and `?gallery=1` for the character sheet.

Some shells (VS Code, T3 Code) export `ELECTRON_RUN_AS_NODE=1`, which turns Electron into plain
Node. The npm scripts clear it; if you start Electron yourself, clear it first
(`Remove-Item Env:ELECTRON_RUN_AS_NODE`).

Environment overrides the app honours:

| Variable | Effect |
| --- | --- |
| `CLIPPY_HOME` | Data dir (default `%APPDATA%\professor-clippy`). Use a temp dir to try things safely. |
| `CLIPPY_CLAUDE_HOME` | "Connect Claude Code" wires `<dir>\.claude` instead of your real Claude config. |
| `CLIPPY_CLAUDE_PATH` | The `claude` executable (default: PATH, then `~\.local\bin\claude.exe`, then `claude.cmd`). |
| `CLIPPY_MCP_PATH` | The MCP server the brain and the wiring use. |
| `CLIPPY_FORCE_LOGIN_ITEM=1` | Register the start-at-login entry in a dev build (normally only the installed app does). |

Running `apps/desktop/release/win-unpacked/Professor Clippy.exe` counts as the installed app, so
with "Start with Windows" on it registers itself at login. Turn the setting off (or start it with
a `CLIPPY_HOME` whose `settings.json` has `"autoStart": false`) when you only want to look.

### Repository layout

| Path | What |
| --- | --- |
| `packages/shared` | Every shared contract: schemas, settings, local API routes, paths, `ClippyClient`, IPC, relay protocol. |
| `apps/desktop` | The Electron app: local API, SQLite store, scheduler, brain, relay client, the window and character. |
| `apps/mcp` | The stdio MCP server agents use. |
| `apps/hook` | The Claude Code hook. |
| `apps/worker` | The Cloudflare Worker + Durable Object WhatsApp relay. |
| `scripts/install-claude-wiring.ts` | Registers the MCP server, hook and CLAUDE.md hint with Claude Code. |

### Data

Everything lives in `%APPDATA%\professor-clippy\` (or `CLIPPY_HOME`): `clippy.db` (messages,
reminders, history), `settings.json`, `token` and `port` (how the MCP server and hook reach the
local API), `brain\` (the brain's MCP config) and `hook-state.json`.

## Troubleshooting

| Symptom | Try |
| --- | --- |
| SmartScreen blocks the installer | It is unsigned: More info → Run anyway. |
| Agents don't see the Clippy tools | Start a **new** Claude Code session. Check `claude mcp list` shows `clippy`. Re-run Connect Claude Code. Make sure `node --version` works in a new terminal (Node 24+). |
| "Claude Code was not found" in the wizard | Install Claude Code and run `claude` once to sign in; or set `CLIPPY_CLAUDE_PATH`. |
| An agent says Clippy isn't running | The MCP server starts the app from `%LOCALAPPDATA%\Programs\professor-clippy\`; if you installed elsewhere, set `CLIPPY_APP_PATH` for the MCP server, or start Clippy yourself. |
| No notes when an agent finishes | Settings → Claude Code hook must be on, and the hook installed (Connect Claude Code). New sessions only. |
| Chat says Clippy can't answer / not logged in | Run `claude` in a terminal and sign in; the brain uses that login. |
| WhatsApp shows "off" in Settings | Both the Worker URL (https) and the secret must be saved. "saved" only means they are; it doesn't prove the Worker answers, so check `https://<worker>/health` answers `{"ok":true}`. |
| Nothing arrives on WhatsApp | The secret must equal the Worker's `PC_SECRET`; your number must be a verified recipient of the test number; outside the 24 h window the `clippy_note` template must be **Approved**. `npx wrangler tail` in `apps/worker` shows the Worker's logs. |
| WhatsApp replies don't reach the PC | Meta's webhook must point at `<worker>/webhook` with your `VERIFY_TOKEN` and be subscribed to `messages`; `APP_SECRET` must be right (bad signatures are dropped). |
| Clippy vanished | He hides while a fullscreen app is focused (Settings → Hide during fullscreen apps), and closing the window only hides him: use the tray icon → Show Clippy. |
| Start fresh | Quit from the tray, then delete or rename `%APPDATA%\professor-clippy\`. Set `firstRunDone` to `false` in its `settings.json` to see the wizard again. |

## Known limitations & security notes

- **Prompt injection.** Clippy's brain can read files in your home folder (and anywhere else
  Claude Code's Read tool can reach) and fetch web pages, by design (decision 11). A crafted
  WhatsApp message or agent message could try to talk it into reading something private and
  sending it out, for example by fetching a URL with the data in it. Only your own number can
  reach the Worker, and only local processes can post to Clippy, but anything an agent relays
  (web pages, issue text, email) reaches the brain too. If that worries you, remove `WebFetch`
  (and `WebSearch`) from `ALLOWED_TOOLS` and `BUILTIN_TOOLS` in
  `apps/desktop/src/main/brain/brain.ts` and rebuild.
- **Meta's test number.** It can only message the numbers you verify (up to 5), shows as a test
  sender, and Meta can change or limit test numbers at any time. Outside the 24 h window it can
  only send the approved template.
- **Unsigned installer.** SmartScreen warns once; the exe and installer have no publisher.
- **The fullscreen check runs PowerShell.** To hide during fullscreen apps, the app keeps a
  PowerShell child process running (plainly visible in Task Manager, not disguised) that uses
  `Add-Type` to call `SHQueryUserNotificationState`. Some
  antivirus or endpoint tools flag that pattern; switch off "Hide during fullscreen apps" and it
  never runs.
- **Reminders can stay on a Worker you disconnected from or switched away from.** On Disconnect,
  or when you change the Worker URL, the app deletes your reminders from that Worker, giving it
  10 seconds in all. If the Worker is unreachable then (you are offline, it is down, or its secret
  no longer matches), the ones it couldn't delete stay there and **the Worker keeps sending
  them**, recurring ones forever. The app remembers them: reconnecting to that same Worker URL
  later deletes any you have cancelled meanwhile and keeps the rest. To be sure nothing is left,
  delete the old Worker (`npx wrangler delete --name <old worker name>` in `apps\worker`, or in
  the Cloudflare dashboard); that removes the Worker with every reminder it holds.
- **Failed WhatsApp sends are retried only while the app runs** (5 tries over about 12 minutes).
  A send still failing when you quit is not retried after a restart; the note is still on the
  desk.
- **Checked by hand, not by the automated tests:** hiding behind a real fullscreen app (a game,
  a video, a slideshow) and dragging mini Clippy with a real mouse, including a new message
  arriving mid-drag.
