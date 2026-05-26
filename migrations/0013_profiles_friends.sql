-- 0013_profiles_friends.sql — public-facing profile fields + friends graph.
-- Apply each statement separately in the D1 Console; the worker also adds
-- these at runtime as a fallback for older databases.

ALTER TABLE users ADD COLUMN alias  TEXT;
ALTER TABLE users ADD COLUMN avatar TEXT;
ALTER TABLE users ADD COLUMN bio    TEXT;

CREATE TABLE IF NOT EXISTS friendships (
  user_id_a    TEXT    NOT NULL,   -- lexicographically smaller user id
  user_id_b    TEXT    NOT NULL,   -- lexicographically larger user id
  requested_by TEXT    NOT NULL,   -- whichever side asked first
  status       TEXT    NOT NULL DEFAULT 'pending',  -- pending | accepted
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id_a, user_id_b)
);

CREATE INDEX IF NOT EXISTS idx_friendships_a ON friendships(user_id_a, status);
CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_id_b, status);
