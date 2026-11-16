"""Happy paths through every operation, in the order a client uses them (§3.1-§3.12)."""

from __future__ import annotations

import sk


async def test_healthz(world):
    r = await world.api.call("GET", "/healthz")
    assert r.status_code == 200 and r.json()["ok"] is True and isinstance(r.json()["server_time"], int)


async def test_first_device_status_put_and_history(world):
    w = world
    acct, dev, keys = await w.vault()
    r = await w.api.call("GET", "/v1/account", acct=acct)
    assert r.json()["has_vault"] is True and r.json()["device_count"] == 1
    assert r.json()["vault_created_at"] % sk.HOUR == 0

    st = (await w.api.status(dev)).json()
    assert (st["version"], st["kver"], st["vk_id"], st["devices_rev"], st["pending_enrollments"]) == (
        1,
        1,
        keys.vk_id,
        1,
        0,
    )

    r = await w.api.call("GET", "/v1/vault", dev=dev)
    env1 = r.json()["envelope"]
    assert st["head"] == sk.b64(sk.sha256(env1.encode()))

    text, cs = sk.envelope(keys.vault_id, keys.vk_id, 2)
    r = await w.api.put_vault(dev, keys, env=(text, cs))
    assert r.status_code == 200 and r.json() == {"version": 2, "forked": False, "server_time": r.json()["server_time"]}
    keys.version = 2
    assert (await w.api.call("GET", "/v1/vault", dev=dev)).json()["envelope"] == text

    vs = (await w.api.call("GET", "/v1/vault/versions", dev=dev)).json()["versions"]
    assert [v["version"] for v in vs] == [2, 1] and all(v["created_at"] % sk.HOUR == 0 for v in vs)
    assert (await w.api.call("GET", "/v1/vault/versions/1", dev=dev)).json()["envelope"] == env1

    r = await w.api.call("DELETE", "/v1/vault/versions", {"password_auth": keys.pw_auth_b64}, dev=dev)
    assert r.json()["deleted"] == 1
    r = await w.api.call("DELETE", "/v1/vault/versions", {"password_auth": keys.pw_auth_b64}, dev=dev)
    assert r.json()["deleted"] == 0
    assert [v["version"] for v in (await w.api.call("GET", "/v1/vault/versions", dev=dev)).json()["versions"]] == [2]


async def test_keys_change_password_and_recovery(world):
    w = world
    acct, dev, keys = await w.vault()
    r = await w.api.call("GET", "/v1/keys", dev=dev)
    assert r.json()["bundle"] == keys.bundle_text and r.json()["kver"] == 1

    # new recovery code only (§3.7): recovery wrap changes, recovery_verifier sent
    keys.rec_wrap = sk.wrap("recovery", keys.vk_id, keys.at)
    new_rec = sk.rnd(32)
    text = keys.bundle(dev.device_id, kver=2)
    r = await w.api.call(
        "PUT",
        "/v1/keys",
        {
            "if_kver": 1,
            "bundle": text,
            "password_auth": keys.pw_auth_b64,
            "recovery_verifier": keys.rec_verifier(new_rec),
        },
        dev=dev,
    )
    assert r.status_code == 200 and r.json()["kver"] == 2, r.text
    keys.rec_auth, keys.kver, keys.bundle_text = new_rec, 2, text

    # change password (§3.6): password wrap + auth.kdf + password_verifier; kver may jump (N27)
    keys.pw_wrap, keys.auth_kdf = sk.wrap("password", keys.vk_id, keys.at), sk.kdf_pbkdf2()
    new_pw = sk.rnd(32)
    text = keys.bundle(dev.device_id, kver=9)
    r = await w.api.call(
        "PUT",
        "/v1/keys",
        {
            "if_kver": 2,
            "bundle": text,
            "password_auth": keys.pw_auth_b64,
            "password_verifier": keys.pw_verifier(new_pw),
        },
        dev=dev,
    )
    assert r.status_code == 200 and r.json()["kver"] == 9, r.text
    old_pw, keys.pw_auth = keys.pw_auth, new_pw
    # the old pw_auth no longer works (§8.4), the new one does
    r = await w.api.call("DELETE", "/v1/vault/versions", {"password_auth": sk.b64(old_pw)}, dev=dev)
    assert r.status_code == 403 and r.json()["error"]["code"] == "password_mismatch"
    r = await w.api.call("DELETE", "/v1/vault/versions", {"password_auth": keys.pw_auth_b64}, dev=dev)
    assert r.status_code == 200


async def test_approval_enrollment_and_devices(world):
    w = world
    acct, dev_a, keys = await w.vault()
    flow = await w.start_approval(acct)
    st = (await w.api.status(dev_a)).json()
    assert st["pending_enrollments"] == 1
    lst = (await w.api.call("GET", "/v1/enroll/requests", dev=dev_a)).json()["requests"]
    assert [x["request_id"] for x in lst] == [flow.rid] and lst[0]["state"] == "pending"
    assert lst[0]["created_at"] % 60_000 == 0

    view = (await flow.poll(dev_a)).json()
    assert view["new_device_id"] == flow.dev.device_id and view["commit"] == sk.b64(flow.commit)
    assert (await flow.respond(dev_a, keys)).json()["state"] == "responded"
    nv = (await flow.poll()).json()
    assert nv["approver_device_id"] == dev_a.device_id and nv["approver_epk"] == sk.b64(flow.approver_epk)
    assert (await flow.reveal()).json()["state"] == "revealed"
    av = (await flow.poll(dev_a)).json()
    assert av["new_epk"] == sk.b64(flow.epk) and av["new_name_ct"] == sk.b64(flow.name)
    assert (await flow.approve(dev_a, keys)).json()["state"] == "approved"
    assert "payload" in (await flow.poll()).json()
    r = await flow.complete()
    assert r.status_code == 200 and r.json()["device_id"] == flow.dev.device_id
    # the request is gone, the device works
    assert (await w.api.status(flow.dev)).status_code == 200
    devs = (await w.api.call("GET", "/v1/devices", dev=flow.dev)).json()
    assert devs["current"] == flow.dev.device_id
    by_id = {d["device_id"]: d for d in devs["devices"]}
    assert by_id[flow.dev.device_id]["joined_via"] == "approval"
    assert by_id[flow.dev.device_id]["approved_by"] == dev_a.device_id


async def test_recovery_enrollment_rename_fork_revoke(world):
    w = world
    acct, dev_a, keys = await w.vault()
    dev_r = await w.recovery_device(acct, keys)
    devs = {d["device_id"]: d for d in (await w.api.call("GET", "/v1/devices", dev=dev_a)).json()["devices"]}
    assert devs[dev_r.device_id]["joined_via"] == "recovery" and devs[dev_r.device_id]["approved_by"] is None

    r = await w.api.call(
        "PATCH",
        f"/v1/devices/{dev_r.device_id}",
        {"name_ct": keys.name_ct(), "password_auth": keys.pw_auth_b64},
        dev=dev_a,
    )
    assert r.status_code == 200, r.text

    new = sk.Dev()
    r = await w.api.call(
        "POST",
        "/v1/devices/fork",
        {
            "new_device_id": new.device_id,
            "new_sig_pubkey": new.spki_b64,
            "name_ct": keys.name_ct(),
            "password_auth": keys.pw_auth_b64,
        },
        dev=dev_r,
        new_sig=new,
    )
    assert r.status_code == 201 and r.json()["device_id"] == new.device_id, r.text
    assert (await w.api.status(new)).status_code == 200

    r = await w.api.call(
        "POST", f"/v1/devices/{dev_r.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev_a
    )
    assert r.status_code == 200 and r.json()["revoked_at"] % sk.HOUR == 0
    r2 = await w.api.call(
        "POST", f"/v1/devices/{dev_r.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev_a
    )
    assert r2.json()["revoked_at"] == r.json()["revoked_at"]
    r = await w.api.status(dev_r)
    assert r.status_code == 403 and r.json()["error"]["code"] == "device_revoked"


async def test_rotate_then_put(world):
    w = world
    acct, dev, keys = await w.vault()
    other = await w.recovery_device(acct, keys)
    flow = await w.start_approval(acct)
    new_vk = sk.vk_id()
    k2 = sk.Keys(vault_id=keys.vault_id, vk_id=new_vk, at=keys.at)
    text, cs = sk.envelope(keys.vault_id, new_vk, 2)
    bundle = k2.bundle(dev.device_id, kver=2)
    names = [{"device_id": d.device_id, "name_ct": k2.name_ct()} for d in (dev, other)]
    body = {
        "if_version": 1,
        "if_kver": 1,
        "envelope": text,
        "write_proof": keys.proof(1, cs),
        "new_write_key": sk.b64(k2.write_key),
        "bundle": bundle,
        "password_auth": keys.pw_auth_b64,
        "recovery_verifier": k2.rec_verifier(),
        "password_verifier": k2.pw_verifier(),
        "device_names": names,
    }
    r = await w.api.call("POST", "/v1/keys/rotate", body, dev=dev)
    assert r.status_code == 200 and (r.json()["version"], r.json()["kver"]) == (2, 2), r.text
    # identical replay: idempotent 200 whatever the proofs say now (§3.6.0)
    r = await w.api.call("POST", "/v1/keys/rotate", body, dev=dev)
    assert r.status_code == 200 and r.json()["kver"] == 2
    # open enrollments are void
    assert (await flow.poll()).status_code == 410
    st = (await w.api.status(dev)).json()
    assert st["vk_id"] == new_vk and st["version"] == 2
    k2.version, k2.kver = 2, 2
    r = await w.api.put_vault(dev, k2)
    assert r.status_code == 200 and r.json()["version"] == 3, r.text
    # the old K_write is dead
    keys.version = 3
    text, cs = sk.envelope(keys.vault_id, new_vk, 4)
    r = await w.api.put_vault(dev, keys, env=(text, cs))
    assert r.status_code == 403 and r.json()["error"]["code"] == "write_denied"


async def test_delete_account(world):
    w = world
    acct, dev, keys = await w.vault()
    await w.recovery_device(acct, keys)
    fresh = await w.login(acct.email)
    r = await w.api.call("DELETE", "/v1/account", {"password_auth": keys.pw_auth_b64}, dev=dev, acct=fresh)
    assert r.status_code == 204 and r.content == b""
    rows = await w.rows(acct.sub)
    assert all(v == [] for v in rows.values()), rows
    r = await w.api.status(dev)
    assert r.status_code == 401 and r.json()["error"]["code"] == "unknown_device"


async def test_no_conditional_get(world):
    """N2: GET /v1/vault ignores If-None-Match and never answers 304 or sends an ETag."""
    w = world
    acct, dev, keys = await w.vault()
    head = (await w.api.status(dev)).json()["head"]
    for inm in ('"v1"', "*", head):
        r = await w.api.call("GET", "/v1/vault", dev=dev, headers={"If-None-Match": inm})
        assert r.status_code == 200 and r.json()["envelope"] and "etag" not in r.headers
