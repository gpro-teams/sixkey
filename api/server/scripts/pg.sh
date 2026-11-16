#!/usr/bin/env bash
# Local PostgreSQL for M4 development and tests (no Docker needed).
#
#   scripts/pg.sh start    initdb on first use, then start (unix socket only, no TCP port)
#   scripts/pg.sh stop
#   scripts/pg.sh status
#   scripts/pg.sh dsn      print the superuser DSN (used by migrate and the tests)
#   scripts/pg.sh reset    stop and delete the cluster
#
# The cluster lives in api/server/.pg (git-ignored). Settings that matter for the tests:
#   - listen_addresses = ''          nothing listens on TCP; clients use the socket in .pg/run
#   - auth = trust on the socket     local scratch cluster only (each role still has only its grants)
#   - log_error_verbosity = terse    no DETAIL ("Failing row contains ...") in the server log (§5.6 P7)
#   - timezone = Asia/Kolkata        deliberately not UTC: the migration's ALTER ROLE ... SET timezone
#                                    = 'UTC' must be what makes the API's sessions UTC (§5.3 N4)
#   - fsync/synchronous_commit off   speed; durability is irrelevant for a scratch test cluster
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PGROOT="${SIXKEY_PGROOT:-$HERE/.pg}"
DATA="$PGROOT/data"
RUN="$PGROOT/run"
LOG="$PGROOT/postgres.log"
PORT="${SIXKEY_PGPORT:-55432}"

find_bin() {
  if command -v "$1" >/dev/null 2>&1; then command -v "$1"; return; fi
  for d in /opt/homebrew/opt/postgresql@1{7,6,5,4}/bin /usr/local/opt/postgresql@1{7,6,5,4}/bin \
           /usr/lib/postgresql/1{7,6,5,4}/bin; do
    if [ -x "$d/$1" ]; then echo "$d/$1"; return; fi
  done
  echo "error: $1 not found (install PostgreSQL 14+, e.g. 'brew install postgresql@14')" >&2
  exit 1
}

INITDB="$(find_bin initdb)"
PG_CTL="$(find_bin pg_ctl)"

dsn() { echo "postgresql://postgres@/postgres?host=$RUN&port=$PORT"; }

case "${1:-}" in
  start)
    mkdir -p "$RUN"
    if [ ! -f "$DATA/PG_VERSION" ]; then
      "$INITDB" -D "$DATA" -U postgres --auth=trust -E UTF8 --locale=C >/dev/null
    fi
    if "$PG_CTL" -D "$DATA" status >/dev/null 2>&1; then
      echo "already running: $(dsn)"
      exit 0
    fi
    "$PG_CTL" -D "$DATA" -l "$LOG" -w start -o "-c listen_addresses='' -c unix_socket_directories='$RUN' \
      -c port=$PORT -c max_connections=300 -c log_error_verbosity=terse -c timezone=Asia/Kolkata \
      -c log_timezone=UTC -c fsync=off -c synchronous_commit=off -c full_page_writes=off" >/dev/null
    echo "started: $(dsn)"
    ;;
  stop)
    if "$PG_CTL" -D "$DATA" status >/dev/null 2>&1; then "$PG_CTL" -D "$DATA" -m fast -w stop >/dev/null; fi
    echo "stopped"
    ;;
  status)
    "$PG_CTL" -D "$DATA" status
    ;;
  dsn)
    dsn
    ;;
  reset)
    "$0" stop
    rm -rf "$PGROOT"
    echo "removed $PGROOT"
    ;;
  *)
    echo "usage: $0 start|stop|status|dsn|reset" >&2
    exit 2
    ;;
esac
