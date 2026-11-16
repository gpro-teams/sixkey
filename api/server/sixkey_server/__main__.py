"""python -m sixkey_server: run the API with uvicorn (local development and e2e).

uvicorn's access log is off and proxy headers are not interpreted by uvicorn (§5.6): the app decides
which single forwarding header to believe, and only for SIXKEY_TRUSTED_PROXIES.
"""

from __future__ import annotations

import logging
import os

import uvicorn

from . import applog
from .config import Settings
from .main import create_app


LOOPBACK = ("127.0.0.1", "::1", "localhost")


def main() -> None:
    settings = Settings.from_env()  # refuses to start without an explicit SIXKEY_ENV (S12)
    applog.configure()
    host, _, port = os.environ.get("SIXKEY_BIND", "127.0.0.1:8787").rpartition(":")
    host = host.strip("[]")
    if settings.env != "production" and host not in LOOPBACK:
        raise SystemExit("the FakeAuthProvider (dev/test) only listens on a loopback address")
    if settings.env == "production" and not settings.trusted_proxies:
        # review P3: behind a proxy every client would share the proxy's IP buckets (a global OTP DoS)
        applog.emit(event="warning_no_trusted_proxy")
    # limit_concurrency: uvicorn answers 503 past this many connections (S3); proxy timeouts at M8.
    uvicorn.run(
        create_app(settings),
        host=host,
        port=int(port),
        access_log=False,
        proxy_headers=False,
        server_header=False,
        log_level=logging.WARNING,
        log_config=None,
        limit_concurrency=int(os.environ.get("SIXKEY_LIMIT_CONCURRENCY", "256")),
        timeout_keep_alive=5,
    )


if __name__ == "__main__":
    main()
