"""PUT /v1/keys and POST /v1/keys/rotate: kver rules (N27, F-01), byte-identical idempotency (§3.6.0),
P4 (§2.3, S-2), by = signer, hour alignment (N16), integer tokens (N20), rotate atomicity (§3.8)."""

from __future__ import annotations

import asyncio
import json

import pytest

import sk
from sixkey_server.constants import KVER_MAX_JUMP, MAX_ENVELOPE_BYTES


def recovery_change(keys, dev, kver):
    keys.rec_wrap = sk.wrap("recovery", keys.vk_id, keys.at)
    new = sk.rnd(32)
    return new, {
        "if_kver": keys.kver,
        "bundle": keys.bundle(dev.device_id, kver=kver),
        "password_auth": keys.pw_auth_b64,
        "recovery_verifier": keys.rec_verifier(new),
    }


async def put_keys(w, dev, body, **kw):
    return await w.api.call("PUT", "/v1/keys", body, dev=dev, **kw)


async def stored(w):
    return (await w.sql("SELECT kver, bundle, recovery_verifier, password_verifier FROM sixkey.vaults"))[0]


@pytest.mark.parametrize(
    "jump,status", [(1, 200), (5, 200), (KVER_MAX_JUMP, 200), (KVER_MAX_JUMP + 1, 422), (0, 422), (-1, 422)]
)
async def test_kver_must_be_above_if_kver_within_the_jump_bound(world, jump, status):
    w = world
    acct, dev, keys = await w.vault()
    if 1 + jump < 1:  # kver 0 is not a Kver at all (schema)
        _, body = recovery_change(keys, dev, 1)
        body["bundle"] = body["bundle"].replace('"kver":1', '"kver":0')
    else:
        _, body = recovery_change(keys, dev, 1 + jump)
    r = await put_keys(w, dev, body)
    assert r.status_code == status, r.text
    assert (await stored(w))["kver"] == (1 + jump if status == 200 else 1)


async def test_stale_if_kver_is_keys_conflict_and_changes_nothing(world):
    w = world
    acct, dev, keys = await w.vault()
    _, body = recovery_change(keys, dev, 2)
    assert (await put_keys(w, dev, body)).status_code == 200
    before = await stored(w)
    _, body2 = recovery_change(keys, dev, 3)
    body2["if_kver"] = 1  # stale
    r = await put_keys(w, dev, body2)
    assert r.status_code == 409 and r.json()["error"] == {"code": "keys_conflict"}
    assert await stored(w) == before


async def test_identical_replay_is_200_whatever_if_kver_and_after_a_password_change(world):
    """§3.6.0, N27: the stored bundle text equal to the submitted one is the idempotent 200 — even when
    the replay's pw_auth and verifiers belong to the state it replaced."""
    w = world
    acct, dev, keys = await w.vault()
    keys.pw_wrap, keys.auth_kdf = sk.wrap("password", keys.vk_id, keys.at), sk.kdf_pbkdf2()
    new_pw = sk.rnd(32)
    body = {
        "if_kver": 1,
        "bundle": keys.bundle(dev.device_id, kver=4),
        "password_auth": keys.pw_auth_b64,
        "password_verifier": keys.pw_verifier(new_pw),
    }
    assert (await put_keys(w, dev, body)).json()["kver"] == 4
    failures_before = await w.val("SELECT auth_failures FROM sixkey.devices")
    r = await put_keys(w, dev, body)  # the old pw_auth no longer matches, the text does
    assert r.status_code == 200 and r.json()["kver"] == 4
    assert await w.val("SELECT auth_failures FROM sixkey.devices") == failures_before == 0
    body["if_kver"] = 3  # any if_kver
    assert (await put_keys(w, dev, body)).status_code == 200


async def test_same_kver_different_text_after_progress_is_a_conflict(world):
    w = world
    acct, dev, keys = await w.vault()
    _, b1 = recovery_change(keys, dev, 2)
    assert (await put_keys(w, dev, b1)).status_code == 200
    # a different bundle with the same kver and the old if_kver: not idempotent (text differs)
    _, b2 = recovery_change(keys, dev, 2)
    b2["if_kver"] = 1
    r = await put_keys(w, dev, b2)
    assert r.status_code == 409 and r.json()["error"]["code"] == "keys_conflict"


async def test_concurrent_key_changes_one_wins(world):
    w = world
    acct, dev, keys = await w.vault()
    bodies = []
    for _ in range(8):
        _, b = recovery_change(keys, dev, 2)
        bodies.append(b)
    rs = await asyncio.gather(*(put_keys(w, dev, b) for b in bodies))
    assert sorted(r.status_code for r in rs) == [200] + [409] * 7
    winner = bodies[[r.status_code for r in rs].index(200)]
    assert (await stored(w))["bundle"] == winner["bundle"]


# ------------------------------------------------------------------------------------ P4 and friends


async def test_p4_rules(world):
    w = world
    acct, dev, keys = await w.vault()
    base = keys.bundle_text

    async def attempt(bundle, **extra):
        body = {"if_kver": 1, "bundle": bundle, "password_auth": keys.pw_auth_b64, **extra}
        return (await put_keys(w, dev, body)).status_code

    v = sk.b64(sk.rnd(32))
    # nothing changed but a verifier sent / nothing sent at all
    same = keys.bundle(dev.device_id, kver=2)
    assert await attempt(same, recovery_verifier=v) == 422
    assert await attempt(same, password_verifier=v) == 422
    # recovery wrap changed: needs recovery_verifier, refuses password_verifier
    keys.rec_wrap = sk.wrap("recovery", keys.vk_id, keys.at)
    rec = keys.bundle(dev.device_id, kver=2)
    assert await attempt(rec) == 422
    assert await attempt(rec, recovery_verifier=v, password_verifier=v) == 422
    # auth.kdf changed alone ("only the auth"), or the password wrap without auth: 422
    old_kdf = keys.auth_kdf
    keys.auth_kdf = sk.kdf_pbkdf2()
    assert await attempt(keys.bundle(dev.device_id, kver=2), recovery_verifier=v, password_verifier=v) == 422
    keys.auth_kdf = old_kdf
    keys.pw_wrap = sk.wrap("password", keys.vk_id, keys.at)
    assert await attempt(keys.bundle(dev.device_id, kver=2), recovery_verifier=v, password_verifier=v) == 422
    # both wraps + auth: both verifiers needed
    keys.auth_kdf = sk.kdf_pbkdf2()
    both = keys.bundle(dev.device_id, kver=2)
    assert await attempt(both, recovery_verifier=v) == 422
    assert (await stored(w))["bundle"] == base
    assert await attempt(both, recovery_verifier=v, password_verifier=v) == 200


async def test_wrap_differing_only_in_created_at_is_not_a_change(world):
    w = world
    acct, dev, keys = await w.vault()
    keys.pw_wrap = dict(keys.pw_wrap, createdAt=keys.at - 3_600_000)
    keys.rec_wrap = dict(keys.rec_wrap, createdAt=keys.at - 7_200_000)
    body = {"if_kver": 1, "bundle": keys.bundle(dev.device_id, kver=2), "password_auth": keys.pw_auth_b64}
    assert (await put_keys(w, dev, body)).status_code == 200


async def test_wrap_members_other_than_iv_and_wrapped_do_not_count(world):
    """S-2: only iv and wrapped decide "the wrap changed"; an extra member (forward compatibility) does not."""
    w = world
    acct, dev, keys = await w.vault()
    keys.rec_wrap = dict(keys.rec_wrap, note="kept")
    body = {"if_kver": 1, "bundle": keys.bundle(dev.device_id, kver=2), "password_auth": keys.pw_auth_b64}
    assert (await put_keys(w, dev, body)).status_code == 200
    keys.kver = 2
    keys.rec_wrap = dict(keys.rec_wrap, iv=sk.b64(sk.rnd(12)))  # now really changed: a verifier is required
    body = {"if_kver": 2, "bundle": keys.bundle(dev.device_id, kver=3), "password_auth": keys.pw_auth_b64}
    assert (await put_keys(w, dev, body)).status_code == 422


@pytest.mark.parametrize("what", ["by", "vaultId", "keyring.vaultId", "keyring.vkId", "wrap.vkId"])
async def test_bundle_consistency_with_the_account(world, what):
    w = world
    acct, dev, keys = await w.vault()
    other = await w.recovery_device(acct, keys)
    _, body = recovery_change(keys, dev, 2)
    b = json.loads(body["bundle"])
    if what == "by":
        b["by"] = other.device_id  # another device of the account: still not the signer
    elif what == "vaultId":
        b["vaultId"] = "v-another-vault"
        b["keyring"]["vaultId"] = "v-another-vault"
    elif what == "keyring.vaultId":
        b["keyring"]["vaultId"] = "v-another-vault"
    elif what == "keyring.vkId":
        new = sk.vk_id()
        b["keyring"]["vkId"] = new
        for wr in b["keyring"]["wraps"]:
            wr["vkId"] = new
    else:
        b["keyring"]["wraps"][0]["vkId"] = sk.vk_id()
    body["bundle"] = sk.compact(b)
    r = await put_keys(w, dev, body)
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_request"
    assert (await stored(w))["kver"] == 1


@pytest.mark.parametrize("where", ["at", "wrap", "previous"])
async def test_bundle_times_not_hour_aligned_are_422(world, where):
    w = world
    acct, dev, keys = await w.vault()
    _, body = recovery_change(keys, dev, 2)
    b = json.loads(body["bundle"])
    if where == "at":
        b["at"] += 1
    elif where == "wrap":
        b["keyring"]["wraps"][1]["createdAt"] += 1000
    else:
        b["keyring"]["previous"] = [
            {"vkId": sk.vk_id(), "iv": sk.b64(sk.rnd(12)), "wrapped": sk.b64(sk.rnd(48)), "createdAt": keys.at + 60_000}
        ]
    body["bundle"] = sk.compact(b)
    assert (await put_keys(w, dev, body)).status_code == 422


@pytest.mark.parametrize("token", ['"kver":2.0', '"kver":2e0', '"if_kver":1.0', '"iterations":6e5', "dup"])
async def test_non_integer_number_tokens_and_duplicate_keys_are_422(world, token):
    w = world
    acct, dev, keys = await w.vault()
    _, body = recovery_change(keys, dev, 2)
    raw = sk.compact(body)
    if token == '"kver":2.0':
        raw = raw.replace('\\"kver\\":2', '\\"kver\\":2.0')
    elif token == '"kver":2e0':
        raw = raw.replace('\\"kver\\":2', '\\"kver\\":2e0')
    elif token == '"if_kver":1.0':
        raw = raw.replace('"if_kver":1', '"if_kver":1.0')
    elif token == '"iterations":6e5':
        raw = raw.replace('\\"iterations\\":600000', '\\"iterations\\":6e5', 1)
    else:
        raw = raw.replace('"if_kver":1,', '"if_kver":1,"if_kver":1,')
    assert raw != sk.compact(body)
    r = await put_keys(w, dev, None, raw=raw.encode())
    assert r.status_code == 422, r.text


async def test_unknown_members_are_kept_in_the_bundle_but_not_in_the_body(world):
    w = world
    acct, dev, keys = await w.vault()
    _, body = recovery_change(keys, dev, 2)
    b = json.loads(body["bundle"])
    b["futureField"] = {"x": 1}  # forward compatibility (§2.3): kept, stored byte for byte
    body["bundle"] = sk.compact(b)
    assert (await put_keys(w, dev, dict(body, extra=1))).status_code == 422  # strict request body
    assert (await put_keys(w, dev, body)).status_code == 200
    assert (await stored(w))["bundle"] == body["bundle"]


async def test_recovery_auth_path_and_its_failures_count(world):
    """§3.3 step 5: a recovery-code reset sends recovery_auth instead of pw_auth (S6)."""
    w = world
    acct, dev, keys = await w.vault()
    keys.pw_wrap, keys.auth_kdf, keys.rec_wrap = (
        sk.wrap("password", keys.vk_id, keys.at),
        sk.kdf_pbkdf2(),
        sk.wrap("recovery", keys.vk_id, keys.at),
    )
    body = {
        "if_kver": 1,
        "bundle": keys.bundle(dev.device_id, kver=2),
        "recovery_auth": sk.b64(sk.rnd(32)),
        "password_verifier": keys.pw_verifier(sk.rnd(32)),
        "recovery_verifier": keys.rec_verifier(sk.rnd(32)),
    }
    r = await put_keys(w, dev, body)
    assert r.status_code == 403 and r.json()["error"]["code"] == "recovery_mismatch"
    assert await w.val("SELECT auth_failures FROM sixkey.devices") == 1
    body["recovery_auth"] = keys.rec_auth_b64
    assert (await put_keys(w, dev, body)).status_code == 200
    assert await w.val("SELECT auth_failures FROM sixkey.devices") == 0
    both = dict(body, password_auth=keys.pw_auth_b64)  # exactly one of the two
    assert (await put_keys(w, dev, both)).status_code == 422


# ------------------------------------------------------------------------------------ rotate


def rotate_body(keys, dev, devs, *, if_version=None, if_kver=None, kver=None, env=None, k2=None, names=None):
    k2 = k2 or sk.Keys(vault_id=keys.vault_id, vk_id=sk.vk_id(), at=keys.at)
    iv = keys.version if if_version is None else if_version
    text, cs = env or sk.envelope(keys.vault_id, k2.vk_id, iv + 1)
    body = {
        "if_version": iv,
        "if_kver": keys.kver if if_kver is None else if_kver,
        "envelope": text,
        "write_proof": keys.proof(iv, cs),
        "new_write_key": sk.b64(k2.write_key),
        "bundle": k2.bundle(dev.device_id, kver=kver or keys.kver + 1),
        "password_auth": keys.pw_auth_b64,
        "recovery_verifier": k2.rec_verifier(),
        "password_verifier": k2.pw_verifier(),
        "device_names": names
        if names is not None
        else [{"device_id": d.device_id, "name_ct": k2.name_ct()} for d in devs],
    }
    return body, k2


async def snapshot(w):
    return [dict(r) for r in await w.sql("SELECT * FROM sixkey.vaults")] + [
        dict(r) for r in await w.sql("SELECT device_id, name_ct FROM sixkey.devices ORDER BY 1")
    ]


async def test_rotate_conflicts(world):
    w = world
    acct, dev, keys = await w.vault()
    before = await snapshot(w)
    body, _ = rotate_body(keys, dev, [dev], if_kver=2, kver=3)
    r = await w.api.call("POST", "/v1/keys/rotate", body, dev=dev)
    assert r.status_code == 409 and r.json()["error"]["code"] == "keys_conflict"
    body, _ = rotate_body(keys, dev, [dev], if_version=7)
    r = await w.api.call("POST", "/v1/keys/rotate", body, dev=dev)
    assert r.status_code == 409 and r.json()["error"] == {
        "code": "version_conflict",
        "version": 1,
        "vk_id": keys.vk_id,
        "kver": 1,
    }
    body, _ = rotate_body(keys, dev, [dev])
    body["write_proof"] = sk.b64(sk.rnd(32))
    r = await w.api.call("POST", "/v1/keys/rotate", body, dev=dev)
    assert r.status_code == 403 and r.json()["error"]["code"] == "write_denied"
    body, _ = rotate_body(keys, dev, [dev])
    body["password_auth"] = sk.b64(sk.rnd(32))
    r = await w.api.call("POST", "/v1/keys/rotate", body, dev=dev)
    assert r.status_code == 403 and r.json()["error"]["code"] == "password_mismatch"
    after = await snapshot(w)
    # the vault row is untouched; only the failure counter moved, which bumps devices_rev once (N15)
    assert {k: v for k, v in after[0].items() if k != "devices_rev"} == {
        k: v for k, v in before[0].items() if k != "devices_rev"
    }
    assert after[0]["devices_rev"] == before[0]["devices_rev"] + 1


@pytest.mark.parametrize("bad", ["foreign_device", "dup", "wrong_vk", "env_vk", "rev"])
async def test_rotate_refuses_inconsistent_requests_atomically(world, bad):
    w = world
    acct, dev, keys = await w.vault()
    _, _, keys_b = await w.vault()  # another tenant
    other_devs = await w.sql("SELECT device_id FROM sixkey.devices WHERE user_id <> $1::uuid", acct.sub)
    k2 = sk.Keys(vault_id=keys.vault_id, vk_id=sk.vk_id(), at=keys.at)
    names = [{"device_id": dev.device_id, "name_ct": k2.name_ct()}]
    env = None
    if bad == "foreign_device":
        names.append({"device_id": other_devs[0]["device_id"], "name_ct": k2.name_ct()})
    elif bad == "dup":
        names.append(dict(names[0]))
    elif bad == "wrong_vk":
        names[0]["name_ct"] = k2.name_ct(keys.vk_id)
    elif bad == "env_vk":
        env = sk.envelope(keys.vault_id, sk.vk_id(), 2)
    elif bad == "rev":
        env = sk.envelope(keys.vault_id, k2.vk_id, 3)
    body, _ = rotate_body(keys, dev, [dev], k2=k2, names=names, env=env)
    before = [dict(r) for r in await w.sql("SELECT * FROM sixkey.vaults ORDER BY user_id")]
    devs_before = [dict(r) for r in await w.sql("SELECT * FROM sixkey.devices ORDER BY device_id")]
    flow = await w.start_approval(acct)
    r = await w.api.call("POST", "/v1/keys/rotate", body, dev=dev)
    assert r.status_code == 422, r.text
    assert [dict(r) for r in await w.sql("SELECT * FROM sixkey.vaults ORDER BY user_id")] == before
    assert [dict(r) for r in await w.sql("SELECT * FROM sixkey.devices ORDER BY device_id")] == devs_before
    assert (await flow.poll()).status_code == 200  # the open enrollment was not voided


async def test_rotate_with_an_8_mib_envelope(world):
    """N13: rotate carries an envelope, so its body limit is 9 MiB."""
    w = world
    acct, dev, keys = await w.vault()
    k2 = sk.Keys(vault_id=keys.vault_id, vk_id=sk.vk_id(), at=keys.at)
    env = sk.envelope_of_size(keys.vault_id, k2.vk_id, 2, MAX_ENVELOPE_BYTES)
    body, _ = rotate_body(keys, dev, [dev], k2=k2, env=env)
    r = await w.api.call("POST", "/v1/keys/rotate", body, dev=dev)
    assert r.status_code == 200, r.text
    assert await w.val("SELECT size_bytes FROM sixkey.vaults") == MAX_ENVELOPE_BYTES


async def test_rotate_racing_a_put(world):
    w = world
    acct, dev, keys = await w.vault()
    other = await w.recovery_device(acct, keys)
    body, k2 = rotate_body(keys, dev, [dev, other])
    rs = await asyncio.gather(w.api.call("POST", "/v1/keys/rotate", body, dev=dev), w.api.put_vault(other, keys, 1))
    codes = sorted(r.status_code for r in rs)
    assert codes == [200, 409], [r.text for r in rs]
    v = (await w.sql("SELECT version, vk_id FROM sixkey.vaults"))[0]
    assert v["version"] == 2
    assert v["vk_id"] == (k2.vk_id if rs[0].status_code == 200 else keys.vk_id)
