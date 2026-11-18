# Nexus

A self-hosted second brain for a household. It combines what Obsidian, Tana and Notion each do best, and adds a shared calendar so you and your partner see the same schedule.

| From | What you get |
| --- | --- |
| **Obsidian** | Plain Markdown notes, `[[wikilinks]]` with automatic backlinks, renaming a note updates every link to it, a graph view, folders, daily notes, a command palette, and importing an existing vault. |
| **Tana** | `#supertags` with typed fields (`key:: value`), templates for each tag, inline properties, and outliner bullets that fold. |
| **Notion** | Every tag is a live **database**, viewable as a table (sortable, filterable, editable in place) or a **board** you can drag cards across. Also slash commands and callouts. |
| **Extras** | Spaced-repetition **flashcards** for cert prep, tasks with due dates on the calendar, **homelab health checks**, and a **household calendar** with Google and Outlook sync. |

Nexus is one Node.js process (its only npm dependencies are the official Anthropic SDK and Zod, used by Ask Claude) with the SQLite built into Node: FTS5 full-text search, WAL mode and prepared statements. The frontend is vanilla JavaScript with no build step, and assets are precompressed with Brotli. With 5,000 notes, every API call takes under 35 ms and search takes about 20 ms.

---

## Quick start

### Unraid

See **[unraid/README.md](unraid/README.md)**. It covers a ready-made Docker template, prebuilt images on GHCR, Tailscale or Cloudflare remote access, and backups.

### Docker (recommended for a home server)

```bash
cd nexus
docker compose up -d --build
# open http://<server-ip>:8080
```

### Plain Node (needs Node ≥ 22.13)

```bash
cd nexus
npm start            # http://localhost:8080
npm run dev          # same, restarts on change
npm test             # unit tests
```

On first visit you create the first account. **Settings → Household members** adds your partner. Each of you gets your own calendar and color. Notes are shared with the whole household unless you mark one 🔒 private.

All data lives in a single SQLite file, `data/nexus.db`.

---

## Writing notes

| Type | Result |
| --- | --- |
| `[[Note title]]`, `[[Note#Heading]]`, `[[Note\|alias]]` | A link. The target note gets a backlink. Clicking a link to a missing note creates it. |
| `#tag` | A tag. It shows up under **Databases** in the sidebar. |
| `status:: studying` | A property. It becomes a column in that tag's database. |
| `- [ ] Renew TLS cert @2026-12-01 14:00` | A task that appears in **Tasks** and on the **calendar**. |
| `What is LRS? ?? Locally redundant storage` | A flashcard. |
| `Q: …` on one line, then `A: …` on the next | Also a flashcard. |
| `> [!tip] Title` | A callout. `warning`, `danger`, `info` and `question` also work. |
| `/` at the start of a line | Slash menu: headings, to-dos, tables, code, callouts, properties, cards and supertag templates. |

Keyboard shortcuts: **Ctrl/⌘ K** search and commands · **Ctrl/⌘ N** new note · **Ctrl/⌘ D** today's daily note · **Ctrl/⌘ E** switch between edit and read · **Ctrl/⌘ Enter** toggle a to-do · **Tab / Shift-Tab** indent.

### Supertags (databases)

These supertags come preconfigured:

| Tag | Use | Fields |
| --- | --- | --- |
| `#cert` | Certification prep | provider, status, exam date, score, expires |
| `#kb` | Job knowledge base | system, owner, status, reviewed |
| `#service` | Homelab services | url, host, port, stack, status, backup |
| `#runbook` | Homelab procedures | service, last run |
| `#meeting` | Meeting notes | date, attendees |

You can add your own with **＋** next to *Databases*. Editing a cell in a table, or dragging a card on a board, rewrites the `key:: value` line in the note. That keeps the Markdown file as the single source of truth.

### Homelab monitoring

Any note tagged `#service` that has a `url::` property is pinged every 2 minutes. The check accepts self-signed certificates. Status and latency appear on the Home page and in the service database.

### Flashcards

**Review** uses an SM-2 style scheduler with four grades: Again, Hard, Good and Easy, on keys 1–4. You can study all due cards, or cram the cards in a single note. A card keeps its review schedule when you edit its answer.

---

## Ask Claude

**✨ Ask Claude** in the sidebar is a chat with Claude that can work with everything in Nexus. You can also click ✨ on any note to ask about that note, or type a question in Ctrl+K and pick *Ask Claude*. For example:

- *"What's on our calendar this week?"* or *"Add a dentist appointment for Sarah next Tuesday at 3pm."*
- *"Quiz me on my AZ-104 notes"* or *"Make flashcards from this note."*
- *"Which homelab services are down, and what do my runbooks say to do?"*
- *"Turn my notes on resetting MFA into a #kb article."*

**Web access:** Claude can also search the web and read web pages, for example *"What changed in the latest Proxmox release?"* or *"Find the current AZ-104 exam objectives and update my study plan."* Answers that use the web end with a list of **Sources**.
- These searches run on Anthropic's side, so nothing new is exposed on your server.
- Web pages are treated as untrusted: Claude won't edit your notes or calendar because a page told it to.
- Set `CLAUDE_WEB=off` to keep it to notes and calendar only.
- Web search may need to be enabled for your organization in the Anthropic Console (**Settings → Privacy**) before it works.

Claude acts as whoever is signed in. It sees only the notes that person can see, so private notes stay private. It can search, read, create and append to notes, make small find-and-replace edits, read the calendar and add events, including to a connected Google or Outlook calendar. It has no tools for deleting anything. When it creates or changes something, the chat says so and links to it.

**Setup:** create an API key at [console.anthropic.com](https://console.anthropic.com/settings/keys), add credits under **Billing**, and set `ANTHROPIC_API_KEY` on the container.
- A Claude.ai Pro or Max subscription **can't** be used here. Apps call Claude through Anthropic's API, which is a separate pay-as-you-go account.
- Set a monthly **spend limit** in the Console so the cost can never surprise you.

**Cost:** each question is billed by the amount of text sent and received. With the default model (Claude Opus 5.5) a typical question costs roughly 3–15¢. Questions that read many long notes cost more. The Unraid container's log (Docker → Nexus → Logs) prints the token count for every question.
- To spend less, set `CLAUDE_MODEL` to `claude-sonnet-5-5` (about half the price) or `claude-haiku-5-5` (much cheaper, less capable).
- `CLAUDE_EFFORT` (`low`, `medium` or `high`) controls how hard it thinks.

**Privacy:** the notes and events Claude reads to answer a question are sent to Anthropic's API. Nothing is sent until someone asks Claude something. If a note is too sensitive for that, keep it out of the conversation, or don't enable Ask Claude.

**How it works:** Nexus uses the official Anthropic SDK's tool runner on the Messages API. The conversation loop runs on your own server, and the chat history stays in your browser.

## Capture from your phone

There are two ways to get thoughts into Nexus without opening it. Either way, short thoughts land in **today's daily note under "Inbox"** with the time. Longer memos become their own note in the **Inbox** folder. Tasks with a date also appear on the calendar.

### 1. Claude app connector (voice or text, with AI)
Nexus is an MCP server, so you can add it as a **custom connector** in Claude:
1. On claude.ai, go to **Settings → Connectors → Add custom connector**.
2. Enter the URL `https://YOUR-HOST/mcp` (also shown in **Nexus → Settings → Phone & Claude app**).
3. Click **Connect**, sign in to Nexus, and click **Allow**.

The connector then shows up in the Claude app on your phone. Ask for things in plain language:

- *"Save to Nexus: idea for the garage shelves…"*
- *"Add tasks to replace the UPS battery Friday and call the vet."*
- *"What did I write about the NAS layout?"*
- *"Put the parent-teacher conference on our calendar Tuesday at 4."*

You can talk to Claude using dictation (the mic on the keyboard) or voice mode.

Claude can use the same tools as Ask Claude: capture, search and read notes, create and append to notes, and read or add calendar events. It acts as the person who connected it. Each household member connects their own Claude account, and you can disconnect it any time in Settings.

> **Cloudflare Access users:** Anthropic's servers call the connector directly, so add a **Bypass** policy for these paths: `/mcp`, `/.well-known/*`, `/oauth/*` and `/api/capture`. They're still protected by Nexus's own sign-in and tokens.

### 2. Siri / Shortcuts quick capture (no AI, instant)
1. Go to **Settings → Phone & Claude app → Create capture token**.
2. Build the 4-step iPhone Shortcut shown there: *Dictate Text → Get Contents of URL*, which sends a POST to `/api/capture` with `Authorization: Bearer <token>`.
3. Run it by saying *"Hey Siri, Nexus note"*, or put it on your Action Button or Home Screen.

Starting a note with "remind me to…", "todo…" or "task…" saves it as a task. Any tool that can send an HTTP request works too, for example Android HTTP shortcuts or scripts:

```bash
curl -X POST https://YOUR-HOST/api/capture -H "Authorization: Bearer nxp_…" -H "content-type: application/json" -d '{"text":"Look into a Tailscale exit node"}'
```

## Shared calendar

- **Month, Week and Agenda** views. You can filter each person and the shared *Household* calendar on or off.
- Each event has **Who** chips. **⚠ marks a conflict**: one person booked twice at the same time.
- Repeating events: daily, weekdays, weekly, biweekly, monthly and yearly. You can delete a single occurrence.
- **Meeting notes** on an event creates a linked `#meeting` note.
- Daily notes show that day's agenda in the side panel.

### Getting events onto your phones (no setup)

**Settings → Household feed** gives you a private ICS URL. Subscribe to it in Google Calendar (*Other calendars → From URL*), Outlook (*Add calendar → Subscribe from web*) or iOS (*Settings → Calendar → Accounts → Add Subscribed Calendar*). The feed leaves out the subscriber's own Google/Outlook events to avoid duplicates.

### Pulling in calendars you already have

| Option | Direction | Setup |
| --- | --- | --- |
| **Subscribe to ICS URL** | read-only | None. Google: *Settings → your calendar → Secret address in iCal format*. Outlook: *Settings → Calendar → Shared calendars → Publish a calendar*. |
| **Connect Google Calendar** | two-way | OAuth app (below) |
| **Connect Outlook / Microsoft 365** | two-way | OAuth app (below) |

Two-way calendars sync every 10 minutes and whenever you click **Sync**. Events you create or edit in Nexus are pushed to Google/Outlook straight away. **Choose calendar** lets you point the sync at a shared "Family" calendar instead of your primary one.

### Calendar integrations (OAuth)

Google and Microsoft only accept sign-in redirects to **https** URLs or `localhost`. Put Nexus behind HTTPS first, for example with Caddy, Nginx Proxy Manager, Traefik, Tailscale Serve or a Cloudflare Tunnel, and set `PUBLIC_URL` to that address.

**Google**
1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a project, and enable the **Google Calendar API**.
2. Set up the **OAuth consent screen** as External and add both of your Google accounts as test users. Then click **Publish app**. While the app stays in *Testing*, Google expires refresh tokens after 7 days. An unverified app still works for your own accounts; you just click past a warning.
3. Go to **Credentials → Create credentials → OAuth client ID → Web application**. Add this redirect URI: `https://YOUR-HOST/api/oauth/google/callback`
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then restart.

**Outlook / Microsoft 365**

Microsoft registers every app inside an Entra "directory". Work and school accounts already have one. A **personal** Outlook.com, Hotmail or Live account doesn't, so do step 0 first.

0. *(Personal accounts only)* Go to [azure.microsoft.com/free](https://azure.microsoft.com/free) and sign up with your Microsoft account. That creates a "Default Directory" for you. Signup usually asks for a phone number and a card for identity verification. App registrations themselves are free.
1. Go to [entra.microsoft.com](https://entra.microsoft.com) (or portal.azure.com) → **App registrations → New registration**:
   - **Name:** `Nexus`
   - **Supported account types:** pick **Personal Microsoft accounts only** for Outlook.com/Hotmail. Pick *Any organizational directory and personal Microsoft accounts* to also allow work accounts.
   - **Redirect URI:** platform **Web**, address `https://YOUR-HOST/api/oauth/outlook/callback`
2. On the **Overview** page, copy the **Application (client) ID**. That's `MS_CLIENT_ID`.
3. Go to **Certificates & secrets → New client secret** (24 months). Copy the **Value** column right away; that's `MS_CLIENT_SECRET`. Don't copy the "Secret ID", which is a different thing. The secret expires, so set a reminder to replace it.
4. Go to **API permissions → Add a permission → Microsoft Graph → Delegated permissions** and add `Calendars.ReadWrite`, `offline_access` and `User.Read`. Personal accounts don't need admin consent.
5. Set `MS_CLIENT_ID` and `MS_CLIENT_SECRET`. Then set `MS_TENANT` to match the account type you chose in step 1:
   - **Personal accounts only:** `consumers` (required)
   - **Work and personal:** `common` (the default)
   - **One organization only:** that organization's tenant ID

   Restart Nexus.
6. In Nexus, go to **Settings → Calendars → Connect Outlook / Microsoft 365** and sign in. You should see a row labeled *Outlook · two-way · synced just now*. If you'd previously added the same calendar as an ICS link, delete that row so events don't appear twice.

**Check it works:** create an event in Nexus on the calendar marked **(outlook)**. It should appear in Outlook within seconds. Then create one in Outlook and click **Sync** in Nexus; it should appear there. Edits and deletes made in Nexus are sent to Outlook straight away. Changes made in Outlook arrive at the next sync, which runs every 10 minutes or when you click Sync.

| Error | Fix |
| --- | --- |
| `AADSTS50011` (redirect URI mismatch) | The redirect address in step 1 must exactly match `PUBLIC_URL` + `/api/oauth/outlook/callback`. |
| `AADSTS50020` / `unauthorized_client` / "not enabled for consumers" | `MS_TENANT` doesn't match the account type chosen in step 1 (see step 5). |
| `invalid_client` / `AADSTS7000215` | The secret is wrong or has expired. Create a new one and paste its **Value**. |

**No-setup alternative:** if you'd rather skip the app registration, use two read-only links instead.
- **Outlook → Nexus:** in outlook.com, go to *Settings → Calendar → Shared calendars → Publish a calendar → ICS link*, and add that link in Nexus with **Subscribe to ICS URL**.
- **Nexus → Outlook:** in outlook.com, go to *Add calendar → Subscribe from web* and paste the Nexus **Household feed** link.

The catches: Outlook only refreshes subscribed calendars every few hours, and neither side can edit the other's events.

> Some employers block third-party apps on work Microsoft 365 accounts. If yours does, publish your work calendar as ICS and use **Subscribe to ICS URL**.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `DATA_DIR` | `./data` | Location of `nexus.db` |
| `PUBLIC_URL` | (derived from request) | External https URL. Required for OAuth, and enables `Secure` cookies. |
| `TZ` | system | Time zone for ICS events that have no zone ("floating" times) |
| `ANTHROPIC_API_KEY` | — | Turns on **Ask Claude** |
| `CLAUDE_MODEL` / `CLAUDE_EFFORT` | `claude-opus-5-5` / `medium` | Model and thinking effort for Ask Claude |
| `CLAUDE_WEB` | `on` | Let Ask Claude search the web and read pages (`off` to disable) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google Calendar sync |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_TENANT` | — / — / `common` | Outlook sync |
| `SYNC_MINUTES` | `10` | Interval for calendar pulls |
| `HEALTH_SECONDS` | `120` | Interval for service health checks |
| `BACKUP_KEEP` | `14` | Nightly snapshots kept in `DATA_DIR/backups`. `0` turns them off. |
| `COOKIE_SECURE` | auto | Cookies are marked `Secure` when a request arrives over HTTPS (directly or through a proxy's `X-Forwarded-Proto`). Set to `1` to force it. |

## Backup

Everything is in `data/nexus.db` (with `-wal`/`-shm` files next to it while the server runs). Nexus also writes a consistent snapshot to `data/backups/` every night. To make one yourself:

```bash
sqlite3 data/nexus.db ".backup 'nexus-$(date +%F).db'"   # safe while running
# or: Settings → Export everything (JSON), or download single notes as .md
```

## Phones

Open the site on your phone and choose **Add to Home Screen**. It installs as an app, with shortcuts to *Today's note* and *Calendar*. The layout adapts to small screens, and the calendar defaults to the Agenda view.

## Migrating

**Settings → Import folder** accepts an Obsidian vault or an unzipped Notion "Markdown & CSV" export:
- Folders are kept.
- YAML frontmatter becomes `key:: value` properties and `#tags`.
- `.obsidian/` and `.trash/` are skipped.
- The ID suffixes Notion adds to file names are removed.

## Architecture

```
server.js          HTTP server, REST API, SSE live updates, auth, health checks, ICS feed
lib/db.js          SQLite schema (FTS5, WAL) + derived indexes (links, tags, fields, tasks, cards)
lib/parse.js       Markdown → links / tags / properties / tasks / flashcards
lib/calendar.js    ICS, Google Calendar & Microsoft Graph sync (pull + push)
lib/ics.js         RFC 5545 parser/generator      lib/rrule.js  DST-correct recurrence expansion
public/            SPA: app.js (views), editor.js, md.js (renderer), calendar.js, graph.js (canvas)
```

- **Live sync:** when one person edits a note, the other sees the change immediately over Server-Sent Events.
- **Conflict handling:** if both of you edit the same note at once, the second save is rejected with a conflict banner rather than silently overwriting.
- **Connector auth:** OAuth 2.1 with PKCE (S256 only) and dynamic client registration. Access tokens last 7 days, refresh tokens 180 days and rotate on every use. All tokens are stored as SHA-256 hashes, and consent requires a same-origin form post.
- **Security:** passwords are hashed with scrypt; session cookies are HttpOnly and SameSite; state-changing requests are checked for same origin; login is rate-limited; Markdown output is escaped.
