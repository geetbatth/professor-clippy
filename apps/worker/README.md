# @clippy/worker: the WhatsApp relay

A Cloudflare Worker and one SQLite-backed Durable Object (`ClippyDO`). It is the only public piece of Professor Clippy. It:

- receives Meta's WhatsApp webhook,
- holds the Meta token and sends messages to your WhatsApp,
- queues your replies until the desktop app collects them,
- fires synced reminders while the PC is off.

The protocol with the desktop app lives in `packages/shared/src/relay.ts`.

## Routes

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /webhook` | `hub.verify_token` | Meta's verify handshake. Echoes `hub.challenge` when `hub.mode=subscribe` and the token equals `VERIFY_TOKEN`, else 403. |
| `POST /webhook` | `X-Hub-Signature-256` | HMAC-SHA256 of the raw body with `APP_SECRET`, compared in constant time (403 on mismatch). Every message from `MY_NUMBER` (any type) moves the 24 h window; only text messages are queued for the PC. Other senders and status updates are ignored. A valid signature always gets 200. |
| `POST /send` | Bearer `PC_SECRET` | `{text, kind, urgent?}` → `{waId, mode}`. 400 on a bad body, 502 `{error}` if Meta refuses. |
| `PUT /reminders/:id` | Bearer `PC_SECRET` | `{body, dueAt, rrule?, tz?}` → 204. Creates or replaces the reminder (see the re-sync rule below). 400 on a bad body, RRULE or `tz`. |
| `DELETE /reminders/:id` | Bearer `PC_SECRET` | → 204. Deleting an unknown id is not an error. |
| `GET /ws` | Bearer `PC_SECRET` | WebSocket upgrade (426 without `Upgrade: websocket`). |
| `GET /health` | none | `{ok:true}` |

A missing or wrong bearer gets 401. Unknown paths get 404.

### Sending

- Graph calls time out after 10 s.
- Every message goes to `MY_NUMBER` from `PHONE_NUMBER_ID` through `POST https://graph.facebook.com/<GRAPH_API_VERSION>/<PHONE_NUMBER_ID>/messages`. The version (`v24.0`) is the single constant `GRAPH_API_VERSION` in `src/whatsapp.ts`.
- **Free-form text** is used when your last inbound WhatsApp message was less than 24 h ago. Newlines are kept. Text is cut at Meta's 4096-character limit, ending with `…more on desktop`.
- **Otherwise the `clippy_note` template** is used, with `{{1}}` set to the note text. Meta rejects template parameters that contain newlines, tabs or more than 4 spaces in a row (error 132018), so the text is changed first:
  - each line is trimmed,
  - blank lines are dropped,
  - the remaining lines are joined with ` · `,
  - every whitespace run becomes one space.

  The result is then cut by `templateParam()` to at most 1000 characters, ending with `…more on desktop`.
- If Meta answers a free-form send with 131047 (the window has closed), the message is retried once as the template.

### Reminders

- The Durable Object's alarm is always set to the earliest `dueAt` (or pending send retry). The alarm is re-armed even if processing throws.
- When the alarm fires, every due reminder is sent to WhatsApp as `⏰ <body>` (with the same free-form or template choice as above), and a `reminder-fired` item is queued for the PC.
- One-off reminders are then deleted. Recurring ones move to their next occurrence after now, so occurrences missed while overdue are skipped and fire only once.
- **Send failures:** a transient failure (network error or 10 s timeout, HTTP 429 or 5xx, or Meta codes 1, 2, 4, 80007, 130429, 131016) keeps the reminder and retries it after 1, 4, 10 and 15 minutes: 5 attempts over about 30 minutes. After the last attempt, or at once on any other 4xx (bad token, template or number), the firing is recorded without `waId` and the error is logged.
- If a PUT or DELETE for the same reminder lands while its send is in flight, the alarm does not advance or delete the new row.
- **Re-sync rule:** a PUT for an existing recurring reminder with the same `rrule` and `tz` and a `dueAt` that is already past only updates the body; the Worker keeps its own (already advanced) schedule, so the PC re-syncing a stale `dueAt` never causes a duplicate firing. Any other PUT replaces the reminder and makes `dueAt` the new anchor.

RRULEs are handled by the `rrule` package, which bundles for Workers. The semantics match the desktop scheduler:

- `DTSTART` is the `dueAt` that set the schedule. A `DTSTART` line (and any `TZID`) inside the string is ignored, so `COUNT` counts from that PUT.
- The rule runs on **floating local wall time** in the reminder's `tz` (IANA, for example `America/Los_Angeles`; UTC when absent). `dueAt` is converted to its wall time in `tz`, `rrule` iterates on that, and each result is converted back to an instant. So `BYHOUR=9` means 09:00 local, and a weekday 09:00 rule stays at 09:00 across DST.
- A wall time skipped by spring-forward moves forward by the gap; an ambiguous fall-back time takes the earlier instant. The next occurrence is always strictly after now, including inside the repeated hour.
- Allowed `FREQ`: `HOURLY`, `DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY`. `SECONDLY`, `MINUTELY` and `BYSECOND` are rejected with 400, as are a non-positive `INTERVAL` or `COUNT`. `RRULE:` prefixes are accepted; `BYDAY`, `BYHOUR`, `BYMINUTE`, `UNTIL` and the rest work as `rrule` implements them.

### Durable Object storage (SQLite)

| Table | Holds |
| --- | --- |
| `outbox` | Worker→PC frames not yet acked, in delivery order. Each reminder firing is its own frame, with id `<reminderId>:<firedAt>`. |
| `reminders` | `id, body, due_at, rrule, tz, dtstart, attempts, retry_at` |
| `kv` | `lastInboundAt` (epoch ms of your latest inbound WhatsApp message) |
| `sent` | wamid → kind of every message sent, pruned after 30 days |
| `seen` | inbound wamids already handled, pruned after 7 days, so Meta's webhook retries are not delivered twice |

## Secrets

Set each secret with `npx wrangler secret put <NAME>` from `apps/worker`. **Never commit their values.** For `wrangler dev`, put them in `apps/worker/.dev.vars`, which is git-ignored.

| Secret | Value |
| --- | --- |
| `META_TOKEN` | Permanent system-user access token with `whatsapp_business_messaging` (step 5 below). |
| `APP_SECRET` | Meta app secret (App settings → Basic). This is the webhook signature key. |
| `VERIFY_TOKEN` | Any long random string you choose. Enter the same string in Meta's webhook settings. |
| `PC_SECRET` | Long random string, for example `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Enter the same value as `workerSecret` in the desktop settings. |
| `PHONE_NUMBER_ID` | The **Phone number ID** of the sending number (WhatsApp → API Setup). This is not the phone number itself. |
| `MY_NUMBER` | Your own WhatsApp number in international format, digits only, for example `447700900123`. It is the only recipient and the only accepted sender. |

## The `clippy_note` template

Submit this in WhatsApp Manager → Message templates, or with `POST https://graph.facebook.com/v24.0/<WABA_ID>/message_templates` and the system-user token:

```json
{
  "name": "clippy_note",
  "language": "en",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Professor Clippy has a note for you:\n\n{{1}}\n\nReply here to talk to Clippy.",
      "example": { "body_text": [["Tests failed on the payments service · see CI run 4812"]] }
    }
  ]
}
```

- The language must be `en` (English), because the Worker sends `language.code = "en"`.
- Meta doesn't accept a template that starts or ends with a variable, which is why `{{1}}` sits between fixed text.
- Wait for the status to become **Approved** before relying on the out-of-window sends.

## Meta setup, step by step

1. **Create the app.** At <https://developers.facebook.com/apps>, choose Create app → use case "Connect with customers through WhatsApp" (type Business) and attach your business portfolio.
2. **Get the test number.** In the app, go to WhatsApp → API Setup. Meta gives you a free test number. Note its **Phone number ID** (`PHONE_NUMBER_ID`) and the **WhatsApp Business Account ID** (WABA ID, needed for the template).
3. **Verify your phone as a recipient.** On the same page, open the "To" field → Manage phone number list → add your number and enter the code WhatsApp sends you. A test number can only message verified recipients (up to 5).
4. **Get the app secret.** Go to App settings → Basic → App secret → Show. This value is `APP_SECRET`.
5. **Create a permanent token.** In Meta Business Suite → Settings → Users → System users:
   - Add a system user with the Admin role.
   - Click Assign assets and give it the app (full control) and the WhatsApp account (full control).
   - Click Generate new token, select the app, set expiry to **Never**, and tick `whatsapp_business_messaging` and `whatsapp_business_management`.
   - The token is `META_TOKEN`. The temporary 24 h token on the API Setup page is not suitable.
6. **Submit the template** above and wait for approval.
7. **Deploy the Worker.** This is your own step; nothing in this repo deploys automatically. From `apps/worker`, run `npx wrangler login`, then `npx wrangler secret put` for each secret, then `npx wrangler deploy`. Note the URL, for example `https://professor-clippy-relay.<you>.workers.dev`.
8. **Subscribe the webhook.** In the app, go to WhatsApp → Configuration → Webhook → Edit:
   - Callback URL: `https://professor-clippy-relay.<you>.workers.dev/webhook`
   - Verify token: your `VERIFY_TOKEN`
   - Click Verify and save, then under Webhook fields subscribe to **`messages`**.
9. **Connect the desktop app.** In the desktop settings, set `workerUrl` to the Worker URL and `workerSecret` to `PC_SECRET`.
10. **Test it.** Send any WhatsApp message from your phone to the test number. This opens the 24 h free-form window, and the desktop app should receive it.

## Development

```sh
npm test -w apps/worker            # unit + workerd route/DO tests (Graph API mocked)
npm run typecheck -w apps/worker
npx wrangler deploy --dry-run      # bundle check, never uploads
```
