"""Fixtures: one migrated Postgres database per session, a fresh World (pools, FakeAuthProvider,
FakeClock, the real app behind httpx's ASGI transport) per test, and a session-wide log collector."""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import faulthandler
import logging
import os
import sys
import threading
import uuid
from typing import Any, AsyncIterator

import asyncpg
import pytest
import pytest_asyncio

import pgutil
import sk
from sixkey_server.auth_provider import FakeAuthProvider
from sixkey_server.clock import FakeClock
from sixkey_server.config import RateLimits, Settings
from sixkey_server.main import create_app

T0 = 1_792_051_594_787  # the vectors' now_ms (2026-10-15)
HOUR = 3_600_000
# Fixture setup creates many accounts and devices from one client IP; the rate-limit tests use the
# contract's defaults (RateLimits()) explicitly.
TEST_LIMITS = RateLimits(
    otp_send_ip=(1_000_000, 3600),
    otp_verify_ip=(1_000_000, 3600),
    otp_send_email_ip=(1_000, 600),
    otp_send_email_ip_day=(1_000, 86_400),
    otp_send_email_day=(1_000, 86_400),
    recovery_account_ip=(1_000, 3600),
    recovery_account_day=(1_000, 86_400),
    session_writes=(1_000, 60),
)


# ------------------------------------------------------------------------------------ logs


class Collector(logging.Handler):
    """Every log record emitted during the session (server and libraries), for tests/test_zz_logs.py."""

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: list[tuple[str, int, str]] = []

    def emit(self, record: logging.LogRecord) -> None:
        text = record.getMessage()
        if record.exc_info:
            text += "\n" + logging.Formatter().formatException(record.exc_info)
        if record.stack_info:
            text += "\n" + record.stack_info
        self.records.append((record.name, record.levelno, text))


COLLECTOR = Collector()
logging.getLogger().addHandler(COLLECTOR)
logging.getLogger().setLevel(logging.INFO)
logging.getLogger("sixkey").setLevel(logging.INFO)
PG_LOG_START = os.path.getsize(pgutil.PG_LOG) if os.path.exists(pgutil.PG_LOG) else 0
FULL_RUN = {"value": False}
TEST_TIMEOUT_S = float(os.environ.get("SIXKEY_TEST_TIMEOUT_S", "300"))


@pytest.fixture(autouse=True)
def _watchdog(request):
    """No test may hang: past TEST_TIMEOUT_S a timer thread lifts pytest's output capture, prints the
    test id and every thread's stack to the real stderr, and exits the process non-zero, so a mutant
    that makes a request wait forever fails the run instead of stalling it (re-review, F12)."""
    capman = request.config.pluginmanager.getplugin("capturemanager")

    def fire():
        if capman is not None:
            capman.suspend_global_capture(in_=False)
        sys.stderr.write(f"\nTimeout ({TEST_TIMEOUT_S:g} s): {request.node.nodeid} hung. Stacks:\n")
        faulthandler.dump_traceback(file=sys.stderr, all_threads=True)
        sys.stderr.flush()
        os._exit(1)

    timer = threading.Timer(TEST_TIMEOUT_S, fire)
    timer.daemon = True
    timer.start()
    yield
    timer.cancel()


def pytest_collection_modifyitems(session: pytest.Session, config: pytest.Config, items: list) -> None:
    files = {os.path.basename(str(i.fspath)) for i in items}
    here = os.path.dirname(__file__)
    all_files = {f for f in os.listdir(here) if f.startswith("test_") and f.endswith(".py")}
    FULL_RUN["value"] = files == all_files and not config.getoption("-k") and not config.getoption("-m")


# ------------------------------------------------------------------------------------ database


@pytest.fixture(scope="session")
def db() -> Any:
    tdb = asyncio.run(pgutil.create_test_db())
    yield tdb
    asyncio.run(pgutil.drop_test_db(tdb))


@dataclasses.dataclass
class World:
    db: pgutil.TestDb
    clock: FakeClock
    settings: Settings
    pool: asyncpg.Pool
    auth_pool: asyncpg.Pool
    admin: asyncpg.Pool
    provider: FakeAuthProvider
    app: Any
    http: Any
    api: sk.Api

    @property
    def state(self) -> Any:
        return self.app.sixkey["st"]

    async def login(self, email: str | None = None) -> sk.Acct:
        return await self.api.login(self.provider, email)

    async def vault(self, email: str | None = None) -> tuple[sk.Acct, sk.Dev, sk.Keys]:
        acct = await self.login(email)
        dev, keys = sk.Dev(), sk.new_vault_keys(self.hour())
        r = await self.api.init(acct, dev, keys)
        assert r.status_code == 201, r.text
        return acct, dev, keys

    def hour(self) -> int:
        return self.clock.now_ms() // HOUR * HOUR

    async def recovery_device(self, acct: sk.Acct, keys: sk.Keys) -> sk.Dev:
        """Join a second device with the recovery code (§3.3): request, then complete."""
        dev = sk.Dev()
        session = await self.login(acct.email)
        r = await self.api.call(
            "POST",
            "/v1/enroll/recovery",
            {"device_id": dev.device_id, "sig_pubkey": dev.spki_b64, "recovery_auth": keys.rec_auth_b64},
            acct=session,
            reg=dev,
        )
        assert r.status_code == 200, r.text
        rid = r.json()["request_id"]
        r = await self.api.call(
            "POST", f"/v1/enroll/requests/{rid}/complete", {"name_ct": keys.name_ct()}, enroll=(rid, dev)
        )
        assert r.status_code == 200, r.text
        return dev

    async def approval_device(self, acct: sk.Acct, keys: sk.Keys, approver: sk.Dev) -> sk.Dev:
        """Join a device through the full approval state machine (§3.2 M1-M7)."""
        flow = await self.start_approval(acct)
        await flow.respond(approver, keys)
        await flow.reveal()
        await flow.approve(approver, keys)
        r = await flow.complete()
        assert r.status_code == 200, r.text
        return flow.dev

    async def start_approval(self, acct: sk.Acct, session: sk.Acct | None = None) -> "Flow":
        flow = Flow(self, session or await self.login(acct.email))
        r = await flow.create()
        assert r.status_code == 201, r.text
        return flow

    async def rows(self, user: str) -> dict[str, list[dict]]:
        """Every row of one account in every table (for isolation and deletion checks)."""
        uid = uuid.UUID(user)
        out = {}
        async with self.admin.acquire() as con:
            for t in ("auth.users", "sixkey.vaults", "sixkey.vault_versions", "sixkey.devices", "sixkey.enrollments"):
                col = "id" if t == "auth.users" else "user_id"
                out[t] = [dict(r) for r in await con.fetch(f"SELECT * FROM {t} WHERE {col} = $1 ORDER BY 1, 2", uid)]
        return out

    async def sql(self, q: str, *args: Any) -> list[asyncpg.Record]:
        async with self.admin.acquire() as con:
            return await con.fetch(q, *args)

    async def val(self, q: str, *args: Any) -> Any:
        async with self.admin.acquire() as con:
            return await con.fetchval(q, *args)


class Flow:
    """One approval enrollment, driven step by step (for state-machine tests)."""

    def __init__(self, w: World, session: sk.Acct) -> None:
        self.w, self.session, self.dev = w, session, sk.Dev()
        self.epk, self.nonce = sk.ec_point(), sk.rnd(32)
        self.commit = SC_commit(self.dev, self.epk, self.nonce)
        self.rid: str = ""
        self.name = sk.rnd(188)

    async def create(self) -> Any:
        r = await self.w.api.call(
            "POST",
            "/v1/enroll/requests",
            {"device_id": self.dev.device_id, "sig_pubkey": self.dev.spki_b64, "commit": sk.b64(self.commit)},
            acct=self.session,
            reg=self.dev,
        )
        if r.status_code == 201:
            self.rid = r.json()["request_id"]
        return r

    async def respond(self, approver: sk.Dev, keys: sk.Keys, **kw: Any) -> Any:
        self.approver_epk = sk.ec_point()
        body = {"epk": sk.b64(self.approver_epk), "password_auth": keys.pw_auth_b64}
        body.update(kw.pop("body", {}))
        return await self.w.api.call("POST", f"/v1/enroll/requests/{self.rid}/respond", body, dev=approver, **kw)

    async def reveal(self, **kw: Any) -> Any:
        body = {"epk": sk.b64(self.epk), "nonce": sk.b64(self.nonce), "name_ct": sk.b64(self.name)}
        body.update(kw.pop("body", {}))
        return await self.w.api.call(
            "POST", f"/v1/enroll/requests/{self.rid}/reveal", body, enroll=(self.rid, self.dev), **kw
        )

    async def approve(self, approver: sk.Dev, keys: sk.Keys, **kw: Any) -> Any:
        body = {
            "transcript_hash": sk.b64(sk.rnd(32)),
            "payload": sk.b64(sk.rnd(400)),
            "name_ct": keys.name_ct(),
            "sig_pubkey_sha256": sk.b64(sk.sha256(self.dev.spki)),
            "password_auth": keys.pw_auth_b64,
        }
        body.update(kw.pop("body", {}))
        return await self.w.api.call("POST", f"/v1/enroll/requests/{self.rid}/approve", body, dev=approver, **kw)

    async def complete(self, body: dict | None = None, **kw: Any) -> Any:
        return await self.w.api.call(
            "POST", f"/v1/enroll/requests/{self.rid}/complete", body or {}, enroll=(self.rid, self.dev), **kw
        )

    async def poll(self, as_dev: sk.Dev | None = None) -> Any:
        if as_dev is not None:
            return await self.w.api.call("GET", f"/v1/enroll/requests/{self.rid}", dev=as_dev)
        return await self.w.api.call("GET", f"/v1/enroll/requests/{self.rid}", enroll=(self.rid, self.dev))


def SC_commit(dev: sk.Dev, epk: bytes, nonce: bytes) -> bytes:
    return sk.SC.commit_of(dev.device_id, dev.spki, epk, nonce)


@contextlib.asynccontextmanager
async def open_world(
    tdb: pgutil.TestDb, *, now: int = T0, ip: str = "203.0.113.7", reset: bool = True, **over: Any
) -> AsyncIterator[World]:
    if reset:
        await pgutil.reset(tdb)
    clock = FakeClock(now)
    over.setdefault("limits", TEST_LIMITS)
    settings = Settings(database_dsn=tdb.api, env="test", db_pool_max=over.pop("db_pool_max", 40), **over)
    pool = await asyncpg.create_pool(tdb.api, min_size=1, max_size=settings.db_pool_max, statement_cache_size=0)
    auth_pool = await asyncpg.create_pool(tdb.fake_auth, min_size=1, max_size=4, statement_cache_size=0)
    admin = await asyncpg.create_pool(tdb.admin, min_size=1, max_size=4)
    provider = FakeAuthProvider(auth_pool, clock, issuer=settings.jwt_issuer)
    app = create_app(settings, pool=pool, provider=provider, clock=clock)
    http = sk.client(app, ip)
    try:
        yield World(tdb, clock, settings, pool, auth_pool, admin, provider, app, http, sk.Api(http, clock))
    finally:
        await http.aclose()
        await pool.close()
        await auth_pool.close()
        await admin.close()


@pytest_asyncio.fixture
async def world(db: pgutil.TestDb) -> AsyncIterator[World]:
    async with open_world(db) as w:
        yield w


@pytest.fixture
def make_world(db: pgutil.TestDb) -> Any:
    """For tests that need their own settings: async with make_world(limits=...) as w: ..."""
    return lambda **over: open_world(db, **over)
