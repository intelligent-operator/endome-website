-- 0004_story_progress.sql — milestone tracking for the "Your Story" feature.
-- Apply via the D1 Console (paste contents) or:
--   wrangler d1 migrations apply endome-db --remote

CREATE TABLE IF NOT EXISTS story_progress (
  user_id      TEXT    NOT NULL,
  step_id      TEXT    NOT NULL,
  completed_at INTEGER NOT NULL,
  completed_by TEXT    NOT NULL DEFAULT 'manual',  -- manual | auto
  PRIMARY KEY (user_id, step_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_story_progress_user
  ON story_progress(user_id, completed_at DESC);
