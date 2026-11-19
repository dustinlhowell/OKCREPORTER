# Ledger

A self-hosted household budget that runs next to Nexus on your Unraid server. It does envelope budgeting without physical envelopes: every dollar gets a job, and every purchase you log on your phone comes out of one of those jobs.

It comes set up for **November 2026 – December 2027**: the last two months of 2026, then all of 2027. You can extend the range at any time in **Settings → Budget**, and everything carries over.

## What it does (and where the idea came from)

| Feature | Borrowed from |
| --- | --- |
| **Zero-based monthly budget.** Plan income, give every dollar a category until *Left to budget* reaches **$0**. | EveryDollar, YNAB |
| **Envelopes.** Each category shows planned, spent and remaining. Turn on **roll over** for a category and leftovers carry into next month, while overspending comes out of it. That's a true envelope or sinking fund. Categories without roll over start fresh each month. | YNAB, Goodbudget |
| **Fully customizable layout.** Add, rename, recolor, reorder, archive or delete groups and categories. Give categories emoji, notes, default amounts, due days, savings goals, and alternate names for quick add. | all of them |
| **Move money** between categories to cover overspending. Each move is recorded in the activity log. | YNAB |
| **Plan tools.** Copy last month, use last month's actual spending, use the 3-month average, use defaults, fund goals, copy this month to the rest of the year, or clear the month. | EveryDollar, Monarch |
| **Year plan grid.** All 14 months side by side, like a spreadsheet. Type in amounts to plan; switch between Planned, Actual and Remaining. | spreadsheet budgets |
| **Debt snowball.** Debts are paid **smallest balance → largest**, and interest is ignored. Ledger shows the focus debt, what to pay each month, each debt's payoff month, and your debt-free date. A what-if slider shows the effect of extra money. A paid-off debt's minimum rolls onto the next one. **Put plan in budget** fills the Debt lines for you. | Dave Ramsey / EveryDollar |
| **Bills & paydays.** Schedules can be monthly, every two weeks, twice a month, weekly, yearly or one-time. Tap *Paid* to record one, or use **autopay** to have it record itself on the date. You can skip one occurrence, and you get reminders before due dates. | Rocket Money, Simplifi |
| **Calendar views.** **Month** shows spending, bills, paydays, debt due dates, and your cash balance at the end of each day. **Agenda** shows the next 14–90 days with a cash-flow forecast chart and your lowest point. **Year** is a heatmap of daily spending. | Simplifi, Copilot |
| **Quick add from your phone.** Use the home-screen app, a Siri shortcut, or the Claude app. Entries you make offline are saved and sync later. Ledger remembers which category each payee belongs in. | Copilot, Goodbudget |
| **Needs-category inbox.** Anything logged without a category waits on Home until you file it. | Copilot, Monarch |
| **Split transactions, refunds, transfers, multiple accounts, reconciling** against your bank balance, and a **net worth** total. | YNAB, Actual |
| **Bank CSV import.** Map the columns once; duplicates are skipped, known payees are categorized automatically, and bills are matched and marked paid. | Actual, Monarch |
| **Reports.** Income vs spending, where the money went, planned vs actual, top categories and top payees. | Monarch |
| **Household.** You and your partner each have a login and see the same budget. Changes show up live on the other phone, and every transaction records who entered it. | Goodbudget, Monarch |
| **Alerts.** A daily bill digest, warnings when a category runs low or goes over, a nudge to plan next month, a celebration when a debt is paid off, and a warning when cash is projected to dip below $0. Delivered through ntfy, Pushover or email. | Rocket Money |
| **Reliability.** Nightly backups, optional encrypted off-server backups, CSV/JSON export, an activity log, undo on delete, and two-step sign-in. | the Nexus setup |

## Daily use

- **Log a purchase:** tap **＋**. Type the amount, tap a category chip (each chip shows what's left in it), and save. You can also type everything in one line, like `42.50 costco groceries`, and Ledger fills in the rest. A toast tells you what's left, for example *“$69 left in Groceries”*.
- **Start of each month:** open Budget for the next month → **Plan tools → Copy last month's plan** → adjust until *Left to budget* is $0. Around the 25th you'll get a reminder.
- **Overspent?** Tap the category → **Move money** from a category that has money left.
- **Paid a bill?** Tap **Paid** next to it on Home or the calendar. If you'd rather log it with **＋**, choose the bill's category and Ledger links the payment to the bill automatically.
- **Debt payment?** Go to Debt snowball → **Log payment**, or log it under that debt's line in the Debt group.

## Phone setup

1. **Home-screen app:** open Ledger in Safari → Share → **Add to Home Screen**. On Android you can long-press the icon for an **Add transaction** shortcut; on iPhone, `https://YOUR-HOST/#/add` opens straight to it.
2. **Claude app (talk or type):** on claude.ai go to **Settings → Connectors → Add custom connector**, enter `https://YOUR-LEDGER-HOST/mcp`, click Connect, sign in to Ledger, and click Allow. It works the same way as the Nexus connector. Then you can say:
   - *“I spent $38 at Target on clothes.”*
   - *“How much is left for restaurants?”*
   - *“What bills are due this week?”*
   - *“Move $40 from fun money to groceries.”*
   - *“How's my debt snowball?”*
3. **Siri / Action Button (no AI, instant):**
   1. In **Settings → Phone & Claude app**, tap **Create token**.
   2. Build a Shortcut: *Dictate Text* → *Get Contents of URL*. Set it to `POST https://YOUR-HOST/api/spend`, with the header `Authorization: Bearer <token>` and a JSON body field `text` set to the dictated text. Finish with *Show Result*.
   3. Now *“Hey Siri, log spending… twelve fifty Starbucks coffee”* answers back with what's left.

   To check a balance, use `GET /api/spend/status?category=groceries` with the same token.

> **Cloudflare Access users:** add a Bypass policy for `/mcp`, `/.well-known/*`, `/oauth/*`, `/api/spend*` and `/ics/*`, the same as for Nexus. Those paths are still protected by Ledger's own tokens.

## Bills on your calendar (and in Nexus)

**Settings → Calendar feed** gives you a private ICS link with bills, paydays and debt due dates. Paid items show a ✅. You can subscribe to it in two places:
- **Nexus:** go to **Settings → Calendars → Subscribe to ICS URL**. Bills then appear on the household calendar next to everything else.
- **Your phone's calendar:** unpaid bills come with an alert at 9 am the day before they're due.

## Running it

### Unraid

1. **Image:** `.github/workflows/ledger-image.yml` builds `ghcr.io/dustinlhowell/ledger` whenever something under `ledger/` changes. The default branch gets `:latest`. The first time, set the package to Public: GitHub → Packages → ledger → Package settings → Change visibility.
2. **Install the template.** In the Unraid terminal, run:
   ```bash
   mkdir -p /boot/config/plugins/dockerMan/templates-user /mnt/user/appdata/ledger
   wget -qO /boot/config/plugins/dockerMan/templates-user/my-Ledger.xml \
     https://raw.githubusercontent.com/dustinlhowell/OKCREPORTER/HEAD/ledger/unraid/ledger.xml
   ```
3. Go to **Docker → Add Container → Template: Ledger** and click **Apply**. Open `http://tower:8091` and create your account. Unraid passes your time zone (`TZ`) automatically. Ledger uses it to decide what "today" is.
4. **Remote access:** use the same method you use for Nexus (Tailscale or a Cloudflare Tunnel). Set **Public URL** to that https address so the Claude connector and notification links work.

### Docker / plain Node

```bash
cd ledger
docker compose up -d --build      # http://<server>:8091
# or: npm install && npm start    # Node ≥ 22.13, http://localhost:8080
npm test                          # unit tests for the budget math, snowball, recurrence and parsing
```

## How the numbers work

- **Remaining** = carried in (roll-over categories only) + planned − spent. Refunds reduce spending.
- **Left to budget** = income planned − everything planned (including savings and debt). The goal each month is $0.
- **Debt snowball:** each month's total stays the same. It's every minimum (including minimums from debts already paid off) plus your extra. Minimums are paid first; everything left goes to the smallest balance, then cascades to the next. Payments you've already made this month count toward this month. When a lender adds interest or fees, use **Update balance** or **Add charge**.
- **Cash balance / forecast:** checking, savings and cash accounts (not credit cards). Past days use real transactions. Future days subtract unpaid bills and debt minimums and add expected paydays.
- **Accounts** are optional. Without them, everything goes into “Checking”. Use **Reconcile** to match your bank's balance.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `DATA_DIR` | `./data` | Where `ledger.db` and `backups/` live |
| `TZ` | system | Your time zone: decides “today”, due dates and reminder times |
| `PUBLIC_URL` | (from request) | External https URL, used for the Claude connector and links in notifications |
| `BACKUP_KEEP` | `14` | Nightly snapshots to keep (`0` = off) |
| `BACKUP_PASSPHRASE` | — | Encrypts off-server backups (required for cloud) |
| `BACKUP_S3_ENDPOINT` / `_BUCKET` / `_REGION` / `_KEY_ID` / `_SECRET` / `_PREFIX` | — / — / `us-east-1` / — / — / `ledger` | Off-server backups to Backblaze B2, R2, S3, MinIO… |
| `BACKUP_COPY_DIR` / `BACKUP_REMOTE_KEEP` | — / `30` | Also copy encrypted backups to this folder; how many off-server copies to keep |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — / `587` | Email notifications |
| `PUSHOVER_TOKEN` | — | Pushover notifications |

**ntfy** needs no server setup: each person pastes their topic URL in **Settings → Notifications**.

## Backup & restore

Every night Ledger writes `data/backups/ledger-YYYY-MM-DD.db`, a consistent snapshot. **Settings → Backups** has a *Back up now* button, a CSV export of transactions, and a full JSON export.

- **Restore:** stop the container and copy a snapshot over `data/ledger.db`.
- **Encrypted off-server copies:** decrypt with `node scripts/decrypt-backup.mjs ledger-2026-11-19.db.enc ledger.db`.

## Architecture

```
server.js        HTTP server, REST API, auth (scrypt, sessions, TOTP), SSE live updates, autopay, alerts,
                 backups, ICS feed, MCP connector (OAuth 2.1 + PKCE) and the Siri endpoint
lib/budget.js    Pure logic shared with the browser: envelope math, debt snowball, recurrence, quick-entry parser, CSV
lib/db.js        SQLite schema (built into Node: WAL, foreign keys)
lib/tools.js     Claude connector tools
public/          Vanilla-JS PWA: app.js (shell, home, transactions, quick add, settings), budgetview.js,
                 calendar.js, debts.js, bills.js, reports.js, charts.js (SVG)
```

Money is stored as integer cents. The app has one npm dependency, a QR-code generator for the two-step sign-in setup.
