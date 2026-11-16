# Sixkey sync API (milestone M4)

FastAPI + PostgreSQL implementation of `api/openapi.yaml` (29 operations) for `docs/SYNC-DESIGN.md` §5,
with a `FakeAuthProvider` standing in for Supabase until M8. Design notes, decisions, contract
ambiguities and test/mutation results: `docs/design/notes/M4-NOTES.md`.

## Run the tests (one command)

Needs Python 3.14 and PostgreSQL 14+ binaries (`initdb`, `pg_ctl`; e.g. `brew install postgresql@14`).
No Docker, no network once the venv exists.

```
cd api/server
make venv     # once: .venv with the exact versions of requirements-dev.txt
make check    # starts a private Postgres in .pg/ (unix socket only) and runs the whole suite
```

Other targets: `make test` (suite only), `make test-long` (400 model-based programs), `make mutants`
(the mutation check, ~10 min), `make contract` (the contract's own Python checks), `make pg-stop`,
`make pg-reset`.

## Run the server locally

```
make run      # migrates database sixkey_dev and serves http://127.0.0.1:8787 (the e2e origin)
```

OTP codes of the `FakeAuthProvider` are appended to `.pg/otp-inbox.jsonl` (local only; refused when
`SIXKEY_ENV=production`). `make jobs` runs the daily job once.

## Layout

| Path                                                                               | What                                                                                                                  |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `sixkey_server/main.py`                                                            | `create_app()`, the table of the 29 operations, CORS, the outer guard                                                 |
| `sixkey_server/pipeline.py`                                                        | per-request steps: body limit, account session, signatures, strict parsing, proofs, rate limits, errors, the log line |
| `sixkey_server/routes/`                                                            | handlers: `auth`, `account`, `vault`, `keys`, `devices`, `enroll`                                                     |
| `sixkey_server/wire.py`, `sigauth.py`, `account_session.py`, `schema.py`           | keyless checks, request signatures, JWT, strict JSON + the contract's request schemas                                 |
| `sixkey_server/auth_provider.py`                                                   | the `AuthProvider` interface and `FakeAuthProvider`                                                                   |
| `sixkey_server/ratelimit.py`, `retention.py`, `jobs.py`, `applog.py`, `migrate.py` | limits, history retention, the daily job, logging, migrations                                                         |
| `migrations/0001_sixkey.sql`                                                       | the §5.3 schema, roles, RLS policies (also for Supabase at M8)                                                        |
| `migrations/local/0000_auth_stub.sql`                                              | local only: `auth.users`, `anon`, `authenticated`, the fake auth role                                                 |
| `tests/`                                                                           | pytest suite against the real app and Postgres; `tests/mutation/` the mutation check                                  |
| `scripts/pg.sh`                                                                    | start/stop the local Postgres                                                                                         |
