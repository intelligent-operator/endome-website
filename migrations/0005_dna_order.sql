-- 0005_dna_order.sql — track EndoMe DNA test order + results upload per user.
-- Apply via the D1 Console (paste each line) or:
--   wrangler d1 migrations apply endome-db --remote

ALTER TABLE users ADD COLUMN dna_ordered_at INTEGER;
ALTER TABLE users ADD COLUMN dna_results_at INTEGER;
