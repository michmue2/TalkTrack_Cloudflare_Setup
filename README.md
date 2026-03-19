# VoiceCost Tracker – Cloudflare Worker

A serverless REST API that stores a cloud copy of your VoiceCost data so AI
agents, dashboards, and other tools can query it at any time — even when your
iPhone is off.

---

## One-time Cloudflare Setup

### 1. Create a free Cloudflare account

Go to <https://dash.cloudflare.com/sign-up> and sign up (free tier is plenty).

### 2. Install Wrangler CLI

```bash
npm install -g wrangler
wrangler login          # opens browser to authorise
```

### 3. Create the D1 database

```bash
cd cloudflare
wrangler d1 create voice-cost-tracker-db
```

Wrangler prints something like:

```
✅ Created D1 database 'voice-cost-tracker-db'
database_id = "abc123-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Copy the `database_id`** and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding       = "DB"
database_name = "voice-cost-tracker-db"
database_id   = "abc123-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   # ← paste here
```

### 4. Create the schema

```bash
wrangler d1 execute voice-cost-tracker-db --file=schema.sql
```

### 5. Set secrets

Choose a strong random string for each (e.g. `openssl rand -hex 32`).
These are never stored in the repo — Cloudflare holds them as encrypted secrets.

```bash
wrangler secret put WRITE_SECRET
# paste your write secret and press Enter

wrangler secret put READ_API_KEY
# paste your read API key and press Enter
```

> **WRITE_SECRET** – used by the iOS app to push data. Keep it private.
> **READ_API_KEY** – share this with AI agents / scripts that need to read data.

### 6. Deploy

```bash
wrangler deploy
```

Wrangler prints your worker URL:

```
https://voice-cost-tracker.<your-account>.workers.dev
```

Copy this URL — you'll enter it in the app's **Settings → Export & API** screen.

---

## Configuring the iOS App

Open VoiceCost → Settings → Export & API:

| Field | Value |
|---|---|
| Worker URL | `https://voice-cost-tracker.<your-account>.workers.dev` |
| Write Secret | the `WRITE_SECRET` you set above |
| Read API Key | the `READ_API_KEY` you set above |

Toggle **Cloudflare Sync** on, then tap **Sync Now**.

---

## API Reference

All read endpoints require:

```
Authorization: Bearer <READ_API_KEY>
```

### GET /expenses

```
GET /expenses?from=2025-01-01&to=2025-12-31&category=Groceries&account=Personal&status=confirmed&limit=100&offset=0
```

Query parameters:

| Parameter | Description |
|---|---|
| `from` | Start date `YYYY-MM-DD` (inclusive) |
| `to` | End date `YYYY-MM-DD` (inclusive) |
| `category` | Filter by category name |
| `account` | Filter by account name (e.g. `Personal`, `Work`) |
| `status` | `confirmed` or `pending` |
| `limit` | Max results (default 500) |
| `offset` | Pagination offset (default 0) |

Returns `{ expenses: [...], count, limit, offset }`.

Each expense object includes:
```json
{
  "id": "uuid",
  "amount": 12.50,
  "currency_code": "USD",
  "note": "Coffee",
  "category_name": "Dining",
  "account_id": "uuid",
  "account_name": "Personal",
  "status": "confirmed",
  "created_at": "2025-03-15T08:30:00Z"
}
```

### GET /expenses/:id

Returns a single expense object or `404`.

### GET /categories

Returns `{ categories: [...] }`.

### GET /budgets

```
GET /budgets?year=2025&month=3
```

Returns `{ budget_defaults: [...], budget_overrides: [...] }`.

### GET /recurring

Returns `{ recurring: [...] }`.

### GET /summary

```
GET /summary?month=2025-03&account=Personal
```

Query parameters:

| Parameter | Description |
|---|---|
| `month` | `YYYY-MM` format (required) |
| `account` | Filter by account name (optional — omit for all accounts combined) |

Returns totals by category, overall total, and budget amounts for that month.

```json
{
  "month": "2025-03",
  "total": 1240.50,
  "count": 42,
  "by_category": [
    { "category": "Groceries", "total": 320.00, "count": 12 }
  ],
  "budgets": [
    { "category": "Groceries", "budget": 400.00 }
  ]
}
```

### GET /export/csv

Downloads a combined CSV file with all expenses, budgets, and recurring entries. The expenses section includes `account_id` and `account_name` columns.

---

## Using with AI Agents

### Live endpoint

```
Base URL:  https://voice-cost-tracker.michaelmuller3.workers.dev
Auth:      Authorization: Bearer <READ_API_KEY>
```

### Accounts

The app supports multiple spending accounts (e.g. "Personal", "Work"). To list
all accounts and their expenses separately, query `/expenses` and inspect the
`account_name` field, or pass `?account=<name>` to filter.

To check which accounts exist, fetch all expenses and collect distinct
`account_name` values — or request a summary without an account filter and
cross-reference with per-account summaries.

### Example tool definitions (Claude)

```json
[
  {
    "name": "get_spending_summary",
    "description": "Get spending totals by category for a given month, optionally filtered to one account",
    "parameters": {
      "month":   { "type": "string", "description": "YYYY-MM format" },
      "account": { "type": "string", "description": "Account name, e.g. Personal or Work. Omit for all accounts." }
    }
  },
  {
    "name": "get_expenses",
    "description": "List individual expenses with optional filters",
    "parameters": {
      "from":     { "type": "string", "description": "Start date YYYY-MM-DD" },
      "to":       { "type": "string", "description": "End date YYYY-MM-DD" },
      "category": { "type": "string", "description": "Filter by category name" },
      "account":  { "type": "string", "description": "Filter by account name" },
      "limit":    { "type": "integer", "description": "Max results (default 500)" }
    }
  }
]
```

### Example calls

```bash
# Summary for Personal account, March 2025
curl -H "Authorization: Bearer $READ_API_KEY" \
  "https://voice-cost-tracker.michaelmuller3.workers.dev/summary?month=2025-03&account=Personal"

# All Work expenses in Q1 2025
curl -H "Authorization: Bearer $READ_API_KEY" \
  "https://voice-cost-tracker.michaelmuller3.workers.dev/expenses?from=2025-01-01&to=2025-03-31&account=Work"

# All expenses across all accounts this month
curl -H "Authorization: Bearer $READ_API_KEY" \
  "https://voice-cost-tracker.michaelmuller3.workers.dev/expenses?from=2025-03-01&to=2025-03-31"
```

---

## Local Development

```bash
wrangler dev --local
```

This runs the worker locally at `http://localhost:8787` with a local D1 instance.

---

## Redeployment

After any code change:

```bash
wrangler deploy
```

No schema changes are needed unless you add new tables.
