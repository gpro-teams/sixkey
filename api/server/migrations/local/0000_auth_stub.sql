-- LOCAL ONLY (never applied to Supabase). Stands in for what a Supabase project already has:
-- the auth.users table and the anon / authenticated roles (§5.1 "本地用一个 auth.users 桩表").
-- sixkey_fake_auth plays Supabase's auth service: it owns auth.users and is the only role the
-- FakeAuthProvider uses, so the API role (sixkey_api) never gets any privilege on auth.*.
-- Idempotent: safe to run any number of times.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sixkey_fake_auth') THEN
    CREATE ROLE sixkey_fake_auth LOGIN;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION sixkey_fake_auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text        NOT NULL UNIQUE,
  email_confirmed_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  is_anonymous       boolean     NOT NULL DEFAULT false
);
ALTER TABLE auth.users OWNER TO sixkey_fake_auth;

REVOKE ALL ON SCHEMA auth FROM PUBLIC;
REVOKE ALL ON auth.users FROM PUBLIC;
