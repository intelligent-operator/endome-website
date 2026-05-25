-- 0011_community.sql — circles, members, posts, replies, reactions.
-- Apply each statement separately in the D1 Console.

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
  circle_id  INTEGER NOT NULL,
  user_id    TEXT    NOT NULL,
  role       TEXT    NOT NULL DEFAULT 'member',
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (circle_id, user_id),
  FOREIGN KEY (circle_id) REFERENCES circles(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE
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
  FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE
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
