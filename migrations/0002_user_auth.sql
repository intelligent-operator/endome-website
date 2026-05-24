-- 0002_user_auth.sql — registration-ready credentials on users.
-- Apply via: wrangler d1 migrations apply endome-db --remote
-- (or paste into the D1 → Console tab in the Cloudflare dashboard)

-- New columns are nullable so existing rows (e.g. the legacy "endome"
-- admin user) stay valid. Registered users get email + password_hash +
-- password_salt populated.
ALTER TABLE users ADD COLUMN email          TEXT;
ALTER TABLE users ADD COLUMN password_hash  TEXT;
ALTER TABLE users ADD COLUMN password_salt  TEXT;

-- Unique index lets us query by email cheaply and rejects duplicate signups.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
