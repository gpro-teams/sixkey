# Self-hosting the sync server

**Self-hosting is not possible yet.** This page says why, which model has been chosen, and what has to exist first.
Nothing here is a promise of a date.

## The chosen model

- **A separate self-host build of the extension.** A store build with sync would reach exactly one API origin,
  `https://api.sixkey.app`, built in at build time (no build has a sync client now, and the store build never reached
  that origin): a store build in which users type a server address would need a broad optional host permission and
  would weaken the "one fixed host" guarantee. A
  self-hoster will build a self-host flavour of the extension whose API origin is their own server's; that flavour
  does not exist yet.
- **A sign-in provider that needs only PostgreSQL and SMTP**, so that a self-hosted server does not depend on Supabase.
  It is planned after the hosted service is live.
- **Later, possibly a complete backend** in the style of SimpleLogin or Supabase, offered both as a hosted service and
  as open source that you deploy yourself. The project publishes the code and the documentation needed to run it; it
  does **not** offer to set up or operate hosting for users.

Self-hosting is meant to stay free; the paid offering is limited to the project's own hosted service
([GOVERNANCE.md](../GOVERNANCE.md)).

## Why not yet

1. **The server does not run in production mode.** `api/server` signs users in with a `FakeAuthProvider` that keeps
   one-time codes in memory or in a local file. It is for development and tests only, and the server refuses to start
   with `SIXKEY_ENV` set to anything but `dev` or `test` (`sixkey_server/main.py`). The production sign-in provider is
   planned work (milestone M8 in `docs/SYNC-DESIGN.md` §9).
2. **There is no sign-in provider for self-hosters.** The planned production provider targets a hosted Supabase
   project. The provider that needs nothing but PostgreSQL and an SMTP server (above) has not been written. The
   interface it would implement exists (`sixkey_server/auth_provider.py`).
3. **The extension has no client for the server now.** Its sync client, with the build-time API origin its request
   signatures covered, was removed from every build (it can be found in the history); no build of the extension reaches
   a sync server (the dev and e2e builds' site rules updater reaches only its own rules origin). The self-host build flavour (above) is the chosen way to reach another server once a client comes back;
   it has to be designed and built first, including how a user can tell such a build from the store build.
4. **There is no packaging**: no container image, no compose file, no operator documentation.
5. **Sync itself is not released.** No build of the extension has its client (see the [README](../README.md) status).

## What you can do today

Run the server locally for development and testing (Python 3.14, PostgreSQL 14 or later):

```
cd api/server
make venv
make run      # http://127.0.0.1:8787 (no build of the extension talks to it any more)
```

The server's own suite (`make check`) and the contract's checks exercise it. One-time codes appear in
`api/server/.pg/otp-inbox.jsonl`. This is a test setup with no security for real accounts: use test
data only.

## What has to exist first

- a sign-in provider that works with only PostgreSQL and SMTP;
- the self-host build flavour of the extension, and the build checks that keep its API origin apart from the store
  build's;
- a container image and a compose file, and documentation for operators: configuration (every `SIXKEY_*`
  variable in `sixkey_server/config.py`), TLS and reverse proxies (`SIXKEY_TRUSTED_PROXIES`), backups and restore,
  upgrades and migrations, the daily job (`python -m sixkey_server.jobs`), logs;
- a compatibility policy for clients and servers of different versions.
