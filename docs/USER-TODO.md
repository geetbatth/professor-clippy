# Your to-do list: setting Professor Clippy up for real

Everything here is a step only you can do (accounts, secrets, clicking Install). Do it in this
order. The Meta and Cloudflare steps are explained in detail, with screenshots of where to click
described, in [`apps/worker/README.md`](../apps/worker/README.md); this page is the checklist.

Skipping WhatsApp? Do sections 1, 5 and 6 only, and choose "Skip WhatsApp for now" in the wizard.

## 1. On this PC

- [ ] `node --version` prints v24 or later, in a **new** terminal (Claude Code runs the Clippy
      MCP server and hook with `node`).
- [ ] Claude Code is installed and signed in: run `claude` once and log in.
- [ ] Build the installer from the repo root: `npm ci`, then `npm run package`.
      It ends with `apps\desktop\release\Professor-Clippy-Setup-0.1.0.exe`.

## 2. Meta (WhatsApp Cloud API)

Details: [apps/worker/README.md → Meta setup, step by step](../apps/worker/README.md#meta-setup-step-by-step).

- [ ] Create a Meta app (use case "Connect with customers through WhatsApp", type Business).
- [ ] WhatsApp → API Setup: note the test number's **Phone number ID** and the **WhatsApp
      Business Account ID**.
- [ ] Add **your phone** as a recipient of the test number and enter the code WhatsApp sends.
- [ ] App settings → Basic: copy the **App secret**.
- [ ] Business settings → System users: create an Admin system user, assign it the app and the
      WhatsApp account, and generate a token that **never expires** with
      `whatsapp_business_messaging` and `whatsapp_business_management`.
- [ ] Submit the **`clippy_note`** utility template (exact JSON in the worker README, language
      `en`) and wait until it says **Approved**. Its body is exactly
      `Professor Clippy has a note for you:` / blank line / `{{1}}` / blank line /
      `Reply here to talk to Clippy.` (Meta won't approve a body that starts or ends with
      `{{1}}`, so it isn't the shorter "Professor Clippy 📎: {{1}}" of decision 18.)

## 3. Cloudflare (the relay Worker)

From `apps\worker` in the repo:

- [ ] Have a Cloudflare account (the free plan is enough).
- [ ] `npx wrangler login`
- [ ] Make two long random strings, one for `PC_SECRET` and one for `VERIFY_TOKEN`:
      `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (run it twice).
- [ ] Set the six secrets, one `npx wrangler secret put <NAME>` each (if wrangler offers to create
      the Worker, say yes):
  - `META_TOKEN`: the never-expiring system-user token
  - `APP_SECRET`: the Meta app secret
  - `VERIFY_TOKEN`: your random string
  - `PC_SECRET`: your other random string (you paste it into Clippy later)
  - `PHONE_NUMBER_ID`: the test number's Phone number ID (not the phone number)
  - `MY_NUMBER`: your WhatsApp number, digits only, with country code (e.g. `447700900123`)
- [ ] `npx wrangler deploy`, and note the URL, e.g. `https://professor-clippy-relay.<you>.workers.dev`.
- [ ] Open `https://professor-clippy-relay.<you>.workers.dev/health`: it should say `{"ok":true}`.

## 4. Point Meta at the Worker

- [ ] Meta app → WhatsApp → Configuration → Webhook → Edit: callback URL
      `https://professor-clippy-relay.<you>.workers.dev/webhook`, verify token = your
      `VERIFY_TOKEN`. Click **Verify and save**.
- [ ] Under Webhook fields, subscribe to **`messages`**.

## 5. Install the app

- [ ] Run `Professor-Clippy-Setup-0.1.0.exe`. It is unsigned, so SmartScreen says "Windows
      protected your PC": click **More info → Run anyway**. No admin prompt; it starts by itself.
- [ ] In the first-run wizard:
  - [ ] Paste the Worker URL and your `PC_SECRET`, then **Connect WhatsApp** (or skip).
  - [ ] Choose sounds, unsolicited advice and start with Windows.
  - [ ] **Connect Claude Code…**, read the list of changes, then **Looks good, install**.
  - [ ] **Finish**.

## 6. Check it works

- [ ] In a **new** Claude Code session, ask: "Leave me a note via Professor Clippy saying hello."
      Clippy pops up with it (and it arrives on WhatsApp).
- [ ] Send any WhatsApp message to the test number. It opens the 24 h window and Clippy answers.
- [ ] Ask an agent to `ask_user` something, then quote-reply to it on WhatsApp: the agent gets
      your answer.
- [ ] By hand, since the automated tests can't: start a real fullscreen app (game, video,
      slideshow) and check Clippy hides and comes back; drag mini Clippy around with the mouse,
      including while a new note arrives, and check he lets go when you do.

## Known limitations & security notes

- **Prompt injection.** Clippy's brain can read files in your home folder (your choice, decision 11)
  and search the web, but it can't open web pages: `WebFetch` is blocked, because fetching a URL
  with data in it is the easiest way for a crafted WhatsApp or agent message to send a file out.
  Search queries are still a narrow channel; to close it too, remove `WebSearch` from
  `ALLOWED_TOOLS` and `BUILTIN_TOOLS` in `apps/desktop/src/main/brain/brain.ts` and rebuild.
- **Meta's test number** only messages verified numbers (up to 5), shows as a test sender, may be
  limited or changed by Meta, and outside the 24 h window can only send the approved template.
- **The installer is unsigned**, hence the SmartScreen warning.
- **The fullscreen-hide check runs a PowerShell child that uses `Add-Type`** (to call
  `SHQueryUserNotificationState`). Some antivirus tools flag that; turn off "Hide during
  fullscreen apps" in Settings and it never runs.
- **Failed WhatsApp sends aren't retried across app restarts** (only 5 tries over about 12
  minutes while the app runs). The note itself stays on the desk.
- **Real fullscreen apps and real mouse drags** are only checked by hand (section 6).
