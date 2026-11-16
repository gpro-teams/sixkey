"""The app behind a real uvicorn over TCP, configured as `python -m sixkey_server` runs it: raw request
targets as uvicorn passes them, the configured host (not the Host header), Date on a 204, chunked
bodies past the limit, and no access log (no client IP anywhere)."""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time

import httpx
import uvicorn

import pgutil
import sk
from sixkey_server.config import RateLimits, Settings
from sixkey_server.main import create_app


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_real_server(db, tmp_path):
    asyncio.run(pgutil.reset(db))
    port = free_port()
    inbox = tmp_path / "inbox.jsonl"
    settings = Settings(
        database_dsn=db.api,
        fake_auth_dsn=db.fake_auth,
        fake_inbox_file=str(inbox),
        env="test",
        api_origin=f"http://127.0.0.1:{port}",
        limits=RateLimits(),
    )
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(settings),
            host="127.0.0.1",
            port=port,
            access_log=False,
            proxy_headers=False,
            server_header=False,
            log_level="warning",
            log_config=None,
            lifespan="on",
        )
    )
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.02)
    assert server.started
    host = f"127.0.0.1:{port}"
    try:
        with httpx.Client(base_url=f"http://{host}", timeout=30) as c:
            r = c.get("/healthz")
            assert r.status_code == 200 and "date" in r.headers and "server" not in r.headers
            email = sk.secret("tcp@example.invalid")
            assert c.post("/v1/auth/otp", json={"email": email}).status_code == 202
            code = json.loads(inbox.read_text().splitlines()[-1])["code"]
            assert sk.secret(code) and len(code) == 6
            tok = sk.secret(c.post("/v1/auth/verify", json={"email": email, "token": code}).json()["account_token"])
            sub = json.loads(__import__("base64").urlsafe_b64decode(tok.split(".")[1] + "==="))["sub"]
            acct = sk.Acct(email, tok, sub)
            dev, keys = sk.Dev(), sk.new_vault_keys(int(time.time() * 1000) // 3_600_000 * 3_600_000)

            def signed(method, target, body=None, *, acct_=None, reg=False, host_=host, sub_=None):
                raw = sk.compact(body).encode() if body is not None else b""
                ts = int(time.time() * 1000)
                s = sub_ if sub_ is not None else (acct_.sub if acct_ else "-")
                h = {
                    "Sixkey-Device": dev.device_id,
                    "Sixkey-Ts": str(ts),
                    "Sixkey-Sig": dev.sign(sk.signing_input(method, target, dev.device_id, s, ts, raw, host_)),
                }
                if acct_:
                    h["Authorization"] = f"Bearer {acct_.token}"
                if raw:
                    h["Content-Type"] = "application/json"
                return c.request(method, target, content=raw, headers=h)

            env, _ = sk.envelope(keys.vault_id, keys.vk_id, 1)
            keys.bundle_text = keys.bundle(dev.device_id)
            r = signed(
                "POST",
                "/v1/vault/init",
                {
                    "vault_id": keys.vault_id,
                    "envelope": env,
                    "bundle": keys.bundle_text,
                    "recovery_verifier": keys.rec_verifier(),
                    "password_verifier": keys.pw_verifier(),
                    "write_key": sk.b64(keys.write_key),
                    "device": {"device_id": dev.device_id, "sig_pubkey": dev.spki_b64, "name_ct": keys.name_ct()},
                },
                acct_=acct,
            )
            assert r.status_code == 201, r.text
            assert signed("GET", "/v1/sync/status?b=2&a=%7C").status_code == 200  # raw target from uvicorn
            assert signed("GET", "/v1/sync/status", host_="api.sixkey.app").status_code == 401  # configured host only

            # chunked upload past 64 KiB on a 64 KiB endpoint
            def gen():
                yield b'{"password_auth":"'
                for _ in range(80):
                    yield b"A" * 1024
                yield b'"}'

            r = c.request("DELETE", "/v1/vault/versions", content=gen(), headers={"Content-Type": "application/json"})
            assert r.status_code == 401  # no signer: refused before the body is read (S3)
            known = {
                "Content-Type": "application/json",
                "Sixkey-Device": dev.device_id,
                "Sixkey-Ts": str(int(time.time() * 1000)),
                "Sixkey-Sig": sk.b64u(b"\x01" * 64),
            }
            r = c.request("DELETE", "/v1/vault/versions", content=gen(), headers=known)
            assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"
            assert c.get("/v1/vault/").status_code == 404 and "location" not in c.get("/v1/vault/").headers
            r = signed("DELETE", "/v1/account", {"password_auth": keys.pw_auth_b64}, acct_=acct)
            assert r.status_code == 204 and r.content == b"" and "date" in r.headers
    finally:
        server.should_exit = True
        t.join(timeout=10)
