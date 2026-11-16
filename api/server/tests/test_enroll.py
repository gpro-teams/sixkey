"""Enrollment state machine (§3.2, §3.3, §5.3, §5.4, §8.4 "入网状态机"): every legal and illegal
transition, expiry that was not yet cleaned up (P6), one request per session, the single approver,
key_mismatch, the views' required fields by state (F-10), reject / reject-all, the recovery path."""

from __future__ import annotations

import asyncio
import uuid

import pytest

import sk
from conftest import HOUR


def code(r):
    return r.json()["error"]["code"] if r.status_code >= 400 else None


async def test_out_of_order_transitions_are_enroll_state(world):
    w = world
    acct, dev_a, keys = await w.vault()
    flow = await w.start_approval(acct)
    assert code(await flow.reveal()) == "enroll_state"  # before respond
    assert code(await flow.approve(dev_a, keys)) == "enroll_state"  # before reveal
    assert code(await flow.complete()) == "enroll_state"  # before approve
    await flow.respond(dev_a, keys)
    assert code(await flow.approve(dev_a, keys)) == "enroll_state"
    assert code(await flow.complete()) == "enroll_state"
    await flow.reveal()
    assert code(await flow.complete()) == "enroll_state"
    assert (await flow.approve(dev_a, keys)).status_code == 200
    assert code(await flow.approve(dev_a, keys)) == "enroll_state"  # once only
    assert (await flow.complete()).status_code == 200
    assert code(await flow.complete()) == "enroll_gone"  # the request is deleted


async def test_one_approver_only_and_handled_by(world):
    w = world
    acct, dev_a, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)
    flow = await w.start_approval(acct)
    rs = await asyncio.gather(flow.respond(dev_a, keys), flow.respond(dev_b, keys))
    ok = [r for r in rs if r.status_code == 200]
    lost = [r for r in rs if r.status_code != 200]
    assert len(ok) == 1 and len(lost) == 1 and code(lost[0]) == "enroll_state"
    winner = dev_a if rs[0].status_code == 200 else dev_b
    loser = dev_b if winner is dev_a else dev_a
    assert lost[0].json()["error"]["handled_by"] == winner.device_id
    lst = (await w.api.call("GET", "/v1/enroll/requests", dev=loser)).json()["requests"]
    assert lst[0]["handled_by"] == winner.device_id
    await flow.reveal()
    r = await flow.approve(loser, keys)  # not the device that responded
    assert code(r) == "enroll_state" and r.json()["error"]["handled_by"] == winner.device_id
    assert (await flow.approve(winner, keys)).status_code == 200


async def test_identical_retries_of_respond_and_reveal(world):
    w = world
    acct, dev_a, keys = await w.vault()
    flow = await w.start_approval(acct)
    r1 = await flow.respond(dev_a, keys)
    epk = flow.approver_epk
    r2 = await w.api.call(
        "POST",
        f"/v1/enroll/requests/{flow.rid}/respond",
        {"epk": sk.b64(epk), "password_auth": keys.pw_auth_b64},
        dev=dev_a,
    )
    assert r1.status_code == r2.status_code == 200
    r3 = await flow.respond(dev_a, keys)  # same device, another key: tampering
    assert code(r3) == "enroll_state"
    assert (await flow.reveal()).status_code == 200
    assert (await flow.reveal()).status_code == 200  # identical retry
    other = await flow.reveal(body={"nonce": sk.b64(sk.rnd(32))})
    assert code(other) == "enroll_state"  # another nonce: refused
    assert (await flow.poll(dev_a)).json()["new_nonce"] == sk.b64(flow.nonce)


@pytest.mark.parametrize("step", ["respond", "reveal", "approve", "complete"])
async def test_expired_but_not_deleted_requests_cannot_advance(world, step):
    """P6: every UPDATE carries expires_at > now; the row still exists (no daily job ran)."""
    w = world
    acct, dev_a, keys = await w.vault()
    flow = await w.start_approval(acct)
    if step in ("reveal", "approve", "complete"):
        await flow.respond(dev_a, keys)
    if step in ("approve", "complete"):
        await flow.reveal()
    if step == "complete":
        await flow.approve(dev_a, keys)
    state = await w.val("SELECT state FROM sixkey.enrollments")
    w.clock.advance(11 * 60_000)
    assert await w.val("SELECT count(*) FROM sixkey.enrollments") == 1  # still there
    r = await (
        flow.respond(dev_a, keys)
        if step == "respond"
        else flow.reveal()
        if step == "reveal"
        else flow.approve(dev_a, keys)
        if step == "approve"
        else flow.complete()
    )
    assert code(r) == "enroll_gone", r.text
    assert await w.val("SELECT count(*) FROM sixkey.devices") == 1
    rows = await w.sql("SELECT state FROM sixkey.enrollments")
    assert rows == [] or rows[0]["state"] == state


async def test_expiry_window_and_minute_precision(world):
    w = world
    acct, dev_a, keys = await w.vault()
    flow = await w.start_approval(acct)
    row = (await w.sql("SELECT created_at, expires_at FROM sixkey.enrollments"))[0]
    created, expires = (int(row[k].timestamp() * 1000) for k in ("created_at", "expires_at"))
    assert created % 60_000 == 0 and expires % 60_000 == 0
    now = w.clock.now_ms()
    assert now + 600_000 <= expires < now + 660_000  # at least 10 minutes
    lst = (await w.api.call("GET", "/v1/enroll/requests", dev=dev_a)).json()["requests"]
    assert lst[0]["expires_at"] == expires and lst[0]["created_at"] == created
    w.clock.set(expires - 1)
    assert (await flow.poll()).status_code == 200
    w.clock.set(expires)
    assert code(await flow.poll()) == "enroll_gone"
    assert await w.val("SELECT count(*) FROM sixkey.enrollments") == 0  # deleted on access


async def test_one_pending_request_per_session(world):
    w = world
    acct, dev_a, keys = await w.vault()
    session = await w.login(acct.email)
    f1 = await w.start_approval(acct, session)
    f2 = type(f1)(w, session)
    r = await f2.create()
    assert code(r) == "one_per_session"
    # recovery enrollment is covered by the same index
    dev = sk.Dev()
    r = await w.api.call(
        "POST",
        "/v1/enroll/recovery",
        {"device_id": dev.device_id, "sig_pubkey": dev.spki_b64, "recovery_auth": keys.rec_auth_b64},
        acct=session,
        reg=dev,
    )
    assert code(r) == "one_per_session"
    # another session may
    assert (await w.start_approval(acct)).rid
    # once the first one is gone, the session may open another
    await w.api.call("POST", f"/v1/enroll/requests/{f1.rid}/reject", {}, enroll=(f1.rid, f1.dev))
    assert (await f2.create()).status_code == 201


async def test_create_needs_a_vault_and_a_new_device_id(world):
    w = world
    lonely = await w.login()
    f = type(await w.start_approval(*(await w.vault())[:1]))(w, lonely)
    assert code(await f.create()) == "no_vault"
    acct, dev_a, keys = await w.vault()
    f = await w.start_approval(acct)
    f.dev.device_id = dev_a.device_id
    f2 = type(f)(w, await w.login(acct.email))
    f2.dev.device_id = dev_a.device_id
    assert code(await f2.create()) == "device_exists"


async def test_views_carry_the_fields_their_state_requires(world):
    """F-10: the new device's view from responded on carries the approver's values, approved also the
    payload; the approver's view from revealed on carries the new device's. Schema-checked by sk."""
    w = world
    acct, dev_a, keys = await w.vault()
    flow = await w.start_approval(acct)
    nv, av = (await flow.poll()).json(), (await flow.poll(dev_a)).json()
    assert set(nv) == {"state", "server_time"} and "new_epk" not in av
    await flow.respond(dev_a, keys)
    assert {"approver_device_id", "approver_epk"} <= set((await flow.poll()).json())
    await flow.reveal()
    assert {"new_epk", "new_nonce", "new_name_ct"} <= set((await flow.poll(dev_a)).json())
    await flow.approve(dev_a, keys)
    nv = (await flow.poll()).json()
    assert {"approver_device_id", "approver_epk", "payload"} <= set(nv) and "new_device_id" not in nv
    assert {"new_epk", "new_nonce", "new_name_ct"} <= set((await flow.poll(dev_a)).json())


async def test_invalid_keys_in_the_steps(world):
    w = world
    acct, dev_a, keys = await w.vault()
    flow = await w.start_approval(acct)
    pk = sk.VECTORS["groups"]["public_keys"]
    for bad in pk["epk_reject"]:
        r = await flow.respond(dev_a, keys, body={"epk": bad["b64"]})
        assert r.status_code == 422, bad["name"]
    await flow.respond(dev_a, keys)
    r = await flow.reveal(body={"epk": pk["epk_reject"][3]["b64"]})
    assert r.status_code == 422
    assert (await flow.reveal()).status_code == 200
    r = await flow.approve(dev_a, keys, body={"name_ct": keys.name_ct(sk.vk_id())})  # name under another VK
    assert r.status_code == 422
    r = await flow.approve(dev_a, keys, body={"sig_pubkey_sha256": sk.b64(sk.sha256(dev_a.spki))})
    assert code(r) == "key_mismatch"
    assert (await w.val("SELECT state FROM sixkey.enrollments")) == "revealed"


async def test_rejects(world):
    w = world
    acct, dev_a, keys = await w.vault()
    f1 = await w.start_approval(acct)
    # the new device rejects its own request: no pw_auth (and none allowed)
    r = await w.api.call(
        "POST", f"/v1/enroll/requests/{f1.rid}/reject", {"password_auth": keys.pw_auth_b64}, enroll=(f1.rid, f1.dev)
    )
    assert r.status_code == 422
    r = await w.api.call("POST", f"/v1/enroll/requests/{f1.rid}/reject", {}, enroll=(f1.rid, f1.dev))
    assert r.status_code == 200 and code(await f1.poll()) == "enroll_gone"
    # an enrolled device needs pw_auth
    f2 = await w.start_approval(acct)
    r = await w.api.call("POST", f"/v1/enroll/requests/{f2.rid}/reject", {}, dev=dev_a)
    assert code(r) == "password_mismatch"
    r = await w.api.call("POST", f"/v1/enroll/requests/{f2.rid}/reject", {"password_auth": keys.pw_auth_b64}, dev=dev_a)
    assert r.status_code == 200
    r = await w.api.call("POST", f"/v1/enroll/requests/{f2.rid}/reject", {"password_auth": keys.pw_auth_b64}, dev=dev_a)
    assert code(r) == "enroll_gone"


async def test_reject_all_counts_open_requests_and_voids_recovery_ones(world):
    w = world
    acct, dev_a, keys = await w.vault()
    flows = [await w.start_approval(acct) for _ in range(3)]
    rdev = sk.Dev()
    session = await w.login(acct.email)
    r = await w.api.call(
        "POST",
        "/v1/enroll/recovery",
        {"device_id": rdev.device_id, "sig_pubkey": rdev.spki_b64, "recovery_auth": keys.rec_auth_b64},
        acct=session,
        reg=rdev,
    )
    rrid = r.json()["request_id"]
    r = await w.api.call("POST", "/v1/enroll/reject-all", {"password_auth": keys.pw_auth_b64}, dev=dev_a)
    assert r.json()["rejected"] == 4
    for f in flows:
        assert code(await f.poll()) == "enroll_gone"
    r = await w.api.call("POST", f"/v1/enroll/requests/{rrid}/complete", {}, enroll=(rrid, rdev))
    assert code(r) == "enroll_gone"
    assert (await w.api.call("POST", "/v1/enroll/reject-all", {"password_auth": keys.pw_auth_b64}, dev=dev_a)).json()[
        "rejected"
    ] == 0


async def test_revoking_an_approver_voids_its_unfinished_approvals(world):
    w = world
    acct, dev_a, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)
    flow = await w.start_approval(acct)
    await flow.respond(dev_b, keys)
    await flow.reveal()
    await flow.approve(dev_b, keys)
    await w.api.call("POST", f"/v1/devices/{dev_b.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev_a)
    assert code(await flow.complete()) == "enroll_gone"
    assert await w.val("SELECT count(*) FROM sixkey.devices WHERE device_id = $1", flow.dev.device_id) == 0


async def test_complete_idempotent_and_too_many_devices(world):
    w = world
    acct, dev_a, keys = await w.vault()
    # two requests for the same new device (two sessions): the second complete is the idempotent 200
    s1, s2 = await w.login(acct.email), await w.login(acct.email)
    f1 = type(await w.start_approval(acct))(w, s1)
    f2 = type(f1)(w, s2)
    f2.dev = f1.dev
    f2.commit = f1.commit
    for f in (f1, f2):
        assert (await f.create()).status_code == 201
        await f.respond(dev_a, keys)
        await f.reveal()
        await f.approve(dev_a, keys)
    assert (await f1.complete()).status_code == 200
    r = await f2.complete()
    assert r.status_code == 200 and r.json()["device_id"] == f1.dev.device_id
    assert await w.val("SELECT count(*) FROM sixkey.devices WHERE device_id = $1", f1.dev.device_id) == 1
    # fill the account up to 200 unrevoked devices, then complete one more
    n = await w.val("SELECT count(*) FROM sixkey.devices WHERE user_id = $1::uuid", acct.sub)
    async with w.admin.acquire() as con:
        await con.executemany(
            "INSERT INTO sixkey.devices (device_id, user_id, sig_pubkey, joined_via) "
            "VALUES ($1, $2::uuid, $3, 'recovery')",
            [(sk.Dev().device_id, acct.sub, dev_a.spki) for _ in range(200 - n)],
        )
    f3 = await w.start_approval(acct)
    await f3.respond(dev_a, keys)
    await f3.reveal()
    await f3.approve(dev_a, keys)
    r = await f3.complete()
    assert code(r) == "too_many_devices"
    assert (await f3.poll()).status_code == 200  # the request survives the refusal
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
        dev=dev_a,
        new_sig=new,
    )
    assert code(r) == "too_many_devices"
    one = (await w.sql("SELECT device_id FROM sixkey.devices WHERE joined_via = 'recovery' LIMIT 1"))[0]["device_id"]
    await w.api.call("POST", f"/v1/devices/{one}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev_a)
    assert (await f3.complete()).status_code == 200  # revoked devices do not count


async def test_complete_body_rules(world):
    w = world
    acct, dev_a, keys = await w.vault()
    flow = await w.start_approval(acct)
    await flow.respond(dev_a, keys)
    await flow.reveal()
    await flow.approve(dev_a, keys)
    assert (
        await flow.complete({"name_ct": keys.name_ct()})
    ).status_code == 422  # approval path: name came with approve
    assert (await flow.complete()).status_code == 200
    # recovery path: name_ct under the current VK, or none
    dev = sk.Dev()
    s = await w.login(acct.email)
    r = await w.api.call(
        "POST",
        "/v1/enroll/recovery",
        {"device_id": dev.device_id, "sig_pubkey": dev.spki_b64, "recovery_auth": keys.rec_auth_b64},
        acct=s,
        reg=dev,
    )
    rid = r.json()["request_id"]
    r = await w.api.call(
        "POST", f"/v1/enroll/requests/{rid}/complete", {"name_ct": keys.name_ct(sk.vk_id())}, enroll=(rid, dev)
    )
    assert r.status_code == 422
    r = await w.api.call("POST", f"/v1/enroll/requests/{rid}/complete", {}, enroll=(rid, dev))
    assert r.status_code == 200
    assert await w.val("SELECT name_ct FROM sixkey.devices WHERE device_id = $1", dev.device_id) is None


async def test_recovery_enrollment(world, make_world):
    w = world
    acct, dev_a, keys = await w.vault()
    s = await w.login(acct.email)
    dev = sk.Dev()
    body = {"device_id": dev.device_id, "sig_pubkey": dev.spki_b64, "recovery_auth": sk.b64(sk.rnd(32))}
    r = await w.api.call("POST", "/v1/enroll/recovery", body, acct=s, reg=dev)
    assert code(r) == "recovery_mismatch"
    body["recovery_auth"] = keys.rec_auth_b64
    r1 = await w.api.call("POST", "/v1/enroll/recovery", body, acct=s, reg=dev)
    assert r1.status_code == 200
    j = r1.json()
    assert (j["vault_id"], j["version"], j["kver"], j["bundle"]) == (keys.vault_id, 1, 1, keys.bundle_text)
    # a retry with the same device id and key, even from a new session, gets the same request
    s2 = await w.login(acct.email)
    r2 = await w.api.call("POST", "/v1/enroll/recovery", body, acct=s2, reg=dev)
    assert r2.status_code == 200 and r2.json()["request_id"] == j["request_id"]
    # the same device id with another key, or an id already enrolled: device_exists
    other = sk.Dev()
    r = await w.api.call(
        "POST",
        "/v1/enroll/recovery",
        {"device_id": dev_a.device_id, "sig_pubkey": other.spki_b64, "recovery_auth": keys.rec_auth_b64},
        acct=await w.login(acct.email),
        reg=type(dev)(dev_a.device_id),
    )
    assert code(r) in ("bad_signature", "device_exists")
    clash = sk.Dev(dev_a.device_id)
    r = await w.api.call(
        "POST",
        "/v1/enroll/recovery",
        {"device_id": clash.device_id, "sig_pubkey": clash.spki_b64, "recovery_auth": keys.rec_auth_b64},
        acct=await w.login(acct.email),
        reg=clash,
    )
    assert code(r) == "device_exists"
    # no vault in this account
    lonely = await w.login()
    r = await w.api.call("POST", "/v1/enroll/recovery", body, acct=lonely, reg=dev)
    assert code(r) == "no_vault"
    # GET on a recovery request is not a thing (it is created approved and never polled)
    rid = j["request_id"]
    assert code(await w.api.call("GET", f"/v1/enroll/requests/{rid}", enroll=(rid, dev))) == "enroll_gone"
    assert code(await w.api.call("GET", f"/v1/enroll/requests/{rid}", dev=dev_a)) == "enroll_gone"


async def test_unknown_malformed_and_foreign_request_ids_are_gone(world):
    w = world
    acct, dev_a, keys = await w.vault()
    acct2, dev_b, keys2 = await w.vault()
    flow_b = await w.start_approval(acct2)
    for rid in (str(uuid.uuid4()), "not-a-uuid", flow_b.rid, flow_b.rid.upper()):
        assert code(await w.api.call("GET", f"/v1/enroll/requests/{rid}", dev=dev_a)) == "enroll_gone", rid
        r = await w.api.call(
            "POST",
            f"/v1/enroll/requests/{rid}/respond",
            {"epk": sk.b64(sk.ec_point()), "password_auth": keys.pw_auth_b64},
            dev=dev_a,
        )
        assert code(r) == "enroll_gone", rid
        r = await w.api.call(
            "POST", f"/v1/enroll/requests/{rid}/reject", {"password_auth": keys.pw_auth_b64}, dev=dev_a
        )
        assert code(r) == "enroll_gone", rid
    assert (await flow_b.poll(dev_b)).json()["state"] == "pending"


async def _held(w, name):
    first, release = asyncio.Event(), asyncio.Event()

    async def hold():
        if not first.is_set():
            first.set()
            await release.wait()

    w.state.hooks[name] = hold
    return first, release


async def test_complete_and_rotate_interleaved_do_not_deadlock(world):
    """complete holds its rows and pauses; a rotation starts. complete locks the vault row before the
    request (the lock order), so the rotation waits instead of deadlocking on the request row."""
    w = world
    acct, dev_a, keys = await w.vault()
    flow = await w.start_approval(acct)
    await flow.respond(dev_a, keys)
    await flow.reveal()
    await flow.approve(dev_a, keys)
    first, release = await _held(w, "complete.locked")
    done = asyncio.create_task(flow.complete())
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
                "bundle": k2.bundle(dev_a.device_id, kver=2),
                "password_auth": keys.pw_auth_b64,
                "recovery_verifier": k2.rec_verifier(),
                "password_verifier": k2.pw_verifier(),
                "device_names": [{"device_id": dev_a.device_id, "name_ct": k2.name_ct()}],
            },
            dev=dev_a,
        )
    )
    await asyncio.sleep(0.3)
    release.set()
    rc, rr = await done, await rot
    assert rc.status_code == 200 and rr.status_code == 200, (rc.text, rr.text)
    assert await w.val("SELECT count(*) FROM sixkey.devices WHERE device_id = $1", flow.dev.device_id) == 1


async def test_revoke_and_complete_interleaved_do_not_deadlock(world):
    """revoke takes the vault row before it voids the approver's requests; a complete in between waits
    for it and then finds its request gone (the approver was revoked)."""
    w = world
    acct, dev_a, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)
    flow = await w.start_approval(acct)
    await flow.respond(dev_b, keys)
    await flow.reveal()
    await flow.approve(dev_b, keys)
    first, release = await _held(w, "revoke.between")
    rv = asyncio.create_task(
        w.api.call("POST", f"/v1/devices/{dev_b.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev_a)
    )
    await asyncio.wait_for(first.wait(), 10)
    done = asyncio.create_task(flow.complete())
    await asyncio.sleep(0.3)
    release.set()
    r_rv, r_c = await rv, await done
    assert r_rv.status_code == 200, r_rv.text
    assert r_c.status_code == 410 and r_c.json()["error"]["code"] == "enroll_gone", r_c.text
