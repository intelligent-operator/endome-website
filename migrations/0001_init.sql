-- 0001_init.sql — initial multi-user schema
-- Apply via: wrangler d1 migrations apply endome-db --remote

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Users
-- One row per account. For now there's a single hardcoded login (endome)
-- and the worker auto-provisions a row on first authenticated request.
-- When signup ships, additional rows are inserted by the registration flow.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT    PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE,
  display_name  TEXT,
  timezone      TEXT    NOT NULL DEFAULT 'UTC',
  created_at    INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- daily_logs — one row per (user, calendar date) with morning + evening data
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_logs (
  user_id              TEXT    NOT NULL,
  log_date             TEXT    NOT NULL,           -- YYYY-MM-DD (local)
  morning_mood         INTEGER,                    -- 1..5
  morning_energy       INTEGER,                    -- 1..5
  morning_pain         INTEGER,                    -- 1..5
  morning_sleep_hours  REAL,
  morning_notes        TEXT,
  morning_logged_at    INTEGER,
  evening_overall      INTEGER,                    -- 1..5
  evening_reflection   TEXT,
  evening_gratitude    TEXT,
  evening_logged_at    INTEGER,
  points_total         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, log_date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_daily_logs_user_date
  ON daily_logs(user_id, log_date DESC);

-- ---------------------------------------------------------------------------
-- symptoms — individual symptom entries logged through the day
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS symptoms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL,
  log_date    TEXT    NOT NULL,                    -- denormalised for fast filters
  logged_at   INTEGER NOT NULL,
  symptom     TEXT    NOT NULL,                    -- pain, fatigue, bloating, nausea, cramps, headache, mood, other
  severity    INTEGER NOT NULL CHECK(severity BETWEEN 1 AND 5),
  location    TEXT,
  notes       TEXT,
  points      INTEGER NOT NULL DEFAULT 5,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_symptoms_user_date
  ON symptoms(user_id, log_date DESC, logged_at DESC);

-- ---------------------------------------------------------------------------
-- pets — current EndoPet state per user
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pets (
  user_id       TEXT    PRIMARY KEY,
  pet_type      TEXT    NOT NULL DEFAULT 'luna',   -- luna|poppy|mochi|sunny|coco|kiki
  pet_name      TEXT    NOT NULL DEFAULT 'Luna',
  level         INTEGER NOT NULL DEFAULT 1,
  xp            INTEGER NOT NULL DEFAULT 0,
  mood          TEXT    NOT NULL DEFAULT 'happy',  -- happy|neutral|sad
  streak_days   INTEGER NOT NULL DEFAULT 0,
  last_log_date TEXT,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- notifications — system-generated notifications shown in the bell dropdown
-- (time-based reminders are computed client-side and not persisted)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  type          TEXT    NOT NULL,                  -- info|reminder|achievement
  title         TEXT    NOT NULL,
  body          TEXT,
  action_url    TEXT,
  created_at    INTEGER NOT NULL,
  read_at       INTEGER,
  dismissed_at  INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_active
  ON notifications(user_id, dismissed_at, created_at DESC);
