-- 0002_female_health.sql
-- Expand daily_logs and symptoms with female-health / endo-aware fields.
-- All new columns are nullable so existing rows stay valid.

-- ---- daily_logs ----------------------------------------------------------
-- Cycle awareness
ALTER TABLE daily_logs ADD COLUMN cycle_day            INTEGER;
ALTER TABLE daily_logs ADD COLUMN cycle_phase          TEXT;    -- menstrual|follicular|ovulation|luteal
ALTER TABLE daily_logs ADD COLUMN flow                 TEXT;    -- none|spotting|light|medium|heavy
ALTER TABLE daily_logs ADD COLUMN bbt                  REAL;    -- basal body temperature (°C)
ALTER TABLE daily_logs ADD COLUMN cervical_mucus       TEXT;    -- dry|sticky|creamy|watery|eggwhite
ALTER TABLE daily_logs ADD COLUMN breast_tenderness    INTEGER; -- 0..5

-- Morning extras
ALTER TABLE daily_logs ADD COLUMN morning_sleep_quality INTEGER; -- 1..5 (distinct from hours)

-- Evening body-care
ALTER TABLE daily_logs ADD COLUMN water_glasses        INTEGER;
ALTER TABLE daily_logs ADD COLUMN movement_level       TEXT;    -- none|light|moderate|vigorous
ALTER TABLE daily_logs ADD COLUMN bowel_count          INTEGER;
ALTER TABLE daily_logs ADD COLUMN bowel_type           TEXT;    -- constipated|normal|loose
ALTER TABLE daily_logs ADD COLUMN stress_level         INTEGER; -- 1..5
ALTER TABLE daily_logs ADD COLUMN intimacy             TEXT;    -- none|comfortable|uncomfortable
ALTER TABLE daily_logs ADD COLUMN medications          TEXT;

-- ---- symptoms ------------------------------------------------------------
ALTER TABLE symptoms ADD COLUMN triggers               TEXT;    -- comma-separated tags
ALTER TABLE symptoms ADD COLUMN relief                 TEXT;    -- comma-separated tags
