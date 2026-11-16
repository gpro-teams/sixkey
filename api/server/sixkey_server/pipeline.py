"""The request pipeline shared by all 29 operations.

Order for a request (each step can end it with the contract's error body):
  1. what needs no body: Content-Length over the operation's limit (413), a JSON operation's
     Content-Type must be application/json (422, S6: no cross-site "simple" requests), the account
     session (401 session_invalid), the signer headers' shape (401 bad_signature), and the signer's
     row: device (401 unknown_device) or enrollment (410). So an unauthenticated client cannot make
     the server buffer a body (S3)
  2. the body (counted while it streams, 413; read within body_timeout_s, else 503); requests to the
     three 9 MiB endpoints wait for one of large_body_slots (503 after large_body_wait_s)
  3. signature: verify, then revoked (403), then the ±300 s window (§5.2 / P6 order)
  4. strict JSON + the operation's request schema from api/openapi.yaml            422 invalid_request
  5. proofs: pw_auth / recovery_auth validity is evaluated before the limits, because a valid proof
     is exempt from every per-device limit (§3.14 S2); the handler enforces it where its order says
  6. rate limits; requests that end in 401/403 are refunded (never counted, §5.5), except the
     per-device byte budget for envelope writes, which failing writes pay too   429 rate_limited
  7. the handler
Every response body carries server_time; errors never echo user data; one log line per request.
"""

from __future__ import annotations

import asyncio
import dataclasses
import ipaddress
import json
import secrets
import time
import uuid
from typing import Any, Awaitable, Callable

import asyncpg
from starlette.requests import Request
from starlette.responses import Response

from . import account_session, applog, sigauth, wire
from .auth_provider import ProviderUnavailable
from .clock import Clock
from .config import Settings
from .constants import AUTH_FAILURES_CAP, MAX_BODY_BYTES_OTHER, MAX_BODY_BYTES_VAULT, MAX_ENVELOPE_BYTES, SIG_WINDOW_S
from .db import Db, map_exception
from .errors import ApiError
from .ratelimit import Limiter
from .schema import Contract, JsonError, parse_body

NONE, ACCOUNT, REGISTRATION, DEVICE, DEVICE_STEP_UP, ENROLL, DEVICE_OR_ENROLL = (
    "none",
    "account",
    "registration",
    "device",
    "device_step_up",
    "enroll",
    "device_or_enroll",
)


@dataclasses.dataclass(frozen=True)
class Op:
    op_id: str
    method: str
    path: str
    auth: str
    max_body: int | None = None  # None: no request body defined (still capped at 64 KiB)
    proof: str = "none"  # none | required | password_or_recovery | device_only
    account_ceiling_exempt: bool = False  # revoke and rotate (F8)
    registration_key: Callable[[dict], tuple[str, str]] | None = None  # body -> (device_id, sig_pubkey)


@dataclasses.dataclass
class AppState:
    settings: Settings
    pool: Db
    contract: Contract
    clock: Clock
    limiter: Limiter
    provider: Any
    hooks: dict = dataclasses.field(default_factory=dict)  # tests only: name -> async callable
    large_slots: asyncio.Semaphore | None = None

    def __post_init__(self) -> None:
        if self.large_slots is None:
            self.large_slots = asyncio.Semaphore(self.settings.large_body_slots)

    async def pause(self, name: str) -> None:
        """A named point where a test can interleave another request (no-op in production)."""
        h = self.hooks.get(name)
        if h is not None:
            await h()


Handler = Callable[["Ctx"], Awaitable[tuple[int, dict | None]]]


class Ctx:
    def __init__(self, st: AppState, op: Op, request: Request) -> None:
        self.st = st
        self.op = op
        self.request = request
        self.now = st.clock.now_ms()
        self.raw = b""
        self.body: Any = None
        self.session: account_session.AccountSession | None = None
        self.device: asyncpg.Record | None = None
        self.enrollment: asyncpg.Record | None = None
        self.user_id: str | None = None
        self.signer: str | None = None
        self.proof_valid: bool | None = None
        self.proof_kind: str | None = None
        self.proof_missing = False
        self.charged: list[tuple[str, int]] = []
        self.ts = 0  # the verified Sixkey-Ts (ms)
        self._pending: tuple | None = None

    @property
    def pool(self) -> Db:
        return self.st.pool

    @property
    def path_params(self) -> dict:
        return self.request.path_params

    # -------------------------------------------------------------------------------- rate limits

    def _hit(self, key: str, rule: tuple[int, int], refundable: bool = True, amount: int = 1) -> None:
        retry = self.st.limiter.hit(key, rule[0], rule[1], amount)
        if retry is not None:
            raise ApiError("rate_limited", retry_after=retry)
        if refundable:
            self.charged.append((key, amount))

    def charge(self, *, device_exempt: bool = False) -> None:
        """Per-device (or per-enrollment, per-session) and per-account buckets (§5.5), the valid-proof
        bucket and the envelope byte budgets (§5.5, contract rev 16). A byte budget counts the request
        body's bytes (the contract's "unit bytes counts request bytes"), so a body whose envelope does not
        even parse pays as much as one that does."""
        lim, L = self.st.settings.limits, self.st.limiter
        write = self.op.method != "GET"
        if self.device is not None or self.enrollment is not None:
            who = (
                self.device["device_id"] if self.device is not None else "enroll:" + str(self.enrollment["request_id"])
            )
            if not device_exempt:
                self._hit(("dw:" if write else "dr:") + who, lim.device_writes if write else lim.device_reads)
            # The account ceiling counts enrolled devices only. An enrolling device (enroll:{rid}) needs
            # only an account session, i.e. the email, and the email must not be able to fill the
            # ceiling the owner's devices poll against (§0.0r A21); it is bounded by its own per-rid
            # buckets, one pending request per session and the OTP send limits.
            if not self.op.account_ceiling_exempt and self.device is not None:
                self._hit(
                    L.hkey("aw" if write else "ar", self.user_id or ""),
                    lim.account_writes if write else lim.account_reads,
                )
            if device_exempt:  # a valid proof: exempt per device, but bounded per account (revoke/rotate too)
                self._hit(L.hkey("pv", self.user_id or ""), lim.proof_valid_account)
            if self.op.max_body == MAX_BODY_BYTES_VAULT and self.device is not None:
                n = len(self.raw)
                if not device_exempt:  # paid even when it then fails (write_denied), never refunded (S4)
                    self._hit("eb:" + who, lim.device_envelope_bytes, refundable=False, amount=n)
                self._hit(L.hkey("ab", self.user_id or ""), lim.account_envelope_bytes, amount=n)
        elif self.session is not None:
            self._hit(
                L.hkey("sw" if write else "sr", self.session.session_id),
                lim.session_writes if write else lim.session_reads,
            )
            if self.op.max_body == MAX_BODY_BYTES_VAULT:
                # init: a byte budget per account session. Not a device budget (the device does not exist
                # yet and its id is whatever the client writes into the body), and not the account's: a
                # session needs only the email, which must not be able to use up the budget the
                # account's devices write against (D2).
                self._hit(L.hkey("sb", self.session.session_id), lim.session_envelope_bytes, amount=len(self.raw))

    def refund(self) -> None:
        for key, amount in self.charged:
            self.st.limiter.refund(key, amount)
        self.charged.clear()

    def client_ip(self) -> str:
        """Only for HMAC'd rate-limit keys; never stored or logged (§5.6)."""
        peer = self.request.scope.get("client")
        ip = peer[0] if peer else ""
        if ip in self.st.settings.trusted_proxies:
            values = self.request.headers.getlist("x-forwarded-for")
            if len(values) == 1:
                ip = values[0].split(",")[-1].strip()
        return ip_key(ip)

    # -------------------------------------------------------------------------------- proofs

    async def prepare_proof(self) -> None:
        """Evaluate password_auth / recovery_auth against the stored verifier, without side effects."""
        body = self.body if isinstance(self.body, dict) else {}
        if "password_auth" in body:
            self.proof_kind, value = "password", body["password_auth"]
        elif "recovery_auth" in body and self.op.proof == "password_or_recovery":
            self.proof_kind, value = "recovery", body["recovery_auth"]
        else:
            self.proof_kind, value, self.proof_missing = "password", None, True
            self.proof_valid = False
            return
        row = await self.pool.fetchrow(
            "SELECT password_verifier, recovery_verifier FROM sixkey.vaults WHERE user_id = $1", self._uid()
        )
        if row is None:
            self.proof_valid = False
            return
        if self.proof_kind == "password":
            self.proof_valid = wire.proof_matches(wire.PASSWORD_VERIFIER_PREFIX, value, row["password_verifier"])
        else:
            self.proof_valid = wire.proof_matches(wire.RECOVERY_VERIFIER_PREFIX, value, row["recovery_verifier"])

    async def enforce_proof(self) -> None:
        """403 for a missing or wrong proof. A wrong one first passes its own in-memory bucket (past it:
        429, no database write), then increments the device's failure counter, capped at 10; it never
        locks and never backs off (§3.14 S2). A valid one clears the counter."""
        code = "recovery_mismatch" if self.proof_kind == "recovery" else "password_mismatch"
        dev = self.device
        if self.proof_valid:
            if dev["auth_failures"] > 0:
                async with self.pool.acquire() as con, con.transaction():
                    if await con.fetchval(
                        "UPDATE sixkey.devices SET auth_failures = 0 WHERE device_id = $1 AND auth_failures > 0 "
                        "RETURNING 1",
                        dev["device_id"],
                    ):
                        await con.execute(
                            "UPDATE sixkey.vaults SET devices_rev = devices_rev + 1 WHERE user_id = $1", self._uid()
                        )
            return
        if self.proof_missing:
            raise ApiError(code)
        lim = self.st.settings.limits.invalid_proof_per_device
        retry = self.st.limiter.hit("bp:" + dev["device_id"], lim[0], lim[1])
        if retry is not None:
            raise ApiError("rate_limited", retry_after=retry)
        async with self.pool.acquire() as con, con.transaction():
            n = await con.fetchval(
                "UPDATE sixkey.devices SET auth_failures = auth_failures + 1 "
                "WHERE device_id = $1 AND auth_failures < $2 RETURNING auth_failures",
                dev["device_id"],
                AUTH_FAILURES_CAP,
            )
            if n is not None:
                await con.execute(
                    "UPDATE sixkey.vaults SET devices_rev = devices_rev + 1 WHERE user_id = $1", self._uid()
                )
        raise ApiError(code)

    def _uid(self) -> uuid.UUID:
        return uuid.UUID(self.user_id)

    @property
    def uid(self) -> uuid.UUID:
        return self._uid()


# ------------------------------------------------------------------------------------ responses


def json_response(status: int, payload: dict | None, now_ms: int, headers: dict | None = None) -> Response:
    if status == 204:
        return Response(status_code=204, headers=headers)
    body = dict(payload or {})
    body["server_time"] = now_ms
    return Response(
        json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
        status_code=status,
        media_type="application/json",
        headers=headers,
    )


def error_response(err: ApiError, now_ms: int) -> Response:
    headers = {}
    if "retry_after" in err.details:
        headers["Retry-After"] = str(err.details["retry_after"])
    return json_response(err.status, {"error": {"code": err.code, **err.details}}, now_ms, headers)


# ------------------------------------------------------------------------------------ steps


def ip_key(ip: str) -> str:
    """The unit an IP limit counts: an IPv4 address, or the /64 of an IPv6 one (one customer gets a /64,
    S5). IPv4-mapped IPv6 counts as IPv4. Only ever used inside an HMAC'd rate-limit key."""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if a.version == 6:
        if a.ipv4_mapped is not None:
            return str(a.ipv4_mapped)
        return str(ipaddress.ip_network(f"{a}/64", strict=False))
    return str(a)


def json_content_type(request: Request) -> bool:
    """§5.4 (contract x-sixkey-request-rules json_content_type): application/json, case-insensitive, and
    the only parameter allowed is charset=utf-8 (it may be omitted). No aliases (utf8), no quoted value,
    no other parameter. Anything else could be a cross-site "simple" request (S6)."""
    value = request.headers.get("content-type")
    if value is None:
        return False
    parts = value.split(";")
    if parts[0].strip().lower() != "application/json" or len(parts) > 2:
        return False
    return len(parts) == 1 or parts[1].strip().lower() == "charset=utf-8"


def precheck(request: Request, op: Op) -> int:
    """Step 1's bodiless checks; returns the operation's body limit."""
    limit = op.max_body or MAX_BODY_BYTES_OTHER
    cl = request.headers.get("content-length")
    if cl is not None and cl.isdigit() and int(cl) > limit:
        raise ApiError("too_large")
    if op.max_body is not None and not json_content_type(request):
        raise ApiError("invalid_request")
    return limit


async def read_body(request: Request, limit: int, timeout_s: float) -> bytes:
    async def read() -> bytes:
        chunks, n = [], 0
        async for chunk in request.stream():
            n += len(chunk)
            if n > limit:
                raise ApiError("too_large")
            chunks.append(chunk)
        return b"".join(chunks)

    try:
        return await asyncio.wait_for(read(), timeout_s)
    except asyncio.TimeoutError:
        raise ApiError("unavailable", retry_after=5) from None


async def take_large_slot(st: AppState) -> None:
    try:
        await asyncio.wait_for(st.large_slots.acquire(), st.settings.large_body_wait_s)  # type: ignore[union-attr]
    except asyncio.TimeoutError:
        raise ApiError("unavailable", retry_after=5) from None


def _sig_headers(request: Request) -> tuple[str, bytes]:
    ts = request.headers.get("sixkey-ts")
    sig = sigauth.parse_sig(request.headers.get("sixkey-sig"))
    if not sigauth.ts_ok(ts) or sig is None:
        raise ApiError("bad_signature")
    return ts, sig  # type: ignore[return-value]


def _check_window(ctx: Ctx, ts: str) -> None:
    if abs(int(ts) - ctx.now) > SIG_WINDOW_S * 1000:
        raise ApiError("clock_skew")
    ctx.ts = int(ts)


def _msg(ctx: Ctx, signer: str, sub: str, ts: str) -> bytes:
    target = sigauth.raw_target(ctx.request.scope)
    if target is None:
        raise ApiError("bad_signature")
    return sigauth.signing_input(ctx.st.settings.host, ctx.request.method, target, signer, sub, ts, ctx.raw)


async def find_device(ctx: Ctx, device_id: str) -> None:
    """Before the body: the headers' shape and the device row (§5.2: look up by primary key)."""
    ts, sig = _sig_headers(ctx.request)
    if not sigauth.DEVICE_ID_RE.match(device_id):
        raise ApiError("bad_signature")
    row = await ctx.pool.fetchrow(
        "SELECT device_id, user_id, sig_pubkey, revoked_at, auth_failures FROM sixkey.devices WHERE device_id = $1",
        device_id,
    )
    if row is None:
        raise ApiError("unknown_device")
    ctx._pending = ("device", row, ts, sig)


async def find_enrollment(ctx: Ctx, rid: str) -> None:
    """Before the body: the enrolling signer is bound to the path's request, which must exist."""
    ts, sig = _sig_headers(ctx.request)
    if not sigauth.RID_RE.match(rid) or rid != ctx.path_params.get("rid"):
        raise ApiError("bad_signature")
    row = await ctx.pool.fetchrow(
        "SELECT request_id, user_id, via, new_device_id, new_sig_pubkey, state, expires_at "
        "FROM sixkey.enrollments WHERE request_id = $1",
        rid,
    )
    if row is None:
        raise ApiError("enroll_gone")
    ctx._pending = ("enroll", row, ts, sig)


def verify_signer(ctx: Ctx, sub: str) -> None:
    """After the body: §5.2 / P6 order, verify first, then revoked, then the window."""
    kind, row, ts, sig = ctx._pending  # type: ignore[misc]
    if kind == "device":
        key = wire.spki_public_key(bytes(row["sig_pubkey"]))
        if not sigauth.verify(key, _msg(ctx, row["device_id"], sub, ts), sig):
            raise ApiError("bad_signature")
        if row["revoked_at"] is not None:
            raise ApiError("device_revoked")
        _check_window(ctx, ts)
        ctx.device, ctx.user_id, ctx.signer = row, str(row["user_id"]), row["device_id"]
    else:
        rid = str(row["request_id"])
        key = wire.spki_public_key(bytes(row["new_sig_pubkey"]))
        if not sigauth.verify(key, _msg(ctx, "enroll:" + rid, "-", ts), sig):
            raise ApiError("bad_signature")
        _check_window(ctx, ts)
        ctx.enrollment, ctx.user_id, ctx.signer = row, str(row["user_id"]), "enroll:" + rid


def auth_registration(ctx: Ctx) -> None:
    """init / enrollment request / recovery: proof of possession of the key in the body (§5.2 N8)."""
    ts, sig = _sig_headers(ctx.request)
    device_id, spki_b64 = ctx.op.registration_key(ctx.body)  # type: ignore[misc]
    if ctx.request.headers.get("sixkey-device") != device_id:
        raise ApiError("bad_signature")
    key = wire.spki_public_key(wire.b64d(spki_b64))  # 422 for a key off the curve
    if not sigauth.verify(key, _msg(ctx, device_id, ctx.session.sub, ts), sig):  # type: ignore[union-attr]
        raise ApiError("bad_signature")
    _check_window(ctx, ts)
    ctx.user_id, ctx.signer = ctx.session.sub, device_id  # type: ignore[union-attr]


def parse(ctx: Ctx) -> None:
    schema = ctx.st.contract.ops[ctx.op.op_id]["request_schema"]
    if schema is None:
        return
    try:
        ctx.body = parse_body(ctx.raw)
    except JsonError:
        raise ApiError("invalid_request") from None
    env = ctx.body.get("envelope") if isinstance(ctx.body, dict) else None
    if isinstance(env, str) and len(env.encode("utf-8")) > MAX_ENVELOPE_BYTES:
        raise ApiError("too_large")  # §4.3: an oversized envelope is 413, before its schema's maxLength says 422
    if not ctx.st.contract.request_valid(ctx.op.op_id, ctx.body):
        raise ApiError("invalid_request")


async def run(st: AppState, op: Op, handler: Handler, request: Request) -> Response:
    ctx = Ctx(st, op, request)
    started = time.monotonic()
    status, code, exc_name = 500, None, None
    slot = False
    try:
        limit = precheck(request, op)
        if op.auth in (ACCOUNT, REGISTRATION, DEVICE_STEP_UP):
            token = account_session.bearer(request.headers.get("authorization"))
            ctx.session = account_session.verify(token, st.provider.jwt_keys(), st.provider.issuer, ctx.now)
            if op.auth == ACCOUNT:
                ctx.user_id = ctx.session.sub
        if op.auth in (DEVICE, DEVICE_STEP_UP):
            await find_device(ctx, request.headers.get("sixkey-device") or "")
        elif op.auth == ENROLL:
            await find_enrollment(ctx, request.headers.get("sixkey-enroll") or "")
        elif op.auth == DEVICE_OR_ENROLL:
            dev, enr = request.headers.get("sixkey-device"), request.headers.get("sixkey-enroll")
            if (dev is None) == (enr is None):
                raise ApiError("bad_signature")
            if dev is not None:
                await find_device(ctx, dev)
            else:
                await find_enrollment(ctx, enr or "")
        elif op.auth == REGISTRATION:
            _sig_headers(request)
        if op.max_body == MAX_BODY_BYTES_VAULT:
            await take_large_slot(st)
            slot = True
        ctx.raw = await read_body(request, limit, st.settings.body_timeout_s)
        if ctx._pending is not None:
            verify_signer(ctx, ctx.session.sub if ctx.session is not None and op.auth == DEVICE_STEP_UP else "-")
        if op.proof == "none" and op.auth != REGISTRATION:
            ctx.charge()
            parse(ctx)
        else:
            try:
                parse(ctx)
            except ApiError:
                # a body that does not parse carries no valid proof: it pays every bucket, the byte
                # budgets included, before its 413/422 (re-review RR1)
                ctx.charge()
                raise
            if op.auth == REGISTRATION:
                auth_registration(ctx)
                ctx.charge()
            elif ctx.device is not None:
                await ctx.prepare_proof()
                ctx.charge(device_exempt=bool(ctx.proof_valid))
            else:
                ctx.charge()
        status, payload = await handler(ctx)
        response = json_response(status, payload, ctx.now)
    except ApiError as e:
        status, code = e.status, e.code
        response = error_response(e, ctx.now)
    except ProviderUnavailable:
        e = ApiError("unavailable", retry_after=5)
        status, code, exc_name = e.status, e.code, "ProviderUnavailable"
        response = error_response(e, ctx.now)
    except Exception as ex:  # never log the message: driver errors carry row data (§5.6 P7)
        e = map_exception(ex)
        status, code, exc_name = e.status, e.code, type(ex).__name__
        response = error_response(e, ctx.now)
    finally:
        if slot:
            st.large_slots.release()  # type: ignore[union-attr]
    if status in (401, 403):
        ctx.refund()
    applog.emit(
        rid=secrets.token_hex(6),
        route=op.path,
        method=request.method,
        status=status,
        ms=int((time.monotonic() - started) * 1000),
        code=code,
        exc=exc_name,
        ref=st.limiter.ref(ctx.user_id) if status >= 500 and ctx.user_id else None,
    )
    return response
