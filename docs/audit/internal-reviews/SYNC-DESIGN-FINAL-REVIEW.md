# Final review of SYNC-DESIGN.md (Phase 1 sync, revision 3)

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: the word
> "independent" removed from the heading and the reviewer line, repository paths updated to the current layout and
> absolute local paths shortened. Paths under `scratchpad/` were the reviewer's temporary working copies (probes,
> mutants, logs) and were **not retained**: a probe or mutant exists only as far as this record quotes it or as it was
> adopted into the test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these
> records: [`docs/audit/README.md`](../README.md).

Reviewer: final design review session, 2026-10-15. Review only: nothing in `extension/src/`, tests, `SYNC-DESIGN.md` or other docs was changed, nothing was committed.

**Version reviewed.** `docs/SYNC-DESIGN.md` last modified 2026-10-15 21:33, sha256 `d1b5d7ff…aa2437`, 1,139 lines. The file changed while this review was running: §9 (M7 row, owner-resources line) and §12 (Q6, Q9 now "decided") were edited. I re-read the changed regions. Every section a finding below cites was re-checked against the 21:33 text.

**Method.**
1. I reviewed the design against the real code first: `extension/src/core/{crypto,vault,storage,service,backup}`, `platform/{session,locks,idb-kv,chrome-kv,runtime}.ts`, `background/sw.ts`, `popup/App.tsx`, the e2e harness and specs, `docs/security/local-vault.md` and `docs/history/PLAN-zh.md` §4–7, §11, §15.
2. I wrote my own findings down (scratch file) before opening `SYNC-DESIGN-REVIEW.md`.
3. I then checked F1–F16 and P1–P11 one by one against the revised sections themselves, not against the §0.0 change log.

**Notation.** "§x" = SYNC-DESIGN.md section. Code paths are relative to `extension/`. Severity uses the scale from the first review:
- **critical**: breaks a stated confidentiality guarantee against an in-scope attacker in a common flow.
- **high**: realistic path to seed exposure, data loss or loss of the only recovery path, or a stated guarantee that is false in the recommended flow.
- **medium**: needs unusual conditions, causes liveness or integrity failures, or a stated guarantee is wrong.
- **low**: hygiene, spec precision, small attack surface.

"Blocks" names the earliest milestone that cannot be built correctly until the spec is fixed.

---

## 0. Verdict up front

**READY AFTER FIXES.**
- The cryptographic core is sound: commitment + SAS + CC, KeyBundle MAC and adoption rules, `pw_auth`, `K_write`, the recovery-code path, rotation and the R3 continuity check.
- No critical issue was found.
- Two high issues and six medium issues need spec text before the milestones they affect. All the fixes are small and most of them remove mechanism rather than add it.
- M0 can start now.

Counts: **0 critical, 2 high, 11 medium, 17 low** (30 findings).

---

## 1. Findings

### A. Protocol and cryptography (priority 1)

#### S1 (medium). The VK-encrypted DSK copy turns "profile copy + master password" into a live, invisible sync credential. §2.5 says "不削弱安全", which is overstated.

**Where:** §2.5 "为什么不削弱安全", §1.2 A3, §4.10.

**Before d2:** someone who receives a vendor-synced or teammate copy of `storage.local` without IndexedDB, and knows the master password, gets a *snapshot* of the seeds. To follow later changes they would have to enroll, which needs approval or the recovery code, is visible in the device list, and triggers the "new device" banner.

**After d2, failing sequence:**
1. A GoLogin cloud profile (storage.local synced, IDB not synced) is opened by a teammate on another machine.
2. They unlock with the shared password. `identity_missing` auto-restores the DSK from `sk_sync_cfg.enc`.
3. They now pull every future server version and can write (they have VK, hence `K_write`). The device list shows nothing new, because they share the original deviceId.
4. The only signal is the soft clone detector. It flags whichever copy polls second, which may be the legitimate user, and the copy holder can resolve it by forking, since they have `pw_auth`.

The §2.5 argument "拿得到 VK 的人本来就能在这台设备上使用它的凭据" is true for *this* machine but not for a copy on another machine. This is the d2 target environment.

**Fix (documentation and UX, no new mechanism):**
- State this in A3 and §2.5.
- In H8 and the §3.5 sharing warning, say that a sync-enrolled profile must not be vendor-synced or shared at all; the subset export (H2) is the path for those cases.
- When `forked` is reported, show the "吊销并保护" option next to "建立独立身份".

**Blocks:** nothing (doc only).

#### S2 (medium). The permanent `sensitive_locked` is a denial-of-service lever for anyone holding a copy of the device signing key, and it protects nothing.

**Where:** §3.14 失败计数, §5.3 `devices.sensitive_locked`, §5.5 (`pw_auth` 失败, 写入证明失败), §5.4 423 responses.

**Failing sequence:**
1. A single-device user's profile is copied (vendor sync, a teammate, a Kameleo clone). Profile copies are "常态" per A3.
2. The copy holder needs no password. They send five requests with junk `password_auth`, each signed with the copied DSK (same deviceId as the user's real device).
3. The user's own device is now `423` for rotate, change password, new recovery code, revoke others, approve and delete, "直到被吊销", and there is no unlock endpoint (F14).
4. The flow the user now needs ("吊销并保护" = revoke + rotate) is impossible from their only device. The only way out is revoke-self (no `pw_auth`), re-enroll with the recovery code, then rotate. A user without the recovery code is stuck.

The write-proof counter (§5.5: 10 failures per hour pauses that device's PUT for an hour) is the same lever applied to sync.

**Why it protects nothing:** the only parties who can sign as a device hold a profile copy. A profile copy contains the local keyring, so offline PBKDF2 guessing at the same cost is already available. The 5-try online cap does not slow such an attacker. (The research doc's F23 makes the same argument for local lock-out.)

**Fix, which also simplifies:**
- Keep the per-device failure counter and the "设备 X 多次输错主密码" banner.
- Replace the permanent lock with backoff: after 5 failures, 1 hour, doubling, capped at 24 hours. Reset on success.
- Drop the `sensitive_locked` column, the 423 code and the "敏感操作已锁定" marker.
- Drop the write-proof failure pause. Honest clients never fail write proofs, and the per-device PUT rate already bounds floods.

The same copy holder can also simply revoke the shared identity (S8).

**Blocks:** M4 (schema and error codes).

#### S8 (medium). Self-revoke needs no `pw_auth`, so anyone holding a copy of the profile can revoke the user's real device with one request.

**Where:** §3.14 ("不需要：…给自己改名、吊销自己"), §5.4 `POST /v1/devices/{id}/revoke` ("吊销他机另需 `pw_auth`"), §3.10 ("关闭同步 = 吊销自己").

A profile copy shares the honest device's deviceId and DSK. So "self" for the copy *is* the user's real device.

**Failing sequence:**
1. A vendor-synced copy or a clone, locked and without the password, sends one signed `POST /v1/devices/{own id}/revoke`.
2. The user's real device now gets `403 device_revoked` and goes to `rejected_by_server` (P5 keeps its data).
3. To get back into the cloud vault, the user must re-enroll through another device or the recovery code. A single-device user without the recovery code has lost cloud access for good. Local data is kept.

S2's backoff fix does not touch this path, and self-rename is the same lever with less impact.

**Fix:**
- Require `pw_auth` for self-revoke and self-rename. The honest "关闭同步" flow asks for the password once, the same UX as every other sensitive action.
- If the owner prefers to keep self-revoke password-free, say so in A3's "can" column and §10 as an accepted DoS.

**Blocks:** M4 (auth table, together with S2).

#### What a locked profile copy yields without the password (asked explicitly)

| Can | Cannot |
|---|---|
| Sign as the shared device until it is revoked: pull every envelope, all history and the **current** bundle. After a password change the copy can still fetch the *new* password wrap and brute-force it offline at PBKDF2 cost, so a password change alone does not evict it; revoke + rotate does. | Decrypt anything without the password. `sk_sync_cfg.enc` (the DSK copy and email) is AES-GCM under a VK-derived key. |
| See the encrypted device list (names are padded ciphertext) and the pending-request count. | Write the vault: `write_proof` needs `K_write`, which needs VK. |
| Rename and **revoke the shared identity**, which knocks out the real device (S8). | Any `pw_auth` operation: approve, respond, rotate, change keys, revoke others, fork, pause, delete. |
| Trip the per-device failure counters, which locks the real device's sensitive actions under the current design (S2). | Enroll a new device: that needs approval with SAS + CC, or the recovery code. |

#### S3 (medium). With sync on, the TOTP codes follow the server's clock within ±7 days, so a wrong or malicious server clock breaks every code on every synced device.

**Where:** §4.14 ("同步开启时，HLC、clampVault 的参考时间、TOTP 显示都用 `Date.now() + 偏移`", offset bounded "±7 天"), §4.2 `refNow`.

**Failing sequence:**
1. The server host's NTP fails, or a malicious server lies in `server_time` / `Date` by +40 minutes.
2. Every synced device shifts its displayed TOTP by 40 minutes. Every code is rejected, and the user is locked out of every 2FA-protected site.

Phase 0 guarantees that the authenticator works without any server. Sync should not let the server take the core function away.

**Fix:**
- Keep the corrected time for the HLC and clamping. That is what F5 needs, and `stampAfter` (`core/vault/ops.ts` L29–33) already makes local edits win on their own entries.
- Compute TOTP from the local clock by default.
- When the offset exceeds 15 s, show the existing banner with a one-tap "use corrected time for codes" that the user must choose, and bound that to, say, ±1 hour.

**Blocks:** M3 (engine time source).

#### S4 (low). F2 residual: reconciling by whole-bundle equality can still tell the user that a live recovery code is invalid.

**Where:** §3.6.0 (客户端对账), §3.8 P3.

**Failing sequence:**
1. Device A `PUT /v1/keys` (new recovery code `code2`, kver k+1). The server commits and the response is lost.
2. Before A reconciles, device B changes the password. B's pre-send check (§3.14) fetches A's k+1 bundle and builds k+2 from it, so `code2`'s recovery wrap is kept.
3. A's reconciliation sees k+2 ≠ its bytes, concludes "failed", and per §3.6.0 now says the new code is invalid. `code2` is the live code, and the user discards it.

The same happens for rotation if another device adopts VK2 and changes the password before A reconciles.

**Fix:** reconcile on the part that matters.
- "My recovery wrap (`iv` + `wrapped`) is present in the server's current bundle" → code2 is live.
- "My bundle's `keyring.vkId` is the server's `vk_id`" → the rotation landed.
- Show "本机生成的恢复码已生效" from that test, not from `bundle.by`, which the next writer overwrites.

**Blocks:** M1 (pure function, trivial).

#### S5 (low). Two key-handling steps are unspecified: proof of possession for the fork key, and where the extractable DSK lives before `sk_sync_cfg` is written.

**Where:** §4.10 / §5.4 `POST /v1/devices/fork` ("新公钥的持钥证明"), §2.5 ("生成时私钥必须可导出一次"), §3.1 steps 5–7, §3.2 N1/M7.

**Gap 1, fork:** the fork request is signed by the *current* DSK. Nothing proves possession of `new_sig_pubkey`.

**Gap 2, extractable DSK:** the SW signs with the DSK from IDB from N1 onwards, but the JWK backup is written only at M7 / step 7. Either the extractable JWK is held in tab memory across the whole enrollment, or it sits in IDB as extractable. Neither is stated.

**Fix:**
- Fork body carries `new_sig`, a signature by the new key over the same signature input.
- Generate the DSK extractable, write `sk_sync_cfg` (or keep the JWK in tab memory) before the first signed request, and import a non-extractable copy into IDB at the same step.

**Blocks:** M1 / M2 (one sentence each).

#### S6 (low). The recovery-code key update has no pre-send check, and `recovery_auth` failures are not counted.

**Where:** §3.3 step 5 (`recovery_auth` in place of `pw_auth`), §3.14 发送前检查 (assumes a password), §5.5.

**Gaps:**
- The §3.14 check unwraps the bundle with the *password*. The forgot-password user has none.
- §5.5 has no counter for `recovery_auth` failures on `PUT /v1/keys`.

**Fix:**
- Add "recovery variant: unwrap the bundle's recovery wrap with the entered code, then derive `recAuth`".
- Count `recovery_auth` failures in the same per-device counter.

**Blocks:** M1.

#### S7 (low, residual to document). `K_write` lives in plaintext in the database, so a read-only DB leak plus a locked profile copy gives write access.

**Where:** §2.1 (K_write 交给服务器是有意的), §10.

A backup or SQL-read leak gives every user's `write_key`. Combined with a DSK from a locked profile copy, the holder can compute valid write proofs. `K_write` changes only on VK rotation. This is weaker than "server compromise", which is the only case §2.1 considers.

**Fix:**
- Add this to §10 residuals.
- Include `write_key` in the M7 KMS layer alongside the bundle.

(The signature-based alternative from the first review would close it but adds a key pair; not worth it.)

**Blocks:** nothing.

### B. Data-loss invariants (priority 2)

#### D1 (high). "Every storage-recovery event clears `lastSynced`" has no mechanism. The obvious implementation can overwrite the server head with older data.

**Where:** §4.1 置空规则, §4.2 step 3 ("!needPull and dirty → 跳到 6"). Code:
- `core/storage/store.ts`: recovery writes in `recover()` L105–139 and `openVault` L443–449; `pushEvent` L467–474; `ackEvents` L489–494.
- `core/storage/format.ts` L35: `RETENTION.events = 20`.
- `popup/App.tsx` L443–447: the user acknowledges events.

The store only appends a user-facing event to `sk_events`. It knows nothing about `sk_sync_state`. The doc does not say who clears `lastSynced` or when.

If the engine learns of recoveries by reading `listEvents()`:
- the user can click "知道了" (`ackEvents`) before the engine runs;
- events beyond 20 are trimmed;
- `ackEvents()` with no ids clears all of them.

**Failing sequence (single device, or the only device holding the newest edit):**
1. `lastSynced = {10, c10}`. The user edits, the device commits c11 and uploads it: server v11, `lastSynced = {11, c11}`.
2. The active slot is damaged. `load()` → `recover()` picks the older good slot (c10) and pushes a `slot_fallback` event. `decrypt_fallback` and `snapshot_restore` behave the same way.
3. The popup shows "数据已恢复", and the user acknowledges it.
4. The next round: dirty (c10 ≠ c11), needPull false (11 == 11). The device uploads c10 **without merging**, as v12.
5. The edit from c11 is no longer in the live state anywhere. It survives only in server history v11 and expires with it after 30 days. That violates D5.

**Fix:**
- Give `VaultStore` an `onRecover` hook. Inside the store lock, and *before* any recovery write, it deletes `sk_sync_state.lastSynced` and `sk_sync_outbox` in one `storage.local.set`/`remove`.
- Recovery writes are: the pointer flip in `recover()`, `writeBoth`, the `transact` inside `openVault`, and `transact({overwriteLost})`.
- Clearing first is crash-safe because it is conservative.
- Never derive sync state from the user-facing event list.
- Add "recover → user acks → edit → sync" to §8.2.

**Blocks:** M2 (store) / M3 (engine).

#### D2 (medium). The outbox can undo D1's clearing. Concurrent pages can also write a stale outbox.

**Where:** §4.7 outbox.

**Sequence 1 (the outbox restores a stale `lastSynced`):**
1. Outbox `{base 10, checksum c11}` is pending.
2. A recovery restores c10 locally and `lastSynced` is cleared.
3. The SW pushes the outbox. Server v11 = c11 (good data). §4.7 then sets `lastSynced = {11, c11}` **unconditionally**.
4. The next round: dirty, no pull. c10 is uploaded without a merge, and c11 is overwritten, exactly as in D1.

**Sequence 2 (stale outbox):**
1. The popup commits c11 and the options page commits c12. Each writes the outbox *after* its commit, outside the store lock, so the popup's later write leaves `outbox = c11` while the local state is c12.
2. In "always" mode the locked SW pushes c11. c12 then waits for the next unlock.

No data is lost in this case, but P10's "上传不等下次打开" is defeated.

**Fix:**
- The D1 hook also deletes the outbox.
- An outbox 200 sets `lastSynced` only if `lastSynced ≠ null && lastSynced.version == outbox.base` (compare-and-set on local state).
- Write the outbox only if the current generation's checksum still equals the checksum it was computed for, or write it inside `transact`'s post-commit step.

**Blocks:** M3.

#### D3 (medium). Once a vault is over `MAX_ENVELOPE_BYTES`, it cannot be cleaned up, so "可清理恢复" is false.

**Where:** §4.3 大小 row ("本地编辑：同步开启时 `mutate` 提交前检查，超限抛 `too_large_for_sync`、不写入", and in the same cell "此状态下拒绝新增账户"), §0.0 F15 ("可清理恢复"), Q9 decision (relies on "可清理的兜底").

**Failing sequence:**
1. A merge produces 8.5 MiB. It is committed locally with status `too_large`.
2. The user tries to clean up:
   - moving entries to the trash *adds* bytes (`dhlc`), so it is rejected;
   - each single purge leaves the vault above 8 MiB, so it is rejected;
   - renames are rejected.
3. Only an all-at-once bulk purge that lands under the cap can succeed, and the UI only purges from the trash, which the user cannot fill.
4. Sync is paused permanently. The same cell says only *adds* are refused, so the spec contradicts itself.

**Fix:** the pre-commit check rejects only edits that **increase** the measured size. Any edit that shrinks or keeps the size is always allowed. Test: "over the limit → delete and purge back under → upload resumes" (the §8.2 item "清理后恢复" must exercise this path).

**Blocks:** M3.

#### D4 (medium). An unknown outcome of `init` or `complete` leads to a false "your recovery code is invalid" or an orphan device row.

**Where:** §3.1 steps 6–7, §3.2 M7, §3.3 step 4.

**Sequence (init):**
1. The first device's `POST /v1/vault/init` commits (vault + device row). The response is lost, the tab closes, or the SW is killed.
2. The identity stays `pending`. Retrying gives `409 vault_exists`.
3. §3.1 then says "刚才的恢复码只对本机原来的库有效，对已有的同步库无效". That is false: the cloud vault *is* this vault, with this keyring and the freshly saved recovery code.
4. The user may discard the only valid code (the F2 failure class), then has to join "their own" vault through the recovery code they were just told is invalid.

**Sequence (complete):**
1. `complete` commits and the response is lost.
2. The retry gets 410, and the UI shows "加入未完成".
3. Re-enrolling creates a second device row. The first row stays active forever, with its DSK still on this machine.

**Fix (the same raw-bytes rule §3.6.0 already uses):**
- `init` is idempotent: if `vault_id`, `device_id`, `sig_pubkey` and the bundle bytes equal what is stored, return 201 with the same result.
- On any unclear result of `init` or `complete`, the client first sends a DSK-signed `GET /v1/sync/status` as `Sixkey-Device: devN`. A 200 means "you are enrolled": finish the local steps.
- Only a confirmed foreign vault may trigger the "recovery code invalid" text.

**Blocks:** M1 / M4.

#### D5 (low). After a server rollback, version numbers are reused, so a device can fast-forward over a head it never saw.

**Where:** §4.1 `needPull ⇔ version ≠ lastSynced.version`.

**Sequence:**
1. D2 synced v91 (content X91).
2. PITR rolls the server back to v90. D1 merges and uploads a *different* v91 (Y91).
3. D2 sees 91 == 91 and does not pull. If dirty, it uploads without merging over Y91.

This self-heals when D1 syncs again, because the merge is monotone. If D1 is gone, its post-rollback merge survives only in history.

**Fix:** status returns `head` = SHA-256 of the stored envelope text (the server already validates it). Store it in `lastSynced`, and pull when `(version, head)` differs.

**Blocks:** M3 / M4 (one field).

#### D6 (low). The guard's two-step bypass is real, and §4.4's "要么进回收站，要么阻塞" is overstated.

**Where:** §4.4.

**Sequence:** a VK holder deletes N entries. They go to every device's trash with a non-blocking banner. Minutes later the VK holder purges them. They are "已在回收站", so this is again non-blocking. Every live copy is now cleared without any blocking confirmation.

Recovery from rolling and daily snapshots and from 30 days of history still works, and that is the real protection. No new mechanism is needed.

**Fix:** reword the last bullet of §4.4. Optionally make the banner for "purge of ≥3 entries trashed by a remote device within the last 24 h" use the danger colour.

**Blocks:** nothing.

#### D7 (low). Merge can still fail on entry count at the 50,000 parse cap, and the stuck state has no status.

**Where:** §4.3 条目数 row, `core/vault/validate.ts` L15/L80.

Honest use will not reach 50,000. A VK holder can, though. The 8 MiB cap bounds one envelope to roughly 30k minimal entries, but a local `too_large` vault plus a disjoint remote can exceed 50k. `applyRemote` must then refuse, because the re-load check fails (`service.ts` L232 pattern), and the device fails the same merge on every round.

**Fix:** map this to the same `too_large` status and pause, or state the residual. Do not raise the cap further.

**Blocks:** nothing.

#### D8 (low). The pin-repair rule after a crash between the keyring write and the pin update is missing (the test is specified, the rule is not).

**Where:** §2.5 写入顺序, §3.9 R3, §4.2 step 2.

**Sequence:**
1. R3's `transact` writes the VK2 keyring and the process crashes before the pin update. The pin is still VK1.
2. Step 2 sees the server `vk_id` VK2 ≠ pin VK1, and VK2 is not in `previous`, so it goes to `needs_password`.
3. Unlocking opens VK2 locally, but nothing says to update the pin, so the device loops.

**Fix:** at unlock, if `localKeyring.vkId ≠ pin` and the local keyring's `previous` contains the pin, set pin = `localKeyring.vkId`. §8.1 already requires the property.

**Blocks:** M2.

#### D9 (low). Joining replaces the local keyring, so the local pre-join snapshot history is dropped silently.

**Where:** §3.5 (different vaultId ⑤; same vaultId, different VK). Code: `service.housekeeping` L193–202 and `store.rewriteForKeyChange` L392–412 drop any snapshot whose VK is not current or in `previous`.

**Sequence:**
1. The user deleted an account on this profile three days ago; only a daily snapshot still holds it.
2. The user joins sync.
3. At the next unlock `hasStaleKeyMaterial` triggers housekeeping, and the snapshot under the old local VK is removed.
4. "找回" no longer offers that account.

After ⑤ the old local VK is gone, so every rolling and daily snapshot of the pre-join vault is dropped at the next unlock. `sk_prejoin` keeps only the latest state. Older deleted accounts that a snapshot could have brought back are lost.

**Fix:** either state it, or store the pre-join snapshots' plaintexts in `sk_prejoin` as well (under the cloud VK).

**Blocks:** nothing.

#### D10 (low). The page-run engine and the SW bridge both take the `sixkey-sync` web lock, so they can deadlock.

**Where:** §4.2 step 0, §4.9 ("每一次 GET /v1/sync/status … 都经过同一个函数并持有 sixkey-sync"). `platform/locks.ts` uses `navigator.locks`, which is not re-entrant across contexts.

**Sequence:** a page holds the lock for a round and asks the SW (via `sk-api`) to perform the status call. If the SW's status function takes the lock as §4.9 says, it waits for the page forever.

**Fix:** the context that runs the round takes the lock. The SW's transport function never takes it. Only SW-initiated polls take it. This becomes moot if T2 is adopted, because status calls then no longer touch the cursor.

**Blocks:** M5.

#### D11 (low). "关闭同步" and "移除同步身份" must also delete `sk_sync_cfg`.

**Where:** §3.10, §2.5 table row 2.

Deleting only the IDB identity leaves `sk_sync_cfg.enc`. At the next unlock `identity_missing` auto-restores the revoked identity, the server answers 403, and the device shows "服务器拒绝本设备".

**Fix:** both actions delete IDB identity, `sk_sync_cfg`, `sk_sync_state`, outbox, inbox and staged in one step. `sk_prejoin` is kept.

**Blocks:** M2.

### C. Complexity and zero tracking (priority 3)

#### T1 (medium). The KeyBundle stores exact client timestamps and the writing deviceId in plaintext on the server, which contradicts C14 and F13(c).

**Where:** §2.3 (`by`, `at`), and the keyring inside the bundle. Code:
- `core/crypto/keyring.ts` L59: `wrapVk` stamps `createdAt: now()` in ms on every wrap;
- `keyring.ts` L232: `retirePreviousVk` stamps `createdAt` on every previous VK.

The server keeps ms-precision timestamps of every password change, recovery-code change and rotation, plus `by` = the deviceId that did it. With PITR or backups this is a per-device security-action log. That is exactly what C14 ("服务器时间戳截断到小时") and the rejection of F6(b) ("每个版本记录写入设备 = 活动日志，违背 D3") set out to avoid.

**Fix:**
- When building a bundle for sync, truncate `at` and every `wraps[].createdAt` / `previous[].createdAt` to the hour. Pass an hour-rounded `now` in `ctx`.
- Keep `by`, which F2's UI needs, or replace it with a random per-operation tag if "which device" is not needed.

**Blocks:** M1 (known-answer vectors).

#### T2 (medium). Every status poll writes the database (clone cursor, 5-minute `last_seen_at`), and PITR/WAL turns that into a per-device activity log. The cursor also forces the trickiest lock rule.

**Where:**
- §4.10 软检测: the cursor changes on every status call;
- §5.3 `devices.cursor` and `last_seen_at` ("只存最新值，5 分钟粒度");
- §4.9 lock rule for every status call;
- §8.3 concurrency test.

"只存最新值" holds for the live table only. Each update is a WAL record with a commit time. With Supabase PITR enabled, the provider holds a time series of every device's polls (every 30 minutes and every popup open) for the PITR window. Even daily backups keep one sample per device per day.

The cursor exists only to detect clones, and the doc itself says undetected clones cause "不造成数据风险". The cursor requires:
- a request header that is not covered by the signature;
- a DB write per poll;
- a cross-context lock discipline;
- a fork endpoint, a UI state and three tests.

**Fix:**
- Exchange the cursor only on `PUT /v1/vault` and send it in the signed body. Writes already serialize under CAS and already write rows.
- Clones that never write are harmless. Clones that write are detected on their second write.
- `last_seen_at` becomes day granularity and is written only when the day changes.
- The §4.9 rule "every status call holds `sixkey-sync`" and the "两个并发状态查询" false-positive test can then be deleted.

**Blocks:** M4 / M6.

#### T3 (low). Tracking hygiene: small leftovers.

*Spec precision; no exploit sequence. Each item is a record that should not exist or is more precise than needed.*

**Fixes:**
- **`devices.revoked_by`:** no protocol step or screen uses it, and it records who revoked whom. Delete it.
- **`revoked_at`:** precision is unspecified. Truncate it to the hour like the other timestamps.
- **`enrollments.created_at`:** `default now()` at full precision, used only for "30 秒前发起". Truncate it to the minute; rows are deleted within 10 minutes anyway.
- **`GET /v1/time`:** used by no protocol step, since every response carries `server_time`. Delete it.
- **Supabase `create_user: true`:** an OTP request creates an unconfirmed `auth.users` row for any email anyone types. Add a daily cleanup of unconfirmed users older than 24 hours, or disclose it in PRIVACY.
- **Application logs:** they keep ms timestamps and route templates for 14 days. With few users that is linkable. Log time to the second and keep 14 days, or disclose.

**Blocks:** nothing.

#### Complexity audit: what to keep, simplify or remove

| Mechanism | Verdict |
|---|---|
| Commitment + SAS + CC | **Keep.** Two typed codes are the minimum for mutual confirmation with typing in both directions (see §3 below). |
| KeyBundle (MAC, kver, by, at, auth) | **Keep**; truncate timestamps (T1). |
| `pw_auth` + verifier + pre-send check | **Keep.** |
| Permanent `sensitive_locked`, 423, write-proof failure pause | **Simplify** to backoff + banner (S2). Removes a column, an error code and a UI state. |
| `K_write` / `write_proof` | **Keep.** It is the simplest mechanism that stops writes by DSK-only holders. |
| DSK in IDB + VK-encrypted copy + 4-state table | **Keep** (justified by GoLogin); document S1. |
| Clone cursor on every status call | **Simplify:** PUT-only cursor (T2). Removes the status-lock rule and a test class. |
| Enrollment pause (`enroll_paused_until`, `POST /v1/enroll/pause`, resume, recovery-path interplay) | **Optional removal.** One pending request per account session, OTP limits and 10-minute expiry already bound the flood. "拒绝全部" alone covers the UX. Owner's call. |
| Inbox (`sk_sync_inbox`) | **Remove or re-scope.** Marked "可选, M7", but §4.4 (`review_needed` "远端放 inbox") and §4.6 ("远端存 inbox") are M3 behaviours that depend on it. Simplest: `review_needed` stores nothing and re-fetches the head when the user presses [应用]. |
| History backtracking on an unreadable head | **Keep** (a few lines). |
| `min_client_version` | **Keep.** |
| `GET /v1/time`, `revoked_by` | **Remove** (T3). |
| Everything else (`sk_prejoin`, `different_vault` re-join, staged bundles, reconciliation, history retention) | **Keep.** |

Zero-tracking check:
- No IP is stored anywhere in the schema, and IP use in memory (daily HMAC key) is consistent with D3.
- UA and fingerprinting do not appear anywhere.
- The hidden activity records are T1 and T2 (and T3's small items).
- `vault_versions` at hour precision with no device column is fine and disclosed.

### D. Internal consistency (priority 4)

#### C1 (medium). Milestones and endpoints do not line up: "清除服务器历史" has no endpoint and no auth level, and the inbox is built later than the code that depends on it.

**Where:** Q5 decision; §6 O14 (built in M6, "§6 全部界面"); §9 M7 ("清除服务器历史"); §5.4 (no DELETE on versions).

**Clear-history:**
- M6's acceptance includes a button whose server side is scheduled for M7, after M6, and no API row exists for it.
- No auth level is stated. Server history is the safety net for D6 and for "找回" after a VK holder's purge, so a locked-copy thief with only a DSK must not be able to wipe it.

**Inbox:** the inbox (M7) is needed by M3's `review_needed`; see the complexity table.

**Fix:**
- Add `DELETE /v1/vault/versions` (device + `pw_auth`, keeps the head, idempotent) to §5.4.
- Build it in M4 and its UI in M6, or move O14's button to M7.
- Resolve the inbox dependency.

**Blocks:** M4 / M6.

#### C2 (low). RLS with no policies plus a non-owner `sixkey_api` role denies everything. "所有外键都指向 auth.users" is also inaccurate.

**Where:** §5.3 first paragraph.

In Postgres, a non-owner role without `BYPASSRLS` sees no rows on an RLS-enabled table with no policies. As literally specified, the API cannot read or write its own tables. Also, `vault_versions` references `sixkey.vaults`, not `auth.users`. It still cascades transitively, but the sentence is wrong.

**Fix:**
- Make `sixkey_api` (or a dedicated owner role) the table owner without `FORCE ROW LEVEL SECURITY`, or add `TO sixkey_api USING (true)` policies.
- Confirm in M4 that the cascade from an `auth.users` delete works with the chosen owner.

**Blocks:** M4 (it will fail on the first test anyway).

#### C3 (low). P6's "no write lands after a revoke" is not guaranteed by the SQL as written.

**Where:** §5.3 PUT CAS (`AND EXISTS (SELECT 1 FROM sixkey.devices d WHERE … revoked_at IS NULL)`), §8.4 test "吊销提交之后不会再有该设备的写入落地".

Under READ COMMITTED, the EXISTS sub-select reads the statement-start snapshot and takes no lock. A PUT whose statement started just before the revoke committed can commit after it, so the §8.4 test would be flaky.

**Fix:** inside the PUT and rotate transactions, run `SELECT 1 FROM sixkey.devices WHERE device_id=$6 AND revoked_at IS NULL FOR SHARE` first. It blocks behind a concurrent revoke and re-checks the updated row.

**Blocks:** M4.

#### C4 (low). Smaller contradictions, imprecisions and untested behaviours.

*Spec precision; no exploit sequence, except item 8, where untested behaviour is the risk.*

1. **Q6/Q9:** §11 still lists Q6 as "仍未决 … 推荐：M6 之前实测" and Q9 as "推荐 … 再在 M7 按上述规则实现" under "仍需所有者回答的问题". §12 (edited 21:33) marks both decided ("不做实测", "M7 条目取消"). §8.7 ("指纹浏览器实测见 Q6") and §10 #18 ("克隆本身见 Q6") still point to the test.
2. **Rate-limit windows:** per day ("10 次/天", "50 次/天") in §5.5, but §5.1 and §5.6 say counters have "TTL ≤ 1 小时". Pick one; in-memory day counters keyed by email are fine but must be stated.
3. **R3 third bullet:** "本地包裹打开了 … 而服务器有 MAC 有效的新密码包裹" is unverifiable when the server bundle is under a different VK, since VK1 cannot check a VK2 MAC. R4 also needs an explicit rule: in `needs_password`, try the server/staged bundle **first**, even if the local wrap opens (same-password rotation).
4. **P3's "自身 64 条上限的回收除外":** say exactly what is allowed: drop only the oldest entries, and only when the new list has exactly 64.
5. **§4.2 step 6:** "merged ≠ remoteRaw" must compare `canonicalJson` of parsed vaults (padding differs), not bytes.
6. **§4.2 step 1** omits `min_client_version` / `forked` that §5.4 returns.
7. **Forward compatibility:** I11 covers vault entries. Add the same rule for bundle fields: an older client building kver+1 must keep unknown bundle fields or refuse.
8. **Behaviour the test plan does not cover.** §8.1–8.6 contain nothing for the following, despite PLAN §13 rule 3 ("同步代码每次修改必带测试"):
   - **HOTP (§4.12):** pull before use with a 2 s timeout, commit the counter before showing the code, immediate upload, offline notice. Phase 1 is where HOTP generation ships, so a counter shown before it is committed is a real reuse risk.
   - **`different_vault` → "以云端为准重新加入", and the §3.5 join with an existing local vault:** the added-mode import, the "every local live account survives" check, and `sk_prejoin` creation and later re-import. §8.6 only joins empty profiles.
   - **"以本机为准修复云端" (§4.2):** the rotate-based repair after a rollback past a rotation.
   - **Device-name re-encryption at rotation (§2.4, §3.8 P3 `device_names`),** including revoked devices.
   - **S3's clock-offset bounds,** and **D3's cleanup-under-the-cap path.**

   Add one line each to §8.2 or §8.6.

**Blocks:** nothing (fix in the next edit).

### E. Phase 0.x hardening H1–H8 (priority 5)

#### H-a (high). As specified, H1 does not close the LevelDB-residue hole for restored or imported vaults, and that is the recommended path for shared and vendor profiles.

**Where:** §9.1 H1 ("`restoreBackup` 恢复出的设备密钥库立即要求设密码"; "了结 … LevelDB 残留问题"), §10 #56 ("已修复"), §9.1 H2 (the subset export is "共享/批量配置文件的路径"). Code:
- `core/service/service.ts` L379–391: `restoreBackup` → `createKeyring`, which creates a **device-key** keyring and writes it plus the backup's accounts to storage.local, a rolling snapshot and the IDB mirror;
- `service.ts` L154–162: `create` does the same with an empty vault.

**Failing sequence:**
1. The user exports "所选账户" (H2) for a vendor-synced team profile.
2. In the fresh profile they choose "从备份恢复" (welcome screen, `popup/App.tsx` L75).
3. `restoreBackup` writes the accounts under a device-wrapped VK. H1 then forces `enableMasterPassword`, which rotates the VK.
4. The device key and the device-wrapped envelope with **real seeds** remain as uncompacted LevelDB bytes in both `Local Extension Settings` and `IndexedDB`. This is the residue SECURITY.md documents and `test/regression/residue.spec.ts` reproduces.
5. The vendor sync uploads those files. Anyone with the copy decrypts the seeds without the password.

For `create()` the residue opens only an empty vault, which is harmless, but it still needs an add-gate on every add path (popup QR scan, options add, paste, GA migration, import).

**Fix (simpler than a gate):**
- `create(password)` and `restoreBackup(backup, password)` build the keyring with password + recovery wraps directly (`setPassword` + `setRecovery` on a fresh VK). A device wrap is never written.
- The welcome screen and the restore page ask for the new master password before writing anything.
- Keep a test-only helper that creates a legacy device vault for the fixture.
- Extend the residue test: restore from a backup in a fresh profile → scan profile files → no seed, no device key.

**Blocks:** H1 and H2 (not Phase 1).

#### H-b (medium). H6 reuses `sk_events`, which makes security records show up as "data restored" banners and evicts real recovery events.

**Where:** §9.1 H6 ("复用 `sk_events` 机制"). Code:
- `core/storage/store.ts` L467–474 and `format.ts` L35: a 20-entry ring;
- `popup/App.tsx` L443–447: every event is rendered as `recoveredTitle` / `recoveredBody(restoredTo)`;
- `store.ackEvents()` with no ids clears all.

**Failing sequence:**
1. Five wrong-password unlocks and two exports are recorded.
2. The popup shows "数据已从 {time} 恢复" for a failed unlock.
3. Twenty failed unlocks (a copy holder can cause them) push out an unseen `snapshot_restore`.
4. Clearing the security card also clears unseen recoveries.

**Fix:** a separate key `sk_security_log` (same tiny shape, own cap). The UI filters nothing. Recovery events stay exactly as they are; this matters for D1 too.

**Blocks:** H6.

#### H-c (low). The H1/H3/H5 test migration is larger than "change `startFresh` + one fixture".

*Planning gap; no exploit sequence. The risk is that `npm run verify` fails after H1 lands, or that the gate is put only in the UI to keep tests green.*

Affected tests, checked:
- `test/e2e/harness.ts` L52–56 (`startFresh` clicks "Start without a password"); used by most e2e and regression specs.
- `test/e2e/flows.spec.ts` L298–302: the language test asserts the en and zh text of the removed button.
- `test/e2e/flows.spec.ts` L138–169: "encrypted backup restores a fresh install" needs the new password step (H-a), and H3 adds re-entering the password before export.
- `test/regression/residue.spec.ts` L79–85: needs the legacy device-vault fixture (seed `chrome.storage.local` from the SW with a pre-built generation).
- H5's first-run question adds a step to `startFresh`.
- If the gate or `create(password)` lives in the service, as it should, 27 unit and regression call sites of `svc.create()` need a world helper:
  - `service.test.ts` 16;
  - `import-backup.test.ts` 2;
  - `enable-crash.test.ts` 2;
  - `write-read-mismatch.test.ts` 2;
  - `platform`, `clock`, `session`, `purge` and `store-misc` 1 each.
- i18n keys `welcomeStart` and `noPasswordNotice` become dead or legacy-only.

Safe before sync: yes. Every item is network-free and needs no new permission (`chrome.management.getSelf` needs none).

**Blocks:** nothing (planning).

#### H-d (low). Small issues in H2 and H4.

**H2:**
- The subset file carries the source's entry ids, ms HLC timestamps and the source's HLC device id. The recipient (a teammate) learns when each account was added or edited and can link files to one device. Since import re-creates entries in added mode anyway, export fresh ids and re-stamped HLCs.
- The acceptance criterion "再次导入更新后的子集不重复" fails for renamed accounts, because dedupe is by secret + issuer + label (`service.ts` L406–411). Either dedupe subset imports by secret alone, or relax the criterion.

**H4:** `installType` `admin` (enterprise force-install) should not trigger the "not from the store" banner.

**Blocks:** nothing.

---

## 2. Verification of the first review (F1–F16, P1–P11)

Each row was checked against the revised section text.

| ID | Status | Evidence in the revised text |
|---|---|---|
| F1 | **Verified fixed** | §3.2 M5–M7 and MUST 5: CC is shown by A only after the SAS match and an accepted `approve`; N uses nothing before CC matches. §3.5's yes/no question is deleted. "两边各只有一次" is rewritten. §8.1 includes "服务器冒充 A". I re-derived the bound: the server can compute CC(h1), but the real A displays CC(h2) only after SAS(h2) = SAS(h1), so N is deceived with probability ≤10⁻⁶. 6 digits (stronger than the suggested 4). |
| F2 | **Verified fixed** | Both stated sequences are fixed. §3.6.0: raw-bytes idempotency at "if_kver 落后一步", reconcile on network error / 5xx / timeout / 409, never "invalid" before reconciling; applied in §3.7 and §3.8 P3. Residual S4: a later key op by another device makes whole-bundle comparison report failure while the code is live. |
| F3 | **Claimed but not fixed** | Fixed part: `dirty ⇔ checksum ≠ lastSynced.checksum` is correct against the code (no-op `mutate` rewrites the same envelope, `service.ts` L230; the store snapshots only on checksum change, `store.ts` L279), and it fixes the original cloud-restore sequence. The clearing rule (§4.1) has no implementation path: the store only appends user-ackable events. See D1. The outbox can re-establish a stale `lastSynced`: D2. |
| F4 | **Verified fixed** | §4.1 `needPull` on "≠", §4.2 `base = st.version` with the head checked against it, rollback warning when `st.version < maxSeenVersion`. Residual ABA after rollback: D5 (low). |
| F5 | **Verified fixed** | §4.14 HLC on corrected time; §4.2 step 4 clamps both sides with one `refNow`; step 6 compares against the raw remote. Separate pre-existing issue: TOTP also follows the offset (S3). |
| F6 | **Verified fixed** | (a) §4.3 row 1 backtracks through history. (c) §2.2 / §5.2 / §5.3: `write_proof = HMAC(K_write, vaultId‖if_version‖checksum)`. The checksum covers the AAD (vaultId, vkId, rev), so the proof binds the exact envelope (`crypto/envelope.ts` L46). (d) A3 rewritten. (b) Rejected with a valid D3 reason. Residual S7 (DB leak + DSK). |
| F7 | **Verified fixed** | §2.5 pins `vkId` in IDB; §3.9 R3 continuity (`previous` must unwrap the pinned vkId); §4.13 cloud restore checks the pin; R1 never decides adoption by kver alone. Residual from d2, acknowledged in §2.5: where IDB is wiped on every stop, the pin degrades to "whatever the local keyring says", so a vendor-restored *stale* storage.local plus a malicious server plus a VK1 holder could keep the device on VK1. Acceptable; no local fix exists. |
| F8 | **Verified fixed** | §5.5: per-device buckets with a 20× account ceiling; 401/403/423 not counted; revoke and rotate exempt; one request per account session; "拒绝全部并暂停 24 小时"; OTP per (email, IP-HMAC) plus 50/day per email. The per-device lock is shared by clones and copies, which keeps a DoS lever: S2. |
| F9 | **Verified fixed** | §3.2 M2 and §5.4 `respond` require `pw_auth`; `handled_by` in the request list; O9 copy. |
| F10 | **Verified fixed** | §3.2 M7 and §3.3 step 4 write locally before `complete`; the device row is created at `complete`; `different_vault` offers "以云端为准重新加入". The unknown outcome of `complete` itself is not covered: D4. |
| F11 | **Verified fixed** | The `"sync"` kind is deleted. `ensureCurrentSnapshot` is a `transact` option, so it runs inside the store lock and uses the private `addSnapshot` correctly. It is consistent with `store.ts` L279–280: the new generation is snapshotted after commit. |
| F12 | **Verified fixed** | §5.7: a single auth-user delete with cascade, retryable. Caveat C2 (RLS and owner role; the "all FKs to auth.users" wording). |
| F13 | **Verified fixed** | (a) §4.4 and §7 say "until 10 later changes". (b) §3.6.1 step 5 and the rotate checkbox. (c) `vault_versions.created_at` is hourly. The same concern in other objects is reported separately: other server-visible timestamps are still precise (T1: bundle `at` and wrap `createdAt` in ms; T2: 5-minute `last_seen_at` plus a per-poll cursor in WAL; T3: `enrollments.created_at`, `revoked_at`). |
| F14 | **Verified fixed** | As scoped (partial acceptance): `unlock-sensitive` deleted; increment-before-verify SQL in §3.14; rename replay and static `pw_auth` listed as residuals in §3.14 and §10 #41. The request-bound key was declined, which I accept. |
| F15 | **Fixed but introduces a new problem** | Count part fixed. §3.13 / §4.3: the 5000 cap applies only on add, the parse cap is 50,000, and merges no longer fail at 5000. The byte-overflow recovery claim fails because the pre-commit size check blocks every cleanup edit (D3). The 50k cap is a remaining failure path (D7, low). |
| F16 | **Verified fixed** | §4.4 blocks only on `secretChanged` or a purge of a locally live entry; trash deletions are non-blocking with a banner. The text overstates the protection: two-step bypass, D6 (low). |
| P1 | **Verified fixed** | §3.2 MUST 1–6 match the four pinning rules. §8.1 runs the 4-bit variant against each strategy. Declining the server-side recomputation of h is fine. |
| P2 | **Verified fixed** | `localKver` removed; "adopted" is judged by content; keyring written before the pin; R3 always tries the server bundle. Pin-repair rule missing (D8, low; the test exists). |
| P3 | **Verified fixed** | R2 requires `previous` to be a superset and `auth` to change only with the password wrap. The 64-cap exception is imprecise (C4.4). |
| P4 | **Verified fixed** | §2.3: keyless consistency rules for both verifiers. Rotation correctly sends both verifiers and a new `auth` salt (§3.8 P3). |
| P5 | **Verified fixed** | §3.10 `rejected_by_server`, daily retry, removal only after user confirmation. Removal must also clear `sk_sync_cfg` (D11). |
| P6 | **Claimed but not fixed** | Two of three parts are fixed: Signature checked before "revoked" is revealed (§5.2), `expires_at > now()` on every enrollment UPDATE (§5.3). The in-transaction revocation check is an unlocked `EXISTS`, so a racing PUT can still land after the revoke commits (C3). |
| P7 | **Verified fixed** | Owner action at M8. §5.6: app-side validation, exceptions never logged, `log_error_verbosity = terse`. §8.4 log scan includes `DETAIL: Failing row`. |
| P8 | **Verified fixed** | A4 now says "对已采用 VK2 的设备". |
| P9 | **Verified fixed** | §3.2 M2, §3.9 last bullet, §3.14 pre-send check. |
| P10 | **Fixed but introduces a new problem** | §4.7: the outbox is written after every commit and the SW pushes it. New problems: a successful outbox push unconditionally re-establishes `lastSynced`, and concurrent writers can leave a stale outbox (D2). |
| P11 | **Fixed but introduces a new problem** | 9 of 10 items verified. Raw envelope and bundle text (§3.13, §5.3), SPKI DER and 65-byte points (§2.2), configured host and raw target (§5.2), `sub` in the signature input, 160-byte name padding (§2.4), same-vaultId merge (§3.5), forward-compatibility rule I11; the invite item is moot. The first-device "code invalid" message is also shown after a crashed `init` of the user's own vault (D4). |

Summary (27 rows):
- **22 verified fixed**, some with a low residual noted in the evidence: F1, F2, F4–F14, F16, P1–P5, P7–P9.
- **2 claimed but not fixed:** F3 (clearing rule has no mechanism), P6 (revocation race in the SQL).
- **3 fixed but introduces a new problem:** F15 (cleanup deadlock D3), P10 (outbox undoes the clearing, D2), P11 (false "code invalid" after a crashed `init`, D4).

---

## 3. Checked and found sound

**Enrollment.**
- Commitment C covers devN, dpk_N, epk_N and n_N.
- A pins (rid, devN, dpk_N, C) before `respond`; N pins (devA, epk_A) before `reveal`.
- In both orders of a two-session MITM, the second SAS is uniform to the server: no grinding is possible on epk_S (N's values are hidden behind C) or on the server's own commitment (A's epk_A arrives after it).
- 3 typed tries against one pinned SAS do not add attacker chances.
- CC has a distinct label (`enroll-confirm` vs `enroll-sas`). Under MITM, the real A displays CC(h2) only after SAS(h2) = SAS(h1), so N is safe at ≤10⁻⁶ even though the server can compute CC(h1).
- The payload is AES-GCM under ECDH(K, salt = h). A server relaying honestly cannot read or replace it.
- Labels and prefixes are domain-separated (`sixkey-enroll-commit|1|` vs `sixkey-enroll|1|`). Every `|`-joined field comes from a `|`-free alphabet.
- Bias of `uint32 mod 10⁶` is negligible.

**Typed in both directions is minimal.**
- A must verify before releasing VK.
- N must get out-of-band evidence that the *real* A verified, because the server can produce a payload N can decrypt under the MITM key.
- That needs one channel in each direction.

**`K_write`.**
- HKDF info `sixkey/v1/vault-write` is distinct from `sixkey/v1/vault-enc` (`core/crypto/vk.ts` L26), `vk-id`, `keybundle-mac`, `device-name`, `device-backup` and `kek-previous`.
- This matters concretely: WebCrypto's `deriveKey(AES-GCM-256)` and `deriveBits(256)` produce the same bytes for the same info, so equal labels would hand the server K_enc.
- Recommendation: the M0 vector file should assert that all labels are pairwise distinct.
- The server holding `K_write` learns nothing about VK, K_enc or K_mac (HKDF as a PRF). Integrity is not weakened, because the server could already write anything.
- The outbox carries only a proof bound to one (if_version, checksum), so a copy can only replay that exact fast-forward.

**`pw_auth`.**
- The salt is independent of the wrap salt, and the iteration floor and ceiling are enforced on read (`crypto/kdf.ts` L36). The offline cost per guess equals the wrap's; there is no extra exposure.
- The verifier is never sent to unenrolled sessions.
- The pre-send check means honest clients do not miscount.

**Recovery path.**
- `recAuth` (`HKDF(code, ∅, recovery-auth)`) is separated from the KEK (`HKDF(code, salt, kek-recovery)`, `keyring.ts` L168).
- The server cannot fake a bundle the user's code opens.
- Local `parseRecoveryCode` catches typos (12-bit check).

**Adoption rules.**
- A VK1 holder cannot pass R3 continuity after the pin moved to VK2: `previous` would have to contain VK2 wrapped under the attacker's key.
- R2 never drops a proven password wrap until the user proves the replacement.
- `rekey` re-wraps every older VK (`keyring.ts` L263–269), so the continuity check has the data it needs.

**Rotation.**
- One transaction with double CAS; `write_key` swapped and enrollments deleted in the same transaction; the new code is shown before submission (I5).
- Crash between P3 and P4 is handled by R3, and `housekeeping` finishes re-encrypting snapshots (`service.ts` L193–202).

**Merge under rollback.**
- `mergeVaults` is a per-register LWW with a total-order tie-break (`vault/merge.ts`). A rolled-back or old remote can never remove local data or resurrect a purge, because the purge has the newer `hlc`/`dhlc`.
- Local is never replaced by remote.
- `clampVault` moves each entry's stamps together (`ops.ts` L133–149).

**Never-replace-local.**
- The design keeps every remote change behind `applyRemote` → `transact` with `requireVk`, so a lock during sync aborts the write (`service.ts` L98–100, `platform/session.ts` L52–55).
- There is no whole-replacement code path.

**Storage and MV3.**
- `unlimitedStorage` is declared, so 8 MiB envelopes × about 19 local copies fit.
- Dirty state is derived, so a SW killed at any point converges.
- Web locks die with their context.
- The 30 s alarm floor and the random phase are handled.

**Logs and IP.**
- No IP column; in-memory HMAC with a daily key; uvicorn access log off; DB error verbosity terse; no Origin-based security decisions (d6 is correct for sideloaded IDs).

**Phase 0.x boundary.**
- H1–H8 add no permission, no network and no new crypto format.
- `chrome.management.getSelf` needs no permission.
- `parseEvents` does accept any kind (`format.ts` L87–90), but H-b explains why reusing it is still wrong.

---

## 4. What must change before implementation (blockers)

| # | Finding | Spec change | Blocks |
|---|---|---|---|
| 1 | D1 + D2 | Store-level `onRecover` hook clears `lastSynced` and the outbox before any recovery write; outbox success updates `lastSynced` only by local CAS; outbox written only for the still-current checksum | M2 / M3 |
| 2 | D3 | Size pre-check rejects only size-increasing edits | M3 |
| 3 | C1 | `DELETE /v1/vault/versions` with `pw_auth`, placed in M4/M6 (or move O14's button to M7); resolve the inbox dependency of `review_needed` | M4 / M6 |
| 4 | S2 + S8 | Replace the permanent `sensitive_locked` (and the write-proof pause) with backoff + banner; require `pw_auth` for self-revoke and self-rename (or document the accepted DoS) | M4 schema and auth table |
| 5 | T1 | Hour-truncate `at` and wrap / previous `createdAt` in sync bundles | M1 vectors |
| 6 | H-a | `create(password)` / `restoreBackup(backup, password)` never write a device wrap | H1 / H2 |

Also recommended before the milestone that touches them (not blocking): D4 (M1/M4), T2 (M4/M6), S3 (M3), S4 (M1), H-b (H6), C2 and C3 (M4), D8 and D11 (M2), D10 (M5).

M0 (contract and vectors) can start immediately. M1 can start once rows 5 and S4 are written in.

---

## 5. Short report

- File: `docs/audit/internal-reviews/SYNC-DESIGN-FINAL-REVIEW.md`. Reviewed `SYNC-DESIGN.md` at sha256 `d1b5d7ff…aa2437` (21:33 version).
- **Verdict: READY AFTER FIXES.** Blockers: D1+D2, D3, C1, S2+S8, T1, H-a (table in §4). All are small text changes; three of them delete mechanism.
- **Counts: critical 0, high 2, medium 11, low 17 (30).**
  - High: D1, H-a.
  - Medium: S1, S2, S3, S8, D2, D3, D4, T1, T2, C1, H-b.
  - Low: S4, S5, S6, S7, D5, D6, D7, D8, D9, D10, D11, T3, C2, C3, C4, H-c, H-d.
- **Prior review:** 22 of 27 verified fixed. F3 and P6 claimed but not fixed. F15, P10 and P11 fixed but introduce a new problem.
- **Top 3:**
  1. **D1 (+D2):** "a recovery clears `lastSynced`" has no mechanism. The store only emits user-ackable events, and an outbox push can re-establish a stale `lastSynced`. The next round uploads an older local state over the head without merging. Fix: a store-level hook that runs before the recovered write.
  2. **H-a:** H1 as written leaves device-key LevelDB residue containing real seeds whenever a fresh profile is set up by restoring a backup. That is the recommended H2 path for shared and vendor profiles, so the hole H1 claims to close stays open where it matters most. Fix: create and restore with the password up front.
  3. **S2 + S8:** anyone holding a copy of the profile shares the deviceId (vendor syncs and clones included), and without the password can do two things to the user's real device:
     - trip the permanent `sensitive_locked`, which on a single-device account blocks the revoke-and-rotate the user needs and adds nothing against offline guessing;
     - revoke it outright, because self-revoke needs no `pw_auth`.

     Fix: backoff + banner (removes a column, an error code and a UI state), and `pw_auth` on self-revoke and self-rename.
