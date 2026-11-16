"""Model-based test of the vault CAS and the key endpoints (§8.4): Hypothesis generates programs of
PUT /v1/vault, PUT /v1/keys, POST /v1/keys/rotate (fresh, stale, replayed, wrong proofs, out-of-range
kver) and concurrent PUT pairs; each runs against the real app and Postgres, and after every step the
response and the database must equal a small reference model of §5.3 / §2.3 / §3.6.0 written here.

SIXKEY_MODEL_EXAMPLES (default 40) sets the number of programs; derandomized, so runs are repeatable.
"""

from __future__ import annotations

import asyncio
import dataclasses
import os

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

import sk
from conftest import open_world
from sixkey_server.constants import KVER_MAX_JUMP

EXAMPLES = int(os.environ.get("SIXKEY_MODEL_EXAMPLES", "40"))

put_vault = st.tuples(
    st.just("put"), st.integers(0, 1), st.sampled_from(["cur", "old", "new"]), st.booleans(), st.booleans()
)
put_keys = st.tuples(
    st.just("keys"),
    st.sampled_from(["rec", "pw", "both", "none"]),
    st.sampled_from(["cur", "old"]),
    st.sampled_from([1, 3, KVER_MAX_JUMP, KVER_MAX_JUMP + 1]),
    st.booleans(),
    st.booleans(),
)
rotate = st.tuples(
    st.just("rotate"),
    st.sampled_from(["cur", "old"]),
    st.sampled_from(["cur", "old"]),
    st.booleans(),
    st.booleans(),
    st.booleans(),
)
race = st.tuples(st.just("race"))
program = st.lists(st.one_of(put_vault, put_keys, rotate, race), min_size=1, max_size=18)


@dataclasses.dataclass
class Model:
    keys: sk.Keys
    version: int = 1
    envelope: str = ""
    last_keys_body: dict | None = None
    last_rotate_body: dict | None = None


def code(r):
    return r.json()["error"]["code"] if r.status_code >= 400 else None


async def run_program(db, ops):
    async with open_world(db) as w:
        acct, dev0, keys = await w.vault()
        dev1 = await w.recovery_device(acct, keys)
        devs = [dev0, dev1]
        m = Model(keys, envelope=(await w.api.call("GET", "/v1/vault", dev=dev0)).json()["envelope"])
        for op in ops:
            w.clock.advance(61_000)  # keep every per-minute bucket empty: the model has no limits
            kind = op[0]
            if kind == "put":
                await step_put(w, m, devs[op[1]], *op[2:])
            elif kind == "keys":
                await step_keys(w, m, dev0, *op[1:])
            elif kind == "rotate":
                await step_rotate(w, m, dev0, devs, *op[1:])
            else:
                await step_race(w, m, devs)
            await check(w, m, dev0)


async def step_put(w, m, dev, which, proof_ok, vk_ok):
    k = m.keys
    iv = {"cur": m.version, "old": m.version - 1, "new": m.version + 1}[which]
    if iv < 1:
        iv = m.version + 1
    vk = k.vk_id if vk_ok else sk.vk_id()
    env = sk.envelope(k.vault_id, vk, iv + 1)
    proof = k.proof(iv, env[1]) if proof_ok else sk.b64(sk.rnd(32))
    r = await w.api.put_vault(dev, k, iv, env=env, proof=proof)
    if iv != m.version:
        assert code(r) == "version_conflict" and r.json()["error"]["version"] == m.version
    elif not vk_ok:
        assert code(r) == "vk_mismatch"
    elif not proof_ok:
        assert code(r) == "write_denied"
    else:
        assert r.status_code == 200 and r.json()["version"] == m.version + 1, r.text
        m.version, m.envelope = m.version + 1, env[0]


async def step_keys(w, m, dev, change, which, jump, pw_ok, replay):
    k = m.keys
    if replay and m.last_keys_body is not None:
        r = await w.api.call("PUT", "/v1/keys", m.last_keys_body, dev=dev)
        stored = await w.val("SELECT bundle FROM sixkey.vaults")
        if stored == m.last_keys_body["bundle"]:
            assert r.status_code == 200 and r.json()["kver"] == k.kver  # §3.6.0, whatever the proofs say now
        else:
            assert r.status_code == 409 or code(r) == "keys_conflict"
        return
    if_kver = k.kver if which == "cur" else max(1, k.kver - 1)
    new_kver = if_kver + jump
    nk = dataclasses.replace(k)
    body = {"if_kver": if_kver, "password_auth": k.pw_auth_b64 if pw_ok else sk.b64(sk.rnd(32))}
    new_pw, new_rec = sk.rnd(32), sk.rnd(32)
    if change in ("rec", "both"):
        nk.rec_wrap = sk.wrap("recovery", k.vk_id, k.at)
        body["recovery_verifier"] = k.rec_verifier(new_rec)
    if change in ("pw", "both"):
        nk.pw_wrap, nk.auth_kdf = sk.wrap("password", k.vk_id, k.at), sk.kdf_pbkdf2()
        body["password_verifier"] = k.pw_verifier(new_pw)
    body["bundle"] = nk.bundle(dev.device_id, kver=min(new_kver, 2**53 - 1))
    r = await w.api.call("PUT", "/v1/keys", body, dev=dev)
    if not (if_kver < new_kver <= if_kver + KVER_MAX_JUMP):
        assert code(r) == "invalid_request"
    elif if_kver != k.kver:
        assert code(r) == "keys_conflict"
    elif not pw_ok:
        assert code(r) == "password_mismatch"
    else:
        assert r.status_code == 200 and r.json()["kver"] == new_kver, r.text
        k.kver, k.bundle_text, k.rec_wrap, k.pw_wrap, k.auth_kdf = (
            new_kver,
            body["bundle"],
            nk.rec_wrap,
            nk.pw_wrap,
            nk.auth_kdf,
        )
        if change in ("rec", "both"):
            k.rec_auth = new_rec
        if change in ("pw", "both"):
            k.pw_auth = new_pw
        m.last_keys_body = body


async def step_rotate(w, m, dev, devs, v_which, k_which, proof_ok, pw_ok, replay):
    k = m.keys
    if replay and m.last_rotate_body is not None:
        r = await w.api.call("POST", "/v1/keys/rotate", m.last_rotate_body, dev=dev)
        stored = await w.val("SELECT bundle FROM sixkey.vaults")
        if stored == m.last_rotate_body["bundle"]:
            assert r.status_code == 200 and (r.json()["version"], r.json()["kver"]) == (m.version, k.kver)
        else:
            assert r.status_code in (403, 409), r.text
        return
    iv = m.version if v_which == "cur" else max(1, m.version - 1)
    ik = k.kver if k_which == "cur" else max(1, k.kver - 1)
    k2 = sk.Keys(vault_id=k.vault_id, vk_id=sk.vk_id(), at=k.at)
    env = sk.envelope(k.vault_id, k2.vk_id, iv + 1)
    body = {
        "if_version": iv,
        "if_kver": ik,
        "envelope": env[0],
        "write_proof": k.proof(iv, env[1]) if proof_ok else sk.b64(sk.rnd(32)),
        "new_write_key": sk.b64(k2.write_key),
        "bundle": k2.bundle(dev.device_id, kver=ik + 1),
        "password_auth": k.pw_auth_b64 if pw_ok else sk.b64(sk.rnd(32)),
        "recovery_verifier": k2.rec_verifier(),
        "password_verifier": k2.pw_verifier(),
        "device_names": [{"device_id": d.device_id, "name_ct": k2.name_ct()} for d in devs],
    }
    r = await w.api.call("POST", "/v1/keys/rotate", body, dev=dev)
    if ik != k.kver:
        assert code(r) == "keys_conflict"
    elif iv != m.version:
        assert code(r) == "version_conflict"
    elif not proof_ok:
        assert code(r) == "write_denied"
    elif not pw_ok:
        assert code(r) == "password_mismatch"
    else:
        assert r.status_code == 200 and r.json() == {
            "version": m.version + 1,
            "kver": ik + 1,
            "server_time": r.json()["server_time"],
        }, r.text
        k2.kver, k2.bundle_text = ik + 1, body["bundle"]
        m.keys, m.version, m.envelope, m.last_rotate_body, m.last_keys_body = k2, m.version + 1, env[0], body, None


async def step_race(w, m, devs):
    k = m.keys
    envs = [sk.envelope(k.vault_id, k.vk_id, m.version + 1) for _ in devs]
    rs = await asyncio.gather(*(w.api.put_vault(d, k, m.version, env=e) for d, e in zip(devs, envs)))
    assert sorted(r.status_code for r in rs) == [200, 409]
    win = [r.status_code for r in rs].index(200)
    m.version, m.envelope = m.version + 1, envs[win][0]


async def check(w, m, dev):
    k = m.keys
    v = (await w.sql("SELECT * FROM sixkey.vaults"))[0]
    assert (v["version"], v["kver"], v["vk_id"], v["envelope"]) == (m.version, k.kver, k.vk_id, m.envelope)
    assert v["bundle"] == k.bundle_text and bytes(v["write_key"]) == k.write_key
    assert sk.b64(bytes(v["password_verifier"])) == k.pw_verifier()
    assert sk.b64(bytes(v["recovery_verifier"])) == k.rec_verifier()
    assert bytes(v["head"]) == sk.sha256(m.envelope.encode())
    hist = [r["version"] for r in await w.sql("SELECT version FROM sixkey.vault_versions ORDER BY version")]
    assert hist == list(range(1, m.version + 1))
    assert (await w.sql("SELECT envelope FROM sixkey.vault_versions WHERE version = $1", m.version))[0][
        "envelope"
    ] == m.envelope
    st_ = (await w.api.status(dev)).json()
    assert (st_["version"], st_["kver"], st_["vk_id"]) == (m.version, k.kver, k.vk_id)


@settings(max_examples=EXAMPLES, deadline=None, derandomize=True, suppress_health_check=list(HealthCheck))
@given(ops=program)
def test_vault_and_keys_state_machine(db, ops):
    asyncio.run(run_program(db, ops))
