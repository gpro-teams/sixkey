# Sixkey sync API (M4). Everything runs locally: Postgres from scripts/pg.sh, FakeAuthProvider.
#   make venv        create .venv with the pinned dependencies
#   make check       start Postgres (if needed) and run the whole test suite   <- the one command
#   make run         migrate the dev database and serve on http://127.0.0.1:8787
#   make format      format every Python file in the repository with ruff (format-check: only check)
PY      := .venv/bin/python
PG      := scripts/pg.sh
RUN_DIR := $(CURDIR)/.pg/run
PGPORT  ?= 55432
DEV_DB  := sixkey_dev
ADMIN   := postgresql://postgres@/postgres?host=$(RUN_DIR)&port=$(PGPORT)
API_DSN := postgresql://sixkey_api@/$(DEV_DB)?host=$(RUN_DIR)&port=$(PGPORT)
AUTH_DSN := postgresql://sixkey_fake_auth@/$(DEV_DB)?host=$(RUN_DIR)&port=$(PGPORT)

.PHONY: venv pg-start pg-stop pg-reset migrate test test-long contract mutants run jobs check format format-check

venv:
	python3.14 -m venv .venv
	$(PY) -m pip install -q -r requirements-dev.txt

pg-start:
	$(PG) start

pg-stop:
	$(PG) stop

pg-reset:
	$(PG) reset

migrate: pg-start
	$(PY) -m sixkey_server.migrate --dsn "$(ADMIN)" --local-auth-stub --create-db $(DEV_DB)

test:
	$(PY) -m pytest -q

test-long:
	SIXKEY_MODEL_EXAMPLES=400 $(PY) -m pytest -q tests/test_model.py

contract:
	$(PY) -I -B ../../contract/py/test_contract.py

mutants:
	$(PY) tests/mutation/run_mutants.py

check: pg-start test

# ruff.toml at the repository root says what is formatted and how.
format:
	$(PY) -m ruff format ../..

format-check:
	$(PY) -m ruff format --check ../..

run: migrate
	SIXKEY_ENV=dev SIXKEY_DATABASE_DSN="$(API_DSN)" SIXKEY_FAKE_AUTH_DSN="$(AUTH_DSN)" \
	SIXKEY_API_ORIGIN=http://127.0.0.1:8787 SIXKEY_FAKE_INBOX_FILE=$(CURDIR)/.pg/otp-inbox.jsonl \
	$(PY) -m sixkey_server

jobs:
	SIXKEY_ENV=dev SIXKEY_DATABASE_DSN="$(API_DSN)" SIXKEY_FAKE_AUTH_DSN="$(AUTH_DSN)" $(PY) -m sixkey_server.jobs
