-- 0009_endopet_economy.sql
-- Apply each statement one at a time in the D1 Console.

ALTER TABLE pets ADD COLUMN glow_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pets ADD COLUMN distinct_log_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pets ADD COLUMN last_meaningful_log_at INTEGER;
ALTER TABLE pets ADD COLUMN rest_mode_until INTEGER;

CREATE TABLE IF NOT EXISTS endopet_inventory (
  user_id      TEXT    NOT NULL,
  item_key     TEXT    NOT NULL,
  quantity     INTEGER NOT NULL DEFAULT 1,
  equipped     INTEGER NOT NULL DEFAULT 0,
  acquired_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_endopet_inv_user ON endopet_inventory(user_id, acquired_at DESC);

CREATE TABLE IF NOT EXISTS endopet_reward_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  source_type   TEXT    NOT NULL,
  source_id     TEXT    NOT NULL,
  xp_awarded    INTEGER NOT NULL DEFAULT 0,
  glow_awarded  INTEGER NOT NULL DEFAULT 0,
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (user_id, source_type, source_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_endopet_ledger_user_date ON endopet_reward_ledger(user_id, created_at DESC);
