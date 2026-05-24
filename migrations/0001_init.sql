-- 0001_init.sql — full schema for EndoMe.
-- Apply once after creating the D1 database:
--   wrangler d1 migrations apply endome-db --remote
-- or paste the file contents into the D1 → Console tab in the dashboard.

PRAGMA foreign_keys = ON;

-- ===========================================================================
-- USERS
-- One row per account. Currently the worker auto-provisions the single
-- "endome" login on first authenticated request; the signup flow will add
-- more rows later. Everything else is keyed off users.id.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS users (
  id            TEXT    PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE,
  display_name  TEXT,
  timezone      TEXT    NOT NULL DEFAULT 'UTC',
  created_at    INTEGER NOT NULL
);

-- ===========================================================================
-- DAILY_LOGS
-- One row per (user, calendar date) with morning + evening + cycle data.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS daily_logs (
  user_id              TEXT    NOT NULL,
  log_date             TEXT    NOT NULL,                       -- YYYY-MM-DD
  -- morning check-in
  morning_mood          INTEGER CHECK(morning_mood    BETWEEN 1 AND 5),
  morning_energy        INTEGER CHECK(morning_energy  BETWEEN 1 AND 5),
  morning_pain          INTEGER CHECK(morning_pain    BETWEEN 1 AND 5),
  morning_sleep_hours   REAL,
  morning_sleep_quality INTEGER CHECK(morning_sleep_quality BETWEEN 1 AND 5),
  morning_notes         TEXT,
  morning_logged_at     INTEGER,
  -- evening check-in
  evening_overall       INTEGER CHECK(evening_overall BETWEEN 1 AND 5),
  evening_reflection    TEXT,
  evening_gratitude     TEXT,
  water_glasses         INTEGER,
  movement_level        TEXT,                                  -- none|light|moderate|vigorous
  bowel_count           INTEGER,
  bowel_type            TEXT,                                  -- constipated|normal|loose
  stress_level          INTEGER CHECK(stress_level BETWEEN 1 AND 5),
  intimacy              TEXT,                                  -- none|comfortable|uncomfortable
  medications           TEXT,
  evening_logged_at     INTEGER,
  -- cycle / female-health
  cycle_day             INTEGER,
  cycle_phase           TEXT,                                  -- menstrual|follicular|ovulation|luteal
  flow                  TEXT,                                  -- none|spotting|light|medium|heavy
  bbt                   REAL,                                  -- basal body temp °C
  cervical_mucus        TEXT,                                  -- dry|sticky|creamy|watery|eggwhite
  breast_tenderness     INTEGER CHECK(breast_tenderness BETWEEN 0 AND 5),
  -- gamification
  points_total          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, log_date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_daily_logs_user_date
  ON daily_logs(user_id, log_date DESC);

-- ===========================================================================
-- SYMPTOMS
-- Individual symptom entries logged through the day (many per day per user).
-- log_date is denormalised so range queries don't need a JOIN.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS symptoms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL,
  log_date    TEXT    NOT NULL,
  logged_at   INTEGER NOT NULL,
  symptom     TEXT    NOT NULL,
  severity    INTEGER NOT NULL CHECK(severity BETWEEN 1 AND 5),
  location    TEXT,
  triggers    TEXT,                                            -- comma-separated tags
  relief      TEXT,                                            -- comma-separated tags
  notes       TEXT,
  points      INTEGER NOT NULL DEFAULT 5,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_symptoms_user_date
  ON symptoms(user_id, log_date DESC, logged_at DESC);

CREATE INDEX IF NOT EXISTS idx_symptoms_user_symptom_date
  ON symptoms(user_id, symptom, log_date DESC);

-- ===========================================================================
-- PETS
-- Current EndoPet state per user (1:1 with users).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS pets (
  user_id       TEXT    PRIMARY KEY,
  pet_type      TEXT    NOT NULL DEFAULT 'luna',               -- luna|poppy|mochi|sunny|coco|kiki
  pet_name      TEXT    NOT NULL DEFAULT 'Luna',
  level         INTEGER NOT NULL DEFAULT 1,
  xp            INTEGER NOT NULL DEFAULT 0,
  mood          TEXT    NOT NULL DEFAULT 'happy',              -- happy|neutral|sad
  streak_days   INTEGER NOT NULL DEFAULT 0,
  last_log_date TEXT,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ===========================================================================
-- NOTIFICATIONS
-- Server-generated notifications shown in the bell dropdown. (Time-based
-- reminders for morning/evening check-ins are computed client-side.)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  type          TEXT    NOT NULL,                              -- info|reminder|achievement
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
