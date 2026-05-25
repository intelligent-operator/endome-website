-- 0010_achievements_quests.sql
-- Apply each statement separately in the D1 Console.

CREATE TABLE IF NOT EXISTS endopet_achievements (
  user_id           TEXT    NOT NULL,
  achievement_key   TEXT    NOT NULL,
  unlocked_at       INTEGER NOT NULL,
  glow_reward       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, achievement_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_endopet_ach_user ON endopet_achievements(user_id, unlocked_at DESC);

CREATE TABLE IF NOT EXISTS endopet_quest_completions (
  user_id        TEXT    NOT NULL,
  quest_key      TEXT    NOT NULL,
  period         TEXT    NOT NULL,
  completed_at   INTEGER NOT NULL,
  glow_reward    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, quest_key, period),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_endopet_quest_user_period ON endopet_quest_completions(user_id, period);
