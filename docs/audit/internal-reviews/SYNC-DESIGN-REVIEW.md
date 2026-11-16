# First review of SYNC-DESIGN.md (Phase 1 sync)

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: the word
> "independent" removed from the heading and the reviewer line, repository paths updated to the current layout and
> absolute local paths shortened. Paths under `scratchpad/` were the reviewer's temporary working copies (probes,
> mutants, logs) and were **not retained**: a probe or mutant exists only as far as this record quotes it or as it was
> adopted into the test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these
> records: [`docs/audit/README.md`](../README.md).

Reviewer: protocol review session, 2026-10-15. Scope: `docs/SYNC-DESIGN.md` (all sections), checked against the
code it must fit (`extension/src/core/{crypto,vault,storage,service}`, `extension/src/platform/session.ts`), `docs/security/local-vault.md`
and docs/history/PLAN-zh.md §5–7. Review only: nothing in `src/`, tests or SYNC-DESIGN.md was changed.

Line references: `SD Lnnn` = SYNC-DESIGN.md line; code paths are relative to `extension/src/core/`.

Severity scale:
- **critical**: breaks a stated confidentiality guarantee against an in-scope attacker in a common flow.
- **high**: realistic path to seed exposure, loss of data or loss of the only recovery path; or the doc claims a security bound that depends on rules it never states.
- **medium**: needs unusual conditions, or causes liveness / integrity failures, or a stated guarantee is wrong.
- **low**: hygiene, spec precision, or small attack surface.

Counts: **1 critical, 3 high, 9 medium, 14 low** (27 findings: 16 confirmed with a sequence, F1–F16; 11 plausible / spec gaps, P1–P11).

---

## Part A. Confirmed flaws (the failing sequence can be shown)

### F1 (critical): Enrollment authenticates N to A only. A malicious server can impersonate A and harvest the joining device's seeds.

**Where:** §3.2 (SD L226 "服务器对两边各只有一次 10⁻⁶ 的机会", L235 "这只保护批准方 A"), §3.5 (SD L261, L264), §1.2 A1 (SD L56 "看不到种子").

The SAS check runs only on A: A compares the typed number with its own SAS. N verifies nothing. The §3.5 gate is a yes/no question, and its own justification ("攻击者合法拥有那个库") covers the squatter case, not a server MITM.

**Attack (malicious server S):**
1. N runs M1. S also creates its own request R_S toward A (S-as-N). For N's real request, S answers the M2 `respond` itself, with its own epk_S and a fake devA.
2. The user opens "approve" on A and sees one recent request (R_S; S can hide N's real one), selects it, and A responds.
3. N reveals and shows SAS_N. The user types SAS_N into A. A computes SAS_A from h2 ≠ h1, sees a mismatch, and says "wrong number" (three times).
4. S "approves" N with its own payload: P = {VK_S, a KeyBundle MAC'd with VK_S}, encrypted under K1, which S knows because it is N's peer in session 1. Every N-side check in M6 passes: vkId, MAC and vaultId are all self-consistent.
5. N's gate asks "你刚才是否在你自己的另一台设备上输入了 123 456？". The user did type it, so they answer yes.
6. §3.5 ①–⑥ runs: N imports every local account into the fake vault, encrypts it under VK_S, and pushes. **S decrypts every seed.** An empty N still sends S every account added on it afterwards.

The same route works on the user's *first* device: S lies `has_vault: true` (SD L176) and plays A. That device holds all the user's accounts. The squatting warning text (SD L260) shows a date and a count that S chooses.

**Why the gate does not save it:** the question asks about an action the user really performed. Nothing tells N whether A *accepted*.

**Why this is not already covered by the doc:** the A1 row's residual column says "批准入网（D2）防的是邮箱攻击者，对恶意服务器无效" (SD L56). That caveat is about offline-brute-force material, which the server already holds. The same row's guarantee column still promises "看不到种子" and "不能冒充已入网设备去拿 VK（入网 SAS）". No section acknowledges a server playing A toward N and collecting seeds when N joins and imports.

**Fix (protocol change):**
- Add an A→N confirmation code.
  - After A verifies SAS_N == SAS_A, A displays `CC = uint32be(SHA-256("sixkey/v1/enroll-confirm|" ‖ h)[0..4]) mod 10^4` (or 10^6).
  - N must have the user type CC before it uses the payload in any way: no MAC trust, no local write, no import, no `complete`.
  - N computes CC(h1) itself and allows 3 tries, then self-rejects.
- Why this holds:
  - Under MITM h1 ≠ h2. The real A displays CC(h2) only after a SAS match (≤10⁻⁶), and CC(h2) ≠ CC(h1) except with probability 10⁻⁴.
  - S can compute CC(h1) but cannot put it on the user's screen.
  - The same change turns squatting (A2, SD L57) from "user must answer a question correctly" into "attacker must social-engineer a code out of band".
- Then:
  - Replace the §3.5 question with this check.
  - Correct the "两边各只有一次" sentence.
  - Add the S-impersonates-A strategy to the §8.1 adversary model.
- Cost: typing 4 extra digits once per enrollment. The invite path is unaffected.

### F2 (high): Key changes with an unknown outcome make the user throw away the recovery code that is actually live.

**Where:** §3.7 (SD L277 "PUT 失败：丢弃…'刚才那个新码无效'"), §3.8 P3 (SD L283–285 "409 keys_conflict → 整个轮换作废，告诉用户'刚才的新恢复码无效'"), §3.9 R2 (SD L296), §5.4 `PUT /v1/keys` and `/rotate` (SD L632–633). No op id and no reconciliation step exists anywhere in the doc.

**Sequence (new recovery code):**
1. The device sends `PUT /v1/keys {if_kver: k, bundle(kver k+1, recovery wrap for code2), recovery_verifier(code2)}`.
2. The server commits. The response is lost (timeout, the SW is killed during the request, network drop).
3. The client classifies this as "PUT 失败". The UI says code2 is invalid. The user discards code2 and keeps code1, which they believe is still valid.
   - If the user retries, the request carries `if_kver: k` and gets `409 keys_conflict`. The O11 copy says "已在另一台设备修改", which is false: it was this device.
4. Next sync: kver k+1 > local, so the bundle is staged. Under R2 the password wrap is byte-identical, so it is **adopted immediately** on every device.
5. Now code2 opens every keyring and code1 opens none. The user holds code1. Per Q2 (SD L856), a single-device user who reinstalls has lost the only way back.

**Rotation variant:**
1. P3 commits and the response is lost. The client retries P3 with the old `if_kver` and gets `409 keys_conflict` caused by its own commit.
2. Per SD L285 the client says "刚才的新恢复码无效".
3. Every device later adopts VK2 by entering the password (R3), and VK2's keyring is opened only by code2.

**Fix:**
- `PUT /v1/keys` and `/v1/keys/rotate` carry a client-generated `op_id`. The server stores `(last_op_id, resulting kver, bundle hash)`. Repeating the same `op_id` with the same bundle returns 200 with the same result.
- On any non-definitive result (network error, 5xx, timeout) and on 409, the client GETs `/v1/keys`.
  - If `canonicalJson(server bundle) == canonicalJson(submitted bundle)`, it is a success: run the local commit (P4 / local transact).
  - Only otherwise is it a failure.
- Never tell the user a new code is invalid until reconciliation has finished.
- Persist a non-secret "pending key op" marker (op_id and bundle hash) in `sk_sync_state`. A later sync that sees that bundle can then say "the recovery code you created at {time} is now active" instead of a generic "changed elsewhere".

### F3 (high): `dirty ⇔ seq > lastSyncedSeq` breaks after local recovery, so later edits are silently never uploaded.

**Where:** §4.1 (SD L376), §4.13 cloud restore (SD L484), against `storage/store.ts`.

`transact` computes `seq = (prev?.seq ?? 0) + 1` (store.ts L266, L271), and `prev` is `null` when the status is `lost`. `recover()` rebuilds with `topSeq + 1`, where topSeq is the maximum over the *surviving* candidates only (store.ts L130, L135). `sk_sync_state` lives in `storage.local` and normally survives a `lost` state, because `lost` means vault keys are still present (store.ts L185–189).

**Sequence:**
1. The device has synced with `lastSyncedSeq = 340` (every transact bumps seq, including no-op writes, SD L376).
2. The slots are damaged and the device is `lost`. The user runs §4.13 "从云端恢复": `transact(overwriteLost)` writes seq 1.
3. Next round: `1 > 340` is false, so the device is not dirty. `st.version == lastSyncedVersion`, so it does not pull either (§4.2 step 4).
4. The user makes edits at seq 2…340. None is uploaded unless some other device's change happens to start a merge round. If this device is lost again (it just was), those edits are gone.

The same happens with `restoreBackup`/`startOver` from `lost` (service.ts L379–391, L461–469), and with `recover()` whenever the newest snapshots are also damaged.

**Fix:**
- Track `lastSynced = {seq, envelopeChecksum}` and define dirty as `gen.seq !== lastSynced.seq || gen.envelope.checksum !== lastSynced.envelopeChecksum`. Any decrease in seq therefore counts as dirty.
- On any storage recovery event (`slot_fallback`, `snapshot_restore`, `mirror_restore`, `decrypt_fallback`, `cloud_restore`), clear `lastSyncedVersion` so the next round does a full GET, merge and PUT.
- No format change is needed.
- Add "recover from snapshot/cloud with sk_sync_state intact, then edit" to the §8.2 crash model.

### F4 (medium): After a server rollback (A5) the engine never pulls, and its PUT loops on 409.

**Where:** §4.2 step 4 (SD L388 "若 st.version > lastSyncedVersion：GET"), step 7 (SD L393 `if_version: base`), against the A5 row (SD L60 "版本倒退：告警，照常合并") and §4.3 (SD L408).

**Sequence:**
1. Honest PITR restore: the server goes from version 100 to 90, while the device has `lastSyncedVersion = 100`.
2. `90 > 100` is false, so there is no GET. The device is dirty, so it PUTs with `base` (undefined in the doc).
   - If `base = lastSyncedVersion = 100`: 409, retry 5 times, back off, forever, until the server version passes 100.
   - If `base = st.version = 90`: it uploads without ever merging v90. It is usually a superset, but the A5 "照常合并" path and its alarm never run.

**Fix:**
- Pull whenever `st.version !== lastSyncedVersion`.
- Define `base` as the version of the envelope actually merged in this round.
- Raise the A5 alarm whenever `st.version < maxSeenVersion`, then merge normally.

### F5 (medium): A device whose clock runs more than 24h fast uploads on every round, and makes every other device commit on every round.

**Where:** §4.5 (SD L431), §4.14 (SD L490 "只影响验证码，不影响 HLC"), §8.2 (SD L765 "无改动时不 PUT…包括时钟偏差 ±2 天的设备").

The HLC uses uncorrected `Date.now` (service.ts L226 `createClock(device, { now: this.now })`). Only the *remote* copy is clamped (ops.ts L133–149, SD L389).

**Sequence (device F at +2 days):**
1. F edits an entry. Its stamp T ≈ server_now + 2d.
2. F's next round: `clampVault(remote, refNow = server time)` pulls F's own earlier upload down to server_now + 24h. `merge(local T, clamped)` keeps T. `committed ≠ clampVault(remote)`, so F PUTs.
3. The next round on F is identical (remote raw = T, clamped below T), so F PUTs again, on every 30-minute alarm and every popup open, until the server clock passes T − 24h.
4. Every other device clamps the raw T to its own `now + 24h`, which grows each round. The merge therefore differs from local every round, so it runs `applyRemote`, writing a "sync" snapshot and a rolling snapshot each time.
   - Within hours the 10 sync and 10 rolling snapshots contain near-identical churn. That flushes exactly the safety net §4.4 relies on.

**Fix:**
- With sync on, run the HLC on server-corrected time: `now = Date.now() + offset`, with the offset bounded ±7 days as in §4.3.
- Clamp the *local* vault with the same `refNow` before merging.
- Upload iff `merge(clamp(local), clamp(remote)) ≠ remote (raw)`. The first device that clamps then uploads the clamped stamps once, and every device converges.
- §8.2 would catch this. The algorithm as written fails its own test.

### F6 (medium): Anyone holding only a device signing key can write an undecryptable head, and §4.3 then overwrites it without merging. A3 is mis-stated.

**Where:** §1.2 A3 (SD L58 "持有 VK 时还可以上传恶意内容", which implies "without VK it cannot"), §4.3 row 1 and row 5 (SD L405, L409 "其他错误按第一行处理"), §5.3 PUT checks (SD L610).

The envelope checksum is a plain SHA-256 over aad‖iv‖ct (crypto/envelope.ts L43–51). Every server-side check (rev = base+1, vaultId, vkId, checksum, size) can be computed without VK. A locked profile copy carries a working DSK: IndexedDB stores the non-extractable key material inside the profile, and the doc's own §2.1 (SD L89) makes the same point. A3 explicitly includes AdsPower-style shared and vendor-synced profiles.

**Sequence:**
1. Profile P1 pushes v10, which adds account E, and is then deleted. Deleting profiles is routine in fingerprint-browser workflows.
2. Before any other device merges v10, the holder of a copied DSK PUTs v11: correct header, random ciphertext, valid checksum. The server accepts it.
3. Device D2 GETs v11 and decryption fails. Per §4.3 row 1 it "把本机当前数据正常 PUT 上去" (it uploads its local copy, which lacks E) as v12, with no merge.
4. E now exists only in history v10 and expires with it (30 days). No device holds it, so "永不丢数据" fails.
5. The same key holder can repeat this at 30 PUT/min (the per-account limit, SD L663), which also starves honest devices of PUT budget (see F8).

**Fix:**
- (a) When the head does not decrypt, walk back through `/v1/vault/versions` to the newest version that decrypts under the current VK, merge it, and only then PUT.
- (b) Record `written_by device_id` on every `vault_versions` row and return it. The UI can then say "an undecryptable version was written by device X" and offer revocation.
- (c) Design option: VK-bound write authorization.
  - At init and at every rotation, generate a random ECDSA "vault write key". Store its PKCS8 private key encrypted under `HKDF(VK, "sixkey/v1/write-key")` inside the KeyBundle. Register the public key with the server.
  - Every PUT/rotate carries a signature by it over (vault_id, if_version, envelope checksum).
  - The server then rejects writes from DSK-only holders (A3) and from revoked VK holders after rotation (A4) at the API level.
- (d) Correct the A3 row.

### F7 (medium): Anyone with VK can inflate kver, so R1 is not an anti-downgrade defense. The cloud-restore path can be moved back to a revoked VK.

**Where:** §2.3 (SD L127–128), §3.9 R1 (SD L294), §1.2 A4/A5 (SD L59–60 "KeyBundle 倒退：忽略并告警，永不降级到旧 VK"), §4.13 (SD L484).

K_mac is derived from VK. A revoked device that knows VK1 can therefore mint a VK1-MAC'd bundle with any kver, for example `maxSeenKver + 100`. Normal flows are protected by the previous-chain check (§4.2 step 2, SD L385: "vk_id 在本机 previous 中 → 回滚告警"), but that check needs the *local keyring*. In §4.13 the local data is `lost`, and only `maxSeenKver` survives (in IDB, SD L145).

**Sequence (A4 plus malicious server, or A4 plus a compromised DB):**
1. The user rotated VK1 to VK2 without changing the password (the change is optional, SD L281).
2. Device D becomes `lost` and offers cloud restore. S serves the old VK1 envelope and a VK1 bundle with kver ≫ maxSeenKver. Its password wrap is the genuine old one, so it opens with the unchanged password.
3. R1 passes and the MAC passes under VK1. D restores onto VK1. Every edit D makes from then on is readable by the A4 holder.

**Fix:**
- Pin `{currentVkId, retiredVkIds[]}` in `DeviceIdentity` (IDB, which survives storage.local loss) and update it at every adoption.
- Reject any bundle or envelope whose vkId is in `retiredVkIds`, regardless of kver.
- Require continuity relative to the pinned vkId (the new keyring's `previous` must contain it) even when the local keyring is gone.
- Compare the pair (vkId, kver), not kver alone.

### F8 (medium): Account-wide rate limits bring back the freeze §10 #24 claims to fix, and let DSK-only holders and email attackers block enrollment and sync.

**Where:** §5.5 (SD L665 "密钥操作、吊销、删除 每账户 10 次/小时", L663 "PUT 每账户 30 次/分钟", L660 "入网请求 每账户同时 ≤3 个待处理、20 个/天", L658 OTP per-email limits), against §10 #24 (SD L844) and §3.14 (SD L360). The doc does not say whether requests rejected with 403/423 count toward account buckets.

**Sequences:**
- **Sensitive-op freeze:** a thief with the stolen device's key sends 10 `POST /v1/devices/{laptop}/revoke` per hour with junk `password_auth`. 5 fail (`403`), after which the device is `423`. If these count toward the account bucket, the user's own revoke-and-rotate gets `429` for the rest of the hour, every hour. That is exactly the attack #24 calls fixed.
- **Sync starvation:** the same key holder sends 30 PUT/min (even ones that fail with 409), so honest devices get 429.
- **Enrollment starvation:**
  - An email-only attacker (A2) keeps 3 pending requests open and uses up the 20/day quota, so the user cannot enroll a new profile that day.
  - The constant "有设备请求加入" banners also train users to approve.
- **Login starvation:** anyone who merely *knows* the email can use up "每邮箱 3 次/10 分钟、10 次/天" OTP sends. The user then cannot get an account session to enroll, recover or delete.

**Fix:**
- Use per-device buckets for device-authenticated operations, with only a high ceiling per account.
- Requests rejected for pw_auth or with 423 never consume account-level budget.
- Exempt revoke and rotate from account-level caps.
- Cap enrollment requests per account session (one pending request per OTP session), and let an enrolled device reject requests in bulk and pause new ones for 24h.
- Key OTP-send limits per (email, IP-HMAC) as well as globally per email, with the global cap high enough that strangers cannot lock the owner out.

### F9 (low): `respond` has no `pw_auth`, so a DSK-only holder can claim the single approver slot of every request.

**Where:** §3.2 M2 (SD L203 "CAS pending→responded，只允许一个批准方"), §5.4 (SD L641 auth "设备"), §3.14 list (SD L355).

**Sequence:**
1. The holder of a copied key polls `GET /v1/enroll/requests` and responds to each new request first.
2. N then shows a SAS for the thief's epk. The user's real A gets 409 `enroll_state`, and enrollment is impossible until the user works out which device to revoke.

**Fix:** M2 already makes the user re-enter the password, so require `password_auth` on `respond` at no extra UX cost. Show "already being handled by device X" on A.

### F10 (medium): A crash between `complete` and the local write leaves the device enrolled with no VK and a foreign vaultId: a dead end.

**Where:** §3.2 M6→M7 (SD L218–220), §3.5 ④/⑤ (SD L264), §4.3 `different_vault` (SD L406 "停止，提示联系支持").

**Sequence:**
1. N completes M6, so the server creates the device row.
2. The tab closes (or the browser crashes) before M7 writes local data. VK existed only in tab memory.
3. On restart, the identity is `enrolled` but the local vault still has the old vaultId (or is empty).
   - With an old local vault, the engine hits `different_vault` and says "contact support".
   - The doc covers only a crash *before* `complete` (SD L219).

**Fix:**
- Either write local data before `complete` (N legitimately holds VK after a verified SAS/CC), or persist a non-secret `joining` marker in the identity record.
- On restart with `joining` set, or with an enrolled identity whose local vaultId differs from the cloud's, offer "finish joining": GET `/v1/keys`, unwrap with the master password, then rerun the §3.5 import.

### F11 (low): The new "sync" snapshot kind would be deleted in the same call that writes it. §3.13/I7 misses the retention code.

**Where:** §3.13 (SD L344), I7 (SD L164), against `storage/store.ts` `addSnapshot` (L299–310).

`keep()` retains only `rolling` and `daily` (L305–307). Any other kind lands in `dropped` and is removed at L310. `addSnapshot` is also private, and `transact` has no hook to snapshot `cur` before the commit point. The doc lists `parseSnapshotIndex`, `checkSnapshot` and `rewriteForKeyChange` but not this function, the `SnapshotMeta.kind` type, or a `transact` option. Following the list literally gives a "snapshot before every merge" that never persists.

**Fix:** add `RETENTION.sync` handling to `keep()`, add a `transact(fn, {snapshotBefore: "sync"})` option, and list every touchpoint in §3.13.

### F12 (low): An account deletion that fails halfway cannot be retried by the client.

**Where:** §5.7 (SD L680 "失败时返回 500，客户端重试，此时业务表已空") and §5.4 (SD L650: `DELETE /v1/account` needs a device signature).

**Sequence:** the transaction deletes `devices`, then the Supabase admin delete fails and returns 500. The retry's device signature finds no row (`401 unknown_device`). The auth user, with its email and audit log, stays behind and the client cannot finish.

**Fix:** delete the auth user first, or keep a `deleting` tombstone that allows retrying with only a fresh account session, or finish the deletion in a server-side job.

### F13 (medium): Three privacy statements are not true as designed.

**Where:**
- (a) §7 PRIVACY text (SD L746 "在其他设备快照中 ≤7 天") and Q5 (SD L866), against §4.4 (SD L424) and the rolling/sync retention.
- (b) §3.6 step 5 (SD L273 "服务器上旧密码包裹随即消失").
- (c) §5.3 `vault_versions.created_at` (SD L554), against D3 (SD L24).

**Details:**
- (a) Remote purges deliberately do not clean local snapshots. The rolling (10) and sync (10) snapshots are **count-based**, not time-based, so a quiet profile that makes no edits keeps the purged seed indefinitely, not for at most 7 days.
- (b) PITR and daily backups keep the old password wrap and old verifier for the whole backup window. A password change does not rotate VK. So cracking an old, weak password from a backup opens *current* data.
- (c) Each version row carries a microsecond timestamp. For 30 days that is a per-edit activity log, beyond "最后同步时间".

**Fix:**
- (a) Apply remote purges to local snapshots after a delay (say 7 days), or state "until 10 later changes".
- (b) Disclose this. When the user says they are changing the password because it may be compromised, offer "also rotate the key".
- (c) Round `created_at` to the hour or day, or disclose it.

### F14 (low): `pw_auth`/`recovery_auth` are static bearer values; two non-idempotent replays exist; failure counters have a check-then-act race.

**Where:** §3.14 (SD L353–354), §5.2 (SD L525 "要么幂等（GET、吊销、改名）"), §1.2 A6 (SD L61).

**Details:**
- `password_auth` is the same 256-bit value on every request until the password changes. Any captured request body (a TLS-terminating proxy's request logging, a server memory dump) is a reusable credential for every sensitive endpoint.
- Replays within the ±300 s window:
  - `POST /devices/{id}/unlock-sensitive` re-unlocks a device the user has just re-locked.
  - Replaying an older `PATCH /devices/{id}` reverts a newer rename. "改名幂等" is false once there are two renames.
- `auth_failures` read-then-check lets N parallel requests each get a guess. This is harmless today, as the doc says (SD L360), but becomes real if Q2(b) "email plus password enrollment" ships.

**Fix:**
- Make the proof request-bound.
  - Generate a random ECDSA "auth key". Store its private key in the KeyBundle, encrypted under a key from `PBKDF2(pw, salt_auth)` (the same offline cost as today).
  - The server stores only the public key.
  - Every sensitive request is signed with it over the existing signature input (ts plus body hash).
  - A server breach then yields nothing reusable, and requests cannot be replayed beyond the ts window.
- Add a short-lived nonce cache for the few non-CAS writes.
- Run `UPDATE devices SET auth_failures = auth_failures + 1 WHERE device_id = $1 AND NOT sensitive_locked RETURNING auth_failures` *before* verifying, and reset it on success.

### F15 (medium): A merge can exceed `LIMITS.entries`, which stalls sync permanently on every device.

**Where:** §4.3 size row (SD L411, L413), against `vault/validate.ts` L15 and L80 (`entries.length > 5000` rejects) and `merge.ts` L70–78 (union of ids).

Two vaults that are each valid (each ≤ 5000 entries including permanent tombstones) can merge into more than 5000. `applyRemote` then fails the serialize-and-reload check, so every device fails the same merge on every round. §4.3 handles the *byte* overflow (`too_large`) but not the count. Tombstones are never collected, and the doc itself notes that sync multiplies them (SD L413). The target users run many profiles with many accounts.

**Fix:**
- Give this case its own status with a cleanup UI.
- Count tombstones under a separate, larger limit.
- Design tombstone GC: for example, a purged tombstone older than the 30-day history window, acknowledged by every non-revoked device through a per-device watermark, can be dropped.

### F16 (low): The destructive-change guard is too permissive in absolute terms and treats purge like a delete.

**Where:** §4.4 (SD L419 "lost + purged ≥ max(3, 本地存活数 × 25%)").

- With 400 live entries, 99 remote deletions or purges merge silently.
- A remote purge destroys the secret. "Alive locally, purged remotely" is almost never a normal multi-device outcome, because the user normally trashes first and the trash syncs.

**Fix:** trigger on `purged-while-locally-alive ≥ 1`, or `lost ≥ min(25%, 10)`, or `secretChanged ≥ 1`.

---

## Part B. Plausible concerns and spec gaps (the doc is silent or ambiguous; an implementation could get it wrong)

### P1 (high): The 10⁻⁶ bound depends on pinning rules the doc never states.

**Where:** §3.2 M2–M5 (SD L200–216), §8.1 (SD L757). A grep finds no rule saying either party freezes the other's values.

The commitment argument holds only if each party fixes the counterpart's contribution exactly once:
1. **A** must freeze `(rid, devN, dpk_N, C)` from the poll that precedes its `respond`, and abort on any later change. If A re-reads C at M4, S can replace (C, opening) after seeing epk_A and grind about 2²⁰ P-256 keypairs, which takes seconds, until SAS_A equals SAS_N.
2. **N** must freeze `(devA, epk_A)` from the first M3 poll, compute the SAS exactly once, and never show a different number for the same request. If N recomputes on each poll, S learns n_N from the reveal and grinds epk_A′ until SAS_N′ equals SAS_A, and N's displayed number changes silently.
3. **N must never re-create a request automatically** (on 410, a network error or a timeout). Each fresh request is a fresh 10⁻⁶ draw. If S can make N cycle while the user is looking at the screen, S needs only that N cycles, not that the user retries.
4. A's 3 retries must compare against the same pinned SAS_A. A must not re-key between tries.

Under these rules, parallel requests do not multiply the attacker's chances: each typed number is compared against exactly one SAS_A, and N shows one number per request. The "≤3 pending" limit is not a security bound against a malicious server; user patience is.

**Fix:**
- Write these four rules into §3.2 as MUST statements.
- Add the corresponding adversary strategies to §8.1: change C after respond, change epk_A after reveal, force N to re-create its request.
- The 4-bit SAS test should run against each strategy.
- Optionally have the honest server recompute h from the stored fields at `approve` and reject a mismatch, which cheaply detects client bugs.

### P2 (medium): R1 trusts a `localKver` stored apart from the keyring, with unspecified write order.

**Where:** §3.9 R1 (SD L294), §4.1 `sk_sync_state.localKver` (SD L375).

Adoption is two writes: `transact{keyring}` and an `sk_sync_state` update. If localKver is written first and the process crashes, the device believes it holds k+1 while its keyring is still k, and R1 refuses k+1 permanently.

The bad case: the user forgot the password and reset it with the recovery code on another device (§3.3 step 5, new password P2 and new code2). This device keeps the P1 wrap and the code1 wrap. The user may have discarded code1, P1 is forgotten, and P2 does not open the local keyring. If R3's "try staged" was cleared, the device is locked out along with its unsynced edits.

**Fix:**
- Define "adopted" by content: `canonicalJson(local keyring) == canonicalJson(bundle.keyring)`.
- Always write the keyring first.
- When the local unlock fails, R3 tries the server's current bundle regardless of localKver.

### P3 (low): R2 adopts bundles that only "change previous", including ones that *remove* entries.

**Where:** §3.9 R2 (SD L296 "只换了恢复码或 previous：立即采用").

A VK holder working with a malicious server can publish a bundle with the same password wrap and `previous: []`. After adoption:
- Server history under older VKs can no longer be opened.
- `housekeeping` (service.ts L193–202) returns `null` for any snapshot whose VK is no longer in previous, so `rewriteForKeyChange` drops it (store.ts L401–409).

R2 also accepts a changed `auth.kdf` alongside an unchanged password wrap.

**Fix:**
- `previous` must be a superset of the local list, except for the device's own GC rule beyond 64 entries.
- `auth` may change only together with the password wrap.

### P4 (low): The server-side verifiers can drift away from the wraps.

**Where:** §5.4 `PUT /v1/keys` (SD L632, `recovery_verifier?`, `password_verifier?` optional).

If a client changes the recovery wrap but omits the new verifier (a bug, or a modified client with pw_auth):
- The real new code unwraps but cannot enroll (`403 recovery_mismatch`).
- The old code still enrolls a device but cannot decrypt.

The same can happen between the password wrap, `auth.kdf` and `password_verifier`. The result is §3.14's "诚实客户端永远不会发出错误的 pw_auth" turning into the honest device locking itself out (423).

**Fix:** the server compares the wraps without keys:
- A changed recovery wrap requires a new `recovery_verifier`, and vice versa.
- A changed password wrap requires both a changed `auth.kdf` and a new `password_verifier`.

### P5 (low): Devices delete their identity on a server-asserted 401/403.

**Where:** §3.10 (SD L317 "删除身份记录"), §5.7 (SD L680 "删除身份").

An honest PITR restore, or a deploy that loses `devices` rows, makes every affected device delete its DSK identity. A single-device user without the recovery code then cannot get back into the cloud vault (local data is kept). A malicious server can do the same at will.

**Fix:** mark the identity "server says revoked / unknown" and stop syncing, but keep it until the user confirms. Retry with backoff.

### P6 (low): Server races (check-then-act windows).

**Where:** §5.2 / §5.3.

- Revocation is checked at authentication time, outside the write transaction. A PUT authenticated just before a revoke commits can land just after it.
- Enrollment expiry is described as "S 删除" (SD L222). Unless every state-transition `UPDATE` includes `AND expires_at > now()`, a request that has expired but not yet been deleted can still be approved.
- Revocation status is returned before the signature is verified (SD L523), which gives an unauthenticated oracle for "is device_id X revoked".

**Fix:**
- Re-check `revoked_at IS NULL` inside the same statement or transaction as the write.
- Include `expires_at > now()` in every enrollment and invite `UPDATE`.
- Verify the signature before answering `device_revoked`.

### P7 (low): Database error text can leak row values into provider logs.

**Where:** §5.6.

Postgres check or constraint violations log `DETAIL: Failing row contains (...)` with every column: bundle, verifiers, envelope, user_id. That lands in Supabase's Postgres logs and, if the app logs exception messages, in the app logs. This breaks "永不记录…bundle".

**Fix:**
- Validate everything in the app before writing.
- Never log driver exception messages; map them to error codes.
- Check the Supabase log-verbosity settings.

### P8 (low): The A4 guarantee is stated too strongly given forks.

**Where:** §1.2 A4 (SD L59 "轮换后新增/修改的数据它看不到，即使它与恶意服务器勾结").

A malicious server can hide the rotation from devices C, D, …, which keep writing under VK1, so the A4 holder can read those writes. A1 admits forks (SD L56), but A4 contradicts it.

**Fix:** reword to "for devices that have adopted VK2".

### P9 (low): The approver's state is unspecified when it is behind on keys.

**Where:** §3.2 M5 (SD L213), §3.9 R4.

An approver still on VK1 after a remote rotation (R4) cannot verify the latest bundle, which is MAC'd with VK2, and would send N VK1 or an unverified bundle.

**Fix:** approval and invite creation require the approver to be on the server's current vk_id with the bundle verified. Otherwise force R3 first.

### P10 (low): In "always" mode, edits stay local until the next unlock.

**Where:** §3.11 (SD L331), §4.7 (SD L442).

The outbox is written only after a network failure. In "always" mode the SW never holds VK and the popup closes within seconds, so each edit waits for the next popup open with a completed sync. That widens the window in which a profile wipe loses it.

**Fix:** after each local commit while sync is on, the page precomputes the outbox envelope (`rev = lastSyncedVersion + 1`) so the locked SW can push it fast-forward.

### P11 (low): Spec precision items, each small.

- **Envelope wire form.** State whether `envelope` travels as a JSON string or as an object. If it is an object, the server's re-serialization changes the byte count, and the "one metric" claim (SD L411, §10 #27) holds only by luck. The 16 KiB padding step currently leaves the largest legal envelope about 21 KB under the cap, so this cannot misfire today, but say it.
- **Bundle storage.** Store the bundle as raw text (verbatim) rather than `jsonb`. Then no server-side model round-trip (dropped unknown fields, number re-typing) can break the MAC for newer clients.
- **Transcript encoding.** Fix the encoding of dpk/epk in C and T (SPKI DER or raw uncompressed point) in the vectors.
- **Signed `host`.** It must be the configured API host, not the incoming `Host` header behind a proxy. `path?query` must be the raw request target.
- **Registration requests.** The signature does not bind the account token. A captured registration body can be replayed under another account's token (low value, but cheap to close by including the JWT `sub` in the signature input).
- **Device-name length.** `name_ct` length reveals the name length (up to 40 characters of "business-sensitive" names, C6). Pad it to a fixed size.
- **Same vaultId, different VK.** §3.5 does not cover this join case, which arises after `restoreBackup` on a fresh install. Use `mergeVaults` (same ids), not the added mode.
- **First-device code becomes void.** In §3.1, if step 4(b) creates a new local recovery code and step 7 then returns `409 vault_exists`, the device joins the existing vault and the code the user just saved opens nothing. The UI must say so and point to "验证恢复码".
- **Forward compatibility.** `parseEntry` rebuilds entries from known fields only (validate.ts L55–58), so unknown fields are dropped on merge and re-upload. Every future additive field therefore needs a `schemaVersion` bump, which pauses all older clients (`paused_newer`). Document this as a rule.
- **Invites.** The invite payload sits in PITR backups, and the code passes through the OS clipboard (history tools, the fingerprint browser's own clipboard sync). Use the existing clipboard-clear mechanism for invite codes, and add invites to the anti-fraud copy ("never send an invite code to anyone").

---

## Part C. What a profile thief gets (asked explicitly)

| Holder | Gets | Cannot |
|---|---|---|
| **Locked profile copy** (DSK in IDB plus local keyring; non-extractable is only a JS-API restriction, the key material is in the profile files) | A working device identity until revoked:<br>- latest envelope, bundle and all history (still password-bound, the same exposure as the local keyring);<br>- device list (encrypted names) and pending-request count;<br>- `respond` to requests (F9);<br>- writing undecryptable heads (F6);<br>- using up per-account budgets (F8);<br>- garbage self-rename. | Decrypt anything; approve, rotate, change keys, revoke others, delete (pw_auth). |
| **Unlocked profile** (VK in `storage.session`) | All of the above, plus:<br>- every seed now;<br>- every server history version within 30 days, opened via `keyring.previous`, including seeds purged within retention;<br>- arbitrary content pushes, limited only by the §4.4 guard (F16). | pw_auth operations. After revoke and rotate (plus a password change if the password may be known), it is locked out, except where a malicious server forks (P8). |

---

## Part D. Checked and found sound

**Enrollment cryptography (given P1's pinning):**
- The commitment covers devN, dpk_N, epk_N and n_N.
- T adds rid and devA, which S fixes before N reveals.
- The 32-byte nonce makes C hiding, and SHA-256 makes it binding.
- In either order of S's two sessions, the second SAS is uniform to S. That gives 10⁻⁶ per attempt for A.
- SAS bias: `2³² mod 10⁶ = 967 296`, so the most likely value has probability about 1.00004 × 10⁻⁶. Negligible.
- Reflection fails: S cannot commit to epk_A before it exists, and lacks esk_A.
- The payload and name AADs are domain-separated.
- Payloads cannot be replayed, because they are bound to h and to fresh ephemeral keys.
- KCI does not apply: no long-term keys enter the key exchange.
- §10 #2 (dpk_N in the commitment, plus `sig_pubkey_sha256` at approve) correctly closes the dpk-grinding attack.
- PITR copies of enrollment payloads are useless, because the ephemeral keys are gone.

**Unknown-key-share and identity misbinding:**
- dpk_N and devA are bound in both C and T, so the server cannot swap the identity N registers or the approver N believes it is talking to.
- One gap: T binds no account (`sub`) and no vaultId, and a new N has no expected vaultId. A malicious server could therefore cross-wire two accounts that belong to the same person.
- F1's confirmation code closes this. Adding the account `sub` to T is cheap extra hygiene.

**MV3 service-worker lifecycle:**
- A worker killed in the middle of a vault PUT converges, because dirty state is derived and the retry gets a 409.
- The web lock `sixkey-sync` is released when the worker dies.
- The 30 s alarm floor and the random first-run phase are handled.
- Debounce state that is lost on termination is rebuilt from the derived dirty flag.
- The one lifecycle-sensitive gap is the unknown outcome of key operations, covered in F2.

**Email-only attacker, honest server:** cannot get a trusted device without social engineering. N's number appears only after a real A's `respond`, and the attacker's SAS appears only on the attacker's screen. There is no server-selectable "skip SAS" path. A `has_vault` lie produces only a split vault.

**pw_auth offline exposure (C11, Q8):**
- The claim "no extra offline exposure" is correct.
- The salt is independent and the iteration floor is enforced on read (crypto/kdf.ts L36).
- PBKDF2 with 256-bit output is one block, so the cost per guess is the same as attacking the wrap.
- HKDF is one-way. Even if a forged bundle set `salt_auth` equal to the wrap salt, the server would learn `HKDF(KEK)`, not the KEK.
- The verifier is never given to unenrolled sessions.
- Caveats are in F14 (bearer value) and F13(b) (backups).

**Recovery auth:** `recAuth` uses a different HKDF info and salt from the recovery KEK (crypto/keyring.ts L168 against §2.2). The verifier hashes a 128-bit secret.

**KeyBundle MAC:** `canonicalJson` (vault/merge.ts L13–18) sorts keys and is recomputed from the parsed object, so storage key-reordering is harmless (but see P11 on raw storage). The previous-VK AAD and `rekey`'s re-wrapping of every older VK (keyring.ts L223, L263–269) match §2.2 and support the R3 continuity check.

**R2 password-wrap rule:** it does prevent lock-out by a forged password wrap. The residual cases are P3 and F7.

**Invariants I1–I9, checked against the code:**

| Invariant | Code location | Status |
|---|---|---|
| I1 | storage/format.ts L46 | ✓ |
| I2 | service/service.ts L105 | ✓ |
| I3 | storage/store.ts L457 (`tryOpen` current VK only) | ✓ |
| I4 | service.ts L233 | ✓ |
| I5 | crypto/keyring.ts L267 | ✓ |
| I6 | vault/merge.ts L71 | ✓ |
| I7 | format.ts L58, L83 and store.ts L226–234 | ✓ for parse and GC; `addSnapshot` missed, see F11 |
| I8 | vault/ops.ts L16 (`ContentPatch` has no `secret`) | ✓ |
| I9 | `setRecovery` stores only the wrap | ✓ |

**Session and lock handling:** `lockEpoch` is bumped by `RoutedSession.clear` (platform/session.ts L52–55), and `requireVk` honours it (service.ts L98), so a lock during sync aborts `applyRemote` as claimed. No network calls run under the store lock. Web locks are shared across contexts.

**Database writes:**
- The PUT CAS SQL is correct under READ COMMITTED: the second updater re-evaluates the WHERE clause.
- The `SELECT * FROM upd` column order matches the INSERT list.
- Rotate's double CAS is correct.
- A concurrent `PUT /v1/keys` and rotate is caught by the kver CAS.
- §4.5's "committed, response lost" handling converges for vault PUTs (unlike key operations, F2).

**Auth, logging and smaller items:**
- No refresh tokens in the extension (C1).
- The JWT checks and the `iat` step-up are correct.
- The log field list and the in-memory IP-HMAC rate limiting are consistent with D3 (apart from F13(c) and P7).
- Trailing-space padding is compatible with `deserializeVault` (validate.ts L94–96).
- `clampVault` moves all stamps of an entry together, so delete/alive status survives clamping.
- Inbox, outbox and staged material never rewrite a generation while locked (C8).

---

## Part E. Short report

- File: `docs/audit/internal-reviews/SYNC-DESIGN-REVIEW.md`
- Counts: **critical 1, high 3, medium 9, low 14** (27 findings).
  - Critical: F1.
  - High: F2, F3, P1.
  - Medium: F4, F5, F6, F7, F8, F10, F13, F15, P2.
  - Low: F9, F11, F12, F14, F16, P3–P11.
- The three findings that most change the design:
  1. **F1, two-way enrollment confirmation.** N must check a code that A displays only after a successful SAS check, before it trusts or uses the payload. Without it, a malicious server (and a squatter) gets the seeds of every joining device. It replaces the soft §3.5 gate.
  2. **F2, idempotent and reconciled key operations.** Add an `op_id` to `PUT /v1/keys` and `/rotate`, GET and compare on any unclear result, and never tell the user a recovery code is invalid before reconciliation. Without this, a lost response silently destroys the user's only recovery path.
  3. **F3 (with F4 and F5), the sync-state model.**
     - Replace `seq > lastSyncedSeq` with a {seq, checksum} lineage that a recovery event resets.
     - Pull on any version change, not just an increase.
     - Run the HLC on server-corrected time.
     - The current anchors silently stop uploading after a recovery, hang after a server rollback, and re-upload forever with a fast clock.

  Runner-up: F6(c), VK-bound write authorization (a write key stored in the KeyBundle and verified by the server). It is the only change that makes the server reject writes from key holders who lack VK.
