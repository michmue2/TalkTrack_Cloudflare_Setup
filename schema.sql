-- VoiceCost Tracker – D1 schema
-- Run once: wrangler d1 execute voice-cost-tracker-db --file=schema.sql

CREATE TABLE IF NOT EXISTS categories (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    icon       TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS expenses (
    id                      TEXT PRIMARY KEY,
    amount                  REAL NOT NULL,
    note                    TEXT NOT NULL,
    category_id             TEXT REFERENCES categories(id),
    date                    TEXT NOT NULL,  -- ISO-8601
    created_at              TEXT NOT NULL,
    raw_transcript          TEXT NOT NULL DEFAULT '',
    status                  TEXT NOT NULL DEFAULT 'confirmed',
    source                  TEXT NOT NULL DEFAULT 'voice',
    categorization_source   TEXT NOT NULL DEFAULT 'regex',
    recurring_expense_id    TEXT,
    account_id              TEXT,
    account_name            TEXT,
    synced_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_defaults (
    id             TEXT PRIMARY KEY,
    category_id    TEXT REFERENCES categories(id),
    monthly_amount REAL NOT NULL,
    effective_from TEXT NOT NULL,
    created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_overrides (
    id             TEXT PRIMARY KEY,
    category_id    TEXT REFERENCES categories(id),
    monthly_amount REAL NOT NULL,
    year           INTEGER NOT NULL,
    month          INTEGER NOT NULL,
    created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recurring (
    id                  TEXT PRIMARY KEY,
    amount              REAL NOT NULL,
    note                TEXT NOT NULL,
    category_id         TEXT REFERENCES categories(id),
    cadence             TEXT NOT NULL,
    start_date          TEXT NOT NULL,
    end_date            TEXT,
    last_generated_date TEXT,
    is_active           INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    model      TEXT,
    created_at TEXT NOT NULL
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_ai_requests_user     ON ai_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_requests_date     ON ai_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_requests_user_date ON ai_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_expenses_date        ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_expenses_category    ON expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_expenses_status      ON expenses(status);
CREATE INDEX IF NOT EXISTS idx_budget_overrides_ym  ON budget_overrides(year, month);
