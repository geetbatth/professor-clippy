# Pad, Themes, Settings and Welcome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the user a place for their own notes (the Pad) that Clippy and agents can write to as well, colour themes including dark ones, a regrouped Settings that holds History, and a first-run welcome that teaches by doing.

**Architecture:** Everything lives in the existing Electron app (`apps/desktop`), the shared contracts (`packages/shared`), the MCP server (`apps/mcp`) and the Claude Code wiring script (`scripts/install-claude-wiring.ts`). Pages are a new SQLite table in the existing store, exposed over the local API, IPC and MCP like standing orders and watches. Themes are CSS custom properties switched by a `data-theme` attribute on `<html>`. Settings becomes a menu of sections; History moves into it. The first-run wizard is reordered and gains a live tour, a Getting started checklist and one-time tips.

**Tech Stack:** TypeScript strict, ESM, Node 24, Electron 45, React, zod, `node:sqlite`, Vitest, `@modelcontextprotocol/sdk`.

**Spec:** this plan. The user approved four mockups in chat (Pad tab, Settings menu with History inside, themes, welcome) and said "build it all" without further questions. What they asked for, in their words: "where do i save my own sticky notes ... i open notepad windows all the time because they are self restoring ... then i have a gazillion i have to clean up"; "clippy should also be able to create them"; "move history to settings and then organize settings better"; "different colors themes? dark themes etc"; "a first time user onboarding"; and the other thread's new phone-approvals switch "might need to add that to settings at the appropriate place". Everything below that is not in those words is Claude's call, recorded in `DECISIONS.md` by Task 7.

## Global Constraints

- Read `docs/ARCHITECTURE.md` and `README.md` first; follow the existing code style (comment density, naming, small pure modules with tests next to the existing ones).
- No new npm dependencies; do not touch `package-lock.json`.
- Shared contracts live in `packages/shared` and are imported, never redefined. Renderer/preload code imports only the Node-free subpaths (`@clippy/shared/schemas`, `/settings`, `/api`, `/ipc`).
- Store schema changes are **appended** migrations in `apps/desktop/src/main/core/store.ts` `MIGRATIONS` (current schema version is 6; never edit an existing one).
- Brain-only MCP tools are registered inside `brainOnly(...)` in `apps/mcp/src/server.ts`; tools the brain may use are listed in `BRAIN_CLIPPY_TOOLS` (`apps/desktop/src/main/brain/brain.ts`).
- The browser preview (`?mock=1`, `renderer/src/mock/mockBackend.ts`) must keep working for every new screen: extend the mock backend for every new IPC method.
- Every task: `npm run typecheck` and `npm test` pass at the repo root before committing. Each task updates `README.md` and `docs/ARCHITECTURE.md` for what it adds (short, same tone as the existing text).
- Commit messages: imperative sentence, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit on the current branch (`pad-themes-onboarding`); never push.
- Windows 11 target. UI copy is plain English, no jargon; Clippy's lines keep his pompous-professor tone.

## Review Focus

1. **Clippy (or an agent) changes a page while the user is typing in it** → neither change is silently lost: the user's save is refused as stale, their text stays in the editor, and a banner offers "Keep mine" / "Use theirs". (Task 2 store test, Task 3 renderer test.)
2. **App quits, crashes or the note collapses mid-typing** → at most the last 400 ms of typing can be lost: saves are debounced 400 ms and flushed on blur, on page switch, on collapse and on `beforeunload`. (Task 3 test of the save controller.)
3. **A popped-out page was on a monitor that is no longer attached** → it reopens fully on a visible display. (Task 4 test of the bounds clamp.)
4. **An agent tries to change a page the user (or another sender) wrote** → refused with a 403 that says only the page's author or the user can change it; it can still create its own pages. (Task 2 test.)
5. **Windows switches light/dark while the app runs** → with "Follow Windows dark mode" on, the note, popped-out pages and speech bubble switch within a second without a restart; with it off, nothing changes. (Task 1 test of `resolveTheme` plus the IPC event test.)

---

### Task 1: Colour tokens and themes

**Files:**
- Create: `apps/desktop/src/renderer/src/styles/theme.css`, `packages/shared/src/theme.ts` (exported from the `@clippy/shared/settings` subpath or a new Node-free `@clippy/shared/theme` subpath), `packages/shared/test/theme.test.ts`
- Modify: every renderer `*.css` file and inline colour in `*.tsx` under `apps/desktop/src/renderer/src` (156 hard-coded colours in 19 files today), `packages/shared/src/settings.ts`, `packages/shared/src/ipc.ts`, `packages/shared/src/api.ts`, `packages/shared/src/client.ts`, `apps/desktop/src/main/core/api.ts`, `apps/desktop/src/main/window/registerIpc.ts`, `apps/desktop/src/main/index.ts`, preload, `apps/desktop/src/renderer/src/App.tsx`, `mock/mockBackend.ts`, `apps/mcp/src/server.ts`, `apps/desktop/src/main/brain/brain.ts`, `apps/desktop/src/main/brain/persona.ts`, tests beside each.

**Interfaces:**
- Produces settings: `theme: ThemeId` (default `'classic'`), `followSystemDark: boolean` (default `false`), `darkTheme: DarkThemeId` (default `'night'`), `showTips: boolean` (default `true`, used by Task 6).
- Produces in `packages/shared/src/theme.ts`: `THEMES` (ordered list `{ id, label, dark: boolean, swatch: string }`), `ThemeId = 'classic' | 'mint' | 'blush' | 'sky' | 'peach' | 'night' | 'chalkboard'`, `DarkThemeId = 'night' | 'chalkboard'`, `PageColor = 'yellow' | 'mint' | 'blush' | 'sky' | 'peach'`, `PAGE_COLORS` (`{ id, label, swatch }`), and `resolveTheme(s: Pick<Settings,'theme'|'followSystemDark'|'darkTheme'>, systemDark: boolean): ThemeId` (follow on and system dark → `darkTheme`; otherwise `theme`).
- Produces IPC: `systemDark(): Promise<boolean>` and event `theme:system` (`boolean`), from Electron `nativeTheme.shouldUseDarkColors` / `nativeTheme.on('updated')`.
- Produces route `POST /look` (`Routes.setLook`), body `LookPatch = { theme?, followSystemDark?, darkTheme? }` (at least one key) → `Settings` subset `{ theme, followSystemDark, darkTheme }`; `ClippyClient.setLook`; brain-only MCP tool `set_look` (in `BRAIN_CLIPPY_TOOLS`), so "go dark" works.
- Produces CSS: `:root[data-theme="<id>"]` blocks in `theme.css` defining named tokens. Required token names (later tasks use them): `--paper-1`, `--paper-2`, `--paper-curl`, `--paper-shine`, `--ink`, `--ink-soft`, `--ink-faint`, `--head`, `--line`, `--card`, `--card-border`, `--tab-on`, `--accent`, `--btn`, `--btn-ink`, `--field`, `--field-border`, `--bubble`, `--bubble-ink`, `--bubble-border`, `--ok`, `--bad`, `--badge`. `App.tsx` sets `document.documentElement.dataset.theme = resolveTheme(...)` and `data-dark="true|false"`.

- [ ] **Step 1: Failing tests.** `theme.test.ts`: `resolveTheme({theme:'mint',followSystemDark:false,darkTheme:'night'}, true) === 'mint'`; `({theme:'mint',followSystemDark:true,darkTheme:'chalkboard'}, true) === 'chalkboard'`; `(…followSystemDark:true…, false) === 'mint'`; `THEMES` ids are exactly the seven above in that order, `night` and `chalkboard` have `dark: true`. Shared settings test: `Settings.parse({})` gives the four defaults; `SettingsPatch` accepts them; an unknown theme id is rejected. API test: `POST /look {theme:'night'}` saves and returns it; `{}` → 400. MCP server test: `set_look` exists only for `BRAIN_SENDER`. Renderer test (pure helper, not DOM): a `themeAttrs(themeId)` helper returns `{ theme: 'night', dark: 'true' }`.
- [ ] **Step 2: Run, see them fail.** `npm test -w packages/shared` and `npm test -w apps/desktop` and `npm test -w apps/mcp`.
- [ ] **Step 3: Implement.** Settings fields and `theme.ts` as above. `theme.css` imported once from `main.tsx` before the other styles. `classic` must reproduce today's look exactly (same hex values as now). Replace every hard-coded colour in the renderer CSS/TSX with the tokens (state colours like the red unread badge can stay a token `--badge`). Light themes keep the yellow sticky's structure with their paper colour (mint `#c9f5dc`/`#a9ebc6`, blush `#ffd9e6`/`#ffc6d9`, sky `#d6ecff`/`#bfe0ff`, peach `#ffe2c7`/`#ffd0a8`); dark themes: night (paper `#2b2f3a`/`#1f222b`, ink `#e6e2d3`, head and button `#ffe27a`, accent `#ffcc4d`), chalkboard (paper `#2f4a3a`/`#253d30`, ink `#eef3ea`, accent `#ffb3c7`). In dark themes Clippy's sprite gets a soft rim light: `filter: drop-shadow(0 0 6px rgba(255,255,255,.35))` under `:root[data-dark="true"]`. Main: `systemDark` IPC + `theme:system` event (subscribe to `nativeTheme.on('updated')` once in `index.ts`, broadcast to every window). Route, client, MCP `set_look` tool (description: "Change how Professor Clippy looks: a theme, following Windows dark mode, or which dark theme to use"), brain allowed-list, one persona line ("go dark" / "make it mint" → `set_look`). No Settings UI in this task (Task 5 adds the Look section); the mock backend supports the new settings and `systemDark`.
- [ ] **Step 4: Run tests + typecheck, all pass.** Also run `npm run dev` long enough to check the app starts, or open the mock preview, and confirm classic looks unchanged.
- [ ] **Step 5: Commit** "Add colour themes, including dark ones that can follow Windows".

### Task 2: Pages (store, API, MCP)

**Files:**
- Create: `apps/desktop/src/main/core/pages.ts`, `apps/desktop/test/core/pages.test.ts`
- Modify: `packages/shared/src/schemas.ts`, `packages/shared/src/api.ts`, `packages/shared/src/client.ts`, `packages/shared/src/ipc.ts`, `apps/desktop/src/main/core/store.ts`, `apps/desktop/src/main/core/core.ts`, `apps/desktop/src/main/core/api.ts`, `apps/desktop/src/main/core/errors.ts` (if a 409 error type is missing), `apps/desktop/src/main/backend.ts`, `apps/desktop/src/main/window/registerIpc.ts`, preload, `apps/mcp/src/server.ts`, `apps/mcp/test/fake-api.ts`, `apps/mcp/test/server.test.ts`, `apps/desktop/src/main/brain/brain.ts`, `apps/desktop/src/main/brain/persona.ts`, `scripts/install-claude-wiring.ts` (CLAUDE.md hint), `renderer/src/mock/mockBackend.ts`, matching tests.

**Interfaces:**
- Produces schema `Page = { id: string (ulid), title: string (1–120), body: string (≤ 100_000), color: PageColor | null, pinned: boolean (top of the list), popped: boolean (open as its own window), popBounds: {x,y,width,height,displayId} | null, author: string ('you' for the user, else the sender, e.g. 'clippy-brain', 'claude-code'), project: string | null, unseen: boolean (written by someone else and not yet opened), createdAt: number, updatedAt: number, archivedAt: number | null }`.
- Produces migration 7: table `pages` with those columns (booleans as INTEGER, `pop_bounds` JSON TEXT) and index on `(archived_at, pinned, updated_at)`.
- Produces `Pages` (in `core/pages.ts`, created in `startCore` as `core.pages`), each emitting bus event `page:changed` (`Page`) or `page:deleted` (`{ id }`):
  - `list(opts: { q?: string; archived?: boolean }): Page[]` — not archived by default; pinned first, then `updatedAt` desc; `q` is a case-insensitive substring match on title or body (LIKE, `%` and `_` escaped).
  - `get(id): Page` (NotFoundError), `findByTitle(title): Page | undefined` (case-insensitive exact, else unique prefix, most recently updated wins).
  - `create(input: NewPageInput, author: string): Page` — `NewPageInput = { title, body?, color?, project? }`; `unseen` true unless author is `'you'`.
  - `write(id, change: PageChange, author: string): Page` — `PageChange = { title?, body?, append?: string, color?, pinned?, baseUpdatedAt?: number }`. `append` adds a newline (if the body is non-empty and does not end in one) then the text. Stale `baseUpdatedAt` (≠ stored `updatedAt`) → `ConflictError` (409) carrying the current page. Authors other than `'you'` and `'clippy-brain'` may only change pages whose `author` equals theirs → `ForbiddenError` "Only the person who wrote this page (or you) can change it." A change by anyone but `'you'` sets `unseen`.
  - `markSeen(id)`, `setPopped(id, popped: boolean, bounds?)` (does not touch `updatedAt`), `archive(id)`, `restore(id)`, `remove(id)` (only archived pages; the user only — IPC only, no route).
  - `archiveStale(now): number` — archives pages not pinned, not popped, not archived, with `updatedAt` older than `PAGE_ARCHIVE_AFTER_MS = 30 days`. Called from `startServices` at start and every 6 h.
- Produces routes (agents and brain): `GET /pages?q=&archived=` (`listPages`), `GET /pages/:id` (`getPage`), `POST /pages` (`createPage`, body `NewPageInput`, sender from the usual `X-Clippy-Sender`/body convention the other routes use), `POST /pages/:id` (`writePage`, body `PageChange`), `POST /pages/:id/archive` (`archivePage`). `ClippyClient` methods of the same names.
- Produces IPC for the renderer (author `'you'`): `listPages`, `getPage`, `createPage`, `writePage` (resolves to `{ ok: true, page } | { ok: false, conflict: Page }`), `markPageSeen`, `archivePage`, `restorePage`, `deletePage`, `popPage(id, popped)` (Task 4 wires the window), events `page:changed`, `page:deleted`.
- Produces MCP tools for everyone: `write_page` (`{ title, text, mode: 'new' | 'append' | 'replace' = 'append', page_id? }`: with `page_id`, or a title matching an existing page (`findByTitle`) for append/replace, it writes that page, otherwise it creates one; returns the page id and title), `read_page` (`{ page_id? , title? }` → title + body), `list_pages` (`{ query? }` → id, title, first line, author, updated time; at most 50). Brain-only: `archive_page` (`{ page_id }`). All four go in `BRAIN_CLIPPY_TOOLS`. Persona: "jot down …" → `write_page` new; "add … to my X page" → append; "what did I write about …" → `list_pages` + `read_page`; never replace a page the user wrote unless told to. CLAUDE.md hint gains one sentence: agents can leave a page to keep (a checklist, a summary) with `write_page` instead of a note.

- [ ] **Step 1: Failing tests** in `test/core/pages.test.ts`: create by `'you'` → `unseen: false`; by `'claude-code'` → `unseen: true`; list orders pinned first then newest; `q: '50%'` only matches a literal `50%`; append to `"a"` gives `"a\nb"`, to `""` gives `"b"`; stale `baseUpdatedAt` throws `ConflictError` with the current page and leaves the body unchanged (Review Focus 1); agent `'claude-code'` writing a `'you'` page throws `ForbiddenError` and writing its own page works, `'clippy-brain'` may write any (Review Focus 4); `archiveStale` archives a 31-day-old page, keeps a 29-day-old one, a pinned one and a popped one; `remove` of a non-archived page throws; body of 100_001 chars rejected. Store migration test: schema version becomes 7 from 6 with existing data intact. API tests for each route including 403 and 409 bodies. MCP tests: `write_page` with no match creates, with a matching title appends; `archive_page` is brain-only.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** as specified. Emit `page:changed` on the bus and forward it to every window (like message events).
- [ ] **Step 4: Run tests + typecheck, all pass.**
- [ ] **Step 5: Commit** "Add Pad pages that you, Clippy and agents can write".

### Task 3: The Pad tab

**Files:**
- Create: `renderer/src/note/PadTab.tsx`, `PadTab.css`, `PageEditor.tsx`, `renderer/src/note/pageSave.ts` (pure save controller), `renderer/src/hooks/usePages.ts`, `apps/desktop/test/renderer/pageSave.test.ts`, `apps/desktop/test/renderer/padList.test.ts`
- Modify: `renderer/src/note/StickyNote.tsx` (tab list), `renderer/src/App.tsx`, `renderer/src/views/ExpandedView.tsx` (if tabs route there), `renderer/src/mock/mockBackend.ts`, `sampleData.ts`.

**Interfaces:**
- Consumes: Task 2 IPC and `Page`; Task 1 tokens and `PAGE_COLORS`.
- Produces: tab id `'pad'`; `Tab` becomes `'notes' | 'pad' | 'chat' | 'settings'` after Task 5 (this task adds `'pad'` and keeps `'history'` for now). Tab label "Pad", shows a small green dot when any page is `unseen`.
- Produces `createSaveController(opts: { save(text: string, base: number): Promise<{ok:true,page:Page}|{ok:false,conflict:Page}>; delayMs?: number (default 400); now?; setTimer? })` with `edit(text)`, `flush(): Promise<void>`, `state: 'saved' | 'saving' | 'dirty' | 'conflict'`, and `onConflict(page)`; and pure `padSections(pages): { pinned: Page[]; recent: Page[] }`.

- [ ] **Step 1: Failing tests.** `pageSave.test.ts` (fake timers): edits within 400 ms produce one save with the last text; `flush()` saves immediately and resolves after it; a conflict result sets state `conflict`, keeps the local text and calls `onConflict` with the server page; after "keep mine" (`resolve('mine')`) the next save uses the conflict page's `updatedAt` as base; `resolve('theirs')` replaces the text (Review Focus 1 and 2). `padList.test.ts`: `padSections` splits pinned and recent and keeps their order.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement the UI** to match the approved mockup: list view (search box, "+ New", Pinned / Recent sections, each row: title, author badge "📎 Clippy" for `clippy-brain` or "🤖 <sender> · <project>" for agents, first line, "edited 4 min ago"), "Archived · N" row opening the archived list (Restore, Delete forever with a confirm). Page view: "‹ All pages", editable title, a lined-paper `<textarea>` (tokens), footer "✓ Saved · just now" / "Saving…" / conflict banner "Changed while you were typing. [Keep mine] [Use theirs]", buttons 📌 Pin out (Task 4 makes it work; until then it calls `popPage`), colour dots (`PAGE_COLORS` + "theme"), pin-to-top toggle, Archive. Opening a page calls `markPageSeen`. Flush on blur, page switch, tab switch, collapse and `beforeunload`. A new page starts titled "Untitled" with the title selected. Auto-collapse must not fire while the editor has focus (reuse the Tell box's rule). Mock backend: in-memory pages with sample ones (Scratch pinned, Dave call by Clippy, Deploy steps).
- [ ] **Step 4: Run tests + typecheck, check the mock preview**, all pass.
- [ ] **Step 5: Commit** "Add the Pad tab: your own pages that save as you type".

### Task 4: Pop-out pages

**Files:**
- Create: `apps/desktop/src/main/window/pageWindows.ts`, `apps/desktop/src/main/window/pageBounds.ts` (pure), `apps/desktop/test/window/pageBounds.test.ts`, `renderer/src/views/PageWindow.tsx`, `PageWindow.css`
- Modify: `apps/desktop/src/main/index.ts`, `registerIpc.ts`, `renderer/src/main.tsx` (choose the view by `?page=<id>`), preload if the page window needs a reduced API.

**Interfaces:**
- Consumes: Task 2 `Pages.setPopped`, `page:changed`/`page:deleted`; Task 3 `PageEditor` and save controller.
- Produces: `PageWindows` with `open(page)`, `close(id)`, `restoreAll()` (on start, every `popped` page), and `clampBounds(bounds, displays: {id, workArea}[]): bounds` in `pageBounds.ts`: if the bounds' display is gone or the window would be less than 80 % visible, move it onto the primary display's work area (keep the size, shrink only if larger than the work area); default size 260 × 220 cascading 24 px from the top-right of the primary work area.

- [ ] **Step 1: Failing tests** `pageBounds.test.ts`: bounds on a removed display land fully inside the primary work area (Review Focus 3); bounds half off the right edge are pulled in; bounds fully visible are unchanged; an oversized window is shrunk to the work area; default cascade positions for the 1st and 2nd window differ by 24 px.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** Each popped page is a frameless, transparent, resizable `BrowserWindow` (not always-on-top, `skipTaskbar: true`, min 180 × 120) loading the renderer with `?page=<id>`; it shows the page as a small sticky in the page's colour (or theme paper): a drag header with the title, "—" (collapse to the header) and "×" (un-pop: `setPopped(false)`, the page stays in the Pad), and the editor with the same save controller. Moves/resizes save `popBounds` (debounced 500 ms). Archiving or deleting a page closes its window. `restoreAll()` runs after the main window is created. The theme and `theme:system` apply in page windows too. The Pad's "📌 Pin out" button toggles to "Un-pin" when popped.
- [ ] **Step 4: Run tests + typecheck; start the app with `npm run dev`, pop a page out, restart, confirm it comes back where it was.**
- [ ] **Step 5: Commit** "Let a Pad page float on the desktop as its own sticky".

### Task 5: Settings menu, History inside it, Look section

**Files:**
- Create: `renderer/src/note/settings/SettingsMenu.tsx`, one component per section in `renderer/src/note/settings/` (`AlertsSection.tsx`, `PhoneSection.tsx`, `BriefSection.tsx`, `ClaudeSection.tsx`, `LookSection.tsx`, `PcSection.tsx`), `renderer/src/note/settings/summaries.ts` (pure), `apps/desktop/test/renderer/settingsSummaries.test.ts`
- Modify: `SettingsTab.tsx` (becomes the menu + router; keep its commit helpers, move controls into the sections), `SettingsTab.css`, `HistoryTab.tsx` (rendered inside Settings, with a "‹ Settings" back link), `StickyNote.tsx` (tabs: Notes · Pad · Clippy · ⚙ Settings), `NotesTab.tsx` (empty state gets a "History ›" link), `App.tsx`, mock backend.

**Interfaces:**
- Consumes: Task 1 settings and `THEMES`.
- Produces: `SettingsSection = 'history' | 'alerts' | 'phone' | 'brief' | 'claude' | 'rules' | 'look' | 'pc'`; `sectionSummary(section, ctx: { settings: Settings; telegram?: TelegramStatus; orders: number; watches: number; historyCount?: number; hotkeyOk?: boolean }): string`; App-level `openSettings(section?: SettingsSection)` so other components (Notes empty state, Task 6) can deep-link.

Section contents (every existing setting keeps its control, label and hint text; only its place changes):
- **History**: today's History tab.
- How I behave — **Pop-ups & sounds**: Pop up for, Sounds, Hide during fullscreen apps, Unsolicited advice. **Phone**: Send to my phone, I count as away after, then rows Telegram (status badge, opens today's Telegram setup) and WhatsApp relay (badge; the relay fields). **Morning brief**: Morning brief, Brief time, Weekdays only.
- Agents — **Claude Code**: Claude Code hook, Wait for answers, **"Approve agents from my phone"** (`phoneApprovals`, hint: "When you're away, an agent's 'allow this?' prompt comes to your phone with Allow / Deny. Needs the hook."; disabled while the hook is off), Connect Claude Code. **Standing orders & watches**: `RulesSection`.
- This PC — **Look**: theme swatches (`THEMES`), Follow Windows dark mode, dark theme choice (only shown when following), Show tips (`showTips`). **Windows & hotkeys**: Tell Clippy hotkey, Start with Windows, Let Clippy restart apps and the PC, then a "Run the welcome again" button (Task 6 wires it; until then it sets `firstRunDone: false`) and the app version.

- [ ] **Step 1: Failing tests** `settingsSummaries.test.ts`: alerts → "Questions, reminders & urgent · sounds on"; phone with Telegram connected, away 180 s → "Only when away (3 min) · Telegram"; phone with neither channel → "Not set up"; brief on 09:00 weekdays → "09:00 · weekdays", off → "Off"; claude → "Hook on · questions wait 10 min · phone approvals on"; rules with 2 orders 1 watch → "2 orders · waiting for 1"; look → theme label plus " · follows Windows" when on; pc → "Ctrl+Alt+Space · starts with Windows" (hotkey empty → "No hotkey").
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** the menu and sections to match the approved mockup (rows with icon, title, summary, ›; sections open in place with "‹ Settings"). Remove the History tab; Notes' empty state shows "History ›" which opens Settings → History. Theme swatches apply instantly.
- [ ] **Step 4: Run tests + typecheck, check every section in the mock preview.**
- [ ] **Step 5: Commit** "Regroup Settings into sections and move History into it".

### Task 6: Welcome, Getting started and tips

**Files:**
- Create: `renderer/src/note/welcome/tour.ts` (pure), `renderer/src/note/welcome/GettingStarted.tsx`, `renderer/src/note/welcome/tips.ts` (pure), `apps/desktop/src/main/onboarding.ts`, `apps/desktop/test/renderer/tips.test.ts`, `apps/desktop/test/onboarding.test.ts`
- Modify: `FirstRunWizard.tsx`, `FirstRunWizard.css`, `firstRun.ts`, `test/renderer/firstRun.test.ts`, `PadTab.tsx` (Getting started row), `App.tsx`, `SpeechBubble.tsx` (tips), `packages/shared/src/ipc.ts`, `registerIpc.ts`, preload, mock backend.

**Interfaces:**
- Consumes: Task 1 themes, Task 3 Pad, Task 5 `openSettings`.
- Produces: `WizardStep = 'claude' | 'look' | 'phone' | 'tour'` in that order. `ChecklistItem = 'connect' | 'answer' | 'hotkey' | 'snooze' | 'order' | 'popout' | 'brief'` with labels "Connect Claude Code", "Answer a question", "Tell me something with the hotkey", "Snooze a note until later", "Set a standing order", "Pin a page to the desktop", "Get your morning brief". `Onboarding` (main, kv `onboarding` = `{ startedAt, done: ChecklistItem[], dismissed: boolean, tipsShown: TipId[] }`) marks items from bus events: hook wiring installed → connect; an ask answered by the user (not `via: 'clippy'`) → answer; a Tell box send → hotkey (renderer calls `markOnboarding('hotkey')`); a snooze → snooze; an order added → order; a page popped → popout; a morning brief note created → brief. IPC `onboarding(): Promise<OnboardingState>`, `markOnboarding(item)`, `dismissChecklist()`, `restartWelcome()` (sets `firstRunDone: false`, resets `done` except items already true, `dismissed: false`), event `onboarding:changed`.
- Produces `TipId = 'quiet-history' | 'standing-order' | 'pin-out' | 'pad-jot'` and pure `nextTip(ctx: { now; state: OnboardingState; showTips: boolean; event: TipEvent }): TipId | undefined` — never when `showTips` is false, never one already shown, never after 14 days from `startedAt`, at most one per hour. Triggers: `quiet-history` on the first agent-finished note stored `done` while at the PC ("Finished pings go quietly into Settings → History while you're at your desk."); `standing-order` on the 3rd question the user answers in one day while they have no standing orders ("That's three questions today. Tell me 'whenever an agent asks about X, say Y' and I'll answer those myself."); `pin-out` when the user creates their 2nd page ("Pin a page out and it floats on your desktop, like a Notepad window that never needs cleaning up."); `pad-jot` on the first Tell box send that is not about a page ("You can also say 'jot down: …' and I'll keep it on your Pad."). A tip shows in Clippy's speech bubble for 12 s and is recorded as shown.

- [ ] **Step 1: Failing tests.** `firstRun.test.ts`: step order is claude, look, phone, tour. `tips.test.ts`: each trigger yields its tip once; `showTips: false` → none; day 15 → none; two triggers within an hour → only the first. `onboarding.test.ts` (with a fake bus/store): answering an ask via `desk` marks `answer`, via `clippy` does not; a snooze marks `snooze`; `restartWelcome` keeps done items and clears `dismissed`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** to match the approved mockup. Step 1 "Welcome! I'm Professor Clippy." with the existing Connect Claude Code flow and "Later". Step 2 "How should I look?" theme swatches applying live, Follow Windows dark mode, Sounds, Unsolicited advice, Start with Windows. Step 3 "Want me on your phone?" Telegram setup first (existing `TelegramSetup`), "WhatsApp (advanced) ›" revealing today's relay fields, "Not now". Step 4 "Try it": a demo question card rendered with the real `AskCard` (not stored, never sent anywhere) "❓ Tea or coffee?" with Tea / Coffee; answering shows "✓ Answered. Agents get your reply the same way." and ticks `answer`; then "Press <hotkey> from any app and tell me things, like 'jot down: hello'" (the hotkey from settings; if none, "Use the box under your notes"); Finish sets `firstRunDone: true` and opens the Pad. Skipped steps stay unticked on the checklist. The Pad list shows "Getting started 📎  3/7" pinned at the top until every item is done or it is dismissed (× on the row); opening it shows the checklist (ticked items struck through; each unticked item has a one-line how-to). Existing installs (`firstRunDone: true` already) do not see the wizard; `startedAt` is set on first run of this version, so tips still run for them for 14 days. Settings → Windows & hotkeys → "Run the welcome again" calls `restartWelcome`.
- [ ] **Step 4: Run tests + typecheck, walk the wizard in the mock preview.**
- [ ] **Step 5: Commit** "Make the welcome teach by doing, with a Getting started list and tips".

### Task 7: Docs, decisions, version

**Files:** `README.md`, `docs/ARCHITECTURE.md`, `DECISIONS.md`, `apps/desktop/package.json` (version `0.6.0`), `docs/screenshots/` (new: `expanded-pad.png`, `expanded-settings.png` replaced, `first-run.png` replaced, `pad-popout.png`, if the existing screenshot tooling under `renderer/src/dev` or `main/window/dev` can capture them; otherwise skip screenshots and say so).

- [ ] **Step 1:** README: a Pad bullet (pages, autosave, archive after 30 days, pin out, Clippy and agents write too, the four MCP tools), Themes, the new Settings layout (replace every "Settings → X" path in the README with the new section path, e.g. "Settings → Phone → Send to my phone"), the new welcome, Getting started and tips. A note that existing users should re-run Connect Claude Code to get the new CLAUDE.md hint.
- [ ] **Step 2:** DECISIONS.md: a "Pad, themes and welcome" section listing the calls Claude made: 30-day auto-archive; agents may only change their own pages, Clippy any; conflicts keep both via the banner; popped pages not always-on-top and not in the taskbar; seven themes; page colours; History moved into Settings; tour question is local, never stored or sent; tips limited to the first 14 days, one per hour.
- [ ] **Step 3:** Bump to 0.6.0; `npm run typecheck`, `npm test`, `npm run build` pass.
- [ ] **Step 4: Commit** "Document the Pad, themes, Settings and welcome; bump to 0.6.0".
