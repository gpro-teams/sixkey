-- Sixkey Phase 1 schema (docs/SYNC-DESIGN.md §5.3, revision 14).
-- The same file is meant for Supabase at M8 (supabase/migrations/0001_sixkey.sql); locally the
-- auth.users stub comes from migrations/local/0000_auth_stub.sql.
--
-- Roles (§5.3 C2):
--   sixkey_owner  NOLOGIN, owns the schema and every table; only migrations act as it.
--   sixkey_api    the role FastAPI logs in as: SELECT/INSERT/UPDATE/DELETE on the four tables, one
--                 permissive policy per table (TO sixkey_api USING (true) WITH CHECK (true)).
--   anon, authenticated, PUBLIC: no grant and no policy, so they see nothing.
-- Every table has RLS enabled; the owner is exempt (not FORCE), which is what lets the
-- ON DELETE CASCADE from auth.users run (tests/test_db_roles.py checks it).
--
-- Times (§5.3 C14, N4): every timestamp is written by the application, already truncated in UTC
-- (hour, day or minute). The column defaults below are a fallback only; ALTER ROLE ... SET
-- timezone = 'UTC' makes date_trunc()/current_date in an API session UTC as well.
--
-- Idempotent: every statement can run again on an up-to-date database without error or change.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sixkey_owner') THEN
    CREATE ROLE sixkey_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sixkey_api') THEN
    CREATE ROLE sixkey_api LOGIN;
  END IF;
END
$$;

ALTER ROLE sixkey_api SET timezone = 'UTC';
ALTER ROLE sixkey_owner SET timezone = 'UTC';

-- The migrating role acts as the owner (needed on Supabase, where it is not a superuser).
GRANT sixkey_owner TO CURRENT_USER;

CREATE SCHEMA IF NOT EXISTS sixkey AUTHORIZATION sixkey_owner;
REVOKE ALL ON SCHEMA sixkey FROM PUBLIC;
GRANT USAGE ON SCHEMA sixkey TO sixkey_api;

-- Foreign keys to auth.users need REFERENCES for the table owner (M8: granted by the auth admin).
GRANT USAGE ON SCHEMA auth TO sixkey_owner;
GRANT REFERENCES ON auth.users TO sixkey_owner;

SET ROLE sixkey_owner;

CREATE TABLE IF NOT EXISTS sixkey.vaults (
  user_id            uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  vault_id           text        NOT NULL CHECK (vault_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  version            bigint      NOT NULL CHECK (version >= 1),
  vk_id              text        NOT NULL CHECK (vk_id ~ '^[0-9a-f]{16}$'),
  envelope           text        NOT NULL,                                     -- EncryptedVault JSON text, as received
  head               bytea       NOT NULL CHECK (length(head) = 32),           -- SHA-256(envelope text) (D5)
  devices_rev        bigint      NOT NULL DEFAULT 0 CHECK (devices_rev >= 0),  -- device-list change counter (N15)
  size_bytes         int         NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 8388608),  -- UTF-8 bytes of envelope
  kver               bigint      NOT NULL CHECK (kver >= 1 AND kver <= 9007199254740991),
  bundle             text        NOT NULL,                                     -- KeyBundle JSON text, as received (P11)
  recovery_verifier  bytea       NOT NULL CHECK (length(recovery_verifier) = 32),
  password_verifier  bytea       NOT NULL CHECK (length(password_verifier) = 32),
  write_key          bytea       NOT NULL CHECK (length(write_key) = 32),      -- K_write (C12); KMS layer at M7 (S7)
  history_bytes      bigint      NOT NULL DEFAULT 0 CHECK (history_bytes >= 0),
  created_at         timestamptz NOT NULL DEFAULT date_trunc('hour', now()),
  updated_at         timestamptz NOT NULL DEFAULT date_trunc('hour', now())
);

CREATE TABLE IF NOT EXISTS sixkey.vault_versions (          -- no wrapped keys, no bundle, no writing device (C3, F6b)
  user_id    uuid        NOT NULL REFERENCES sixkey.vaults(user_id) ON DELETE CASCADE,
  version    bigint      NOT NULL CHECK (version >= 1),
  vk_id      text        NOT NULL CHECK (vk_id ~ '^[0-9a-f]{16}$'),
  envelope   text        NOT NULL,
  size_bytes int         NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 8388608),
  created_at timestamptz NOT NULL DEFAULT date_trunc('hour', now()),           -- hour precision (F13c)
  PRIMARY KEY (user_id, version)
);

CREATE TABLE IF NOT EXISTS sixkey.devices (
  device_id     text        PRIMARY KEY CHECK (device_id ~ '^[A-Za-z0-9_-]{22}$'),
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sig_pubkey    bytea       NOT NULL CHECK (length(sig_pubkey) = 91),          -- P-256 SPKI DER, uncompressed point
  name_ct       text,                                                         -- {vkId, iv, ct} JSON, end-to-end encrypted, fixed length
  joined_via    text        NOT NULL CHECK (joined_via IN ('first', 'approval', 'recovery', 'fork')),
  approved_by   text        CHECK (approved_by IS NULL OR approved_by ~ '^[A-Za-z0-9_-]{22}$'),
  created_at    timestamptz NOT NULL DEFAULT date_trunc('hour', now()),
  last_seen_at  date,                                                         -- day, written once per UTC day (T2)
  revoked_at    timestamptz,                                                  -- hour (T3); who revoked is not recorded
  auth_failures int         NOT NULL DEFAULT 0 CHECK (auth_failures >= 0 AND auth_failures <= 10),
  cursor        bytea       CHECK (cursor IS NULL OR length(cursor) = 16)     -- clone soft detection, PUT only (§4.10)
);
CREATE INDEX IF NOT EXISTS devices_by_user ON sixkey.devices(user_id);

CREATE TABLE IF NOT EXISTS sixkey.enrollments (              -- deleted on complete, reject or expiry; no history
  request_id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  via                text        NOT NULL CHECK (via IN ('approval', 'recovery')),
  session_ref        bytea       NOT NULL CHECK (length(session_ref) = 32),    -- SHA-256(JWT session_id) (F8)
  new_device_id      text        NOT NULL CHECK (new_device_id ~ '^[A-Za-z0-9_-]{22}$'),
  new_sig_pubkey     bytea       NOT NULL CHECK (length(new_sig_pubkey) = 91),
  commit             bytea       CHECK (commit IS NULL OR length(commit) = 32),
  state              text        NOT NULL CHECK (state IN ('pending', 'responded', 'revealed', 'approved')),
  approver_device_id text        CHECK (approver_device_id IS NULL OR approver_device_id ~ '^[A-Za-z0-9_-]{22}$'),
  approver_epk       bytea       CHECK (approver_epk IS NULL OR length(approver_epk) = 65),
  new_epk            bytea       CHECK (new_epk IS NULL OR length(new_epk) = 65),
  new_nonce          bytea       CHECK (new_nonce IS NULL OR length(new_nonce) = 32),
  new_name_ct        bytea       CHECK (new_name_ct IS NULL OR length(new_name_ct) = 188),  -- reveal: K_enroll ciphertext
  transcript_hash    bytea       CHECK (transcript_hash IS NULL OR length(transcript_hash) = 32),
  payload            bytea,
  name_ct            text,                                                    -- approve: the K_name name_ct for the device row (docs/M4-NOTES.md)
  created_at         timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  expires_at         timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS enrollments_by_user ON sixkey.enrollments(user_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS enrollments_one_per_session ON sixkey.enrollments(user_id, session_ref);

-- Grants and policies, as the owner.
REVOKE ALL ON sixkey.vaults, sixkey.vault_versions, sixkey.devices, sixkey.enrollments FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON sixkey.vaults, sixkey.vault_versions, sixkey.devices, sixkey.enrollments TO sixkey_api;

ALTER TABLE sixkey.vaults         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sixkey.vault_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sixkey.devices        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sixkey.enrollments    ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vaults', 'vault_versions', 'devices', 'enrollments'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'sixkey' AND tablename = t
                   AND policyname = 'sixkey_api_all') THEN
      EXECUTE format('CREATE POLICY sixkey_api_all ON sixkey.%I TO sixkey_api USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END
$$;

RESET ROLE;

-- Supabase's API roles get nothing here (they have no grant on the schema either).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA sixkey FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA sixkey FROM %I', r);
    END IF;
  END LOOP;
END
$$;
