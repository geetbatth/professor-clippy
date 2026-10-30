# Decisions

## Professor Clippy — 2026-10-30

Grilled in chat (T3 Code question forms).

1. Clippy's own chat brain is Claude running headless through Claude Code in the background (your Claude Code login, no separate API key).
2. Agents hand messages to Clippy through an MCP server (tools like `leave_message`, `remind_me`, `ask_user`).
3. Clippy handles notes/notifications, one-off scheduled reminders, recurring reminders, and questions that need an answer.
4. The window is always on top, collapses to a mini Clippy in a corner when idle, and expands with a wiggle on a new message.
5. Look: an original paperclip professor (googly eyes, mortarboard, glasses) clipped to a yellow sticky note, animated in SVG/CSS. Later replaced by painted sprites of a robot (a riveted canister stencilled "PROF. CLIPPY" with a paperclip head, goggles, mortarboard, arms and caster wheels) standing on the note, still moved with CSS.
6. WhatsApp is two-way: every message is mirrored there, and you can reply or chat with Clippy from your phone.
7. Only agents on this PC can post to Clippy; nothing on the PC is exposed to the internet.
8. The app is built with Electron and TypeScript.
9. WhatsApp goes through Meta's official WhatsApp Cloud API.
10. `ask_user` blocks until you answer (desk or WhatsApp) for up to N minutes, then returns "no answer yet" plus an id the agent can check later.
11. Clippy's brain can manage messages and reminders, read files and search the web; it cannot edit files or run shell commands.
12. Agent messages are shown verbatim, with a random canned Clippy quip alongside.
13. A Cloudflare Worker receives Meta's webhook (signature-checked) and queues replies; the PC pulls them over an outbound connection.
14. Clippy sends from Meta's free test number permanently, using a permanent system-user token.
15. WhatsApp mirrors every message, all the time (no quiet hours).
16. Unread messages show as a stack on the note with an unread badge on mini Clippy; dismissing moves them to a searchable SQLite history; reminders can be snoozed.
17. On WhatsApp, a quote-reply answers that specific question; a plain message goes to Clippy's brain, which can also answer pending questions for you.
18. Messages outside the 24h window use one utility template, "Professor Clippy 📎: {{1}}", carrying the full text (cut at ~1000 chars with "more on desktop").
19. Desk and WhatsApp share one persistent, resumed Claude Code session, with a "New chat" reset.
20. Reminders sync to the Worker, whose cron sends the WhatsApp on time even when the PC is off; the desktop shows it, or on wake marked "missed while you were away".
21. Install: auto-start at login, register the MCP server in Claude Code's user config, add a hint to the global CLAUDE.md, and add a Claude Code hook that posts when an agent finishes or needs permission.
22. Antics: idle life, attention-seeking, sound effects (with mute), and unsolicited advice (with an off switch).
23. Claude decided: the Electron app hosts the local service (localhost API, SQLite, scheduler); the MCP server is a small stdio process that forwards to it.
24. Claude decided: each message carries the sender (agent name and project) and an urgent flag that triggers the stronger attention animation.
25. Claude decided: `ask_user` waits 10 minutes by default; agents can change this per call.
26. Claude decided: mini Clippy is draggable and remembers its position; settings has toggles for the hook, sounds and unsolicited advice.
27. Claude decided: desk and WhatsApp share one message store, so anything dismissed or answered on one side is done on the other.

## Notes

- 2026-10-30, on decision 18 (template text). The approved template can't be "Professor Clippy 📎: {{1}}": Meta rejects a template whose body starts or ends with a variable, and that one ends with `{{1}}`. The `clippy_note` template (utility, language `en`) therefore has fixed text after the variable. Its exact body is:

  ```text
  Professor Clippy has a note for you:

  {{1}}

  Reply here to talk to Clippy.
  ```

  `{{1}}` carries the full message on one line (newlines become " · ", because Meta rejects newlines and tabs in parameters), cut at 1000 characters ending "…more on desktop". The JSON to submit is in apps/worker/README.md; docs/USER-TODO.md points at it.

## Tell Clippy — 2026-10-30

Agreed in chat: Clippy should show things only when they need you, and "chat" is really telling Clippy to do things.

1. Two levels of loud: questions, permission requests, due reminders, urgent notes and Clippy's own notes (nudges, the morning brief) pop up with a wiggle and sound; "agent finished" and plain notes only raise the unread badge, and never nag. Settings → "Pop up for" can switch back to everything.
2. Phone only when away: notes and questions stay on the desktop while you're at the PC and go to the phone once you've been idle past the away threshold (default 3 minutes). A question still unanswered after half the time `ask_user` waits (5 minutes by default) goes to the phone anyway. Settings → "Send to my phone" can switch back to always. WhatsApp reminders are still sent on time by the Worker.
3. Advice quips are off by default, and switched off once for existing installs.
4. A "Tell Clippy…" box sits under the notes, and a global hotkey (default Ctrl+Alt+Space, changeable or off in Settings) opens it from anywhere. The Chat tab is now the "Clippy" tab.
5. Standing orders: tell Clippy "if an agent asks about X, say Y" and he answers matching questions for you. Managed by telling Clippy or in Settings.
6. Watch-and-nudge: "when the build agent finishes, remind me to deploy" leaves a loud nudge once that agent finishes (or, for "when I hear from X", on any note or question from it).
7. Morning brief: a note at 09:00 on weekdays with today's reminders, what's waiting on you and what the agents did overnight. Time, weekdays-only and on/off are in Settings.
8. Clippy can snooze, dismiss and summarise notes when told ("bring that back after lunch", "what happened while I was at lunch?").
9. Claude decided: the hotkey is Ctrl+Alt+Space, because Windows reserves most Win-key shortcuts.
10. Claude decided: standing orders are matched by a one-shot `claude -p --model haiku` with no tools, capped at 20 seconds; with no orders nothing runs, and on any failure or timeout the question is posted normally. An auto-answer must be one of the question's options when it has them.
11. Claude decided: watches match the project name case-insensitively and by substring ("clippy" matches "professor-clippy"), fire once, and ignore Clippy's own notes.
12. Claude decided: a missed morning brief is sent on a late start or wake if it's before 12:00 local or within 2 hours of the brief time, at most once a day.
13. Claude decided: every brain turn starts with the local time and UTC offset, so relative times ("after lunch", "at 3") resolve correctly.

## PC control — 2026-10-30

1. PC control is opt-in, brain-requested and user-confirmed. Clippy's brain can ask to restart an app or the PC (`restart_app`, `restart_computer`, with `list_open_apps` to find the name) only while Settings → "Let Clippy restart apps and the PC" is on (off by default). A request is only a question with Restart and Cancel buttons; the restart runs after the user's own tap on the desk, in Telegram or on WhatsApp, never on an answer from Clippy (`answer_pending`) or through the local API, and a request expires after 10 minutes or when Clippy restarts. The brain reads files and web search results, so a prompt injection could ask it to restart things: it gets request tools only, still no Bash or PowerShell, and ordinary agents never see these tools.

## Phone approvals — 2026-10-30

1. Phone approvals are opt-in, only when away, answered only by the user, and never matched by standing orders. With Settings → "Approve agents' permission requests from your phone" on (off by default; it needs the Claude Code hook), a Claude Code agent's "allow this tool use?" prompt (the `PermissionRequest` hook) goes to the desk note and the phone with Allow and Deny, but only while the user has been idle past the away time; at the PC, Claude Code's normal terminal prompt shows. Only the user's own tap or reply (desk, Telegram, WhatsApp) answers one: Clippy's `answer_pending` and the local API are refused, and approvals are created in-process so standing orders never see them. The hook allows only on an explicit Allow-type answer; Deny or any other reply denies (the reply is passed to the agent); no answer within 29 minutes, a dismissed note or a Clippy restart means no decision, and the terminal prompt shows. `AskUserQuestion` always stays in the terminal.

## Pad, themes and welcome — 2026-10-30

Agreed in chat: the note should be able to hold things you keep, look the way you like, and teach itself to new users. The calls below were made while building it.

1. The Pad is a set of pages that save as you type, unlike notes, which you dismiss. You, Clippy's brain and agents (through the MCP tools `write_page`, `read_page` and `list_pages`) can all write them; `archive_page` is Clippy's alone.
2. Claude decided: a page nobody has changed for 30 days is archived, not deleted, and can be restored. Pinned pages and pages popped out on the desktop are never archived.
3. Claude decided: an HTTP or MCP caller can't claim to be "you". Agents can only change or archive pages they wrote; Clippy's brain can change any page. A refused change says only the page's author or the user can make it.
4. Claude decided: if Clippy or an agent changes a page while you are typing in it, both versions are kept. Your save is refused as stale, your text stays in the editor, and a banner offers "Keep mine" or "Use theirs".
5. Claude decided: leaving a page while that "changed while you were typing" conflict is still open (or quitting) saves your text as a new page called "<title> (your version)", so nothing is lost.
6. Claude decided: a page can pop out as its own sticky on the desktop. Popped pages are not always on top and are not in the taskbar, so they behave like paper rather than windows. A page that was popped out comes back where you left it after a restart.
7. Claude decided: if a popped page is mostly off-screen and the monitor it was on is still attached, it is pulled back onto that monitor; if the monitor is gone it goes to the primary display.
8. Claude decided: popped page windows get a corner grip to resize them, because Windows can't resize a transparent window by its edges.
9. Claude decided: there are seven themes (classic yellow, mint, blush, sky, peach, and two dark ones, night and chalkboard). "Follow Windows dark mode" switches to the chosen dark theme while Windows is dark. Clippy's brain can change the look with `set_look`, and nothing else.
10. Claude decided: each page can have its own colour (yellow, mint, blush, sky or peach, the light papers), so pinned-out pages are easy to tell apart on the desktop.
11. Claude decided: Settings is a menu of sections (Pop-ups & sounds, Phone, Morning brief, Claude Code, Standing orders & watches, Look, Windows & hotkeys), each row saying what it is set to now. History moved into Settings from its own tab, and the empty Notes tab still links to it. Phone approvals live under Claude Code, with the hook they depend on.
12. Claude decided: the welcome is four steps (Claude Code, Look, Phone, Try it), each skippable. The "Try it" step uses a practice question that stays on the note and goes nowhere.
13. Claude decided: the one question the tour asks is answered locally; it is never stored or sent anywhere.
14. Claude decided: a Getting started list sits on the Pad (connect Claude Code, answer a question, tell Clippy something with the hotkey, snooze a note, set a standing order, pin a page, get a morning brief). Each item ticks itself, and you can close the list.
15. Claude decided: tips (a few one-time hints in Clippy's speech bubble) run for the first 14 days only, at most one an hour, and can be switched off in Settings → Look → Show tips. They only show while the note is open; a tip that can't show waits for its next trigger.
16. Claude decided: existing installs don't see the new welcome automatically (Settings → Windows & hotkeys → Run the welcome again brings it back), but they get the Getting started list and the tips for 14 days.
