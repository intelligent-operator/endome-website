-- 0008_evening_symptoms.sql — extra evening body fields + pain type.
-- Apply each line separately in the D1 Console.

ALTER TABLE daily_logs ADD COLUMN evening_symptoms TEXT;
ALTER TABLE daily_logs ADD COLUMN appetite TEXT;
ALTER TABLE symptoms ADD COLUMN pain_type TEXT;
