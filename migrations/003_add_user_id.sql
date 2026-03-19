-- Migration 003: add user_id column and users table

-- Users table (one row per Supabase user)
CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,   -- Supabase user UUID (JWT sub claim)
    trial_start_at  TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

-- Add user_id to all data tables
ALTER TABLE expenses         ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE categories       ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE budget_defaults  ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE budget_overrides ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE recurring        ADD COLUMN user_id TEXT NOT NULL DEFAULT '';

-- Indexes for user-scoped queries
CREATE INDEX IF NOT EXISTS idx_expenses_user        ON expenses(user_id);
CREATE INDEX IF NOT EXISTS idx_categories_user      ON categories(user_id);
CREATE INDEX IF NOT EXISTS idx_budget_defaults_user ON budget_defaults(user_id);
CREATE INDEX IF NOT EXISTS idx_recurring_user       ON recurring(user_id);
