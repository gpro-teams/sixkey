"""§8.4 / §5.3: the CAS PUT under real concurrent Postgres transactions.

Two writers, N writers, a writer racing a revocation, two app instances on one database, and clones
of one identity writing at once. Invariants checked against the database itself: exactly one winner
per version, versions strictly consecutive, every accepted envelope stored exactly once in history, no
lost update, head = SHA-256(stored text), and no write by a device after its revocation committed.
"""

from __future__ import annotations

import asyncio

import sk
from conftest import open_world


async def devices(w, acct, keys, n):
    return [await w.recovery_device(acct, keys) for _ in range(n)]


async def history(w, user):
    return [
        (r["version"], r["envelope"])
        for r in await w.sql(
            "SELECT version, envelope FROM sixkey.vault_versions WHERE user_id = $1::uuid ORDER BY version", user
        )
    ]


async def test_twenty_concurrent_puts_same_if_version_exactly_one_wins(world):
    w = world
    acct, dev, keys = await w.vault()
    devs = [dev] + await devices(w, acct, keys, 19)
    envs = [sk.envelope(keys.vault_id, keys.vk_id, 2) for _ in devs]
    rs = await asyncio.gather(*(w.api.put_vault(d, keys, 1, env=e) for d, e in zip(devs, envs)))
    codes = sorted(r.status_code for r in rs)
    assert codes == [200] + [409] * 19, codes
    winner = next(i for i, r in enumerate(rs) if r.status_code == 200)
    for r in rs:
        if r.status_code == 409:
            e = r.json()["error"]
            assert e == {"code": "version_conflict", "version": 2, "vk_id": keys.vk_id, "kver": 1}
    h = await history(w, acct.sub)
    assert [v for v, _ in h] == [1, 2] and h[1][1] == envs[winner][0]
    st = (await w.api.status(dev)).json()
    assert st["version"] == 2 and st["head"] == sk.b64(sk.sha256(envs[winner][0].encode()))


async def test_n_writers_each_land_exactly_once_no_lost_update(world):
    w = world
    acct, dev, keys = await w.vault()
    devs = [dev] + await devices(w, acct, keys, 7)
    accepted: dict[int, str] = {}
    attempts = {"n": 0}

    async def writer(d):
        while True:
            v = (await w.api.status(d)).json()["version"]
            env = sk.envelope(keys.vault_id, keys.vk_id, v + 1)
            attempts["n"] += 1
            r = await w.api.put_vault(d, keys, v, env=env)
            if r.status_code == 200:
                assert r.json()["version"] == v + 1
                assert r.json()["version"] not in accepted
                accepted[r.json()["version"]] = env[0]
                return
            assert r.status_code == 409 and r.json()["error"]["code"] == "version_conflict", r.text

    await asyncio.gather(*(writer(d) for d in devs))
    h = await history(w, acct.sub)
    assert [v for v, _ in h] == list(range(1, 2 + len(devs)))  # strictly consecutive, none skipped
    assert {v: e for v, e in h if v > 1} == accepted  # every accepted write stored once
    assert attempts["n"] >= len(devs)
    row = (await w.sql("SELECT version, envelope, head, history_bytes, size_bytes FROM sixkey.vaults"))[0]
    assert row["version"] == 1 + len(devs) and row["envelope"] == accepted[row["version"]]
    assert bytes(row["head"]) == sk.sha256(row["envelope"].encode())
    total = await w.val("SELECT sum(size_bytes) FROM sixkey.vault_versions")
    assert row["history_bytes"] == total


async def test_clones_of_one_identity_writing_at_once_do_not_deadlock(world):
    """Two FOR SHARE holders that both update the device row would deadlock (docs/design/notes/M4-NOTES.md)."""
    w = world
    acct, dev, keys = await w.vault()
    envs = [sk.envelope(keys.vault_id, keys.vk_id, 2) for _ in range(10)]
    rs = await asyncio.gather(*(w.api.put_vault(dev, keys, 1, env=e) for e in envs))
    assert sorted(r.status_code for r in rs) == [200] + [409] * 9


async def test_two_puts_of_one_identity_interleaved_after_the_device_lock(world):
    """Deterministic version of the clone race (docs/design/notes/M4-NOTES.md A1): the first PUT holds the device-row
    lock and pauses before its CAS. With FOR SHARE (as §5.3 writes it) the second PUT would get the lock
    too, win the vault CAS, then wait for the first on the device row while the first waits for it on
    the vault row: a deadlock, one of them a 500. With FOR NO KEY UPDATE the second simply waits."""
    w = world
    acct, dev, keys = await w.vault()
    first, release = asyncio.Event(), asyncio.Event()

    async def hold_first():
        if not first.is_set():
            first.set()
            await release.wait()

    w.state.hooks["put_vault.locked"] = hold_first
    t1 = asyncio.create_task(w.api.put_vault(dev, keys, 1))
    await asyncio.wait_for(first.wait(), 10)
    t2 = asyncio.create_task(w.api.put_vault(dev, keys, 1))
    await asyncio.sleep(0.3)  # let the second one run as far as it can
    release.set()
    r1, r2 = await t1, await t2
    assert sorted((r1.status_code, r2.status_code)) == [200, 409], (r1.text, r2.text)
    assert r1.status_code == 200  # the first one holds the lock, so it wins


async def test_rotate_waits_for_a_put_holding_a_device_lock(world):
    """Lock order (A1): rotate locks every device row of the account before its CAS. A PUT by another
    device holds that device's row and pauses before its CAS; the rotate must wait for it (then lose the
    CAS: 409), not take the vault row first and deadlock when it re-encrypts that device's name."""
    w = world
    acct, dev, keys = await w.vault()
    other = await w.recovery_device(acct, keys)
    first, release = asyncio.Event(), asyncio.Event()

    async def hold_first():
        if not first.is_set():
            first.set()
            await release.wait()

    w.state.hooks["put_vault.locked"] = hold_first
    put = asyncio.create_task(w.api.put_vault(other, keys, 1))
    await asyncio.wait_for(first.wait(), 10)
    k2 = sk.Keys(vault_id=keys.vault_id, vk_id=sk.vk_id(), at=keys.at)
    env = sk.envelope(keys.vault_id, k2.vk_id, 2)
    rot = asyncio.create_task(
        w.api.call(
            "POST",
            "/v1/keys/rotate",
            {
                "if_version": 1,
                "if_kver": 1,
                "envelope": env[0],
                "write_proof": keys.proof(1, env[1]),
                "new_write_key": sk.b64(k2.write_key),
                "bundle": k2.bundle(dev.device_id, kver=2),
                "password_auth": keys.pw_auth_b64,
                "recovery_verifier": k2.rec_verifier(),
                "password_verifier": k2.pw_verifier(),
                "device_names": [{"device_id": d.device_id, "name_ct": k2.name_ct()} for d in (dev, other)],
            },
            dev=dev,
        )
    )
    await asyncio.sleep(0.3)
    release.set()
    r_put, r_rot = await put, await rot
    assert r_put.status_code == 200, r_put.text
    assert r_rot.status_code == 409 and r_rot.json()["error"]["code"] == "version_conflict", r_rot.text


async def test_identical_replay_of_a_put_is_a_conflict_not_a_second_write(world):
    w = world
    acct, dev, keys = await w.vault()
    env = sk.envelope(keys.vault_id, keys.vk_id, 2)
    body = {
        "if_version": 1,
        "envelope": env[0],
        "write_proof": keys.proof(1, env[1]),
        "cursor": {"pending": sk.b64(sk.rnd(16))},
    }
    raw = sk.compact(body).encode()
    ts = w.clock.now_ms()
    r1 = await w.api.call("PUT", "/v1/vault", raw=raw, dev=dev, ts=ts)
    sig = r1.request.headers["Sixkey-Sig"]
    r2 = await w.http.request(
        "PUT",
        "/v1/vault",
        content=raw,
        headers={
            "Sixkey-Device": dev.device_id,
            "Sixkey-Ts": str(ts),
            "Sixkey-Sig": sig,
            "Content-Type": "application/json",
        },
    )
    assert r1.status_code == 200 and r2.status_code == 409 and r2.json()["error"]["code"] == "version_conflict"
    assert [v for v, _ in await history(w, acct.sub)] == [1, 2]


async def test_vk_mismatch_and_write_denied_are_distinguished(world):
    w = world
    acct, dev, keys = await w.vault()
    other_vk = sk.vk_id()
    env = sk.envelope(keys.vault_id, other_vk, 2)
    r = await w.api.put_vault(dev, keys, 1, env=env)
    assert r.status_code == 409 and r.json()["error"] == {"code": "vk_mismatch"}
    env = sk.envelope(keys.vault_id, keys.vk_id, 2)
    for proof in (
        sk.b64(sk.rnd(32)),
        keys.proof(2, env[1]),
        keys.proof(1, sk.b64(sk.rnd(32))),
        keys.proof(1, env[1], write_key=sk.rnd(32)),
    ):
        r = await w.api.put_vault(dev, keys, 1, env=env, proof=proof)
        assert r.status_code == 403 and r.json()["error"]["code"] == "write_denied"
    r = await w.api.put_vault(dev, keys, 5, env=sk.envelope(keys.vault_id, keys.vk_id, 6))
    assert r.status_code == 409 and r.json()["error"]["code"] == "version_conflict"
    assert await w.val("SELECT version FROM sixkey.vaults") == 1


async def test_envelope_keyless_checks(world):
    w = world
    acct, dev, keys = await w.vault()
    text, cs = sk.envelope(keys.vault_id, keys.vk_id, 3)  # rev != if_version + 1
    assert (await w.api.put_vault(dev, keys, 1, env=(text, cs))).status_code == 422
    text, cs = sk.envelope("v-someone-else", keys.vk_id, 2)  # another vaultId
    assert (await w.api.put_vault(dev, keys, 1, env=(text, cs))).status_code == 422
    good, cs = sk.envelope(keys.vault_id, keys.vk_id, 2)
    bad = good.replace(cs, sk.b64(sk.rnd(32)))  # checksum that does not match
    assert (await w.api.put_vault(dev, keys, 1, env=(bad, sk.b64(sk.rnd(32))))).status_code == 422
    obj = sk.json.loads(good)
    obj["rev"] = 2.0
    r = await w.api.put_vault(dev, keys, 1, env=(sk.json.dumps(obj), cs))
    assert r.status_code == 422  # 2.0 is not an integer token
    assert await w.val("SELECT version FROM sixkey.vaults") == 1


async def test_revocation_committed_mid_put_stops_the_write(world):
    """C3/P6: the PUT passed its signature check, then the revocation commits, then its transaction runs.
    The device-row lock and the in-transaction re-check must refuse it."""
    w = world
    acct, dev_a, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)
    gate, release = asyncio.Event(), asyncio.Event()

    async def hold():
        gate.set()
        await release.wait()

    w.state.hooks["put_vault.before_tx"] = hold
    put = asyncio.create_task(w.api.put_vault(dev_b, keys, 1))
    await asyncio.wait_for(gate.wait(), 10)
    del w.state.hooks["put_vault.before_tx"]
    r = await w.api.call(
        "POST", f"/v1/devices/{dev_b.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev_a
    )
    assert r.status_code == 200
    release.set()
    r = await put
    assert r.status_code == 403 and r.json()["error"]["code"] == "device_revoked"
    assert await w.val("SELECT version FROM sixkey.vaults") == 1


async def test_writer_racing_revocation_never_lands_after_it(world):
    w = world
    acct, dev_a, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)
    landed: list[int] = []
    stop = asyncio.Event()

    async def writer():
        while not stop.is_set():
            v = await w.api.status(dev_b)
            if v.status_code != 200:
                return
            r = await w.api.put_vault(dev_b, keys, v.json()["version"])
            if r.status_code == 200:
                landed.append(r.json()["version"])
            elif r.status_code == 403:
                return
            await asyncio.sleep(0)

    task = asyncio.create_task(writer())
    await asyncio.sleep(0.05)
    r = await w.api.call(
        "POST", f"/v1/devices/{dev_b.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev_a
    )
    assert r.status_code == 200
    at_revoke = await w.val("SELECT version FROM sixkey.vaults")
    stop.set()
    await task
    assert landed and max(landed) <= at_revoke
    assert await w.val("SELECT version FROM sixkey.vaults") == at_revoke


async def test_two_app_instances_on_one_database(world, db):
    w = world
    acct, dev, keys = await w.vault()
    other = await w.recovery_device(acct, keys)
    async with open_world(db, reset=False) as w2:
        envs = [sk.envelope(keys.vault_id, keys.vk_id, 2) for _ in range(6)]
        rs = await asyncio.gather(
            *[(w if i % 2 else w2).api.put_vault(other if i % 3 else dev, keys, 1, env=e) for i, e in enumerate(envs)]
        )
        assert sorted(r.status_code for r in rs) == [200] + [409] * 5
    assert [v for v, _ in await history(w, acct.sub)] == [1, 2]


async def test_head_tracks_the_stored_text_for_rollback_detection(world):
    """D5: (version, head) lets a client see a reused version number after a server rollback."""
    w = world
    acct, dev, keys = await w.vault()
    r = await w.api.put_vault(dev, keys, 1)
    keys.version = 2
    st2 = (await w.api.status(dev)).json()
    # an honest PITR rolls the vault back to version 1 ...
    v1 = (await w.sql("SELECT envelope FROM sixkey.vault_versions WHERE version = 1"))[0]["envelope"]
    await w.sql("UPDATE sixkey.vaults SET version = 1, envelope = $1, head = sha256(convert_to($1, 'UTF8'))", v1)
    await w.sql("DELETE FROM sixkey.vault_versions WHERE version = 2")
    st1 = (await w.api.status(dev)).json()
    assert st1["version"] == 1 and st1["head"] != st2["head"]
    # ... and another device writes a different version 2: same number, different head
    r = await w.api.put_vault(dev, keys, 1)
    assert r.status_code == 200
    st2b = (await w.api.status(dev)).json()
    assert st2b["version"] == st2["version"] == 2 and st2b["head"] != st2["head"]
