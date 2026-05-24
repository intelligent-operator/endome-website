-- 0003_login_otp.sql — email OTP challenges for 2FA + passwordless login.
-- Apply via wrangler d1 migrations apply endome-db --remote
-- (or paste into the D1 → Console tab in the dashboard).

CREATE TABLE IF NOT EXISTS login_otp (
  challenge   TEXT    PRIMARY KEY,         -- opaque random token, returned to client
  user_id     TEXT    NOT NULL,
  code_hash   TEXT    NOT NULL,            -- HMAC-SHA256(SESSION_SECRET, code) — never the plain code
  expires_at  INTEGER NOT NULL,            -- unix seconds; codes valid for 10 min
  attempts    INTEGER NOT NULL DEFAULT 0,  -- bumped on every wrong verify; locks at 5
  used_at     INTEGER,                     -- one-shot: set when consumed
  created_at  INTEGER NOT NULL,            -- used for per-user rate limiting
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_login_otp_user_recent
  ON login_otp(user_id, created_at DESC);
