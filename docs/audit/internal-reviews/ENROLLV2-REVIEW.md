# ENROLLV2-REVIEW: enrolment v2, the 128-bit pairing code

> **About this record.** An internal review, kept in the audit trail as written. It was made by an AI model (Anthropic's
> Claude) in a review session separate from the session that wrote the change, at the maintainer's request. It is
> **not** an independent third-party audit; none has been done yet. Edited since: only this note was added (the body's
> technical uses of "independent", such as an independent re-derivation of test vectors, are unchanged). Paths under
> `scratchpad/` were the reviewer's temporary working copies (probes, mutants, logs) and were **not retained**: a probe
> or mutant exists only as far as this record quotes it or as it was adopted into the test suite. What became of each
> finding: [`docs/audit/INDEX.md`](../INDEX.md); how to read these records: [`docs/audit/README.md`](../README.md).

Reviewed: `enrollv2/ENROLLV2.patch` (8,555 lines, 70 files), applied with `patch -p1 -E` to a fresh copy of the live tree
(`enrollv2-review/tree/`; it applied cleanly, and `messages.py` regenerated the catalogs). Reference: `docs/SYNC-DESIGN.md`
revision 27 (§0.0aa, §1.3, §2.2, §2.6, §3.2 MUST 1–10, §6 O5/O6/O9, §7, §8.1, §10 rows 1, 28, 109, 110). Every path
below is relative to the repository root unless it says otherwise. Line numbers are those of the patched tree.

## Verdict: merge after fixes

- **Blockers:** none.
- **Before merge:** fix R-1 (Major). It is two lines with an adoptable probe, and I verified the fix.
- **Follow-up, before the gate opens:** R-2 (the contract text).
- **Everything else:** minor or a nit.
- **The m6c e2e failure:** a test bug, not a product bug. A one-line fix to the test, verified end to end (§5).
- **The cryptography is right.** I re-derived it independently, and none of the attacks in the brief works (§2).

## 1. What I checked, and how

| Check | Result |
|---|---|
| Independent re-derivation of the v2 vectors (`probes/rederive_enroll_v2.py`: pyca/cryptography + hashlib, written from §3.2/§2.2 only, imports neither the generator nor the Python reference) | **ALL OK, 63 checks:** C, T, h, Z on both sides, IKM = Z ‖ S (48 B), K = HKDF-SHA256(Z ‖ S, salt h, info `sixkey/v2/enroll-key`), SAS and its u32, the pairing-code text and its 12 check bits, the recovery-code form of the same S, the reveal name and the payload both opening under K with the v2 AADs (name ciphertext 188 B), payload `v: 2` and `approver`, the SAS and pairing_code groups. I recomputed five `must_not_open` keys myself (Z only under the v1 label, Z only under the v2 label, S with a bit flipped, S ‖ Z, no salt) and all 16 cases stay shut. The MITM h1 and SAS are right. Labels: the v2 set is present, no v1 enrolment label is left, HKDF labels are distinct and tags prefix-free. |
| `gen-vectors.mjs --check`, `check_consistency.py`, `test_contract.py` (with and without pyca) | 25 groups match; 0 hard mismatches; 45/45 both ways |
| Server: the real M4 suite against the patched vector file (a scratch PostgreSQL 14 on 127.0.0.1:55492) | **470 passed** (`server-tests.log`). The server needs no v2 code change: `name_ct` is still 188 B and `payload` has the same length (`v:2` is as long as `v:1`). `api/server` has no `cc` field and no CC constant. |
| Unit and fault suites the patch touches (22 files, two workers), plus the 5 untouched unit files that drive enrolment (`m6-permission`, `m6-permission-edges`, `m6-honesty`, `m3rr-fs-probes`, `m3-fake-server`) | 424 passed, 1 skipped; 76 passed |
| Stale v1/CC calls in specs nobody ran (`network.spec.ts`, `page-csp`, `permission-wire`): a grep of `extension/test/**` for `approverPoll(`, `approverSas`, `.cc`, `enter_cc`, `cc_mismatch`, `submitConfirmation`, `syncCc`, `sync-cc`, `approve-cc` and the join helpers | none: the only hits are the patched typed interface (`test/e2e/sync-helpers.ts:125–127`) and assertions that `cc` is absent; `network.spec.ts` does not use the approval join |
| Mutants (`probes/mutants-review.py`, `mutants-review.log`) | **6 of the implementer's 39 re-run independently**, all killed: K from Z only, the untagged check bits, S shown before respond's 200, no reject at `pairing_mismatch`, S in the clipboard relay, and the scam warning dropped. The other 33 I checked **only in the implementer's logs**: `mutants-final-part1.log` and `-part2.log` hold 39 'killed' lines and no survivor; `mutants-final.json` covers 23 of them, all `killed: true`. Of my 9 new mutants, 6 were killed and **3 survive** (R-9). |
| e2e on a scratch copy at 127.0.0.1:8798: `join.spec.ts` | 2/2 passed (recovery join; approval join with a wrong code ending both sides, then the right code and the SAS) |
| e2e: `m6c-section.spec.ts` "find accounts" with the one-line test fix | **1 passed (7.8 s)**; without the fix it times out at 180 s (§5) |
| H8 probe: `sixkey-enroll-name\|1\|` and `sixkey/v3/enroll-key` injected into a copy of the doc | both flagged (H8 now catches labels of any version in the doc); it does not read openapi (R-2) |

## 2. Cryptography and protocol

Each line below is a check I made, with its conclusion. There is no defect here, except where R-numbers are cited.

- **The derivation matches the design exactly.**
  - `enroll-crypto.ts:72–82`: `concat(z, s)`, salt h, info `sixkey/v2/enroll-key`, AES-256-GCM, non-extractable.
  - Lengths are enforced (Z 32, S 16, h 32), inside the `try`, so Z, S and the IKM are wiped even on a refusal.
  - The order mutant S ‖ Z and the any-length-S mutant are both killed.
- **Domain separation.**
  - All six enrolment tags are at v2. `sixkey-pairing-code|1|` is new. The tags are prefix-free, and the CC tag is gone.
  - The AADs are `tag ‖ b64u(h)`. h binds rid, devN, devA, dpk_N, epk_N, epk_A and n_N; the commitment binds devN, dpk_N, epk_N and n_N.
  - The name and the payload share K but have distinct AADs and random IVs (two encryptions per key), so neither can be swapped for the other.
  - The mutant that drops rid from T is killed.
- **Where S is bound.** S is only in the IKM, not in h or C. That is sufficient:
  - Any substitution changes h_A against h_N (C and T).
  - A server without S cannot produce a reveal that opens under A's K. A then ends at `pairing_mismatch` before the SAS.
  - Without S the server also cannot produce a payload N opens; N ends at `bad_payload`.
  - Each side gets key confirmation from the other side's ciphertext, and the SAS remains A's independent second check.
  - With S leaked, A is still protected by the SAS (one guess, 10⁻⁶), and N is the accepted residual of row 110. The adversary test asserts it under that name.
- **No oracle; the 128 bits are intact.**
  - S never leaves the extension. Nothing derived from S is sent: the respond body is `{epk}` only, and the reveal and approve bodies carry ciphertexts and h.
  - The 12 check bits are computed from the typed text alone and never compared with anything secret. N's unlimited free retries therefore test nothing about A's S.
  - N reveals at most once per request (`#guard("entering_code")`), so the server sees one name_ct under K(Z ‖ S_typed).
  - The only offline test, by a MITM that knows its own Z, costs HKDF + GCM per guess over all 128 bits. The check bits are never on the wire, so they cannot shorten that search.
  - A typo that slips past the check bits costs the request (`pairing_mismatch`, rejected). The server learns one bit ("rejected") per user-visible restart.
- **The clipboard hash.**
  - The relay `{type: "sk-clip-arm", hash: SHA-256(code text)}` (`platform/clipboard.ts:20–28`) is a deterministic function of S. It stays inside the extension (the service worker, then the offscreen timer, memory only, `offscreen/main.ts:38–51`), and inverting it is a 2^128 preimage. Acceptable under the Copy exception, as the notes say.
  - `runtime.sendMessage` broadcasts to every open extension context, not only the worker. That is harmless (same trust domain), but worth one sentence in the notes.
- **Cross-protocol.**
  - The same 16 bytes give codes that differ only in their last 3 symbols, and each code is rejected where the other belongs (the probe checks 256 random S).
  - A pairing code typed into the recovery join passes its check bits about 1 in 4096 times. In that case `recAuth = HKDF(S, "sixkey/v1/recovery-auth")` reaches the server: a one-way value derived from S. It does not help the server compute K = HKDF(Z ‖ S, h). Not worth a design change; it could be named in §3.2 MUST 10 for completeness.
- **Replay, reflection, unknown key share.**
  - An old payload or name fails under the new h and S.
  - A reflected epk is refused on both sides (the N-side mutant is killed).
  - Forwarding N2's reveal to A's request fails the pinned C, or fails on rid in T.
- **Malicious approver side or another device.**
  - Another enrolled device never sees S.
  - Racing respond is blocked by the CAS pending → responded, and the losing machine is aborted (S wiped).
- **State machines.**
  - N cannot reveal before S: the reveal body exists only after `submitPairingCode` succeeds.
  - A's code is readable only in `awaiting_reveal`, which `respondAccepted()` enters after the server's 200 (`enroll-approver.ts:194–210`, `enroll.ts:769–776`).
  - The SAS gets 3 tries against one SAS_A, and a malformed SAS costs no try.
  - Format or check-bit errors change no state and send nothing.
  - MUST 7 epoch guards are in both machines (the N-side mutant is killed).
  - Polls and the code step are serialised (`ApprovalJoin.serial`).
- **S has no use after the reveal.** On A, K (a CryptoKey) is derived at the reveal and used for the name and then the payload. On N, S is used only to derive K. Wiping S at the reveal is therefore correct. The design's wording ("A 丢弃 S … after approve") is met earlier than required.

## 3. Findings

### R-1 (Major): a lock while `respond` is in flight leaves S alive in an orphaned machine (MUST 10)

- **Where:** `extension/src/options/sync/approve.ts:114–118` and `extension/src/core/sync/engine/enroll.ts:863–867`.
- **Scenario:**
  1. The user picks a request on the approver; the flow is at `connecting` and respond is on the wire.
  2. The user locks Sixkey: the popup's Lock, or the idle lock.
  3. `ManageFlow.locked()` ends the flow. `clear()` runs, but `#approver` is still null, so nothing is discarded.
  4. `Approver.start` then resolves, and `choose()` sees the run is not live, so it calls `a.reject(pw)`.
  5. `Approver.reject` runs `Approver.checked()` (`flows.current()`) first. That throws `locked`, so `this.machine.abort()` is never reached, and `.catch(() => undefined)` swallows the error.
- **Result:**
  - The machine stays in `awaiting_reveal` with `#s`, `#code` and `#esk` live. Its `pairingCode` getter still returns the code, until GC.
  - The request stays `responded`, so the new device asks for a code that nobody can show.
  - The m6-manage lock test (line 247) only locks after `choose` resolved.
- **Probe:** `probes/enrollv2-review-probes.test.ts` P1 fails on the patch:
  `expected { phase: 'awaiting_reveal', code: '2HBQ-…-7Z0T' } to deeply equal { phase: 'failed', code: null }`.
- **Fix** (`probes/fix-R1-approver-reject-aborts-first.patch`, adoptable alone): in `Approver.reject`, abort the machine *before* the check. This covers every caller: `choose`, `giveUp`, `rejectCurrent`, and the engine's own rejects at `pairing_mismatch`, `sas_mismatch` and `keys_changed`.
  ```ts
  async reject(password: string): Promise<void> {
    this.machine.abort("rejected"); // first: S and the ephemeral key go whatever the check below does (MUST 10)
    const c = await Approver.checked(this.e, "reject", password);
    await this.e.api.reject(this.signer, this.rid, c.proof);
  }
  ```
- **Verified:** with the fix, the probe and `m6-manage`, `m6-flows`, `m3-enroll`, `enroll-v2`, `quick-source-rules` and `sync-crypto-enroll` pass (93 tests), and `tsc --noEmit` is clean.
- **Severity:** S was never displayed, and reading it needs code in the page (A10). The rating is a MUST-rule violation in audit-grade code with a two-line fix; v1 had the same ordering for `esk` (MUST 6).

### R-2 (Major, follow-up): `api/openapi.yaml` still documents enrolment v1, and the notes' list is incomplete

- `ENROLL-V2-NOTES.md` §4 names lines 85, 547, 596 and 1279. The file also carries three **v1 AAD/tag strings**:
  - **523:** reveal `name_ct` AAD `'sixkey-enroll-name|1|'`.
  - **873:** `EnrollPayloadCiphertext`, `sixkey-enroll-payload|1|`.
  - **1104:** the commitment `sixkey-enroll-commit|1|`.
- A third-party implementer reading the contract would build v1. H8 (`contract/tools/check_consistency.py:441–458`) reads only `docs/SYNC-DESIGN.md`, so nothing fails.
- **Probe:** `probes/h8_openapi_labels.py` exits 1 and lists all seven lines. Add its few lines to H8: the same regexes over openapi.yaml, compared against the vector labels. That turns this class into a CI failure.
- **What must change together, in one follow-up:**
  1. `api/openapi.yaml`: line 85 ("the real protection is CC" → the pairing code), 523, 547 ("A shows CC only after this returns 200" → no code after approve; S is shown after respond's 200), 596 ("CC failed three times" → `bad_payload`), 873, 1104 (the `|2|` tags), and 1279 (delete `CC_ATTEMPTS`).
  2. `extension/src/core/sync/crypto/constants.ts:20–22`: delete `CC_ATTEMPTS` and its comment.
  3. `extension/test/unit/enroll-v2.test.ts:218–231`: the `allowed` exception goes, and `toHaveLength(1)` becomes "no `CC_ATTEMPTS` anywhere".
  4. Nothing else needs to change:
     - `sync-crypto-hygiene.test.ts:45–50` iterates the openapi constants, so removing both sides keeps it green.
     - `contract/py` `REQUIRED_CONSTANTS` and the server's `test_contract.py:61–80` do not name CC.
     - The server code needs no change (470 pass).
  5. Optionally, apply the H8 extension above.

### R-3 (Minor): no local deadline for S on the approver (MUST 10: "寿命：至多到请求过期")

- **Where:** `approve.ts:146–159`. A poll that fails with `network` returns quietly and the next poll is scheduled. There is no expiry check on A's side.
- **Scenario:** A is offline, or a hostile server stalls A's polls at the transport level. The pairing code then stays on screen and in memory beyond the request's 10–11 minutes, which widens the row-110 exposure window (shoulder-surfing).
- **Fix:** stamp the deadline at `respondAccepted` (now + ENROLL_TTL_S + 60 s, the bound `expiryOf` already uses for N). When it passes, end the flow (`discard`, "expired"), whatever the polls say.

### R-4 (Minor, pre-existing): the approver rejects only at `pairing_mismatch`, `sas_mismatch` and `keys_changed`

- **Where:** `enroll.ts:792–806`. §3.2 M4 says a commitment mismatch is also "拒绝并告警". The others (`tampered`, `invalid_view`, `reflected_key`, `bad_name`, `unexpected_state`) end the flow on A but leave the request `revealed`, so N waits until expiry.
- `Approver.poll` now takes the password anyway, so it can reject on every terminal failure at no extra cost.
- **Related:** the mismatch screen (`syncApproveMismatch`) says "The request was rejected", even when the reject's network call failed (`.catch(() => undefined)`). Either track the outcome or say "is being ended".

### R-5 (Minor, liveness): a lost answer to `respond` is not retried

- **Where:** `enroll.ts:769–774`. A `NetworkError` aborts the machine, which is correct for S.
- **Problem:** the server may have committed `responded`. N then sits at "type the pairing code" for up to about 10 minutes with no code anywhere.
- **Fix:** respond is idempotent server-side for the same approver and epk (`api/server/sixkey_server/routes/enroll.py:167–173`), so retry it up to twice, as init and complete do, before giving up.

### R-6 (Minor): the field's reading differs from MUST 10 and the vectors at 29+ symbols

- **Where:** `extension/src/options/code-text.ts:10`. `codeSymbols` keeps the first 28 symbols.
- **Effect:**
  - A 29-symbol paste with one extra trailing symbol is *accepted* as the right code.
  - With a leading extra symbol, the user gets "This code has an error" rather than "That is not a pairing code".
  - The vectors (`pairing_code.rejected_inputs`, 29 symbols → `pairing_length`) and MUST 10 ("规范化之后不是 28 个合法字符 → 格式不对") say otherwise.
- This is harmless for security (it only lets through text the user pasted). Either keep everything typed (up to `maxLength`) and let the parser say `pairing_length`, or document the leniency. The probe P2 pins the current behaviour.

### R-7 (Minor): the notes claim two wipes that the code does not do

- **(a)** "A failed checksum now also wipes the candidate secret" (§1.2). `recovery-code.ts:57` throws without wiping. The candidate is S with a typo, a few bits away from S. Add `secret.fill(0)` before the throw, or drop the claim.
- **(b)** `CodeField`'s doc comment (`shared.tsx:377–378`) and §1.4 say the field "tells its owner" when it unmounts. The cleanup at `shared.tsx:412–416` clears the DOM only. Today JoinView's own effect (`JoinView.tsx:116–119`) covers the pairing code.
  - **Fix (optional):** `probes/fix-R7b-codefield-unmount-tells-owner.patch` adds `onValue.current("")` to the cleanup. Every owner I read clears its own copy anyway (Reset already clears `code` after `prepareReset`), so it only adds a safety net. Verified with the tests above.
  - **Caveat:** a step that remounts the field mid-flow would lose what was typed. Run the e2e of `reset`, `flows` and `firstrun` once before adopting it, or just correct the comment and the note.

### R-8 (Minor): the vector schema does not close the `enrollment` group

- **Where:** `contract/vectors/sync-v1.schema.json:284–`. A `cc` member at the group level passes the schema. Checked with the contract's own `sc.validate`; `inputs`, `mitm` and `label_swap` are closed as the notes say.
- The Python verifier refuses it, so this is defence in depth. Add `additionalProperties: false`, or a `not: {required: ["cc"]}`.

### R-9 (Minor): test gaps, three surviving mutants (`mutants-review.log`)

1. **N does not wipe the parsed S on its own way out** (`enroll-new-device.ts:249–251`). The path is an abort before `enrollKey` runs: the S bytes are left until GC. A seam-array probe like the approver's would kill it, which needs a parse seam.
2. **The approver does not drop `#s`/`#code` at the reveal** (`enroll-approver.ts:348–349`). `enrollKey` zeroes the bytes anyway, and the getter is phase-guarded. It is observable only through private state; acceptable.
3. **JoinView keeps the typed pairing code past its step.** Nothing kills it, because the unit suite has no DOM. `probes/enrollv2-review-probes.test.ts` P3a is a source rule that kills it; adopt it.

### R-10 (Minor): wording, en and zh_CN

- **`syncScamWarning`** (m6.py:134, 442):
  - "Anyone who asks you to type them, or to tell them, is trying to scam you": "tell them" has no object. Suggest: "…asks you to type these codes anywhere else, or to read them out to them, is trying to scam you."
  - The zh matches §6 O9 exactly ("这两个码…"). On the pairing-code screens only one code is visible, which is acceptable because the design wrote it for both screens.
- **`syncApprovePairWaiting`** (enroll2.py:14): "Waiting for the new device to take the code…" reads oddly. Suggest: "Waiting for the code to be entered on the new device…". The zh "正在等待新设备输入……" is fine.
- **`syncPairCopyNote`** zh (enroll2.py:28): "开启了清空剪贴板时" → "如果开启了清空剪贴板，" reads better.
- The rest is fine:
  - The en/zh pairs are equivalent.
  - The §7 permitted sentence about the cross-device clipboard is there.
  - No forbidden PQ claims ("抗量子", "量子安全").

### R-11 (Nit): clipboard residual is wider than it needs to be

- S stays on the clipboard after the flow ends. The 30-second clean-up runs only if the user granted clipboard access, and it ignores the reveal.
- Arm an immediate "clear if it still holds this code" at the reveal or at the flow's end, when permitted. This is cheap and narrows row 110.

### R-12 (Nit)

- The developer page (`src/devsync/main.ts`, dev and e2e builds only) never calls `discard()`, so S lives until the page closes. Harmless outside prod.
- `Locked.tsx:183`: see §4.

## 4. The popup's recovery field without a Show toggle (my opinion)

**Add the Show toggle (or keep that one field a text field). Do not ship it masked with no way to see it.**

- The masking buys nothing there. The notes themselves say an action popup is not a tab and is not session-restored (deviation 5).
- It costs usability exactly when the user is locked out and is typing 28 symbols off paper. The check bits only say "has an error", not where, so a blind field means retyping all 28.
- The master-password field beside it is a different case: users know their password, and they read the code.
- The toggle is about +80 B gzipped against roughly 960 B of headroom in the gate-open popup.
- It keeps the one rule the source-rule test enforces (`shown ? "text" : "password"`) and matches the settings page's `CodeField`.
- Shoulder-surfing argues for masking by default, which the toggle keeps.

## 5. The m6c "find accounts" failure (my opinion)

**This is a test bug, not a product bug. The destructive action is reachable. The implementer's diagnosis ("Delete forever is disabled with sync on") is wrong.**

- **Why the button is disabled:** `extension/src/options/Misc.tsx:21,26` sets `canErase = unlocked && (!needsPw || pw.length > 0)`, where `needsPw` comes from `status.passwordProtected`. Nothing about sync is involved.
- **Why that is intended:** the quick-PIN change made "Delete forever" ask for the master password, because it cannot be undone (`QUICK-PIN-NOTES.md` line 147; `service.ts:1362`). `test/e2e/quick-pin.spec.ts:273–282` tests that.
- **Why the test hangs:** `test/sync/m6c-section.spec.ts:68–72` was written before that change and never fills `#trash-pw`. Playwright waits on a disabled button for the full 180 s. The test lives in the sync config, which the quick-PIN change did not run, so it fails identically without this patch.
- **Fix:** `probes/fix-m6c-find-accounts-test.patch`, one line: `await trash.locator("#trash-pw").fill(STRONG);` before the click. Verified on a scratch copy at port 8798: **1 passed (7.8 s)** (`e2e-m6c-fixed.log`).
- Correct the notes' §7 sentence at the same time. It is independent of this patch, and can land with it or separately.

## 6. Invariants from M3/M5/M6

- **Permission first:** unchanged. The approve and join flows still start from `asking()`.
- **A lock ends flows:** yes, except the R-1 window.
- **Demote, never drop, and the guard:** untouched. `foldForJoin` and `prepareJoin` are as before.
- **Sync e2e covers the joins:** `join.spec.ts` (re-run here: 2/2), plus `m6-section` and `m6c-section` approval joins (implementer's run).
- **Budgets:** I did not re-measure. The implementer's numbers are inside the budgets: popup 60,474/61,440 B gate open; Sync catalogs 10,688 and 11,841/12,288 B.

## 7. Files

- **Probes:** `probes/`
  - `rederive_enroll_v2.py`: independent vector re-derivation (all OK).
  - `enrollv2-review-probes.test.ts`: P1 and P3b fail on the patch; P2 (two) and P3a pass; adoptable into `extension/test/unit/`. P3b passes only with the optional R-7b fix: drop it if R-7b is not adopted.
  - `h8_openapi_labels.py`: fails on the patch; adoptable into H8.
  - `mutants-review.py`: 15 mutants, 3 survive.
  - `fix-R1-approver-reject-aborts-first.patch`: R-1, the before-merge fix.
  - `fix-R7b-codefield-unmount-tells-owner.patch`: R-7b, optional. Both verified together: 93 tests and `tsc` clean.
  - `fix-m6c-find-accounts-test.patch`: §5, verified.
- **Logs:** `server-tests.log` (470 passed), `mutants-review.log`, `e2e-join.log`, `e2e-m6c-fixed.log`.
- **The review copy:** `tree/` (the patched state; the probe file is copied there as `test/unit/zz-enrollv2-review-probes.test.ts`). `e2e/` holds the port-8798 copy with the m6c fix.
