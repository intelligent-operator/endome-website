-- 0012_pet_cleanup.sql — adds the cleanup timestamp used by the poop mechanic.
-- The worker also adds this column at runtime as a fallback, so old DBs
-- keep working without manual migration.
-- Apply via the D1 Console or `wrangler d1 migrations apply endome-db --remote`.

ALTER TABLE pets ADD COLUMN last_cleaned_at INTEGER;
