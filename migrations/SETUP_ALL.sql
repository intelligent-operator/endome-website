-- ===========================================================================
-- EndoMe — full D1 schema in one file.
--
-- Two ways to apply this:
--
-- A. Recommended — `wrangler` CLI from your laptop:
--      cd endome-website
--      npx wrangler d1 migrations apply endome-db --remote
--    That runs every migration in `migrations/` in order. Safe to re-run
--    (every CREATE / ALTER uses IF NOT EXISTS or is guarded by the worker).
--
-- B. Manual — Cloudflare dashboard → D1 → endome-db → Console.
--    The console runs ONE statement at a time. Paste each block below,
--    one block per query, in order. The ALTER TABLE blocks will error if
--    the column already exists ("duplicate column name") — that's fine,
--    just skip and move to the next.
--
-- Tables created here:
--   users, login_otp, daily_logs, symptoms, pets, notifications,
--   story_progress, endopet_inventory, endopet_reward_ledger,
--   endopet_achievements, endopet_quest_completions,
--   circles, circle_members, circle_posts, circle_replies, circle_reactions,
--   friendships, medications, medication_logs, documents.
-- ===========================================================================

-- ---------- Users + auth ----------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT    PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE,
  display_name  TEXT,
  timezone      TEXT    NOT NULL DEFAULT 'UTC',
  created_at    INTEGER NOT NULL
);
ALTER TABLE users ADD COLUMN email             TEXT;
ALTER TABLE users ADD COLUMN password_hash     TEXT;
ALTER TABLE users ADD COLUMN password_salt     TEXT;
ALTER TABLE users ADD COLUMN dna_ordered_at    INTEGER;
ALTER TABLE users ADD COLUMN dna_results_at    INTEGER;
ALTER TABLE users ADD COLUMN bloods_ordered_at INTEGER;
ALTER TABLE users ADD COLUMN bloods_results_at INTEGER;
ALTER TABLE users ADD COLUMN map_ordered_at    INTEGER;
ALTER TABLE users ADD COLUMN map_results_at    INTEGER;
ALTER TABLE users ADD COLUMN alias             TEXT;
ALTER TABLE users ADD COLUMN avatar            TEXT;
ALTER TABLE users ADD COLUMN bio               TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS login_otp (
  challenge   TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL,
  code_hash   TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_login_otp_user_recent ON login_otp(user_id, created_at DESC);

-- ---------- Daily logs + symptoms ----------
CREATE TABLE IF NOT EXISTS daily_logs (
  user_id              TEXT    NOT NULL,
  log_date             TEXT    NOT NULL,
  morning_mood          INTEGER,
  morning_energy        INTEGER,
  morning_pain          INTEGER,
  morning_sleep_hours   REAL,
  morning_sleep_quality INTEGER,
  morning_notes         TEXT,
  morning_logged_at     INTEGER,
  evening_overall       INTEGER,
  evening_reflection    TEXT,
  evening_gratitude     TEXT,
  water_glasses         INTEGER,
  movement_level        TEXT,
  bowel_count           INTEGER,
  bowel_type            TEXT,
  stress_level          INTEGER,
  intimacy              TEXT,
  medications           TEXT,
  evening_logged_at     INTEGER,
  cycle_day             INTEGER,
  cycle_phase           TEXT,
  flow                  TEXT,
  bbt                   REAL,
  cervical_mucus        TEXT,
  breast_tenderness     INTEGER,
  points_total          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, log_date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
ALTER TABLE daily_logs ADD COLUMN evening_symptoms TEXT;
ALTER TABLE daily_logs ADD COLUMN appetite         TEXT;
CREATE INDEX IF NOT EXISTS idx_daily_logs_user_date ON daily_logs(user_id, log_date DESC);

CREATE TABLE IF NOT EXISTS symptoms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL,
  log_date    TEXT    NOT NULL,
  logged_at   INTEGER NOT NULL,
  symptom     TEXT    NOT NULL,
  severity    INTEGER NOT NULL,
  location    TEXT,
  triggers    TEXT,
  relief      TEXT,
  notes       TEXT,
  points      INTEGER NOT NULL DEFAULT 5,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
ALTER TABLE symptoms ADD COLUMN pain_type TEXT;
CREATE INDEX IF NOT EXISTS idx_symptoms_user_date         ON symptoms(user_id, log_date DESC, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_symptoms_user_symptom_date ON symptoms(user_id, symptom, log_date DESC);

-- ---------- Notifications ----------
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  body          TEXT,
  action_url    TEXT,
  created_at    INTEGER NOT NULL,
  read_at       INTEGER,
  dismissed_at  INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_active ON notifications(user_id, dismissed_at, created_at DESC);

-- ---------- EndoPet ----------
CREATE TABLE IF NOT EXISTS pets (
  user_id       TEXT    PRIMARY KEY,
  pet_type      TEXT    NOT NULL DEFAULT 'luna',
  pet_name      TEXT    NOT NULL DEFAULT 'Luna',
  level         INTEGER NOT NULL DEFAULT 1,
  xp            INTEGER NOT NULL DEFAULT 0,
  mood          TEXT    NOT NULL DEFAULT 'happy',
  streak_days   INTEGER NOT NULL DEFAULT 0,
  last_log_date TEXT,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
ALTER TABLE pets ADD COLUMN hatched_at             INTEGER;
ALTER TABLE pets ADD COLUMN color_seed             INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pets ADD COLUMN hunger                 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pets ADD COLUMN happiness              INTEGER NOT NULL DEFAULT 100;
ALTER TABLE pets ADD COLUMN last_fed_at            INTEGER;
ALTER TABLE pets ADD COLUMN last_played_at         INTEGER;
ALTER TABLE pets ADD COLUMN glow_points            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pets ADD COLUMN distinct_log_days      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pets ADD COLUMN last_meaningful_log_at INTEGER;
ALTER TABLE pets ADD COLUMN rest_mode_until        INTEGER;
ALTER TABLE pets ADD COLUMN last_cleaned_at        INTEGER;
ALTER TABLE pets ADD COLUMN meals_since_clean      INTEGER NOT NULL DEFAULT 0;

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

CREATE TABLE IF NOT EXISTS endopet_achievements (
  user_id         TEXT    NOT NULL,
  achievement_key TEXT    NOT NULL,
  unlocked_at     INTEGER NOT NULL,
  glow_reward     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, achievement_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_endopet_ach_user ON endopet_achievements(user_id, unlocked_at DESC);

CREATE TABLE IF NOT EXISTS endopet_quest_completions (
  user_id      TEXT    NOT NULL,
  quest_key    TEXT    NOT NULL,
  period       TEXT    NOT NULL,
  completed_at INTEGER NOT NULL,
  glow_reward  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, quest_key, period),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_endopet_quest_user_period ON endopet_quest_completions(user_id, period);

-- ---------- Story progress ----------
CREATE TABLE IF NOT EXISTS story_progress (
  user_id      TEXT    NOT NULL,
  step_id      TEXT    NOT NULL,
  completed_at INTEGER NOT NULL,
  completed_by TEXT    NOT NULL DEFAULT 'manual',
  PRIMARY KEY (user_id, step_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_story_progress_user ON story_progress(user_id, completed_at DESC);

-- ---------- Community: circles, members, posts, replies, reactions ----------
CREATE TABLE IF NOT EXISTS circles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  description     TEXT,
  creator_user_id TEXT,
  is_official     INTEGER NOT NULL DEFAULT 0,
  is_open         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (creator_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_circles_official ON circles(is_official, created_at DESC);

CREATE TABLE IF NOT EXISTS circle_members (
  circle_id INTEGER NOT NULL,
  user_id   TEXT    NOT NULL,
  role      TEXT    NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (circle_id, user_id),
  FOREIGN KEY (circle_id) REFERENCES circles(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_circle_members_user ON circle_members(user_id);

CREATE TABLE IF NOT EXISTS circle_posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id   INTEGER NOT NULL,
  user_id     TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  is_question INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  FOREIGN KEY (circle_id) REFERENCES circles(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_circle_posts_circle_recent ON circle_posts(circle_id, created_at DESC);

CREATE TABLE IF NOT EXISTS circle_replies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id         INTEGER NOT NULL,
  user_id         TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  parent_reply_id INTEGER,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  FOREIGN KEY (post_id)         REFERENCES circle_posts(id)   ON DELETE CASCADE,
  FOREIGN KEY (user_id)         REFERENCES users(id)          ON DELETE CASCADE,
  FOREIGN KEY (parent_reply_id) REFERENCES circle_replies(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_circle_replies_post ON circle_replies(post_id, created_at);

CREATE TABLE IF NOT EXISTS circle_reactions (
  target_type TEXT    NOT NULL,
  target_id   INTEGER NOT NULL,
  user_id     TEXT    NOT NULL,
  reaction    TEXT    NOT NULL DEFAULT 'heart',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (target_type, target_id, user_id, reaction),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_circle_reactions_target ON circle_reactions(target_type, target_id);

-- ---------- Friendships ----------
CREATE TABLE IF NOT EXISTS friendships (
  user_id_a    TEXT    NOT NULL,
  user_id_b    TEXT    NOT NULL,
  requested_by TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id_a, user_id_b)
);
CREATE INDEX IF NOT EXISTS idx_friendships_a ON friendships(user_id_a, status);
CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_id_b, status);

-- ---------- Medications ----------
CREATE TABLE IF NOT EXISTS medications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  kind              TEXT,
  dose              TEXT,
  dose_mg           REAL,
  frequency         TEXT,
  min_hours_between REAL,
  brand             TEXT,
  link              TEXT,
  notes             TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_medications_user ON medications(user_id, is_active);

CREATE TABLE IF NOT EXISTS medication_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  medication_id INTEGER NOT NULL,
  taken_at      INTEGER NOT NULL,
  dose_text     TEXT,
  notes         TEXT,
  FOREIGN KEY (user_id)       REFERENCES users(id)       ON DELETE CASCADE,
  FOREIGN KEY (medication_id) REFERENCES medications(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_medlogs_med  ON medication_logs(medication_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_medlogs_user ON medication_logs(user_id, taken_at DESC);

-- ---------- Documents (R2 metadata) ----------
CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT    NOT NULL,
  r2_key       TEXT    NOT NULL UNIQUE,
  filename     TEXT    NOT NULL,
  content_type TEXT,
  size_bytes   INTEGER,
  kind         TEXT,
  notes        TEXT,
  uploaded_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, uploaded_at DESC);
