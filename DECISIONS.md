# Decisions

## Professor Clippy — 2026-10-30

Grilled in chat (T3 Code question forms).

1. Clippy's own chat brain is Claude running headless through Claude Code in the background (your Claude Code login, no separate API key).
2. Agents hand messages to Clippy through an MCP server (tools like `leave_message`, `remind_me`, `ask_user`).
3. Clippy handles notes/notifications, one-off scheduled reminders, recurring reminders, and questions that need an answer.
4. The window is always on top, collapses to a mini Clippy in a corner when idle, and expands with a wiggle on a new message.
5. Look: an original paperclip professor (googly eyes, mortarboard, glasses) clipped to a yellow sticky note, animated in SVG/CSS.
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
