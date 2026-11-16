"""History retention (§5.8): newest 30 versions + each of the last 30 UTC days' last version, head always
kept, 64 MiB cap (oldest non-daily-last first). Checked after every write against a model written here
independently of sixkey_server.retention, with a fake clock across 45 days; times are hour precision."""

from __future__ import annotations

import json
import random

import sk
from sixkey_server import jobs
from sixkey_server.constants import MAX_ENVELOPE_BYTES
from sixkey_server.retention import Policy

HOUR, DAY = 3_600_000, 86_400_000


def model_keep(rows: dict[int, tuple[int, int]], now: int, keep_n=30, days=30, cap=64 * 2**20) -> set[int]:
    """rows: version -> (created_ms, size). The policy as the doc states it, step by step."""
    head = max(rows)
    newest = set(sorted(rows, reverse=True)[:keep_n])
    today = now // DAY
    last_of_day: dict[int, int] = {}
    for v, (created, _) in rows.items():
        d = created // DAY
        if today - days < d <= today:
            last_of_day[d] = max(v, last_of_day.get(d, 0))
    daily = set(last_of_day.values())
    keep = newest | daily | {head}
    while sum(rows[v][1] for v in keep) > cap:
        plain = sorted(v for v in keep if v not in daily and v != head)
        lasts = sorted(v for v in keep if v in daily and v != head)
        if plain:
            keep.discard(plain[0])
        elif lasts:
            keep.discard(lasts[0])
        else:
            break
    return keep


async def db_versions(w):
    return {
        r["version"]: (int(r["created_at"].timestamp() * 1000), r["size_bytes"])
        for r in await w.sql("SELECT version, created_at, size_bytes FROM sixkey.vault_versions")
    }


async def check(w, model, dev):
    got = await db_versions(w)
    assert set(got) == set(model), sorted(set(got) ^ set(model))
    assert all(c % HOUR == 0 for c, _ in got.values())
    hb, head = (await w.sql("SELECT history_bytes, version FROM sixkey.vaults"))[0]
    assert hb == sum(s for _, s in got.values()) and head == max(got)
    listed = (await w.api.call("GET", "/v1/vault/versions", dev=dev)).json()["versions"]
    assert [v["version"] for v in listed] == sorted(got, reverse=True)
    assert all(v["created_at"] % HOUR == 0 for v in listed)


async def test_retention_over_45_days(world):
    w = world
    rng = random.Random(1234)
    acct, dev, keys = await w.vault()
    model = await db_versions(w)
    for day in range(45):
        for _ in range(rng.choice([0, 0, 1, 2, 3, 6])):
            w.clock.advance(rng.randrange(1, 3 * HOUR))
            r = await w.api.put_vault(dev, keys)
            assert r.status_code == 200, r.text
            keys.version = r.json()["version"]
            now = w.clock.now_ms()
            model[keys.version] = (now // HOUR * HOUR, len(json.loads(r.request.content)["envelope"].encode()))
            model = {v: model[v] for v in model_keep(model, now)}
            await check(w, model, dev)
        w.clock.set((w.clock.now_ms() // DAY + 1) * DAY + rng.randrange(0, 5 * HOUR))
    assert len(model) > 30  # daily lasts beyond the newest 30 were really kept


async def test_retention_with_the_byte_cap(make_world):
    cap = 120_000
    async with make_world(history_max_bytes=cap) as w:
        rng = random.Random(99)
        acct, dev, keys = await w.vault()
        model = await db_versions(w)
        for i in range(60):
            w.clock.advance(rng.choice([HOUR, 5 * HOUR, DAY]))
            env = sk.envelope_of_size(keys.vault_id, keys.vk_id, keys.version + 1, rng.randrange(2_000, 30_000))
            r = await w.api.put_vault(dev, keys, env=env)
            keys.version = r.json()["version"]
            model[keys.version] = (w.clock.now_ms() // HOUR * HOUR, len(env[0]))
            model = {v: model[v] for v in model_keep(model, w.clock.now_ms(), cap=cap)}
            await check(w, model, dev)
            assert sum(s for _, s in model.values()) <= cap or len(model) == 1


async def test_real_64_mib_cap_with_8_mib_envelopes(world):
    w = world
    acct, dev, keys = await w.vault()
    for i in range(10):
        w.clock.advance(HOUR)
        env = sk.envelope_of_size(keys.vault_id, keys.vk_id, keys.version + 1, MAX_ENVELOPE_BYTES)
        r = await w.api.put_vault(dev, keys, env=env)
        assert r.status_code == 200
        keys.version = r.json()["version"]
        total = await w.val("SELECT sum(size_bytes) FROM sixkey.vault_versions")
        assert total <= 64 * 2**20 and total == await w.val("SELECT history_bytes FROM sixkey.vaults")
        assert await w.val("SELECT max(version) FROM sixkey.vault_versions") == keys.version
    assert await w.val("SELECT count(*) FROM sixkey.vault_versions") == 8


async def test_daily_job_ages_out_old_days(world):
    w = world
    acct, dev, keys = await w.vault()
    model = await db_versions(w)
    for i in range(45):  # three writes a day for 15 days: older days' lasts sit outside
        w.clock.advance(DAY // 3)  # the newest 30 and are kept only as daily lasts
        r = await w.api.put_vault(dev, keys)
        keys.version = r.json()["version"]
        model[keys.version] = (w.clock.now_ms() // HOUR * HOUR, await w.val("SELECT size_bytes FROM sixkey.vaults"))
        model = {v: model[v] for v in model_keep(model, w.clock.now_ms())}
    await check(w, model, dev)
    assert len(model) > 30
    flow = await w.start_approval(acct)
    await w.provider.send_otp("never-confirmed@example.invalid")
    w.clock.advance(25 * DAY)  # no writes: the 30-day window moves past the first days
    counts = await jobs.run_daily(w.pool, w.provider, w.clock, Policy())
    model = {v: model[v] for v in model_keep(model, w.clock.now_ms())}
    await check(w, model, dev)
    assert counts["enrollments"] == 1 and counts["unconfirmed_users"] == 1 and counts["versions"] > 0
    assert (await flow.poll()).status_code in (401, 410)
    assert await w.val("SELECT count(*) FROM auth.users WHERE email = 'never-confirmed@example.invalid'") == 0
    assert await w.val("SELECT count(*) FROM auth.users WHERE email = $1", acct.email) == 1


async def test_unconfirmed_users_younger_than_a_day_stay(world):
    w = world
    await w.provider.send_otp("fresh@example.invalid")
    w.clock.advance(DAY - 1000)
    assert (await jobs.run_daily(w.pool, w.provider, w.clock, Policy()))["unconfirmed_users"] == 0
    w.clock.advance(2000)
    assert (await jobs.run_daily(w.pool, w.provider, w.clock, Policy()))["unconfirmed_users"] == 1


async def test_clear_history_keeps_the_head(world):
    w = world
    acct, dev, keys = await w.vault()
    for _ in range(5):
        r = await w.api.put_vault(dev, keys)
        keys.version = r.json()["version"]
    r = await w.api.call("DELETE", "/v1/vault/versions", {"password_auth": keys.pw_auth_b64}, dev=dev)
    assert r.json()["deleted"] == 5
    got = await db_versions(w)
    assert list(got) == [6]
    assert await w.val("SELECT history_bytes FROM sixkey.vaults") == got[6][1]
    r = await w.api.put_vault(dev, keys)
    assert [v["version"] for v in (await w.api.call("GET", "/v1/vault/versions", dev=dev)).json()["versions"]] == [7, 6]
