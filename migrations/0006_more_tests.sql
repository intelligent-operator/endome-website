-- 0006_more_tests.sql — track EndoMe Bloods + EndoMe Map order/results per user.
-- Apply each line in the D1 Console one at a time (the dashboard chokes on
-- leading comments + multi-statement scripts).

ALTER TABLE users ADD COLUMN bloods_ordered_at INTEGER;
ALTER TABLE users ADD COLUMN bloods_results_at INTEGER;
ALTER TABLE users ADD COLUMN map_ordered_at INTEGER;
ALTER TABLE users ADD COLUMN map_results_at INTEGER;
