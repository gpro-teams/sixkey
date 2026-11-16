"""create_app(): the FastAPI app with the 29 operations of api/openapi.yaml."""

from __future__ import annotations

import contextlib
import json

import asyncpg
from fastapi import FastAPI
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request
from starlette.responses import Response

from . import applog
from .auth_provider import AuthProvider, FakeAuthProvider
from .clock import Clock
from .config import Settings
from .constants import MAX_BODY_BYTES_OTHER as OTHER
from .constants import MAX_BODY_BYTES_VAULT as VAULT
from .db import Db, create_pool
from .pipeline import ACCOUNT, DEVICE, DEVICE_OR_ENROLL, DEVICE_STEP_UP, ENROLL, NONE, REGISTRATION, AppState, Op, run
from .ratelimit import Limiter
from .routes import account, auth, devices, enroll, keys, vault
from .schema import Contract

E = "/v1/enroll/requests/{rid}"

OPS: list[tuple[Op, object]] = [
    (Op("healthz", "GET", "/healthz", NONE), auth.healthz),
    (Op("authOtp", "POST", "/v1/auth/otp", NONE, OTHER), auth.otp),
    (Op("authVerify", "POST", "/v1/auth/verify", NONE, OTHER), auth.verify),
    (Op("getAccount", "GET", "/v1/account", ACCOUNT), account.get_account),
    (Op("deleteAccount", "DELETE", "/v1/account", DEVICE_STEP_UP, OTHER, proof="required"), account.delete_account),
    (
        Op(
            "initVault",
            "POST",
            "/v1/vault/init",
            REGISTRATION,
            VAULT,
            registration_key=lambda b: (b["device"]["device_id"], b["device"]["sig_pubkey"]),
        ),
        vault.init,
    ),
    (Op("getSyncStatus", "GET", "/v1/sync/status", DEVICE), vault.status),
    (Op("getVault", "GET", "/v1/vault", DEVICE), vault.get_vault),
    (Op("putVault", "PUT", "/v1/vault", DEVICE, VAULT), vault.put_vault),
    (Op("listVaultVersions", "GET", "/v1/vault/versions", DEVICE), vault.list_versions),
    (Op("deleteVaultVersions", "DELETE", "/v1/vault/versions", DEVICE, OTHER, proof="required"), vault.delete_versions),
    (Op("getVaultVersion", "GET", "/v1/vault/versions/{v}", DEVICE), vault.get_version),
    (Op("getKeys", "GET", "/v1/keys", DEVICE), keys.get_keys),
    (Op("putKeys", "PUT", "/v1/keys", DEVICE, OTHER, proof="password_or_recovery"), keys.put_keys),
    (
        Op("rotateKeys", "POST", "/v1/keys/rotate", DEVICE, VAULT, proof="required", account_ceiling_exempt=True),
        keys.rotate,
    ),
    (Op("listDevices", "GET", "/v1/devices", DEVICE), devices.list_devices),
    (Op("forkDevice", "POST", "/v1/devices/fork", DEVICE, OTHER, proof="required"), devices.fork),
    (Op("renameDevice", "PATCH", "/v1/devices/{id}", DEVICE, OTHER, proof="required"), devices.rename),
    (
        Op(
            "revokeDevice",
            "POST",
            "/v1/devices/{id}/revoke",
            DEVICE,
            OTHER,
            proof="required",
            account_ceiling_exempt=True,
        ),
        devices.revoke,
    ),
    (
        Op(
            "createEnrollRequest",
            "POST",
            "/v1/enroll/requests",
            REGISTRATION,
            OTHER,
            registration_key=lambda b: (b["device_id"], b["sig_pubkey"]),
        ),
        enroll.create,
    ),
    (Op("listEnrollRequests", "GET", "/v1/enroll/requests", DEVICE), enroll.list_requests),
    (Op("getEnrollRequest", "GET", E, DEVICE_OR_ENROLL), enroll.get_request),
    (Op("respondEnrollRequest", "POST", E + "/respond", DEVICE, OTHER, proof="required"), enroll.respond),
    (Op("revealEnrollRequest", "POST", E + "/reveal", ENROLL, OTHER), enroll.reveal),
    (Op("approveEnrollRequest", "POST", E + "/approve", DEVICE, OTHER, proof="required"), enroll.approve),
    (Op("completeEnrollRequest", "POST", E + "/complete", ENROLL, OTHER), enroll.complete),
    (Op("rejectEnrollRequest", "POST", E + "/reject", DEVICE_OR_ENROLL, OTHER, proof="device_only"), enroll.reject),
    (
        Op("rejectAllEnrollRequests", "POST", "/v1/enroll/reject-all", DEVICE, OTHER, proof="required"),
        enroll.reject_all,
    ),
    (
        Op(
            "enrollWithRecovery",
            "POST",
            "/v1/enroll/recovery",
            REGISTRATION,
            OTHER,
            registration_key=lambda b: (b["device_id"], b["sig_pubkey"]),
        ),
        enroll.recovery,
    ),
]

CORS_HEADERS = "authorization, content-type, sixkey-device, sixkey-enroll, sixkey-ts, sixkey-sig, sixkey-new-sig"


class Cors:
    """ACAO only for the configured chrome-extension:// origins, only so web pages cannot read
    responses. No security decision depends on Origin (§5.2 d6)."""

    def __init__(self, app, origins: tuple[str, ...]) -> None:
        self.app, self.origins = app, frozenset(origins)

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers") or [])
        origin = headers.get(b"origin", b"").decode("latin-1")
        allowed = origin in self.origins
        extra = [(b"vary", b"Origin")]
        if allowed:
            extra += [
                (b"access-control-allow-origin", origin.encode("latin-1")),
                (b"access-control-expose-headers", b"Retry-After, Date"),
            ]
        if scope["method"] == "OPTIONS" and b"access-control-request-method" in headers:
            if allowed:
                extra += [
                    (b"access-control-allow-methods", b"GET, POST, PUT, PATCH, DELETE"),
                    (b"access-control-allow-headers", CORS_HEADERS.encode()),
                    (b"access-control-max-age", b"600"),
                ]
            await send({"type": "http.response.start", "status": 204, "headers": extra})
            await send({"type": "http.response.body", "body": b""})
            return

        async def send_with(msg) -> None:
            if msg["type"] == "http.response.start":
                msg = dict(msg, headers=list(msg.get("headers") or []) + extra)
            await send(msg)

        await self.app(scope, receive, send_with)


class Guard:
    """Outermost: an exception that escapes everything still never reaches a logger with its message."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        started = False

        async def tracking(msg) -> None:
            nonlocal started
            if msg["type"] == "http.response.start":
                started = True
            await send(msg)

        try:
            await self.app(scope, receive, tracking)
        except Exception as ex:  # noqa: BLE001
            applog.emit(event="unhandled", exc=type(ex).__name__, status=500)
            if scope["type"] == "http" and not started:
                body = json.dumps({"error": {"code": "internal_error"}, "server_time": 0}).encode()
                await send(
                    {"type": "http.response.start", "status": 500, "headers": [(b"content-type", b"application/json")]}
                )
                await send({"type": "http.response.body", "body": body})


def create_app(
    settings: Settings,
    *,
    pool: asyncpg.Pool | None = None,
    provider: AuthProvider | None = None,
    clock: Clock | None = None,
    contract: Contract | None = None,
):
    """Tests pass pool/provider/clock in; `python -m sixkey_server` builds them in the lifespan."""
    clock = clock or Clock()
    contract = contract or Contract()
    holder: dict[str, AppState] = {}

    def make_state(p: asyncpg.Pool, prov: AuthProvider) -> AppState:
        return AppState(
            settings,
            Db(p, settings.db_acquire_timeout_s),
            contract,
            clock,
            Limiter(clock, settings.limiter_max_keys),
            prov,
        )

    if pool is not None and provider is not None:
        holder["st"] = make_state(pool, provider)

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        if "st" in holder:
            yield
            return
        if settings.env not in ("dev", "test"):
            raise SystemExit("production needs SupabaseAuthProvider (milestone M8); FakeAuthProvider is local only")
        p = await create_pool(settings)
        if not settings.fake_auth_dsn:
            raise SystemExit("SIXKEY_FAKE_AUTH_DSN is required for the FakeAuthProvider")
        auth_pool = await asyncpg.create_pool(settings.fake_auth_dsn, min_size=1, max_size=4, statement_cache_size=0)
        prov = FakeAuthProvider(auth_pool, clock, issuer=settings.jwt_issuer, inbox_file=settings.fake_inbox_file)
        holder["st"] = make_state(p, prov)
        try:
            yield
        finally:
            await p.close()
            await auth_pool.close()

    # redirect_slashes=False: no 307 built from the Host header for "/v1/vault/" (S13); it is a 404.
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan, redirect_slashes=False)

    for op, handler in OPS:

        def endpoint_for(op=op, handler=handler):
            async def endpoint(request: Request) -> Response:
                return await run(holder["st"], op, handler, request)

            endpoint.__name__ = op.op_id
            return endpoint

        app.add_api_route(op.path, endpoint_for(), methods=[op.method], include_in_schema=False)

    @app.exception_handler(StarletteHTTPException)
    async def not_found(request: Request, exc: StarletteHTTPException) -> Response:
        st = holder.get("st")
        now = st.clock.now_ms() if st else 0
        applog.emit(route="-", method=request.method, status=404, code="not_found")
        return Response(
            json.dumps({"error": {"code": "not_found"}, "server_time": now}).encode(),
            status_code=404,
            media_type="application/json",
        )

    guarded = Guard(Cors(app, settings.cors_origins))
    guarded.sixkey = holder  # type: ignore[attr-defined]  # tests reach the AppState here
    return guarded
