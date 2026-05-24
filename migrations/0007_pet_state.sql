-- 0007_pet_state.sql — Tamagotchi-style pet state.
-- Apply one line at a time in the D1 Console:

ALTER TABLE pets ADD COLUMN hatched_at INTEGER;
ALTER TABLE pets ADD COLUMN color_seed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pets ADD COLUMN hunger INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pets ADD COLUMN happiness INTEGER NOT NULL DEFAULT 100;
ALTER TABLE pets ADD COLUMN last_fed_at INTEGER;
ALTER TABLE pets ADD COLUMN last_played_at INTEGER;
