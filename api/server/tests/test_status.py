"""Status is read-only (T2), the cursor changes only in PUT (§4.10), devices_rev moves exactly on
device-row changes (N15), min_client_version (d6)."""

from __future__ import annotations

import sk


async def all_rows(w):
    return {
        t: [dict(r) for r in await w.sql(f"SELECT * FROM {t} ORDER BY 1")]
        for t in ("sixkey.vaults", "sixkey.vault_versions", "sixkey.devices", "sixkey.enrollments")
    }


async def test_status_writes_nothing_but_last_seen_once_a_day(world):
    w = world
    acct, dev, keys = await w.vault()
    await w.api.status(dev)
    base = await all_rows(w)
    for _ in range(5):
        await w.api.status(dev)
        for p in ("/v1/vault", "/v1/keys", "/v1/devices", "/v1/vault/versions", "/v1/enroll/requests"):
            await w.api.call("GET", p, dev=dev)
        w.clock.advance(3_600_000)
    assert await all_rows(w) == base
    xmin = await w.val("SELECT xmin::text FROM sixkey.devices")
    w.clock.advance(86_400_000)
    await w.api.status(dev)
    after = await all_rows(w)
    assert after["sixkey.vaults"] == base["sixkey.vaults"]  # devices_rev not bumped by last_seen
    assert str(after["sixkey.devices"][0]["last_seen_at"]) == "2026-10-16"
    assert {k: v for k, v in after["sixkey.devices"][0].items() if k != "last_seen_at"} == {
        k: v for k, v in base["sixkey.devices"][0].items() if k != "last_seen_at"
    }
    xmin2 = await w.val("SELECT xmin::text FROM sixkey.devices")
    await w.api.status(dev)
    assert await w.val("SELECT xmin::text FROM sixkey.devices") == xmin2 != xmin  # one write that day only


async def test_cursor_and_forked(world):
    w = world
    acct, dev, keys = await w.vault()

    async def put(cursor):
        r = await w.api.put_vault(dev, keys, cursor=cursor)
        assert r.status_code == 200, r.text
        keys.version = r.json()["version"]
        return r.json()["forked"], bytes(await w.val("SELECT cursor FROM sixkey.devices"))

    p1, p2, p3 = (sk.rnd(16) for _ in range(3))
    assert await w.val("SELECT cursor FROM sixkey.devices") is None
    assert await put({"pending": sk.b64(p1)}) == (False, p1)  # first write starts the chain
    assert await put({"cur": sk.b64(p1), "pending": sk.b64(p2)}) == (False, p2)  # normal step
    assert await put({"cur": sk.b64(p1), "pending": sk.b64(p2)}) == (False, p2)  # the 200 was lost: same again
    clone = sk.rnd(16)
    assert await put({"cur": sk.b64(p1), "pending": sk.b64(clone)}) == (True, p2)  # a copy with an old cursor
    assert await put({"pending": sk.b64(clone)}) == (True, p2)  # a copy without one
    assert await put({"cur": sk.b64(p2), "pending": sk.b64(p3)}) == (False, p3)  # the chain goes on
    # a refused PUT never moves the cursor
    r = await w.api.put_vault(dev, keys, 1, cursor={"cur": sk.b64(p3), "pending": sk.b64(sk.rnd(16))})
    assert r.status_code == 409
    assert bytes(await w.val("SELECT cursor FROM sixkey.devices")) == p3


async def test_devices_rev_moves_exactly_on_device_changes(world):
    w = world
    acct, dev, keys = await w.vault()

    async def rev():
        return (await w.api.status(dev)).json()["devices_rev"]

    seen = [await rev()]
    assert seen == [1]  # init added the first device
    other = await w.recovery_device(acct, keys)  # complete: +1
    seen.append(await rev())
    flow = await w.start_approval(acct)  # enrollment rows are not device rows
    await flow.respond(dev, keys)
    seen.append(await rev())
    new = sk.Dev()
    await w.api.call(
        "POST",
        "/v1/devices/fork",
        {
            "new_device_id": new.device_id,
            "new_sig_pubkey": new.spki_b64,
            "name_ct": keys.name_ct(),
            "password_auth": keys.pw_auth_b64,
        },
        dev=other,
        new_sig=new,
    )
    seen.append(await rev())
    await w.api.call(
        "PATCH",
        f"/v1/devices/{other.device_id}",
        {"name_ct": keys.name_ct(), "password_auth": keys.pw_auth_b64},
        dev=dev,
    )
    seen.append(await rev())
    await w.api.call("POST", "/v1/enroll/reject-all", {"password_auth": sk.b64(sk.rnd(32))}, dev=dev)  # failure +1
    seen.append(await rev())
    await w.api.put_vault(dev, keys)  # a write is not a device change
    keys.version = 2
    w.clock.advance(86_400_000)
    await w.api.status(dev)  # nor is last_seen_at
    seen.append(await rev())
    await w.api.call("POST", f"/v1/devices/{new.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev)
    seen.append(await rev())  # revoke +1 (and the failure reset +1)
    k2 = sk.Keys(vault_id=keys.vault_id, vk_id=sk.vk_id(), at=keys.at)
    env = sk.envelope(keys.vault_id, k2.vk_id, 3)
    await w.api.call(
        "POST",
        "/v1/keys/rotate",
        {
            "if_version": 2,
            "if_kver": 1,
            "envelope": env[0],
            "write_proof": keys.proof(2, env[1]),
            "new_write_key": sk.b64(k2.write_key),
            "bundle": k2.bundle(dev.device_id, kver=2),
            "password_auth": keys.pw_auth_b64,
            "recovery_verifier": k2.rec_verifier(),
            "password_verifier": k2.pw_verifier(),
            "device_names": [
                {"device_id": d, "name_ct": k2.name_ct()} for d in (dev.device_id, other.device_id, new.device_id)
            ],
        },
        dev=dev,
    )
    seen.append(await rev())  # names re-encrypted +1
    assert seen == [1, 2, 2, 3, 4, 5, 5, 7, 8], seen


async def test_min_client_version(make_world):
    async with make_world(min_client_version="1.4.0.7") as w:
        acct, dev, keys = await w.vault()
        assert (await w.api.status(dev)).json()["min_client_version"] == "1.4.0.7"
