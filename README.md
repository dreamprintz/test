# WA Campaign Manager

A Chrome extension (Manifest V3) for sending **personalised WhatsApp messages to people who agreed to hear from you**. You import a CSV, write a template with placeholders, review every recipient, then send. There are two ways to send:

| | **A. WhatsApp Web helper** (default) | **B. Official WhatsApp Business Platform (Cloud API)** |
|---|---|---|
| Setup | None | Meta Business account, approved templates, and the `backend/` server |
| How it sends | Opens each chat in WhatsApp Web with the message filled in. **You** press Send. | Your backend calls Meta's Cloud API. |
| What "Sent" means | You confirmed you pressed Send | Meta accepted the message (`wamid…` id) |
| Delivered / read | Not available | Yes, from webhooks |
| Runs in background | No, each message needs one click from you | Yes, rate-limited, survives closed tabs and browser restarts |

The helper never sends anything by itself. It doesn't script WhatsApp Web, read its DOM, or work around WhatsApp's limits. It only opens WhatsApp's own click-to-chat link (`web.whatsapp.com/send?phone=…&text=…`).

```
wa-campaign-manager/
├── extension/          React + TypeScript + Vite + Tailwind (MV3)
│   ├── src/lib/        Pure logic: CSV, phone normalisation, templates, audience, campaign state machine
│   ├── src/db/         IndexedDB (Dexie) repositories
│   ├── src/providers/  manual.ts (WhatsApp Web helper), cloudApi.ts (backend client)
│   ├── src/background/ Service worker: persistent Cloud API queue, delivery and opt-out sync
│   ├── src/pages/      Dashboard pages
│   ├── src/sidepanel/  WhatsApp Web helper panel
│   ├── src/popup/      Toolbar popup
│   └── e2e/            Playwright tests that load the built extension into Chromium
├── backend/            Express + TypeScript server for the official API (optional)
└── sample/contacts-sample.csv
```

---

## Quick start (extension)

Requirements: Node.js 20+ and Chrome 116+.

```bash
cd extension
npm ci
npm run build          # type-checks, then builds into extension/dist
```

Load it in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select `extension/dist`.
4. Pin **WA Campaign Manager** and click it, then click **Open dashboard**.

After a rebuild, click the ↻ reload icon on the extension card.

### First campaign (WhatsApp Web helper)

1. **Import Contacts**: drop `sample/contacts-sample.csv`. Check the column mapping, review the flagged rows, set the consent status, and import.
2. **Message Templates**: save the example template, or write your own with `{{name}}`, `{{course}}`, `{{registration_no}}` and any other CSV column.
3. **New Campaign**: pick the list and template, review the recipients and exclusions, then click **Review & start**.
4. On the campaign page click **Open helper**. In the side panel:
   **Open chat in WhatsApp Web** → check the message in WhatsApp and press **Send** there → **I sent it — next**.
   You need to be logged in at web.whatsapp.com.

Progress is saved after every step, so you can close the panel or restart Chrome and pick up where you left off.

---

## Features

**CSV import**
- Drag-and-drop with a choice of encoding (UTF-8, UTF-16, Windows-1252, ISO-8859-1). The delimiter (`,` `;` tab `|`) and a UTF-8 BOM are detected automatically.
- Mapping is detected automatically and can be changed. Name, first and last name, phone (WhatsApp, Mobile and Phone columns, in that priority), email, and custom fields. *Registration Number* / *Reg No* become `{{registration_no}}`.
- Shows the first 20 rows, then validates every row in a Web Worker (50,000 rows takes about 2 s without freezing the page).
- Phone numbers are normalised to E.164 with [libphonenumber-js](https://gitlab.com/catamphetamine/libphonenumber-js), using a configurable default country (**India, +91**). It handles `0` trunk prefixes, `00` international prefixes, and spaces, dashes and brackets. Spreadsheet scientific notation (`9.87E+09`) is rejected. Landlines get a warning.
- Flags invalid numbers, missing phones or names, bad emails, duplicates within the file, contacts you already have, and opted-out numbers.
- **Nothing is changed or dropped silently.** Each row shows its normalisation and any issues. Invalid and duplicate rows can be exported to CSV with the original data and the reasons. You choose which rows to import.

**Contacts and lists**
- Search, sort and filter by list or consent. Select one by one or select all eligible contacts.
- A contact can belong to several lists. Contacts are unique by phone number, so duplicates across lists merge into one contact.
- Re-importing either keeps the saved data or merges in non-empty values. Opt-outs are never changed by an import.
- Consent status with a source note. An **opt-out / suppression list** survives contact deletion and is applied to every campaign, both at launch and again just before each send.
- Edit and delete contacts, and export them to CSV.

**Templates**
- Placeholders for any field, with fallbacks: `{{name|there}}`. Emoji, line breaks, and WhatsApp formatting preview (`*bold*`, `_italic_`, `~strike~`).
- Live preview for any contact, a character count, and warnings for unknown placeholders and missing values.
- Save, duplicate and delete. A campaign keeps a frozen copy of its message, so editing a template later doesn't change campaign history.

**Campaigns**
- Create, edit drafts, duplicate and archive. Start, pause, resume and cancel, each with a confirmation.
- Before starting you can see every recipient, who is excluded and why, and the personalised message for each one.
- Live progress with pending, processing, sent, failed, skipped and outcome-unknown counts. Each recipient keeps a history and error details.
- **Safe retries** (see below), a CSV report export, and a campaign timeline and history.

**Privacy**: there's no analytics. CSV files never leave the browser. You can export all data as JSON, purge message content from finished campaigns, or delete everything.

---

## How retries avoid double-sending

Recipient states: `pending → processing → sent | failed | skipped | unknown`.

- Every Cloud API send carries an **idempotency key** (`campaignId:recipientId:generation`). The backend stores the result under that key **before and after** calling Meta. Repeating a request with the same key returns the stored result instead of sending again. Concurrent duplicates are serialised.
- If the extension loses the backend's response, or Chrome restarts mid-send, the recipient stays `processing`. The next run safely re-sends the same key and gets the original result back.
- Temporary Meta errors (rate limits `130429`/`80007`, `131000`, `131016`, `133004`, …) are retried with backoff, first inside the backend and then in the queue, and become `failed (retryable)` after 3 attempts. **Retry failed** requeues only these, plus helper failures you reported yourself.
- A timeout or dropped connection to Meta, or a backend crash mid-request, means the message *may* have gone out. Those become **`unknown`** and are **never retried automatically**. A recipient's details have a **Force resend…** action, which uses a new key and warns that the person might get the message twice.
- Permanent errors (for example `131026` undeliverable, or `132001` template missing) are not retried.

---

## Official API setup (optional)

The Meta access token lives **only** on your server. The extension only has your backend's URL and a separate access key that you create.

### 1. Meta side
1. Create an app at <https://developers.facebook.com/> and add the **WhatsApp** product.
2. In WhatsApp Manager, add and verify a business phone number. Note its **Phone number ID**.
3. Create a **System User** with the `whatsapp_business_messaging` permission and generate a permanent token.
4. Create and get approval for a **message template** (for example `registration_confirmation`) whose body uses `{{1}}`, `{{2}}`, …
5. Only message people who have **opted in** to WhatsApp messages from you, as the [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy) requires.

### 2. Run the backend
```bash
cd backend
npm ci
cp .env.example .env     # fill in the values (see comments in the file)
npm run build && npm start      # or: npm run dev
```

| Variable | Purpose |
|---|---|
| `BACKEND_API_KEY` | Shared secret the extension sends as a Bearer token (at least 24 characters) |
| `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID` | Cloud API credentials |
| `META_API_VERSION` | Graph API version (default `v23.0`; set it to a version currently supported by Meta) |
| `META_APP_SECRET` | Verifies the `X-Hub-Signature-256` header on webhooks (unsigned webhooks are rejected) |
| `META_WEBHOOK_VERIFY_TOKEN` | Token for Meta's webhook verification handshake |
| `OPT_OUT_KEYWORDS` | Whole-message replies recorded as opt-outs (default `STOP, STOP ALL, UNSUBSCRIBE, OPT OUT, OPTOUT`) |
| `DATA_DIR` | Where message state is stored (`store.json`, mode 600) |
| `ALLOWED_ORIGINS` | Optional CORS allow-list, e.g. `chrome-extension://<id>` |

Deploy it behind **HTTPS** (Render, Fly.io, Railway, a VM with Caddy or nginx, …) with a persistent disk for `DATA_DIR`. The store is a single-instance JSON file. To run several instances, replace `src/store.ts` with Postgres or Redis.

### 3. Webhooks
In the Meta app → WhatsApp → Configuration, set the callback URL to `https://<your-backend>/webhook`, enter your verify token, and subscribe to the **messages** field. This gives you:
- `sent` / `delivered` / `read` / `failed` statuses. Out-of-order events never downgrade a status.
- Inbound replies that exactly match an opt-out keyword. These are synced into the extension's suppression list on its next run, and the backend refuses to send to those numbers.

### 4. Connect the extension
Dashboard → **Settings → Official WhatsApp Business API**: enable it, enter the backend URL and access key, tick the data-sharing notice, and save. Chrome asks for permission to reach that host. **Test connection** checks the key and the configuration.

In **New Campaign**, choose *Official WhatsApp Business API*. Enter the approved template name and language, and map `{{1}}`, `{{2}}`, … to contact fields. Opt-in is required for this method. The service worker sends at your configured rate (on a 30-second alarm), so campaigns keep going after you close the dashboard and resume after Chrome restarts.

### Backend API (used by the extension)
All routes need `Authorization: Bearer <BACKEND_API_KEY>`.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/health` | | `{ ok, configured, apiVersion }` |
| POST | `/api/messages` | `{ idempotencyKey, to: "9198…", template: { name, language, bodyParams[] } }` | `{ key, status: accepted\|failed\|unknown\|in_progress, providerMessageId?, deliveryStatus?, error?: { code, message, retryable } }` |
| POST | `/api/messages/status` | `{ keys: string[] }` (≤ 500) | `{ messages: [...] }` |
| GET | `/api/optouts?since=<ms>` | | `{ optouts: [{ phone, at }] }` |
| GET/POST | `/webhook` | Meta verification / events (signature checked) | |

---

## Development and testing

```bash
# from the repo root
npm run install:all
npm test            # unit + integration tests (extension: Vitest + fake-indexeddb; backend: Vitest + real HTTP server)
npm run build
npm run e2e         # loads extension/dist into Chromium with Playwright (needs a Chromium; set CHROMIUM_PATH if Playwright's isn't installed)
```

- `extension/e2e/smoke.mjs` imports the sample CSV, adds an opt-out, saves a template, then runs a helper campaign: open chat, confirm sent, report a failure, retry. It also checks that progress survives a reload, exports a report, and opens dark mode and the popup. WhatsApp Web is stubbed, so nothing is sent.
- `extension/e2e/cloud.mjs` starts the real backend with a **mocked Meta API** (`backend/e2e/mock-meta-server.ts`), runs a Cloud API campaign in the background, delivers a signed `read` webhook and a `STOP` reply, and checks they reach the extension.
- `npm run dev` in `extension/` serves the dashboard at `http://localhost:5173/dashboard.html` for UI work. Chrome APIs fall back to `localStorage`, and the helper and background queue only work in the real extension.

Unit tests cover CSV parsing and mapping, phone normalisation, template rendering, suppression filtering, campaign and recipient status transitions, retry eligibility, the Cloud API queue (idempotency, backoff, unknown outcomes, opt-out-after-launch, pause), backend idempotency and crash recovery, Meta error classification, webhook signatures, and status and opt-out handling.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Settings, and the helper's tab and campaign selection |
| `alarms` | Wakes the service worker to continue Cloud API campaigns |
| `sidePanel` | The WhatsApp Web helper panel |
| `unlimitedStorage` | Large contact lists in IndexedDB |
| Optional host permission | Only your backend's origin, requested when you save the API settings |

No content scripts, no `tabs` permission, and no access to WhatsApp Web pages.

## Troubleshooting

| Problem | Fix |
|---|---|
| Columns look garbled (`Ã©`, `�`) | Choose a different **encoding** on the import page (Excel often uses Windows-1252 or UTF-16). |
| All numbers invalid | Check **Settings → Default country**. Numbers stored by Excel as `9.87E+09` must be re-exported with the column formatted as Text. |
| "Map exactly one column to Phone" | Two columns are mapped to Phone, or none is. Fix it in the mapping row. |
| Helper opens WhatsApp but the text is empty | Log in to WhatsApp Web first. If the number isn't on WhatsApp, WhatsApp shows an error, so choose **Couldn't send → Number is not on WhatsApp**. |
| Side panel doesn't open | Use **Helper window** on the campaign page (opens the same helper in a small window). Needs Chrome 116+. |
| Cloud campaign stays *pending* | Check that **Settings → Test connection** works. The campaign auto-pauses on auth errors and shows why. Resume after fixing. Chrome wakes the queue every 30 s. |
| Recipient shows *Outcome unknown* | Check the conversation in WhatsApp Manager or your phone. Use **Force resend…** only if it wasn't received. |
| `132001` / `132000` errors | The template name, language or number of parameters doesn't match the approved template. |
| `131047` | Re-engagement: free-form messages need an open 24-hour window. Use an approved template. |
| `131026` | The recipient can't receive the message (not on WhatsApp, old app version, or blocked you). |
| Webhooks don't arrive | The backend must be public HTTPS, `META_APP_SECRET` must be set (otherwise every webhook gets 401), and the **messages** field must be subscribed. |

## Responsible use

Message only people who opted in, honour opt-outs immediately, and follow the WhatsApp Business Messaging and Commerce policies and local law (for example India's DPDP Act 2023, GDPR). This project deliberately doesn't automate WhatsApp Web or bypass rate limits or anti-spam measures.
