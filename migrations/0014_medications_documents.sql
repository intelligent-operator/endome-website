-- 0014_medications_documents.sql — medication tracking + private document
-- storage metadata. Documents themselves live in the Cloudflare R2 bucket
-- bound as DOCS (see wrangler.toml). The worker bootstraps these tables on
-- first use too, so older deployments don't need this applied manually.

CREATE TABLE IF NOT EXISTS medications (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             TEXT    NOT NULL,
  name                TEXT    NOT NULL,
  kind                TEXT,                                      -- medication | vitamin | supplement | herbal
  dose                TEXT,                                      -- "400mg", "2 tablets"
  dose_mg             REAL,
  frequency           TEXT,                                      -- as_needed | once_daily | every_6h ...
  min_hours_between   REAL,                                      -- PRN cooldown
  brand               TEXT,
  link                TEXT,
  notes               TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
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

CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  r2_key        TEXT    NOT NULL UNIQUE,                         -- "users/<user_id>/..."
  filename      TEXT    NOT NULL,
  content_type  TEXT,
  size_bytes    INTEGER,
  kind          TEXT,                                            -- ultrasound | report | lab | image | other
  notes         TEXT,
  uploaded_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, uploaded_at DESC);
