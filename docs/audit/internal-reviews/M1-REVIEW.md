# M1 review: `core/sync/crypto`

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model
> (Anthropic's Claude) in a review session separate from the session that wrote the change, at the maintainer's
> request. It is **not** an independent third-party audit; none has been done yet. Edited since: the word
> "independent" removed from the first sentence, repository paths updated to the current layout and absolute local
> paths shortened. Paths under `scratchpad/` were the reviewer's temporary working copies (probes, mutants, logs) and
> were **not retained**: a probe or mutant exists only as far as this record quotes it or as it was adopted into the
> test suite. What became of each finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these records:
> [`docs/audit/README.md`](../README.md).

This is a code and crypto review of milestone M1 (`extension/src/core/sync/crypto/`, 20 files, 2,076 lines). It covers the tests `extension/test/unit/sync-crypto-*.test.ts` and the helpers `test/helpers/sync-vectors.ts` and `sync-keyrings.ts`. The code was reviewed against `docs/SYNC-DESIGN.md` revision 6, `contract/vectors/sync-v1.json` and `api/openapi.yaml`.

The review was done without changing anything in the repository. All reproductions and mutations ran in a scratch copy (see [Artifacts](#artifacts)). `docs/design/notes/M1-NOTES.md` was read only after the reviewer's own view had formed.

**Verdict: READY AFTER FIXES.**

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 7 |
| Low | 6 |

- **M2 can start now**, provided it adds one stored record (see F-06 and F-07).
- **M3 should start only after** these are fixed: F-01, F-02, F-03 and F-06, and the T-01 test gaps.
- **Before M5 wires the enrollment UI:** F-04, F-05 and F-09.

**Top 3 issues**

1. **F-01 (high): kver exhaustion.** One MAC-valid bundle at `kver = 2^53 − 1` makes every later bundle impossible to publish. That rules out every password change, recovery-code change, rotation and repair, so "revoke and protect" stops working permanently.
2. **F-02 (medium): a same-VK bundle can drop the whole VK history.** Under the M1-3 reading of the "exactly 64" rule, a VK holder can replace `previous` with 64 freshly generated real VKs.
3. **T-01 (medium): 11 of 38 plausible bugs survive the suite.** These include the two that would silently re-open F7 ("an old VK pulls the device back") and N27 ⑤ ("downgrade without confirmation").

## Baseline (reproduced)

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | 35 files, **537 passed, 1 skipped** (matches the stated baseline) |
| `python3 -I ../contract/py/test_contract.py` | 31/31 passed (stdlib and `cryptography`) |
| `node ../contract/tools/gen-vectors.mjs --check` | 24 groups recomputed, file matches |
| `python3 -I ../contract/tools/check_consistency.py` | 0 hard mismatches |

## Findings

"Confirmed" means a scratch test or a mutation run reproduces the issue (the names are listed under [Artifacts](#artifacts)). "Plausible" means the issue follows from reading the code but was not run.

| ID | Sev | Where | Status | Blocks |
|---|---|---|---|---|
| F-01 | high | `adoption.ts:19-23`, `keybundle.ts:151-154`, contract `Kver` | confirmed (REPRO-11) | M3, M4 |
| F-02 | medium | `adoption.ts:35-42` (M1-3) | confirmed (REPRO-4) | M3 |
| F-03 | medium | `bundle-eval.ts:63-75`, `138-158`; `presend.ts:50-53` | confirmed (REPRO-3) | M3 |
| F-04 | medium | `enroll-new-device.ts:182-184, 199-208, 164-177`; `enroll-approver.ts:189-191, 160-168, 207-222` | confirmed (REPRO-1, 3 cases) | M5 |
| F-05 | medium | `enroll-approver.ts:131, 233-240` | confirmed (REPRO-2) | M5 |
| F-06 | medium | `bundle-eval.ts:145`, `adoption.ts:19-23` | confirmed (REPRO-5) | M2 (one field), M3 |
| F-07 | low | `bundle-eval.ts:57, 73, 154`; `adoption.ts:21-22, 64` | confirmed (REPRO-7) | M2 (same field) |
| F-08 | low | `presend.ts:53-57` vs `:64`; `index.ts:18` | confirmed (REPRO-6, M22) | no |
| F-09 | medium | `enroll-approver.ts:92-107, 155-169`; `presend.ts:12-20` | confirmed (REPRO-10) | M5 |
| F-10 | low | `enroll-new-device.ts:140, 148, 211-217`; openapi `EnrollNewDeviceView` | confirmed (REPRO-9) | M4 contract |
| F-11 | low | Phase 0 `keyring.ts:269` (`rekey`); no M1 helper | confirmed (REPRO-8) | no |
| F-12 | low | `enroll-new-device.ts:78, 174` | confirmed (read) | no |
| T-01 | medium | tests | confirmed (11 surviving mutants, each killed by K1–K11) | M3 |
| T-02 | low | `sync-crypto-adoption.test.ts:345-486`, `sync-crypto-adversary.test.ts:198-230` | confirmed (read + M21/M23/M36) | no |

### F-01 (high): kver exhaustion disables every future key operation

**What happens.** R1 (`classifyKver`) accepts any `kver > maxSeenKver`, and N27 lets the server accept any `kver > if_kver`. The only bound is the safe-integer limit. A VK holder publishes the current keyring once, unchanged, at `kver = 9007199254740991`. A VK holder here is an A3 profile copy plus the password with an honest server (it has `pw_auth`), or any VK holder with a malicious server.

Every device then classifies that bundle as `in_sync` and sets `maxSeenKver = 2^53 − 1`. From then on:
- `publishKver(MAX, MAX)` silently returns `2^53`, which is not a safe integer (`keybundle.ts:153` does not check its result);
- `sealBundle` throws `non_integer_number`, and the server would refuse the bundle anyway.

So no device can change the password, change the recovery code, rotate, or repair. The S1 attacker (a copy plus the password, which shares the real device's identity) can no longer be evicted, because eviction needs a rotation.

**Demonstration (REPRO-11, `test/review/kver.test.ts`):**
- `evaluateSameVkBundle` returns `{kind: "in_sync", maxSeenKver: 9007199254740991}`;
- `preSendCheck({op: "rotate"})` returns `ok: true`;
- `publishKver` returns an unsafe integer;
- `sealBundle` rejects.

**Fix.** This is a spec change in §3.9 R1 and §2.3, plus M1 and M4 code.
1. `publishKver` throws when its result is not a safe integer.
2. Bound the jump. Add a contract constant such as `KVER_MAX_JUMP = 2^16`.
   - The server accepts only `if_kver < kver ≤ if_kver + KVER_MAX_JUMP`.
   - `classifyKver` rejects (as `reject: kver_jump`) a bundle with `kver > max(maxSeenKver, 1) + KVER_MAX_JUMP`.
   - Honest jumps are at most the rollback depth plus 1, so honest traffic is unaffected.
   - Exhaustion would then take about 2^37 publishes.
3. Add vectors for both bounds.

### F-02 (medium): the "exactly 64" exception lets a same-VK bundle drop all history

**What happens.** `previousCovers` accepts any number of missing local entries when the new list has exactly 64 unwrapping entries. This is M1-3's reading: "any count, including all of them". Because M1-2 counts only entries that really unwrap, a VK holder can generate 64 fresh VKs and wrap them under the current VK, which is cheap: HKDF plus AES only.

R2 then adopts a same-VK bundle whose `previous` no longer contains VK1. Old server versions and old snapshots under VK1 become unreadable on every device. §8.1's "no lost history VK (64 rule excepted)" holds only literally.

**Demonstration (REPRO-4):** `evaluateSameVkBundle` returns `{kind: "adopt"}`. The adopted keyring's unwrapped previous ids lack VK1, while the local one had it.

**Fix.**
- Honest same-VK operations (change password, change recovery code, same-VK repair) never change `previous`. So in R2 (same VK) the remote real ids must be a superset of the local real ids, with no exception.
- Keep the 64 exception only on the R3 other-VK path, where the bundle's author holds the new VK and therefore already controls everything after the rotation. Document that as a residual.
- Change `adoption.ts:39-41` (pass a `sameVk` flag), the `previousCovers` table test, and the §3.9 R2 wording.
- The same-VK containment check runs in **three** places, and all three must change:
  1. `evaluateSameVkBundle` (`bundle-eval.ts:71`);
  2. `afterRemote` when the opened VK is the pinned or local one, i.e. the R3 same-VK unlock (`bundle-eval.ts:153`);
  3. the `decideSameVk` call in `preSendCheck` (`presend.ts:68`).

  Patching only the first leaves the same-VK unlock and the pre-send check accepting the 64-fresh-VK bundle. Give REPRO-4 and K10 a same-VK unlock variant and a pre-send variant.

### F-03 (medium): adoption never compares the bundle's vaultId with the local one

**What happens.** `passwordWrapSame` is canonical-JSON equality of the two wrap objects (`bundle-eval.ts:72`). A wrap object contains method, vkId, kdf, iv, wrapped and createdAt, but not vaultId. The wrap's AAD does bind `keyring.vaultId` (`keyring.ts:49-51`).

A VK holder can copy the local wraps verbatim into a keyring with `vaultId: "evil-vault-0001"` and MAC it. R2 then judges the bundle `adopt`, and its password wrap no longer opens with the proven password. Nothing in `evaluateSameVkBundle`, `afterRemote` or `preSendCheck` compares `bundle.vaultId` with `local.vaultId`.

The damage is contained today by Phase 0 I1: `checkGeneration` refuses `envelope.vaultId ≠ keyring.vaultId` (`format.ts:46`, `store.ts:272`). As a result, the M3 adoption `transact` would throw on every sync round instead of locking the user out. Even so, the verdict is wrong, the facts it rests on are unsound, and the R2 promise ("drop a proven wrap only after the replacement is proven") is enforced only by accident.

**Demonstration (REPRO-3):**
- the verdict is `adopt`;
- `unlockWithPassword(bundle.keyring, P)` fails with `unwrap_failed`.

**Fix.**
- Reject with a new reason `wrong_vault` when `bundle.vaultId ≠ local.vaultId`, in `evaluateSameVkBundle`, `afterRemote` and `preSendCheck`.
- When the local keyring is null, pass the expected vaultId in from the identity or `sk_sync_cfg` owner.
- Add a test.

### F-04 (medium): `abort()` during an in-flight transition is overwritten

**What happens.** `#busy` serializes transitions, but `abort()` bypasses it. `#fail` sets `phase = "failed"` and drops the keys, and the running transition then resumes and writes its own phase. Three cases were reproduced by calling `abort` from inside a `crypto.subtle` call (REPRO-1):

| Machine | Abort during | Result |
|---|---|---|
| Approver | `buildApproval` (payload encryption), user pressed Cancel | Phase ends as `approving` with `failure: "cancelled"`. The VK-bearing approve body is returned, and `approveAccepted()` still yields a CC. |
| New device | `submitConfirmationCode` (payload decryption), request rejected | Phase ends as `accepted` with `failure: "rejected"`, and the keys are returned. |
| New device | building the reveal, request expired | Phase ends as `showing_sas` after the terminal abort, so a SAS is shown for a dead request. |

This breaks the "every failure is terminal" structure that the MUST 3 and MUST 6 comments claim. It also makes the user's Cancel on the approver unreliable. When the abort lands before `#esk` is consumed, the transition instead throws a `TypeError`, and the failure reason is overwritten to `invalid_view`.

**Fix.**
- Compute each transition into local variables.
- Commit them in one synchronous block at the end, guarded by `if (this.#phase !== <phase at start>) return { kind: "failed", reason: this.#failure! }`.
- Or keep an epoch counter that `#fail` bumps and `#run` checks after `await fn()`.
- Add the REPRO-1 cases as regression tests.

### F-05 (medium): an approver poll racing the approve response fails the request as "tampered"

**What happens.** In phase `approving`, `onPoll` calls `#sameReveal`, which requires `state === "revealed"` (`enroll-approver.ts:236`). The race:
1. The server commits revealed→approved.
2. The page's 2-second poll (§4.8) lands before the approve response has been turned into `approveAccepted()`.
3. The machine fails as `tampered` with a "possibly tampered" alarm.
4. `approveAccepted()` then throws `enroll_state`, so the CC is never shown.

N is stranded until the request expires.

**Demonstration:** REPRO-2.

**Fix.**
- In `approving`, treat `state: "approved"` with the same pinned values as `{kind: "wait"}`, or as a signal that approve was committed.
- `approved` in `verifying` or `sas_ok` stays unexpected.
- M5 should also not poll while approve is in flight.

### F-06 (medium): a normal cloud restore triggers the "older key state" confirmation

**What happens.** With the local keyring lost but the IDB identity intact (§4.13), `afterRemote` classifies with `sameKeyring = false`, because there is no local keyring to compare (`bundle-eval.ts:145`). The current bundle, at `kver == maxSeenKver`, is therefore `keys_behind`.

The user is asked "this password only opens an older key state; adopting it rolls this device back to the old password and recovery code" during an ordinary restore. Routine prompts train users to click "adopt anyway", which is exactly the N27 ⑤ protection against a replayed older bundle.

**Demonstration (REPRO-5):** `unlockWithSync({local: null, remote: <bundle at kver 4>, maxSeenKver: 4})` returns `confirm_older`.

**Fix.**
- M2 stores, next to `maxSeenKver` in the IDB identity, a digest of the last adopted or seen bundle (SHA-256 of its raw text, or of canonical keyring plus auth).
- `classifyKver` uses that digest when the local keyring is absent.
- Name the field in §2.5. It is the same record M1-1 asks for (see F-07).

### F-07 (low): the "auth changes only with the password wrap" rule is skippable and does not cover auth-only changes

**What happens.** `localAuth` is optional, and the rule is skipped when it is absent (M1-1). That is the default, because no stored record holds it yet.

Separately, a bundle that changes only `auth` has the same keyring and so is classified `in_sync`. It never reaches `decideSameVk`, even when `localAuth` is supplied (REPRO-7). The §8.1 "只改 auth 的" case is thus effectively unenforced at the M1 layer.

Impact is limited:
- an honest server refuses such bundles by P4;
- a malicious server plus a VK holder only gains a `pw_auth` mismatch, a denial of service it already has.

**Fix.**
- Make `localAuth: BundleAuth | null` a required field, so callers must decide.
- Source it from the F-06 record.
- In the `in_sync` branch, a known `localAuth ≠ bundle.auth` is `reject: auth_without_password`.

### F-08 (low): `preSendCheck` classifies before it checks the MAC; `classifyKver` is public

**What happens.** M1-11 says "a same-VK bundle is classified only after its MAC verifies". `preSendCheck`, however, gates on `keys_behind` (`presend.ts:53-57`) before the MAC check at `:64`.

A server that breaks the MAC of a real bundle (for example by lowering its kver) gets `change_password` refused as `keys_behind`, not `bad_mac` (REPRO-6). The UI then points at the repair path for a forged bundle. `classifyKver` is also exported from `index.ts:18`, so M3 can classify unverified bundles. Mutation M22, which moves the MAC check after classification in `sameVkVerdict`, survives the suite (see T-01).

**Fix.**
- In `preSendCheck`, verify the MAC before classifying:
  - for the same VK, with `i.vk`;
  - for an older VK, with the `Vk` object that `unwrapPreviousVks` already returns.
- Drop `classifyKver` from the public index.

### F-09 (medium, API ergonomics): approval is not bound to the pre-send check

**What happens.** `startApproval` and `buildApproval` accept any MAC-valid bundle text for the VK (REPRO-10 hands out an older genuine bundle). Nothing proves that `preSendCheck({op: "respond" | "approve"})` ran, that the bundle is the server's latest, or that the device is not `keys_behind`. N27 blocks `approve` in `keys_behind` and §3.2 M5 requires "the bundle M2 fetched and verified", but both are enforced only by caller discipline.

In addition, `preSendCheck` takes a parsed `KeyBundle` while `buildApproval` takes raw text, so the two can diverge.

**Fix.**
- `preSendCheck` takes the raw text, parses it itself, and on success returns a branded `VerifiedServerBundle {raw, bundle, vk, op, keysBehind}`.
- `buildApproval` (and ideally `startApproval`) requires that object, with `op` in `{respond, approve}` and `keysBehind === false`.

### F-10 (low): the new device requires the approver fields in every later poll

**What happens.** After pinning, `#samePinned` treats a poll without `approver_device_id`/`approver_epk` as `tampered` (REPRO-9). `EnrollNewDeviceView` and §5.4 mark both fields as optional, while MUST 2 only says that a *different* value aborts. This is an interop trap for M4.

**Fix.** Either the contract says both fields are present in every state from `responded` on, or N ignores absent fields and aborts only on a present, different value. The first is simpler.

### F-11 (low): no helper caps `previous` at 64

**What happens.** Phase 0 `rekey` appends without a cap (`keyring.ts:269`). The 65th rotation produces a keyring that `validateKeyring` rejects, so `sealBundle` throws (REPRO-8). §3.8 says that past 64 entries only the oldest are dropped, but M1 offers no function that does this.

**Fix.** Add `capPrevious(keyring)`, which drops the oldest entries by `createdAt` then `vkId`, the same order `previousCovers` uses. Use it in the rotation builder.

### F-12 (low): dead field holding the VK

**What happens.** `NewDeviceEnrollment.#keys` is written at `:174` and never read. It keeps the VK reachable from the machine after acceptance.

**Fix.** Delete it.

### T-01 (medium): mutation survivors

38 plausible bugs were applied one at a time to a scratch copy of the source, each run against the whole suite. **27 were killed and 11 survived.**

| # | Mutation | Result |
|---|---|---|
| M01 | N: drop `P.vaultId == bundle.vaultId` (§3.2 M7) | **survived** |
| M02 | N: drop `P.approver == pinned devA` | **survived** |
| M03 | N: do not verify the bundle MAC inside P (§3.2 M7) | **survived** |
| M04 | A: `buildApproval` drops `verifyBundleMac` (keeps vkId) | **survived** |
| M05 | A: `#sameReveal` ignores the nonce | **survived** |
| M06 | `sealBundle` self-check in read mode (no N16 alignment, no auth-salt rule) | **survived** |
| M07 | shape: drop `wraps.length === 2` | killed |
| M08 | shape: drop the deviceKey check | killed |
| M09 | MAC input excludes `auth` | killed |
| M10 | SAS and CC tags swapped | killed |
| M11 | A: commitment check skipped | killed (vectors, grind adversary) |
| M12 | A: CC computed and readable before approve is accepted | killed |
| M13 | `classifyKver`: `>` becomes `>=` | killed |
| M14 | `realPrevious` returns listed entries (undo M1-2b) | killed |
| M15 / M16 | reflection check removed (A / N) | killed |
| M17 | signing input omits `sub` | killed |
| M18 | `keys_behind` treated as an adoption candidate | killed |
| M19 | K_enroll IV reused across seals | killed |
| M20 | `verifyInput` accepts DER (converted to P1363) | killed |
| M21 | **R3 continuity by listed ids instead of unwrapped ones** | **survived** |
| M22 | `sameVkVerdict` classifies before the MAC check | **survived** |
| M23 | **R3 never checks the remote bundle's MAC** | **survived** |
| M24 | N: MUST 2 pin not re-checked after reveal | killed |
| M25 | N: payload change while confirming ignored | killed |
| M26 | "exactly 64" relaxed to "≥ 64" | killed |
| M27 | A: MUST 4 broken (a new reveal recomputes SAS_A and resets attempts) | killed (adversary band and unit test) |
| M28 | N: CC comparison skipped | killed |
| M29 | write-proof input omits `if_version` | killed |
| M30 | HMAC key without an explicit length (512 bit) | killed |
| M31 | shape: `bundle.vaultId` vs `keyring.vaultId` dropped | killed |
| M32 | `preSendCheck`: `keys_behind` gate removed | killed |
| M33 | `preSendCheck`: R2 checks (previous, auth) skipped | **survived** |
| M34 / M35 | SAS / CC attempts unlimited | killed |
| M36 | R3: `previousCovers` ignored at unlock | **survived** |
| M37 | D8 pin repair without proof | killed |
| M38 | approver skips the §2.4 re-check of the claimed name | killed |

What the survivors that matter would open:

| Mutant | What survives the suite | Security effect |
|---|---|---|
| M21 | A revoked VK1 holder's VK1 bundle that lists the pinned VK2's id over garbage bytes is **adopted**. | F7 is re-opened. |
| M23 | An old genuine bundle with its kver bumped (MAC broken) is **adopted** without the N27 ⑤ confirmation. | Silent downgrade to the old password and recovery code. |
| M22 | An unauthenticated bundle raises `maxSeenKver` to 10^15. | Key operations blocked until a repair at that value. |
| M33, M36 | Pre-send and unlock no longer refuse a history-dropping bundle. | VK history loss. |

None of the §3.2 M7 payload checks are tested (M01–M03).

**Fix.** Add the twelve tests in `killers.test.ts`: a control K0 plus K1–K11, one for each survivor. All twelve pass on the reviewed code, and each of K1–K11 fails its mutant. Add the REPRO-1, REPRO-2 and REPRO-11 cases as regression tests once F-01, F-04 and F-05 are fixed.

### T-02 (low): where the property tests stop

**Adoption model.** The fast-check adoption model (`sync-crypto-adoption.test.ts:345-486`) and the N27 model drive the production *deciders*, but re-implement the orchestration in the test. They never call `evaluateSameVkBundle` or `unlockWithSync`. So bugs in how `bundle-eval.ts` gathers its facts are visible only to the handful of example tests: M21, M23 and M36 survive, and F-03 and F-06 are invisible to the model because it abstracts vaultId and "local lost" away.

**Hash-level trial.** The 10^5 hash-level trial (`sync-crypto-adversary.test.ts:198-230`) measures how often `SHA-256(tag‖h) mod 10^6` collides for two independent random transcripts. That is a property of SHA-256, not of the protocol.
- Its expected count is 0.1.
- A random seed would catch a 5-digit regression with probability 1 − e^-1 ≈ 63%. The test is seeded, so its result for any given regression is fixed: it catches it or it does not.

It is harmless, but the protocol evidence lies elsewhere (next section).

**Fix.**
- Add an example per fact source, as in K7, K9 and K11.
- Optionally, run a small number of fact-level sequences through `unlockWithSync` with cheap keyrings, for example PBKDF2 at 1 iteration through an injected KDF in a test-only path.

## The adversary simulation's statistics

The simulation is valid for what it claims, and it would detect a broken protocol or implementation.

**It is deterministic.** Ephemeral keys come from seeded scalars, and nonces and IVs from a seeded stream, so the counts are fixed and nothing can flake.

**The bands are right.**
- With 4-bit codes, a single uniform guess wins with probability 1/16. Over N = 1600, the ±4σ band is [61, 139].
- If MUST 4 were broken, three independent guesses would win with probability 1 − (15/16)^3 ≈ 17.6%, about 282 of 1600, well outside the band.
  - **M27 is killed by this band.**
- For N to accept the fake vault, both the SAS and the CC must collide: about 1/256, with the bound N/256 + 4σ = 17.

**Ablation and mutation evidence.**
- The ablation (epk_A known before C′) wins at least 190 times in 200, which shows the harness *can* see a win.
- Mutations M11 (no commitment check), M27 (MUST 4) and M28 (no CC check) are all killed by the adversary tests.
- The harness therefore detects a broken implementation, not only a broken model.

**Limits.**
- The harness exercises the strategies it codes: honest commitment, grinding, re-reveal and ablation. It is not a proof of optimality.
- The full-length runs (2000 sessions, expected wins 0.002) have negligible power on their own. The SAS and CC known-answer vectors are what pin the code length.

**Code bias.** `u32 mod 10^6` gives a maximum probability of 4295/2^32 ≈ 1.00002 × 10^-6, so the bias is negligible.

## M1-2b and the other ambiguity resolutions (goal 3)

**M1-2 and M1-2b are sound on their own.**
- **M1-2 (remote side):** counting only entries that unwrap is strictly stronger than counting listed ids.
- **M1-2b (local side):** a local entry that does not unwrap under the local VK held no usable key, so not requiring it loses nothing.
  - When the local VK is unknown, the listed entries are used, which is stricter.
  - In `afterRemote`, the "local VK" is looked up by id among the VKs the remote bundle yields. A wrong one would need a 2^64 second preimage on the 64-bit `vkId` (see S-3).
- No downgrade or history-loss path comes from M1-2b. The history-loss path comes from **M1-3** combined with M1-2 (F-02).

| Note | Assessment |
|---|---|
| M1-1 | The resolution "skip when absent" is unsafe as a default. Make `localAuth` required (F-07), store it (F-06). |
| M1-3 | **Unsafe** (F-02): restrict the exception to the other-VK path. |
| M1-4 | `respond` blocked with `approve` in `keys_behind`: sound and conservative. |
| M1-5 | Repair refused when not behind: sound. A forged "behind" bundle still stops at `bad_mac`. |
| M1-6 | Auth salt ≠ wrap salt checked on upload only: fine, since no security property relies on it at read time. The rule is not tested, though (M06). |
| M1-7 | Clients reject non-integer number tokens: sound (fails closed). |
| M1-8 | Unknown members of P are ignored: sound, because P is authenticated under K and gated by the CC. |
| M1-9 | Device-backup plaintext layout: fine, local only. |
| M1-10 | Recovery-wrap fingerprint layout: fine, local only. |
| M1-11 | Right rule, but not followed by `preSendCheck`; `classifyKver` is public (F-08). |
| M1-12, M1-13 | Seeded simulation and hash-level shortcut: valid as described (see the previous section). |
| M1-14 | Malformed input costs no attempt: sound, since only the user types codes. |
| M1-15 | `unexpected_state` and `reflected_key`: sound. Note F-05: `approved` while `approving` is *expected*, not unexpected. |

## Checked and found sound

**Commitment, transcript, keys and codes (§3.2)**
- C is built from exactly `devN | b64u(dpk_N) | b64u(epk_N) | b64u(n_N)` under its tag.
- T has the exact field order and alphabet, and both T and C are SHA-256.
- Z is ECDH `deriveBits(256)`. K_enroll is HKDF(Z, salt = h, `sixkey/v1/enroll-key`), non-extractable AES-256-GCM, and Z is wiped after use.
- SAS and CC are `uint32be(SHA-256(tag ‖ raw h)[0..4]) mod 10^6`, zero-padded to six digits, with distinct tags. Their vectors match.
- The payload and reveal-name AADs use `b64u(h)`. `sig_pubkey_sha256 = SHA-256(dpk_N)`.
- The approve `name_ct` is re-encrypted under K_name with the devname AAD.
- The reveal name is padded to 160 bytes, so the wire value is 188 bytes, and it is re-checked with the §2.4 rules on A.

**MUST rules (§3.2)**
- **MUST 1:** (rid, devN, dpk_N, C) are pinned at `start` and re-checked on every poll.
- **MUST 2:** (devA, epk_A) are pinned at the first `responded` and the SAS is computed once.
- **MUST 3:** there is no restart path (a test asserts the method set).
- **MUST 4:** one SAS_A is used for three attempts, with no new ephemeral key.
- **MUST 5:** the CC exists only in `approved`. N stores the payload as an opaque string until the CC matches.
- **MUST 6:** the ephemeral key is dropped once K is derived, and K after use, apart from F-04.
- Illegal calls throw `enroll_state` without changing state, and server states ahead of this side abort.

**KeyBundle (§2.3)**
- The MAC covers every member except `mac`, including unknown ones.
- Domain separation: tag prefix plus canonical JSON (sorted keys, self-delimiting, integers only), so no length-prefixing is needed. Duplicate JSON keys resolve last-wins in both TS and Python.
- HMAC keys are 256 bits explicitly. Verification uses `subtle.verify`, so it is constant-time.
- Every leaf is MAC-covered (property test, and M09 killed).
- The shape rules hold: exactly the password and recovery wraps with the right KDF names, no device key, `vaultId` equal to `keyring.vaultId`, and safe times. Upload mode adds hour alignment and the auth-salt rule.
- The raw text is kept for idempotent retries. `requiredVerifiers` implements P4.

**Write proof, pw_auth, recAuth, signatures**
- **K_write and write_proof:**
  - The HKDF label is distinct from `vault-enc` (the WebCrypto hazard vector is checked).
  - The proof binds `vaultId`, `if_version` and `envelope.checksum`. Phase 0 computes the checksum as `SHA-256(sixkey-vault|1|vaultId|vkId|rev ‖ iv ‖ ct)`, so the proof binds the exact envelope.
  - Method, path, timestamp and body are bound by the request signature, not by the write proof, as §5.2 specifies.
- **pw_auth and recAuth:** the §3.14 and §2.2 constructions, NFKC for the password, KDF bounds enforced, and the intermediate bytes zeroed.
- **Request signatures (§5.2):**
  - every field comes from a `|`-free printable-ASCII alphabet, and the host must be lowercase;
  - `apiHost` drops default ports and rejects paths and credentials;
  - an empty body hashes zero bytes;
  - signatures are P1363, 64 bytes, with `0 < r, s < n`, and DER is refused (M20 killed);
  - fork signs one input with both keys.
- The timestamp window and replay checks are server-side by design.

**Keys and encodings**
- **Points:** `dpk` must have the exact P-256 SPKI prefix and an uncompressed point. `epk` must be 65 bytes starting with `0x04`. Both are then imported, which checks they are on the curve. Off-curve and x ≥ p cases have vectors.
- **Infinity and reflection:** the point at infinity cannot be encoded in 65 bytes, and with cofactor 1 there are no other low-order points. Reflection is checked on both sides.
- **Private keys:** the DSK private key is re-imported non-extractable with only the five JWK members. The ephemeral keys, K_mac, K_name, K_devbackup and K_enroll are non-extractable. The randomness source is `crypto.getRandomValues`.
- **IVs:** a fresh 96-bit random IV per AES-GCM call, and no key is used for enough messages to approach the collision bound.
- **Strict base64url:** canonical re-encoding and length mod 4 ≠ 1 are enforced.
- **Integer-only JSON:** the raw-token scan skips strings correctly. `-0` is harmless: it canonicalizes to `0` in both languages.
- **Device names:** NFKC, then trimming of U+0020 only. The Bidi and zero-width regexes contain exactly the §2.4 code points (checked byte by byte). Lengths are counted in code points, with 40 × 4 = 160 and no off-by-one.
- **Error oracles:** errors are fixed codes. Errors after decryption (`invalid_device_name`, `invalid_payload`) come only after AEAD authentication, so they are not oracles. N collapses every payload failure to `bad_payload`.

**Adoption rules (§3.9)**
- **R1:** the rules, and the `keys_behind` gate (§3.14 N27).
- **R2/R3:** the decision tables.
- **R4:** the unlock order.
- **R6:** a recovery code is treated like a password.
- **D8:** the pin repair.
- `classifyServerVk` covers §4.2 step 2.
- The pre-send check covers the wrong secret, the password changed elsewhere, the old password required after a rollback, needs-adoption (P9), the unknown-fields refusal, and the recovery-code version (S6).
- Reconciliation by critical parts (S4) works as specified.

**Phase 0 behaviour the code relies on, re-read**
- `validateKeyring` returns the same object, so unknown members survive.
- `unwrapPreviousVks` skips unreadable entries and checks the unwrapped VK's id.
- `unwrapVk` fails indistinguishably (`unwrap_failed`).
- Recovery-code typos throw before any unwrap.
- `fromB64` rules are as the doc states.

**Hygiene**
- Nothing outside `core/sync` imports the module, and a test enforces this. Nit: that test's regex `/core\/sync|sync\/crypto/` would miss `from "../sync"` from inside `core/`.
- The module makes no browser, network, storage, clock, timer or logging calls (enforced by a test).
- **No bundle-size impact:** `dist/` was built after the last M1 source change and contains no sync strings.
- No new dependencies (`fast-check` was already a devDependency).
- The constants mirror `x-sixkey-constants` (enforced by a test).
- No secret appears in any error or refusal (enforced by a test). Results that return a `Vk` do so by design.
- The memory-wiping claims in M1-NOTES are accurate and modest. The only gap is F-12.

**Complexity**
- Splitting the logic into pure deciders and fact gathering is reasonable, not over-engineered.
- There is no dead code beyond F-12.
- The module-internal exports (`shortCode`, `transcript`, `commitInput` and others) are test seams kept out of `index.ts`.

## Spec observations (not code bugs)

- **S-1.** The rotate `write_proof` binds only (vaultId, if_version, checksum), not `new_write_key` or the bundle. This follows §5.2: those are protected by the device signature and `pw_auth`.
- **S-2.** P4's "wrap changed" has no stated comparison basis. The client compares iv and wrapped bytes. M4 must use the same basis, or a wrap that differs only in a truncated `createdAt` would give a 422. State it in §2.3 and the contract.
- **S-3.** Continuity (R3) and "real previous" identify VKs by the 64-bit `vkId`. A forged continuation would need a 2^64 second preimage on HKDF. That is acceptable, but it should be written down as the bound.
- **S-4.** The doc should say whether a reveal or approve view repeats the pinned fields (F-10).

## Ergonomics for M3 and M5 (goal 6)

**Misuse-prone surfaces**
- Approval is not bound to the pre-send check (F-09).
- `localAuth` is optional (F-07).
- `classifyKver` is public (F-08).
- `publishKver` can return an unsafe value (F-01).
- No helper caps `previous` (F-11).

**Missing convenience for §3.3 step 4**
- There is no single exported "verify a received bundle" helper covering vkId, MAC and the expected vaultId.
- `openKeyring` is not exported, so M5 will hand-assemble Phase 0 `unlockWithRecoveryCode` + `verifyBundleMac` + a vaultId check, and could forget the last one.

**Exports per §9 M1:** all present (bundle, names, proofs, pre-send, write proof, both machines, signatures, padding, reconciliation, fork signature, R1, kver).

## Artifacts

The scratch directory below lasted only for the review session and is not in the repository. **The appendix holds the lasting copy of the test sources**: to re-run them, copy them into `extension/test/review/` together with the config shown there.
`scratchpad/m1-review/`

| Path | Contents |
|---|---|
| `repo/extension/test/review/repro.test.ts` | REPRO-1 to REPRO-10 (12 tests, all reproduce the stated behaviour) |
| `repo/extension/test/review/kver.test.ts` | REPRO-11 (F-01) |
| `repo/extension/test/review/killers.test.ts` | K0–K11: pass on the reviewed code; each of K1–K11 kills its surviving mutant (verified with `killcheck.py`) |
| `mutate.py`, `mutation-results.json` | the 38 mutations and their results against the full suite; the source is restored after each run (scratch source verified identical to the pristine copy) |
| `repo/extension/vitest.review.config.ts` | runs the review tests from `repo/extension`: `npx vitest run -c vitest.review.config.ts` |

## Appendix: reproduction and killer test sources (verbatim)

These files ran against the reviewed code with the vitest config below. They import only from `src/` and the existing `test/helpers/`.

### `vitest.review.config.ts`

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", testTimeout: 60_000, include: ["test/review/**/*.test.ts"] },
});
```

### `test/review/repro.test.ts`

```ts
// Reviewer reproductions for docs/audit/internal-reviews/M1-REVIEW.md. Scratch only; not part of the repo.
import { beforeAll, describe, expect, it } from "vitest";
import { toB64 } from "../../src/core/crypto/bytes";
import { rekey, retirePreviousVk, unlockWithPassword, unwrapPreviousVks, type Keyring } from "../../src/core/crypto/keyring";
import { generateVk, type Vk } from "../../src/core/crypto/vk";
import { evaluateSameVkBundle, unlockWithSync } from "../../src/core/sync/crypto/bundle-eval";
import { generateDeviceKey, generateEphemeral, newDeviceId } from "../../src/core/sync/crypto/device-key";
import { ApproverEnrollment, type ApproverView } from "../../src/core/sync/crypto/enroll-approver";
import { NewDeviceEnrollment } from "../../src/core/sync/crypto/enroll-new-device";
import { sealBundle } from "../../src/core/sync/crypto/keybundle";
import { preSendCheck } from "../../src/core/sync/crypto/presend";
import { bundleOf, ctx, keyrings, P, T0, type Fixture } from "../helpers/sync-keyrings";
import { G, VK1_RAW, vk } from "../helpers/sync-vectors";

let f: Fixture;
beforeAll(async () => {
  f = await keyrings();
}, 30_000);

// ---- helpers: an honest pair of machines -------------------------------------------------------------------------
async function session() {
  const dk = await generateDeviceKey();
  const devN = newDeviceId();
  const devA = newDeviceId();
  const rid = crypto.randomUUID();
  const { machine: n, request } = await NewDeviceEnrollment.start({ deviceId: devN, dpk: dk.spki, name: "Laptop" });
  n.requestCreated(rid);
  const pending: ApproverView = { state: "pending", new_device_id: devN, new_sig_pubkey: request.sig_pubkey, commit: request.commit };
  const { machine: a, respond } = await ApproverEnrollment.start({ approverId: devA, rid, request: pending });
  const responded = { state: "responded", approver_device_id: devA, approver_epk: respond.epk };
  return { n, a, devA, pending, responded };
}
async function toSasOk() {
  const s = await session();
  const r = await s.n.onPoll(s.responded);
  if (r.kind !== "reveal") throw new Error("no reveal");
  const revealed: ApproverView = { ...s.pending, state: "revealed", new_epk: r.body.epk, new_nonce: r.body.nonce, new_name_ct: r.body.name_ct };
  await s.a.onPoll(revealed);
  expect(await s.a.submitSas(r.sas)).toEqual({ kind: "matched" });
  return { ...s, reveal: r, revealed };
}

/** Run `hook` the first time crypto.subtle[method] is called while armed, then call the real method. */
function armOnce(method: "encrypt" | "decrypt", hook: () => void): () => void {
  const subtle = crypto.subtle as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const orig = subtle[method]!.bind(crypto.subtle);
  let fired = false;
  subtle[method] = (...a: unknown[]) => {
    if (!fired) {
      fired = true;
      hook();
    }
    return orig(...a);
  };
  return () => {
    delete subtle[method];
  };
}

describe("REPRO-1 abort() during an in-flight transition is overwritten (terminal state resurrected)", () => {
  it("approver: user cancels while buildApproval encrypts the payload -> machine still ends in 'approving' and returns the VK-bearing body", async () => {
    const s = await toSasOk();
    const restore = armOnce("encrypt", () => s.a.abort("cancelled"));
    let body;
    try {
      body = await s.a.buildApproval({ vk: await vk(VK1_RAW), bundleRaw: G.keybundle.raw, now: 1 });
    } finally {
      restore();
    }
    expect(body.payload.length).toBeGreaterThan(100);
    expect([s.a.phase, s.a.failure]).toEqual(["approving", "cancelled"]); // phase resurrected, failure still set
    expect(typeof (await s.a.approveAccepted())).toBe("string"); // and the CC is shown
  });
  it("new device: request rejected while the CC-matched payload is decrypted -> machine ends 'accepted' with the keys", async () => {
    const s = await toSasOk();
    const approve = await s.a.buildApproval({ vk: await vk(VK1_RAW), bundleRaw: G.keybundle.raw, now: 1 });
    const cc = await s.a.approveAccepted();
    await s.n.onPoll({ ...s.responded, state: "approved", payload: approve.payload });
    const restore = armOnce("decrypt", () => s.n.abort("rejected"));
    let r;
    try {
      r = await s.n.submitConfirmationCode(cc);
    } finally {
      restore();
    }
    expect(r.kind).toBe("accepted");
    expect([s.n.phase, s.n.failure]).toEqual(["accepted", "rejected"]);
  });
  it("new device: request expires while the reveal is being built -> machine shows a SAS after the terminal abort", async () => {
    const s = await session();
    const restore = armOnce("encrypt", () => s.n.abort("expired"));
    let r;
    try {
      r = await s.n.onPoll(s.responded);
    } finally {
      restore();
    }
    expect(r.kind).toBe("reveal");
    expect([s.n.phase, s.n.failure, typeof s.n.sas]).toEqual(["showing_sas", "expired", "string"]);
  });
});

describe("REPRO-2 approver poll that lands between the server's revealed->approved commit and approveAccepted()", () => {
  it("is reported as 'tampered', and the CC can then never be shown", async () => {
    const s = await toSasOk();
    await s.a.buildApproval({ vk: await vk(VK1_RAW), bundleRaw: G.keybundle.raw, now: 1 });
    expect(s.a.phase).toBe("approving");
    // honest server: approve committed; the 2 s poll timer fires before the POST response is processed
    expect(await s.a.onPoll({ ...s.revealed, state: "approved" })).toEqual({ kind: "failed", reason: "tampered" });
    await expect(s.a.approveAccepted()).rejects.toMatchObject({ code: "enroll_state" });
  });
});

describe("REPRO-3 a same-VK bundle whose keyring.vaultId differs from the local one is judged 'adopt'", () => {
  it("the wraps are copied verbatim, so passwordWrapSame is true, but they no longer open (AAD binds vaultId)", async () => {
    const evil: Keyring = { ...f.k1, vaultId: "evil-vault-0001" };
    const b = (await sealBundle(f.v1, { vaultId: evil.vaultId, kver: 2, keyring: evil, auth: (await bundleOf(f.v1, f.k1, 1)).auth, by: "qqqqqqqqqqqqqqqqqqqqqg", now: T0 })).bundle;
    expect(await evaluateSameVkBundle({ bundle: b, vk: f.v1, local: f.k1, maxSeenKver: 1 })).toEqual({ kind: "adopt", maxSeenKver: 2 });
    await expect(unlockWithPassword(b.keyring, P)).rejects.toMatchObject({ code: "unwrap_failed" });
  }, 20_000);
});

describe("REPRO-4 a VK holder drops the whole history with 64 fresh real previous entries (M1-3 reading)", () => {
  it("same-VK: R2 adopts a bundle whose previous no longer holds VK1", async () => {
    let kr: Keyring = { ...f.k2, previous: [] };
    for (let i = 0; i < 64; i++) kr = await retirePreviousVk(kr, await generateVk(), f.v2, ctx);
    expect(kr.previous.length).toBe(64);
    const b = await bundleOf(f.v2, kr, 5);
    expect(await evaluateSameVkBundle({ bundle: b, vk: f.v2, local: f.k2, maxSeenKver: 2 })).toEqual({ kind: "adopt", maxSeenKver: 5 });
    const ids = (await unwrapPreviousVks(b.keyring, f.v2)).map((v: Vk) => v.id);
    expect(ids).not.toContain(f.v1.id); // VK1 history is gone from the adopted keyring
    // the honest local keyring had it
    expect((await unwrapPreviousVks(f.k2, f.v2)).map((v: Vk) => v.id)).toContain(f.v1.id);
  }, 30_000);
});

describe("REPRO-5 cloud restore (local keyring lost, identity kept) of the bundle last seen", () => {
  it("asks 'adopt an OLDER key state?' although the bundle is exactly the one at maxSeenKver", async () => {
    const current = await bundleOf(f.v1, f.k1, 4);
    const r = await unlockWithSync({ secret: { password: P }, local: null, remote: current, pinnedVkId: f.v1.id, maxSeenKver: 4, needsPassword: true });
    expect(r).toEqual({ kind: "confirm_older" });
  }, 20_000);
});

describe("REPRO-6 preSendCheck classifies before the MAC is checked", () => {
  it("a forged (bad MAC) lower-kver bundle refuses change_password as 'keys_behind', not 'bad_mac'", async () => {
    const real = await bundleOf(f.v1, f.k1b, 3);
    const forged = { ...real, kver: 1 }; // MAC no longer verifies
    expect(await preSendCheck({ op: "change_password", serverBundle: forged, secret: { password: P }, local: f.k1, vk: f.v1, maxSeenKver: 2 })).toEqual({ ok: false, reason: "keys_behind" });
  }, 20_000);
});

describe("REPRO-7 localAuth omitted: the 'auth may change only with the password wrap' rule is skipped", () => {
  it("an auth-only change is adopted when the caller has no localAuth (the default)", async () => {
    const b1 = await bundleOf(f.v1, f.k1, 1);
    const authOnly = await bundleOf(f.v1, f.k1, 2); // same keyring, fresh auth
    expect(authOnly.auth).not.toEqual(b1.auth);
    // same keyring -> classified in_sync, auth change ignored entirely
    expect(await evaluateSameVkBundle({ bundle: authOnly, vk: f.v1, local: f.k1, maxSeenKver: 1 })).toEqual({ kind: "in_sync", maxSeenKver: 2 });
    expect(await evaluateSameVkBundle({ bundle: authOnly, vk: f.v1, local: f.k1, maxSeenKver: 1, localAuth: b1.auth })).toEqual({ kind: "in_sync", maxSeenKver: 2 });
  }, 20_000);
});

describe("REPRO-8 Phase 0 rekey never caps previous at 64; M1 has no capping helper", () => {
  it("the 65th entry makes the next bundle invalid", async () => {
    let kr: Keyring = { ...f.k2, previous: [] };
    for (let i = 0; i < 64; i++) kr = await retirePreviousVk(kr, await generateVk(), f.v2, ctx);
    const r = await rekey(kr, f.v2, P, ctx);
    expect(r.keyring.previous.length).toBe(65);
    await expect(bundleOf(r.vk, r.keyring, 9)).rejects.toMatchObject({ code: "invalid_bundle" });
  }, 30_000);
});

describe("REPRO-9 N requires approver_device_id / approver_epk in every later poll (optional in the contract)", () => {
  it("a later poll without them is 'tampered'", async () => {
    const s = await session();
    await s.n.onPoll(s.responded);
    expect(await s.n.onPoll({ state: "revealed" })).toEqual({ kind: "failed", reason: "tampered" });
  });
});

describe("REPRO-10 the approver accepts any MAC-valid bundle text: nothing ties buildApproval to the pre-send check", () => {
  it("an old genuine bundle (keys_behind for this device) is handed out", async () => {
    const s = await toSasOk();
    const old = await sealBundle(f.v1, { vaultId: f.k1.vaultId, kver: 1, keyring: f.k1, auth: (await bundleOf(f.v1, f.k1, 1)).auth, by: "qqqqqqqqqqqqqqqqqqqqqg", now: T0 });
    await expect(s.a.buildApproval({ vk: f.v1, bundleRaw: old.raw, now: 1 })).resolves.toMatchObject({ transcript_hash: expect.any(String) });
    void toB64; void generateEphemeral;
  }, 20_000);
});
```

### `test/review/kver.test.ts`

```ts
// REPRO-11: a VK holder burns the kver space; afterwards no device can publish any bundle (no rotation, no repair).
import { beforeAll, describe, expect, it } from "vitest";
import { setRecovery } from "../../src/core/crypto/keyring";
import { evaluateSameVkBundle, unlockWithSync } from "../../src/core/sync/crypto/bundle-eval";
import { publishKver, sealBundle } from "../../src/core/sync/crypto/keybundle";
import { preSendCheck } from "../../src/core/sync/crypto/presend";
import { bundleOf, ctx, keyrings, P, T0, type Fixture } from "../helpers/sync-keyrings";

let f: Fixture;
beforeAll(async () => { f = await keyrings(); }, 30_000);

describe("REPRO-11 kver exhaustion", () => {
  it("a MAC-valid bundle at kver 2^53-1 is accepted, then every publish fails", async () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    const burnt = await bundleOf(f.v1, f.k1, MAX); // same keyring, kver at the safe-integer ceiling
    const v = await evaluateSameVkBundle({ bundle: burnt, vk: f.v1, local: f.k1, maxSeenKver: 3 });
    expect(v).toEqual({ kind: "in_sync", maxSeenKver: MAX }); // maxSeenKver now at the ceiling on every device
    // the user notices the compromise and wants to rotate ("revoke and protect"): pre-send check passes ...
    expect(await preSendCheck({ op: "rotate", serverBundle: burnt, secret: { password: P }, local: f.k1, vk: f.v1, maxSeenKver: MAX })).toMatchObject({ ok: true });
    // ... but no bundle can be built: publishKver silently returns an unsafe integer and sealBundle refuses it
    const next = publishKver(MAX, MAX);
    expect(Number.isSafeInteger(next)).toBe(false);
    const rec = (await setRecovery(f.k1, f.v1, ctx)).keyring;
    await expect(sealBundle(f.v1, { vaultId: f.k1.vaultId, kver: next, keyring: rec, auth: burnt.auth, by: "qqqqqqqqqqqqqqqqqqqqqg", now: T0 })).rejects.toMatchObject({ code: "non_integer_number" }); // MAC input refuses the unsafe kver
    void unlockWithSync;
  }, 30_000);
});
```

### `test/review/killers.test.ts`

```ts
// Tests that pass on the reviewed code and kill the surviving mutants (docs/audit/internal-reviews/M1-REVIEW.md, section "Mutation testing").
import { beforeAll, describe, expect, it } from "vitest";
import { fromB64, toB64 } from "../../src/core/crypto/bytes";
import { rekey, type Keyring } from "../../src/core/crypto/keyring";
import { evaluateSameVkBundle, unlockWithSync } from "../../src/core/sync/crypto/bundle-eval";
import { generateDeviceKey, generateEphemeral, importEpk, newDeviceId } from "../../src/core/sync/crypto/device-key";
import { ApproverEnrollment, type ApproverView } from "../../src/core/sync/crypto/enroll-approver";
import { ccOf, enrollKey, payloadText, sealPayload, sharedSecret, transcriptHash } from "../../src/core/sync/crypto/enroll-crypto";
import { NewDeviceEnrollment } from "../../src/core/sync/crypto/enroll-new-device";
import { sealBundle } from "../../src/core/sync/crypto/keybundle";
import { preSendCheck } from "../../src/core/sync/crypto/presend";
import { bundleOf, keyrings, P, pwSalt, T0, type Fixture } from "../helpers/sync-keyrings";
import { G, VK1_RAW, vk } from "../helpers/sync-vectors";

let f: Fixture;
beforeAll(async () => {
  f = await keyrings();
}, 30_000);

/** The server plays the approver toward N and knows K; the test then types the right CC (as if A had shown it). */
async function nWithPayload(p: { vaultId?: string; approver?: string; bundleRaw?: string }) {
  const dk = await generateDeviceKey();
  const devN = newDeviceId();
  const devA = newDeviceId();
  const rid = crypto.randomUUID();
  const { machine: n } = await NewDeviceEnrollment.start({ deviceId: devN, dpk: dk.spki, name: "Laptop" });
  n.requestCreated(rid);
  const s = await generateEphemeral();
  const r = await n.onPoll({ state: "responded", approver_device_id: devA, approver_epk: toB64(s.raw) });
  if (r.kind !== "reveal") throw new Error("no reveal");
  const epkN = fromB64(r.body.epk);
  const h = await transcriptHash({ rid, devN, devA, dpkN: dk.spki, epkN, epkA: s.raw, nN: fromB64(r.body.nonce) });
  const k = await enrollKey(await sharedSecret(s.privateKey, await importEpk(epkN)), h);
  const raw = p.bundleRaw ?? G.keybundle.raw;
  const text = payloadText({ vaultId: p.vaultId ?? JSON.parse(raw).vaultId, vk: await vk(VK1_RAW), bundleRaw: raw, approver: p.approver ?? devA, at: 1 });
  await n.onPoll({ state: "approved", approver_device_id: devA, approver_epk: toB64(s.raw), payload: await sealPayload(k, h, text) });
  return n.submitConfirmationCode(await ccOf(h));
}

const badMacRaw = () => {
  const b = JSON.parse(G.keybundle.raw);
  b.at += 3_600_000;
  return JSON.stringify(b);
};

describe("killers for the surviving mutants", () => {
  it("K0 control: the honest payload is accepted by this harness", async () => {
    expect((await nWithPayload({})).kind).toBe("accepted");
  });
  it("K1 (M01) N refuses P whose vaultId differs from the bundle's", async () => {
    expect(await nWithPayload({ vaultId: "other-vault-0001" })).toEqual({ kind: "failed", reason: "bad_payload" });
  });
  it("K2 (M02) N refuses P naming another approver than the pinned devA", async () => {
    expect(await nWithPayload({ approver: newDeviceId() })).toEqual({ kind: "failed", reason: "bad_payload" });
  });
  it("K3 (M03) N refuses P whose bundle MAC does not verify", async () => {
    expect(await nWithPayload({ bundleRaw: badMacRaw() })).toEqual({ kind: "failed", reason: "bad_payload" });
  });
  it("K4 (M04) buildApproval refuses a bundle of this VK whose MAC does not verify", async () => {
    const s = await honestToSasOk();
    await expect(s.a.buildApproval({ vk: await vk(VK1_RAW), bundleRaw: badMacRaw(), now: 1 })).rejects.toMatchObject({ code: "invalid_argument" });
  });
  it("K5 (M05) the approver aborts when the reveal's nonce changes after the SAS was computed", async () => {
    const s = await honestToSasOk(false);
    expect(await s.a.onPoll({ ...s.revealed, new_nonce: toB64(new Uint8Array(32).fill(1)) })).toEqual({ kind: "failed", reason: "tampered" });
  });
  it("K6 (M06) sealBundle refuses unaligned keyring times and an auth salt equal to the password wrap's", async () => {
    const unaligned: Keyring = { ...f.k1, wraps: f.k1.wraps.map((w) => ({ ...w, createdAt: w.createdAt + 1 })) };
    const auth = (await bundleOf(f.v1, f.k1, 1)).auth;
    await expect(sealBundle(f.v1, { vaultId: f.k1.vaultId, kver: 2, keyring: unaligned, auth, by: "qqqqqqqqqqqqqqqqqqqqqg", now: T0 })).rejects.toMatchObject({ code: "unaligned_time" });
    const pwKdf = f.k1.wraps.find((w) => w.method === "password")!.kdf!;
    expect(pwKdf.salt).toBe(pwSalt(f.k1));
    await expect(sealBundle(f.v1, { vaultId: f.k1.vaultId, kver: 2, keyring: f.k1, auth: { kdf: pwKdf as never }, by: "qqqqqqqqqqqqqqqqqqqqqg", now: T0 })).rejects.toMatchObject({ code: "invalid_bundle" });
  });
  it("K7 (M21) F7: a VK1 bundle that lists the pinned VK2 over garbage bytes cannot pull the device back", async () => {
    const forged: Keyring = { ...f.k1, previous: [{ vkId: f.v2.id, iv: toB64(new Uint8Array(12)), wrapped: toB64(new Uint8Array(48).fill(5)), createdAt: T0 }] };
    const b = await bundleOf(f.v1, forged, 99);
    expect(await unlockWithSync({ secret: { password: P }, local: null, remote: b, pinnedVkId: f.v2.id, maxSeenKver: 2, needsPassword: true })).toEqual({ kind: "reject", reason: "discontinuous" });
  }, 20_000);
  it("K8 (M22) a forged same-keyring bundle with a huge kver is rejected, never classified (maxSeenKver unchanged)", async () => {
    const b = { ...(await bundleOf(f.v1, f.k1, 2)), kver: 10 ** 15 };
    expect(await evaluateSameVkBundle({ bundle: b, vk: f.v1, local: f.k1, maxSeenKver: 1 })).toEqual({ kind: "reject", reason: "bad_mac" });
  }, 20_000);
  it("K9 (M23) unlock refuses a remote bundle whose MAC does not verify (an old genuine bundle with its kver bumped)", async () => {
    const old = { ...(await bundleOf(f.v1, f.k1, 1)), kver: 50 }; // would skip the N27 confirmation if trusted
    const r = await unlockWithSync({ secret: { password: P }, local: f.k1b, remote: old, pinnedVkId: f.v1.id, maxSeenKver: 2, needsPassword: false });
    expect(r).toEqual({ kind: "reject", reason: "bad_mac" });
  }, 20_000);
  it("K10 (M33) the pre-send check refuses to build on a newer server bundle that dropped a history VK", async () => {
    const dropped = await bundleOf(f.v2, { ...f.k2, previous: [] }, 5);
    expect(await preSendCheck({ op: "change_recovery", serverBundle: dropped, secret: { password: P }, local: f.k2, vk: f.v2, maxSeenKver: 2 })).toEqual({ ok: false, reason: "previous_dropped" });
  }, 20_000);
  it("K11 (M36) unlock refuses a rotation bundle that keeps the pinned VK but drops older history", async () => {
    const r3 = await rekey(f.k2, f.v2, P, { now: () => T0 });
    const kr = { ...r3.keyring, previous: r3.keyring.previous.filter((p) => p.vkId !== f.v1.id) };
    const res = await unlockWithSync({ secret: { password: P }, local: f.k2, remote: await bundleOf(r3.vk, kr, 3), pinnedVkId: f.v2.id, maxSeenKver: 2, needsPassword: true });
    expect(res).toMatchObject({ kind: "local", remoteRejected: "previous_dropped" });
  }, 30_000);
});

async function honestToSasOk(match = true) {
  const dk = await generateDeviceKey();
  const devN = newDeviceId();
  const devA = newDeviceId();
  const rid = crypto.randomUUID();
  const { machine: n, request } = await NewDeviceEnrollment.start({ deviceId: devN, dpk: dk.spki, name: "Laptop" });
  n.requestCreated(rid);
  const pending: ApproverView = { state: "pending", new_device_id: devN, new_sig_pubkey: request.sig_pubkey, commit: request.commit };
  const { machine: a, respond } = await ApproverEnrollment.start({ approverId: devA, rid, request: pending });
  const r = await n.onPoll({ state: "responded", approver_device_id: devA, approver_epk: respond.epk });
  if (r.kind !== "reveal") throw new Error("no reveal");
  const revealed: ApproverView = { ...pending, state: "revealed", new_epk: r.body.epk, new_nonce: r.body.nonce, new_name_ct: r.body.name_ct };
  await a.onPoll(revealed);
  if (match) await a.submitSas(r.sas);
  return { a, revealed };
}
```

