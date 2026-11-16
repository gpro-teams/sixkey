"""pw_auth (§3.14, S2, S8, F14): every endpoint that needs it refuses a missing or wrong proof; failures
are counted per device, atomically, capped at 10, never lock and never back off; a flood past the
in-memory bucket does not touch the database; a valid proof is exempt from the per-device limits, so a
copy of the identity cannot crowd out the real device's revocation and rotation."""

from __future__ import annotations

import asyncio

import pytest

import sk
from sixkey_server.config import RateLimits


def code(r):
    return r.json()["error"]["code"] if r.status_code >= 400 else None


async def scenario(w):
    acct, dev, keys = await w.vault()
    dev_b = await w.recovery_device(acct, keys)
    return acct, dev, dev_b, keys


def requests_needing_pw(w, acct, dev, dev_b, keys, pw):
    """(name, coroutine factory) for every operation whose x-sixkey-auth.pw_auth is required."""
    k2 = sk.Keys(vault_id=keys.vault_id, vk_id=sk.vk_id(), at=keys.at)
    env = sk.envelope(keys.vault_id, k2.vk_id, 2)
    keys.rec_wrap = sk.wrap("recovery", keys.vk_id, keys.at)
    new_rec_bundle = keys.bundle(dev.device_id, kver=2)
    fork_dev = sk.Dev()

    async def enroll_step(step):
        flow = await w.start_approval(acct)
        if step == "respond":
            return await flow.respond(dev, keys, body={"password_auth": pw})
        await flow.respond(dev, keys)
        await flow.reveal()
        return await flow.approve(dev, keys, body={"password_auth": pw})

    async def reject():
        flow = await w.start_approval(acct)
        body = {} if pw is None else {"password_auth": pw}
        return await w.api.call("POST", f"/v1/enroll/requests/{flow.rid}/reject", body, dev=dev)

    def pwb(extra=None):
        b = dict(extra or {})
        if pw is not None:
            b["password_auth"] = pw
        return b

    async def delete_account():
        fresh = await w.login(acct.email)
        return await w.api.call("DELETE", "/v1/account", pwb(), dev=dev, acct=fresh)

    return {
        "putKeys": lambda: w.api.call(
            "PUT",
            "/v1/keys",
            pwb({"if_kver": 1, "bundle": new_rec_bundle, "recovery_verifier": keys.rec_verifier(sk.rnd(32))}),
            dev=dev,
        ),
        "rotateKeys": lambda: w.api.call(
            "POST",
            "/v1/keys/rotate",
            pwb(
                {
                    "if_version": 1,
                    "if_kver": 1,
                    "envelope": env[0],
                    "write_proof": keys.proof(1, env[1]),
                    "new_write_key": sk.b64(k2.write_key),
                    "bundle": k2.bundle(dev.device_id, kver=2),
                    "recovery_verifier": k2.rec_verifier(),
                    "password_verifier": k2.pw_verifier(),
                    "device_names": [],
                }
            ),
            dev=dev,
        ),
        "respondEnrollRequest": lambda: enroll_step("respond"),
        "approveEnrollRequest": lambda: enroll_step("approve"),
        "rejectEnrollRequest": reject,
        "rejectAllEnrollRequests": lambda: w.api.call("POST", "/v1/enroll/reject-all", pwb(), dev=dev),
        "revokeDevice (self)": lambda: w.api.call("POST", f"/v1/devices/{dev.device_id}/revoke", pwb(), dev=dev),
        "revokeDevice": lambda: w.api.call("POST", f"/v1/devices/{dev_b.device_id}/revoke", pwb(), dev=dev),
        "renameDevice (self)": lambda: w.api.call(
            "PATCH", f"/v1/devices/{dev.device_id}", pwb({"name_ct": keys.name_ct()}), dev=dev
        ),
        "renameDevice": lambda: w.api.call(
            "PATCH", f"/v1/devices/{dev_b.device_id}", pwb({"name_ct": keys.name_ct()}), dev=dev
        ),
        "forkDevice": lambda: w.api.call(
            "POST",
            "/v1/devices/fork",
            pwb({"new_device_id": fork_dev.device_id, "new_sig_pubkey": fork_dev.spki_b64, "name_ct": keys.name_ct()}),
            dev=dev,
            new_sig=fork_dev,
        ),
        "deleteVaultVersions": lambda: w.api.call("DELETE", "/v1/vault/versions", pwb(), dev=dev),
        "deleteAccount": delete_account,
    }


OPS = [
    "putKeys",
    "rotateKeys",
    "respondEnrollRequest",
    "approveEnrollRequest",
    "rejectEnrollRequest",
    "rejectAllEnrollRequests",
    "revokeDevice (self)",
    "revokeDevice",
    "renameDevice (self)",
    "renameDevice",
    "forkDevice",
    "deleteVaultVersions",
    "deleteAccount",
]


async def state(w):
    return (
        [dict(r) for r in await w.sql("SELECT * FROM sixkey.vaults")],
        [dict(r) for r in await w.sql("SELECT device_id, name_ct, revoked_at FROM sixkey.devices ORDER BY 1")],
        await w.val("SELECT count(*) FROM sixkey.vault_versions"),
    )


@pytest.mark.parametrize("op", OPS)
@pytest.mark.parametrize("variant", ["wrong", "missing"])
async def test_every_pw_endpoint_refuses_a_bad_proof(world, op, variant):
    w = world
    acct, dev, dev_b, keys = await scenario(w)
    pw = sk.b64(sk.rnd(32)) if variant == "wrong" else None
    before = await state(w)
    r = await requests_needing_pw(w, acct, dev, dev_b, keys, pw)[op]()
    if variant == "missing" and op != "rejectEnrollRequest":
        assert r.status_code == 422, r.text  # required by the schema
    else:
        assert (r.status_code, code(r)) == (403, "password_mismatch"), r.text
    after = await state(w)
    v_before, v_after = before[0][0], after[0][0]
    assert {k: v for k, v in v_after.items() if k != "devices_rev"} == {
        k: v for k, v in v_before.items() if k != "devices_rev"
    }
    assert after[1:] == before[1:]
    want = 1 if variant == "wrong" else 0  # a missing proof is not a guess: not counted
    assert await w.val("SELECT auth_failures FROM sixkey.devices WHERE device_id = $1", dev.device_id) == want
    # and with the right proof the same operation works
    r = await requests_needing_pw(w, acct, dev, dev_b, keys, keys.pw_auth_b64)[op]()
    assert r.status_code in (200, 201, 204), r.text
    if op not in ("deleteAccount", "revokeDevice (self)"):
        assert await w.val("SELECT auth_failures FROM sixkey.devices WHERE device_id = $1", dev.device_id) == 0


async def test_failure_counter_is_per_device_capped_and_never_locks(world):
    w = world
    acct, dev, dev_b, keys = await scenario(w)
    bad = {"password_auth": sk.b64(sk.rnd(32))}
    revs = []
    for i in range(10):
        r = await w.api.call("POST", "/v1/enroll/reject-all", bad, dev=dev)
        assert code(r) == "password_mismatch"
        revs.append(await w.val("SELECT devices_rev FROM sixkey.vaults"))
    assert await w.val("SELECT auth_failures FROM sixkey.devices WHERE device_id = $1", dev.device_id) == 10
    assert revs == list(range(revs[0], revs[0] + 10))  # each increase bumps devices_rev (N15)
    devs = {d["device_id"]: d for d in (await w.api.call("GET", "/v1/devices", dev=dev_b)).json()["devices"]}
    assert devs[dev.device_id]["auth_failures"] == 10 and devs[dev_b.device_id]["auth_failures"] == 0
    # other devices are unaffected (no account-wide lock), and so is this one with the right proof
    assert (
        await w.api.call("POST", "/v1/enroll/reject-all", {"password_auth": keys.pw_auth_b64}, dev=dev_b)
    ).status_code == 200
    w.clock.advance(61_000)
    r = await w.api.call("POST", "/v1/enroll/reject-all", bad, dev=dev)  # past the cap: still 403, no write
    assert code(r) == "password_mismatch"
    assert await w.val("SELECT auth_failures FROM sixkey.devices WHERE device_id = $1", dev.device_id) == 10
    assert await w.val("SELECT devices_rev FROM sixkey.vaults") == revs[-1]
    assert (
        await w.api.call("POST", "/v1/enroll/reject-all", {"password_auth": keys.pw_auth_b64}, dev=dev)
    ).status_code == 200
    assert await w.val("SELECT auth_failures FROM sixkey.devices WHERE device_id = $1", dev.device_id) == 0
    assert await w.val("SELECT devices_rev FROM sixkey.vaults") == revs[-1] + 1  # the reset is a change too


async def test_concurrent_failures_count_exactly(world):
    w = world
    acct, dev, dev_b, keys = await scenario(w)
    bad = {"password_auth": sk.b64(sk.rnd(32))}
    rs = await asyncio.gather(*(w.api.call("POST", "/v1/enroll/reject-all", bad, dev=dev) for _ in range(7)))
    assert all(code(r) == "password_mismatch" for r in rs)
    assert await w.val("SELECT auth_failures FROM sixkey.devices WHERE device_id = $1", dev.device_id) == 7


async def test_invalid_proof_flood_stops_at_the_bucket_without_writes(world):
    w = world
    acct, dev, dev_b, keys = await scenario(w)
    bad = {"password_auth": sk.b64(sk.rnd(32))}
    for _ in range(3):
        await w.api.call("POST", "/v1/enroll/reject-all", bad, dev=dev)
    await w.sql("UPDATE sixkey.devices SET auth_failures = 0")  # so the cap is not what stops the writes
    for _ in range(7):
        await w.api.call("POST", "/v1/enroll/reject-all", bad, dev=dev)
    assert await w.val("SELECT auth_failures FROM sixkey.devices WHERE device_id = $1", dev.device_id) == 7
    rev = await w.val("SELECT devices_rev FROM sixkey.vaults")
    for _ in range(20):  # past 10/min: 429, nothing written
        r = await w.api.call("POST", "/v1/enroll/reject-all", bad, dev=dev)
        assert code(r) == "rate_limited" and r.headers["retry-after"]
    assert await w.val("SELECT auth_failures FROM sixkey.devices WHERE device_id = $1", dev.device_id) == 7
    assert await w.val("SELECT devices_rev FROM sixkey.vaults") == rev
    # a valid proof is not affected by that bucket
    r = await w.api.call("POST", "/v1/enroll/reject-all", {"password_auth": keys.pw_auth_b64}, dev=dev)
    assert r.status_code == 200


async def test_a_copy_cannot_crowd_out_revocation_and_rotation(make_world):
    """S2 / F8: the copy of the identity exhausts every bucket it can; the real device, with the right
    pw_auth, still revokes and rotates at once."""
    async with make_world(
        limits=RateLimits(otp_send_ip=(10_000, 3600), otp_verify_ip=(10_000, 3600), recovery_account_ip=(100, 3600))
    ) as w:
        acct, dev, dev_b, keys = await scenario(w)
        bad = {"password_auth": sk.b64(sk.rnd(32))}
        for _ in range(40):  # invalid proofs: their own bucket
            await w.api.call("POST", "/v1/enroll/reject-all", bad, dev=dev)
        for _ in range(35):  # counted writes (409s)
            await w.api.put_vault(dev, keys, 99, env=sk.envelope(keys.vault_id, keys.vk_id, 100))
        for _ in range(65):
            await w.api.status(dev)
        assert (
            code(await w.api.put_vault(dev, keys, 99, env=sk.envelope(keys.vault_id, keys.vk_id, 100)))
            == "rate_limited"
        )
        assert code(await w.api.status(dev)) == "rate_limited"
        r = await w.api.call(
            "POST", f"/v1/devices/{dev_b.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev
        )
        assert r.status_code == 200
        k2 = sk.Keys(vault_id=keys.vault_id, vk_id=sk.vk_id(), at=keys.at)
        env = sk.envelope(keys.vault_id, k2.vk_id, 2)
        r = await w.api.call(
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
                "device_names": [],
            },
            dev=dev,
        )
        assert r.status_code == 200, r.text


async def test_401_and_403_are_not_counted_against_quotas(make_world):
    async with make_world(limits=RateLimits(otp_send_ip=(10_000, 3600), otp_verify_ip=(10_000, 3600))) as w:
        acct, dev, keys = await w.vault()
        for _ in range(40):  # write_denied: never counted (S2)
            r = await w.api.put_vault(dev, keys, 1, proof=sk.b64(sk.rnd(32)))
            assert code(r) == "write_denied"
        for _ in range(40):  # bad signatures
            r = await w.api.put_vault(dev, keys, 1, target="/v1/other")
            assert code(r) == "bad_signature"
        r = await w.api.put_vault(dev, keys, 1)
        assert r.status_code == 200
