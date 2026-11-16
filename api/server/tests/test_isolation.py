"""Tenant isolation (§8.4 "每个端点的跨租户隔离", PLAN 7.2): user A, with valid credentials of its own,
aims every operation at user B's ids. Afterwards every row of B in every table is unchanged and no
response A received contains anything of B's."""

from __future__ import annotations

import sk


async def test_user_a_can_never_read_or_modify_user_b(world):
    w = world
    acct_a, dev_a, keys_a = await w.vault()
    acct_b, dev_b, keys_b = await w.vault()
    dev_b2 = await w.recovery_device(acct_b, keys_b)
    await w.api.put_vault(dev_b, keys_b, 1)
    keys_b.version = 2
    flow_b = await w.start_approval(acct_b)
    await flow_b.respond(dev_b, keys_b)
    flow_b2 = await w.start_approval(acct_b)
    flow_a = await w.start_approval(acct_a)
    before = await w.rows(acct_b.sub)
    b_secrets = {
        acct_b.sub,
        dev_b.device_id,
        dev_b2.device_id,
        flow_b.rid,
        flow_b2.rid,
        flow_b.dev.device_id,
        keys_b.vault_id,
        keys_b.vk_id,
        keys_b.bundle_text[:60],
    }
    b_secrets |= {r["envelope"][-60:] for r in before["sixkey.vault_versions"]}
    pw = {"password_auth": keys_a.pw_auth_b64}
    responses = []

    async def call(*a, **kw):
        r = await w.api.call(*a, **kw)
        responses.append(r)
        return r

    # reads aimed at B
    for v in (1, 2, 3):
        r = await call("GET", f"/v1/vault/versions/{v}", dev=dev_a)
        assert r.status_code in (200, 404) and (r.status_code == 404 or r.json()["version"] == 1)
    for rid in (flow_b.rid, flow_b2.rid):
        assert (await call("GET", f"/v1/enroll/requests/{rid}", dev=dev_a)).status_code == 410
        r = await call("POST", f"/v1/enroll/requests/{rid}/respond", {"epk": sk.b64(sk.ec_point()), **pw}, dev=dev_a)
        assert r.status_code == 410
        r = await call(
            "POST",
            f"/v1/enroll/requests/{rid}/approve",
            {
                "transcript_hash": sk.b64(sk.rnd(32)),
                "payload": sk.b64(sk.rnd(100)),
                "name_ct": keys_a.name_ct(),
                "sig_pubkey_sha256": sk.b64(sk.rnd(32)),
                **pw,
            },
            dev=dev_a,
        )
        assert r.status_code == 410
        assert (await call("POST", f"/v1/enroll/requests/{rid}/reject", pw, dev=dev_a)).status_code == 410
        # A's enrolling device signing as enroll:{B's rid}: its key is not B's request key
        for path, body in (
            (
                f"/v1/enroll/requests/{rid}/reveal",
                {"epk": sk.b64(sk.ec_point()), "nonce": sk.b64(sk.rnd(32)), "name_ct": sk.b64(sk.rnd(188))},
            ),
            (f"/v1/enroll/requests/{rid}/complete", {}),
            (f"/v1/enroll/requests/{rid}/reject", {}),
        ):
            r = await call("POST", path, body, enroll=(rid, flow_a.dev))
            assert r.status_code == 401
        assert (await call("GET", f"/v1/enroll/requests/{rid}", enroll=(rid, flow_a.dev))).status_code == 401
    # writes aimed at B's devices
    for d in (dev_b, dev_b2):
        r = await call("PATCH", f"/v1/devices/{d.device_id}", {"name_ct": keys_a.name_ct(), **pw}, dev=dev_a)
        assert r.status_code == 404
        r = await call("POST", f"/v1/devices/{d.device_id}/revoke", pw, dev=dev_a)
        assert r.status_code == 404
        nd = sk.Dev(d.device_id)
        r = await call(
            "POST",
            "/v1/devices/fork",
            {"new_device_id": d.device_id, "new_sig_pubkey": nd.spki_b64, "name_ct": keys_a.name_ct(), **pw},
            dev=dev_a,
            new_sig=nd,
        )
        assert r.status_code == 409
        # B's device id with A's key
        assert (
            await call("GET", "/v1/sync/status", dev=dev_a, signer=d.device_id, headers={"Sixkey-Device": d.device_id})
        ).status_code == 401
    # registrations with B's ids
    s = await w.login(acct_a.email)
    clash = sk.Dev(dev_b.device_id)
    r = await call(
        "POST",
        "/v1/enroll/requests",
        {"device_id": clash.device_id, "sig_pubkey": clash.spki_b64, "commit": sk.b64(sk.rnd(32))},
        acct=s,
        reg=clash,
    )
    assert r.status_code == 409
    r = await call(
        "POST",
        "/v1/enroll/recovery",
        {"device_id": sk.Dev().device_id, "sig_pubkey": clash.spki_b64, "recovery_auth": keys_b.rec_auth_b64},
        acct=await w.login(acct_a.email),
        reg=clash,
    )
    assert r.status_code in (401, 403)
    newcomer = await w.login()
    k = sk.new_vault_keys(w.hour())
    r = await w.api.init(newcomer, clash, k)
    responses.append(r)
    assert r.status_code == 409 and r.json()["error"]["code"] == "device_exists"
    # A's vault operations carrying B's vault id or bundle
    env = sk.envelope(keys_b.vault_id, keys_a.vk_id, 2)
    assert (
        await call(
            "PUT",
            "/v1/vault",
            {
                "if_version": 1,
                "envelope": env[0],
                "write_proof": keys_a.proof(1, env[1]),
                "cursor": {"pending": sk.b64(sk.rnd(16))},
            },
            dev=dev_a,
        )
    ).status_code == 422
    r = await call("PUT", "/v1/keys", {"if_kver": 1, "bundle": keys_b.bundle(dev_a.device_id, kver=2), **pw}, dev=dev_a)
    assert r.status_code == 422
    k2 = sk.Keys(vault_id=keys_a.vault_id, vk_id=sk.vk_id(), at=keys_a.at)
    env = sk.envelope(keys_a.vault_id, k2.vk_id, 2)
    r = await call(
        "POST",
        "/v1/keys/rotate",
        {
            "if_version": 1,
            "if_kver": 1,
            "envelope": env[0],
            "write_proof": keys_a.proof(1, env[1]),
            "new_write_key": sk.b64(k2.write_key),
            "bundle": k2.bundle(dev_a.device_id, kver=2),
            **pw,
            "recovery_verifier": k2.rec_verifier(),
            "password_verifier": k2.pw_verifier(),
            "device_names": [{"device_id": dev_b.device_id, "name_ct": k2.name_ct()}],
        },
        dev=dev_a,
    )
    assert r.status_code == 422
    # account-wide operations of A touch only A
    assert (await call("DELETE", "/v1/vault/versions", pw, dev=dev_a)).status_code == 200
    assert (await call("POST", "/v1/enroll/reject-all", pw, dev=dev_a)).status_code == 200
    r = await call("DELETE", "/v1/account", pw, dev=dev_a, acct=await w.login(acct_b.email))
    assert r.json()["error"]["code"] == "step_up_required"
    # lists show A's things only
    devs = (await call("GET", "/v1/devices", dev=dev_a)).json()["devices"]
    assert {d["device_id"] for d in devs} == {dev_a.device_id}
    assert (await call("GET", "/v1/enroll/requests", dev=dev_a)).json()["requests"] == []
    st = (await call("GET", "/v1/sync/status", dev=dev_a)).json()
    assert st["pending_enrollments"] == 0 and st["vk_id"] == keys_a.vk_id
    acc = (await call("GET", "/v1/account", acct=s)).json()
    assert acc["device_count"] == 1
    for path in ("/v1/vault", "/v1/keys", "/v1/vault/versions"):
        await call("GET", path, dev=dev_a)

    after = await w.rows(acct_b.sub)
    assert after == before
    for r in responses:
        text = r.text
        for s_ in b_secrets:
            assert s_ not in text, (r.request.method, r.request.url.path, s_[:20])


async def test_conflict_bodies_carry_only_the_callers_state(world):
    w = world
    acct_a, dev_a, keys_a = await w.vault()
    acct_b, dev_b, keys_b = await w.vault()
    for _ in range(3):
        r = await w.api.put_vault(dev_b, keys_b)
        keys_b.version += 1
    r = await w.api.put_vault(dev_a, keys_a, 3, env=sk.envelope(keys_a.vault_id, keys_a.vk_id, 4))
    e = r.json()["error"]
    assert e == {"code": "version_conflict", "version": 1, "vk_id": keys_a.vk_id, "kver": 1}
    assert keys_b.vk_id not in r.text and keys_b.version == 4  # B's state (version 4, its vk_id) is not in it
