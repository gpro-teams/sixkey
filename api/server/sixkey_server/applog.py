"""Application log (§5.6): one JSON line per request with only

  t (UTC, whole seconds), rid (random per request), route (template), method, status, ms, code,
  and on 5xx ref = HMAC(daily key, user_id)[:8] and exc = the exception class name.

Never logged: IPs, user agents, header values, bodies, tokens, signatures, emails, OTPs, envelopes,
bundles, verifiers, cursors, user or device ids, exception messages (Postgres DETAIL carries rows).
"""

from __future__ import annotations

import datetime as dt
import json
import logging

LOGGER = logging.getLogger("sixkey")
ALLOWED = ("t", "rid", "route", "method", "status", "ms", "code", "ref", "exc", "event")


def _now_s() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def emit(**fields: object) -> None:
    rec = {"t": _now_s()}
    for k in ALLOWED:
        if k in fields and fields[k] is not None:
            rec[k] = fields[k]
    LOGGER.info(json.dumps(rec, separators=(",", ":")))


class JsonLineFormatter(logging.Formatter):
    """The message already is the JSON line; no logger-added timestamps with sub-second precision."""

    def format(self, record: logging.LogRecord) -> str:
        return record.getMessage()


def configure(level: int = logging.INFO) -> None:
    """Production logging: sixkey lines to stderr; uvicorn's access log is off at the server level."""
    handler = logging.StreamHandler()
    handler.setFormatter(JsonLineFormatter())
    LOGGER.handlers[:] = [handler]
    LOGGER.setLevel(level)
    LOGGER.propagate = False
