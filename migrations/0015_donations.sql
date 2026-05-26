-- 0015_donations.sql — research crowdfunding donations.
-- The worker also creates this at runtime via ensureDonationsSchema().

CREATE TABLE IF NOT EXISTS donations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            TEXT,                                     -- nullable: anonymous donations allowed
  donor_name         TEXT,                                     -- shown on the leaderboard (or "Anonymous")
  donor_message      TEXT,
  amount_cents       INTEGER NOT NULL,
  currency           TEXT    NOT NULL DEFAULT 'aud',
  stripe_session_id  TEXT,
  status             TEXT    NOT NULL DEFAULT 'pending',       -- pending | succeeded | failed
  created_at         INTEGER NOT NULL,
  completed_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_donations_status  ON donations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_donations_user    ON donations(user_id, status);
CREATE INDEX IF NOT EXISTS idx_donations_session ON donations(stripe_session_id);
