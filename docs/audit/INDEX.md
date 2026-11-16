# Audit index: finding IDs

Code comments and test names in this repository cite findings of the internal review records by ID (for example
`GM2-5` or `M3RR-4`). This index resolves each one: which record defines it, where the outcome of the finding is
recorded, which product code cites it and which tests name it. The records themselves are described in
[README.md](README.md). They are AI-model review sessions, not third-party audits.

The tables below were generated from the tree (by a script that is not kept in the repository; the section on record-local
IDs was added by hand): they list every ID that appears in `extension/src`, `extension/scripts`,
`extension/test`, `api/server` or `contract/`. A test that names an ID is the regression test for that finding, or
pins the behaviour the finding settled. An ID with no test listed is cited only as the reason for a piece of code;
its record says how it was verified.

## ID families

| Prefix | Defined in | Outcome recorded in |
|---|---|---|
| `GM2-n` | docs/audit/internal-reviews/GM2-REVIEW.md | the A4 package (docs/audit/internal-reviews/A4-REVIEW.md); SYNC-DESIGN §0.0i (revision 9) |
| `A4R-n` | docs/audit/internal-reviews/A4-REVIEW.md | SYNC-DESIGN §0.0i and §0.0j (revision 10) |
| `A3-n` | docs/audit/internal-reviews/A3-REVIEW.md | docs/history/PLAN-zh.md §15 (status); docs/audit/internal-reviews/C6-REVIEW.md and docs/audit/internal-reviews/A4-REVIEW.md re-check them |
| `C6-n` | docs/audit/internal-reviews/C6-REVIEW.md | docs/history/PLAN-zh.md §15 (status); SYNC-DESIGN §0.0j (C6-8) |
| `P-n` | docs/audit/internal-reviews/A2-REVIEW.md | FIXb and FIXa2 (docs/history/PHASE0X-PLAN.md), reviewed in docs/audit/internal-reviews/GM2-REVIEW.md |
| `F-n` | docs/audit/internal-reviews/M1-REVIEW.md | SYNC-DESIGN §0.0f (revision 7); docs/design/notes/M1-NOTES.md |
| `S-n` | docs/audit/internal-reviews/M1-REVIEW.md (spec observations) | SYNC-DESIGN §0.0f (revision 7) |
| `M1-n` | docs/design/notes/M1-NOTES.md (decision table) | SYNC-DESIGN §0.0f/§0.0h |
| `M2R-n` | docs/audit/internal-reviews/M2-REVIEW.md | docs/design/notes/M2-NOTES.md §8; SYNC-DESIGN §0.0l |
| `RR-n` | docs/audit/internal-reviews/M2-REREVIEW.md | docs/design/notes/M2-NOTES.md §8.4; SYNC-DESIGN §0.0m |
| `M3R-n` | docs/audit/internal-reviews/M3-REVIEW.md | docs/design/notes/M3-NOTES.md (findings table, revision 2) |
| `M3RR-n` | docs/audit/internal-reviews/M3-REREVIEW.md | docs/design/notes/M3-NOTES.md (revision 3); SYNC-DESIGN §0.0s |
| `R3R-n` | M3-R3-REVIEW (third M3 review; report not retained) | docs/design/notes/M3-NOTES.md §0b; SYNC-DESIGN §0.0t |
| `R4R-n` | M3-R4-REVIEW (fourth M3 review; report not retained) | docs/design/notes/M3-NOTES.md §0a |
| `R5R-n` | M3-R5-REVIEW (fifth M3 review; report not retained) | docs/design/notes/M3-NOTES.md §0 |
| `MY-n` | docs/design/notes/M3-NOTES.md §7 (the implementer's mutants) | docs/design/notes/M3-NOTES.md §7 |
| `MR-n` | docs/audit/internal-reviews/M3-REVIEW.md §5.2 (the review's mutants) | docs/design/notes/M3-NOTES.md §7 |
| `FIXb`, `FIXa2` | docs/history/PHASE0X-PLAN.md (fix packages FIXb, FIXa2) | docs/audit/internal-reviews/GM2-REVIEW.md |

Families without a dash, used mostly in the server and the contract:

| IDs | Defined in | Tests |
|---|---|---|
| `S1`–`S14`, `T1`–`T3`, `I2` (server review findings) | docs/audit/internal-reviews/M4-REVIEW.md | `api/server/tests/test_review.py` |
| `RR1`–`RR6` (server re-review) | docs/audit/internal-reviews/M4-REREVIEW.md | `api/server/tests/test_rereview.py` |
| `A1`–`A30`, `B1`–`B3` (contract ambiguities and decisions) | docs/design/notes/M4-NOTES.md | the server suite, by topic |
| `N0`–`N29` (contract notes) | contract/M0-NOTES.md | `contract/py/test_contract.py`, `extension/test/unit/contract-*.test.ts` |
| `K0`–`K11` (mutant killers) | docs/audit/internal-reviews/M1-REVIEW.md | `extension/test/unit/sync-crypto-review.test.ts` |
| `M01`–`M45`, `R01`–`R32`, `F01`–… (server mutants) | `api/server/tests/mutation/mutants.py` | `make mutants` |
| `H1`–`H8`, `U1`, `U1b`, `Z1`–`Z6` (Phase 0.x work items) | docs/SYNC-DESIGN.md §9.1; docs/history/PHASE0X-PLAN.md | by package |
| `A1`–`A11` (attacker classes) | docs/SYNC-DESIGN.md §1.2 | — |

Two prefixes are reused with another meaning: `A1`…`A4` and `C1`…`C8` are also Phase 0.x package names
(docs/history/PHASE0X-PLAN.md), and `A1`…`A11` are attacker classes; the context says which.

## Records with record-local IDs

The records of the M6 (sync UI) to budget round, listed below, number their findings `B1`, `M1`, `m1`, `R5`, `N2`,
`m-3` and so on. Those IDs are **only unique inside their record**: `B1` of M6B-REVIEW.md, of M6C-REVIEW.md and of
HYPHEN-REVIEW.md are three different findings, and `A1`…`A30`, `B1`…`B3` above are something else again. They are not
scanned for in the tree. Where code or a test cites one, it names the record, for example "HYPHEN review B1". This
section is kept by hand. The records' own "Verdict" lines are in
[README.md](README.md).

| Record | Findings numbered | Cited in product code | Named in tests |
|---|---|---|---|
| docs/audit/internal-reviews/M6A-REVIEW.md | `R1`–`R17` | — | — |
| docs/audit/internal-reviews/M6A-REREVIEW.md (re-review of M6A's fix round) | re-checks `R1`–`R17`; new `N1`–`N5`; questions `Q1`–`Q3` | — | — |
| docs/audit/internal-reviews/M6B-REVIEW.md | `B1`–`B12`; questions `Q1`… | — | — |
| docs/audit/internal-reviews/M6B-REREVIEW.md (re-review of M6B's fix round) | re-checks `B1`–`B12`; new `N1`–`N3`; questions `Q(a)`–`Q(c)` | — | — |
| docs/audit/internal-reviews/M6C-REVIEW.md | `B1`, `M1`, `m1`–`m9` | — | — |
| docs/audit/internal-reviews/QUICKPIN-REVIEW.md | `M1`, `M2`, `m1`–`m10` | — | — |
| docs/audit/internal-reviews/PWUX-REVIEW.md | `B1`, `M1`, `m1`–`m6` | — | — |
| docs/audit/internal-reviews/ENROLLV2-REVIEW.md | `R-1`–`R-12` | — | — |
| docs/audit/internal-reviews/HYPHEN-REVIEW.md | `B1`, `M1`–`M3`, `m1`–`m6` | `src/options/Backup.tsx` (B1), `src/options/MasterField.tsx` (m2), `src/core/service/pw-format.ts` (M3) | `test/unit/password-entry-review.test.ts`, `test/unit/password-entry-samepw.test.ts` (B1) |
| docs/audit/internal-reviews/BUDGET-REVIEW.md | `M-1`, `m-1`–`m-5`; its mutants `K1`…`K11b` | — | — |

## `GM2-n`: docs/audit/internal-reviews/GM2-REVIEW.md

| ID | Cited in product code | Named in tests |
|---|---|---|
| `GM2-1` | `src/core/service/service.ts`, `src/core/service/sync-flows.ts`, `src/options/Security.tsx` | `test/fault/gm2-crash-matrix.test.ts`, `test/regression/gm2-fixes.test.ts`, `test/unit/service.test.ts`, `test/unit/source-rules.test.ts` |
| `GM2-2` | `src/core/storage/store.ts` | `test/fault/gm2-crash-matrix.test.ts`, `test/helpers/store-main.ts`, `test/regression/gm2-fixes.test.ts` |
| `GM2-3` | `src/core/service/service.ts`, `src/core/storage/store.ts` | `test/fault/gm2-crash-matrix.test.ts`, `test/fault/keychange-marker.test.ts`, `test/helpers/store-main.ts`, `test/regression/a2-review.test.ts`, `test/regression/gm2-fixes.test.ts` |
| `GM2-4` | `src/core/service/service.ts`, `src/core/service/sync-flows.ts`, `src/core/storage/store.ts` | `test/fault/gm2-crash-matrix.test.ts`, `test/fault/keychange-marker.test.ts`, `test/helpers/store-main.ts`, `test/regression/gm2-fixes.test.ts` |
| `GM2-5` | `src/core/sync/crypto/adoption.ts`, `src/core/sync/crypto/bundle-eval.ts`, `src/core/sync/crypto/capability.ts`, `src/core/sync/crypto/presend.ts`, `src/core/sync/engine/engine.ts`, `src/core/sync/engine/keys.ts`, `src/core/sync/local/identity.ts`, `src/core/sync/local/pins.ts` | `test/fault/m2-local-tail-lost.test.ts`, `test/helpers/m2-crash.ts`, `test/helpers/m2-world.ts`, `test/regression/m2-rereview.test.ts`, `test/regression/m2-review.test.ts`, `test/regression/m2-service.test.ts`, `test/unit/m2-sync-local.test.ts`, `test/unit/m3-keys.test.ts`, `test/unit/m3-repair.test.ts`, `test/unit/sync-crypto-adoption.test.ts`, `test/unit/sync-crypto-m2.test.ts` |
| `GM2-7` | `src/core/storage/store.ts` | `test/helpers/store-main.ts`, `test/regression/gm2-fixes.test.ts`, `test/regression/m2-store.test.ts` |
| `GM2-10` | `src/core/service/service.ts` | `test/regression/gm2-fixes.test.ts` |
| `GM2-11` | `src/core/storage/store.ts` | `test/helpers/store-main.ts`, `test/unit/source-rules.test.ts` |
| `GM2-12` | — | `test/fault/gm2-crash-matrix.test.ts`, `test/regression/gm2-fixes.test.ts` |
| `GM2-13` | `scripts/i18n/a4.py`, `src/core/service/service.ts`, `src/options/Reset.tsx` | `test/regression/gm2-fixes.test.ts`, `test/unit/source-rules.test.ts` |
| `GM2-15` | `src/core/service/service.ts` | `test/regression/m2-service.test.ts` |

## `A4R-n`: docs/audit/internal-reviews/A4-REVIEW.md

| ID | Cited in product code | Named in tests |
|---|---|---|
| `A4R-1` | `scripts/i18n/a4.py`, `src/core/service/service.ts`, `src/options/App.tsx`, `src/options/Reset.tsx`, `src/popup/screens/Locked.tsx` | `test/e2e/flows.spec.ts`, `test/e2e/reset.spec.ts`, `test/fault/security-log-crash.test.ts`, `test/helpers/vaults.ts`, `test/unit/source-rules.test.ts` |
| `A4R-2` | `src/core/service/service.ts` | `test/fault/security-log-crash.test.ts`, `test/regression/gm2-fixes.test.ts` |
| `A4R-3` | `src/core/storage/store.ts` | `test/helpers/store-main.ts`, `test/regression/gm2-fixes.test.ts`, `test/regression/m2-store.test.ts` |
| `A4R-4` | `src/core/service/service.ts`, `src/core/sync/engine/state.ts`, `src/core/sync/local/port.ts`, `src/core/sync/local/records.ts`, `src/core/sync/local/sync-local.ts` | `test/regression/gm2-fixes.test.ts`, `test/regression/m2-records.test.ts`, `test/unit/m2-source-rules.test.ts`, `test/unit/m2-sync-local.test.ts` |
| `A4R-5` | `src/core/service/service.ts` | `test/fault/security-log-crash.test.ts`, `test/helpers/vaults.ts`, `test/unit/source-rules.test.ts` |
| `A4R-7` | `src/core/storage/store.ts` | `test/helpers/store-main.ts` |
| `A4R-8` | `scripts/i18n/a4.py`, `src/options/Reset.tsx` | `test/e2e/reset.spec.ts` |
| `A4R-10` | — | `test/helpers/m2-crash.ts`, `test/helpers/m3-crash.ts`, `test/unit/m2-sync-local.test.ts` |
| `A4R-12` | `src/core/service/service.ts` | `test/regression/m2-service.test.ts` |
| `A4R-13` | — | `test/regression/gm2-fixes.test.ts` |

## `A3-n`: docs/audit/internal-reviews/A3-REVIEW.md

| ID | Cited in product code | Named in tests |
|---|---|---|
| `A3-3` | — | `test/unit/security-log.test.ts` |
| `A3-4` | `src/options/Backup.tsx` | — |
| `A3-5` | — | `test/fault/security-log-crash.test.ts` |
| `A3-9` | `src/core/service/service.ts` | `test/e2e/reset.spec.ts`, `test/regression/gm2-fixes.test.ts` |

## `C6-n`: docs/audit/internal-reviews/C6-REVIEW.md

| ID | Cited in product code | Named in tests |
|---|---|---|
| `C6-1` | `src/core/service/service.ts`, `src/core/service/sync-flows.ts`, `src/options/Security.tsx` | `test/e2e/export.spec.ts`, `test/e2e/reset.spec.ts`, `test/regression/gm2-fixes.test.ts`, `test/unit/export-gate.test.ts` |
| `C6-2` | `src/core/backup/subset.ts`, `src/options/Backup.tsx`, `src/options/SubsetPicker.tsx` | `test/e2e/export-selection.spec.ts`, `test/unit/backup-subset.test.ts` |
| `C6-3` | — | `test/e2e/export-selection.spec.ts`, `test/e2e/export.spec.ts`, `test/unit/backup-subset-fuzz.test.ts`, `test/unit/backup-subset.test.ts` |
| `C6-4` | `src/options/Backup.tsx` | `test/e2e/export.spec.ts` |
| `C6-5` | `src/options/Backup.tsx` | — |
| `C6-6` | `src/options/Backup.tsx` | `test/e2e/export.spec.ts` |
| `C6-7` | `src/options/SubsetPicker.tsx` | `test/e2e/export-selection.spec.ts` |
| `C6-8` | `src/core/backup/subset.ts`, `src/core/service/sync-flows.ts` | `test/regression/m2-service.test.ts` |

## `P-n`: docs/audit/internal-reviews/A2-REVIEW.md

| ID | Cited in product code | Named in tests |
|---|---|---|
| `P-1` | `src/core/storage/store.ts`, `src/core/sync/engine/keys.ts` | `test/helpers/store-main.ts`, `test/regression/a2-review.test.ts`, `test/unit/m3-review.test.ts` |
| `P-2` | `src/core/storage/store.ts` | `test/helpers/store-main.ts`, `test/regression/a2-review.test.ts`, `test/unit/m3-review.test.ts` |
| `P-3` | `src/core/storage/store.ts`, `src/core/sync/engine/enroll.ts` | `test/helpers/store-main.ts`, `test/regression/a2-review.test.ts`, `test/unit/m3-review.test.ts` |
| `P-4` | `src/core/storage/store.ts` | `test/helpers/store-main.ts`, `test/regression/a2-review.test.ts` |
| `P-5` | `src/core/service/service.ts`, `src/core/storage/store.ts` | `test/fault/gm2-crash-matrix.test.ts`, `test/helpers/store-main.ts`, `test/regression/a2-review.test.ts`, `test/regression/gm2-fixes.test.ts`, `test/regression/m2-service.test.ts` |
| `P-6` | `src/core/storage/store.ts` | `test/fault/keychange-marker.test.ts`, `test/helpers/store-main.ts`, `test/regression/a2-review.test.ts` |
| `P-7` | `src/core/service/service.ts` | `test/regression/a2-review.test.ts` |
| `P-8` | `src/core/service/service.ts` | `test/regression/m2-service.test.ts` |
| `P-384` | `contract/tools/gen-vectors.mjs` | `test/unit/sync-crypto-hygiene.test.ts` |

## `F-n`: docs/audit/internal-reviews/M1-REVIEW.md

| ID | Cited in product code | Named in tests |
|---|---|---|
| `F-01` | `api/server/sixkey_server/constants.py`, `api/server/sixkey_server/wire.py`, `contract/py/sixkey_contract.py`, `contract/tools/gen-vectors.mjs`, `src/core/sync/crypto/adoption.ts`, `src/core/sync/crypto/constants.ts`, `src/core/sync/crypto/errors.ts`, `src/core/sync/crypto/keybundle.ts` | `api/server/tests/test_keys.py`, `test/unit/contract-vectors.test.ts`, `test/unit/sync-crypto-adoption-crypto.test.ts`, `test/unit/sync-crypto-adoption.test.ts`, `test/unit/sync-crypto-review.test.ts` |
| `F-02` | `src/core/sync/crypto/adoption.ts` | `test/unit/sync-crypto-adoption-crypto.test.ts`, `test/unit/sync-crypto-adoption.test.ts`, `test/unit/sync-crypto-presend.test.ts` |
| `F-03` | `src/core/sync/crypto/bundle-eval.ts`, `src/core/sync/crypto/errors.ts`, `src/core/sync/crypto/presend.ts`, `src/core/sync/local/identity.ts` | `test/unit/sync-crypto-adoption-crypto.test.ts`, `test/unit/sync-crypto-presend.test.ts` |
| `F-06` | `src/core/sync/crypto/bundle-eval.ts`, `src/core/sync/crypto/keybundle.ts`, `src/core/sync/local/identity.ts` | `test/unit/sync-crypto-adoption-crypto.test.ts`, `test/unit/sync-crypto-adoption.test.ts` |
| `F-07` | `src/core/sync/crypto/adoption.ts`, `src/core/sync/crypto/bundle-eval.ts`, `src/core/sync/crypto/keybundle.ts`, `src/core/sync/crypto/presend.ts`, `src/core/sync/local/identity.ts` | `test/regression/m2-service.test.ts`, `test/unit/sync-crypto-adoption-crypto.test.ts`, `test/unit/sync-crypto-adoption.test.ts`, `test/unit/sync-crypto-presend.test.ts` |
| `F-08` | `src/core/sync/crypto/index.ts` | `test/unit/sync-crypto-presend.test.ts` |
| `F-09` | `src/core/sync/crypto/capability.ts`, `src/core/sync/crypto/enroll-approver.ts`, `src/core/sync/crypto/presend.ts` | `test/unit/sync-crypto-enroll.test.ts` |
| `F-10` | `contract/py/sixkey_contract.py`, `contract/tools/gen-vectors.mjs`, `src/core/sync/crypto/enroll-approver.ts`, `src/core/sync/crypto/enroll-new-device.ts` | `api/server/tests/test_enroll.py`, `test/helpers/contract.ts`, `test/unit/m3-fake-server.test.ts`, `test/unit/sync-crypto-enroll.test.ts` |
| `F-11` | `src/core/service/service.ts`, `src/core/sync/crypto/cap-previous.ts`, `src/core/sync/engine/keys.ts` | `test/unit/sync-crypto-adoption-crypto.test.ts` |

## `S-n`: docs/audit/internal-reviews/M1-REVIEW.md (spec observations)

| ID | Cited in product code | Named in tests |
|---|---|---|
| `S-2` | `api/server/sixkey_server/wire.py`, `contract/py/sixkey_contract.py`, `contract/tools/gen-vectors.mjs` | `api/server/tests/test_keys.py`, `test/helpers/fake-server.ts`, `test/unit/contract-vectors.test.ts` |
| `S-5` | `src/core/sync/crypto/adoption.ts`, `src/core/sync/crypto/cap-previous.ts` | `test/unit/sync-crypto-adoption-crypto.test.ts`, `test/unit/sync-crypto-adoption.test.ts` |

## `M1-n`: docs/design/notes/M1-NOTES.md (decision table)

| ID | Cited in product code | Named in tests |
|---|---|---|
| `M1-2` | `src/core/sync/crypto/adoption.ts` | — |
| `M1-2b` | `src/core/sync/crypto/adoption.ts`, `src/core/sync/crypto/bundle-eval.ts` | `test/unit/sync-crypto-adoption-crypto.test.ts` |
| `M1-3` | — | `test/unit/sync-crypto-adoption-crypto.test.ts` |
| `M1-4` | `src/core/sync/crypto/adoption.ts` | `test/unit/sync-crypto-presend.test.ts` |
| `M1-5` | `src/core/sync/crypto/presend.ts` | — |
| `M1-18` | `src/core/sync/engine/enroll.ts` | — |
| `M1-19` | `src/core/sync/crypto/capability.ts`, `src/core/sync/engine/enroll.ts`, `src/core/sync/engine/keys.ts` | — |

## `M2R-n`: docs/audit/internal-reviews/M2-REVIEW.md

| ID | Cited in product code | Named in tests |
|---|---|---|
| `M2R-1` | `src/core/sync/local/pins.ts` | `test/helpers/m2-crash.ts`, `test/regression/m2-review.test.ts`, `test/unit/m2-sync-local.test.ts`, `test/unit/m3-edges.test.ts` |
| `M2R-2` | `src/core/sync/crypto/presend.ts` | `test/fault/m2-local-tail-lost.test.ts`, `test/regression/m2-review.test.ts`, `test/unit/m3-repair.test.ts`, `test/unit/sync-crypto-m2.test.ts` |
| `M2R-3` | `src/core/service/service.ts` | `test/regression/m2-review.test.ts` |
| `M2R-4` | `src/core/sync/crypto/capability.ts` | `test/regression/m2-review.test.ts` |
| `M2R-5` | — | `test/regression/m2-review.test.ts` |
| `M2R-6` | `src/core/sync/local/identity.ts`, `src/core/sync/local/sync-local.ts` | `test/regression/m2-review.test.ts`, `test/unit/m2-sync-local.test.ts` |
| `M2R-7` | `src/core/sync/local/record-writers.ts`, `src/core/sync/local/records.ts`, `src/core/sync/local/sync-local.ts` | `test/regression/m2-review.test.ts`, `test/unit/m2-sync-local.test.ts` |
| `M2R-8` | — | `test/unit/m2-source-rules.test.ts` |
| `M2R-9` | `src/core/service/sync-flows.ts` | `test/regression/m2-service.test.ts` |
| `M2R-10` | — | `test/regression/m2-review.test.ts` |
| `M2R-11` | `src/core/service/sync-flows.ts` | `test/regression/m2-service.test.ts` |
| `M2R-12` | — | `test/regression/m2-records.test.ts`, `test/unit/sync-crypto-adoption.test.ts`, `test/unit/sync-crypto-m2.test.ts` |
| `M2R-14` | — | `test/fault/m2-crash-matrix.test.ts`, `test/helpers/m2-crash.ts` |
| `M2R-17` | `src/core/service/sync-flows.ts` | — |
| `M2R-18` | — | `test/regression/m2-review.test.ts` |

## `RR-n`: docs/audit/internal-reviews/M2-REREVIEW.md

| ID | Cited in product code | Named in tests |
|---|---|---|
| `RR-1` | `src/core/service/sync-flows.ts`, `src/core/sync/crypto/capability.ts`, `src/core/sync/crypto/presend.ts`, `src/core/sync/engine/engine.ts`, `src/core/sync/engine/keys.ts` | `test/regression/m2-rereview.test.ts`, `test/unit/m3-edges.test.ts`, `test/unit/sync-crypto-m2.test.ts` |
| `RR-2` | `src/core/service/sync-flows.ts`, `src/core/sync/crypto/capability.ts` | `test/regression/m2-rereview.test.ts` |
| `RR-3` | `src/core/service/sync-flows.ts`, `src/core/sync/engine/enroll.ts`, `src/core/sync/local/pins.ts`, `src/core/sync/local/sync-local.ts` | `test/regression/m2-rereview.test.ts`, `test/regression/m2-review.test.ts`, `test/unit/m2-sync-local.test.ts` |
| `RR-3b` | — | `test/regression/m2-rereview.test.ts` |
| `RR-4` | `src/core/sync/local/identity.ts`, `src/core/sync/local/pins.ts` | `test/regression/m2-rereview.test.ts`, `test/regression/m2-review.test.ts`, `test/unit/m2-sync-local.test.ts` |
| `RR-5` | — | `test/regression/m2-rereview.test.ts` |
| `RR-6` | `src/core/sync/engine/keys.ts`, `src/core/sync/engine/state.ts` | `test/regression/m2-rereview.test.ts` |
| `RR-7` | `src/core/sync/local/pins.ts` | `test/fault/m2-crash-settle.test.ts`, `test/helpers/m2-crash.ts`, `test/unit/m2-settle-reads.test.ts`, `test/unit/m2-sync-local.test.ts` |
| `RR-8` | — | `test/regression/m2-rereview.test.ts`, `test/unit/m2-sync-local.test.ts` |
| `RR-9` | `src/core/sync/local/pins.ts` | `test/unit/m2-sync-local.test.ts` |
| `RR-10` | `src/core/sync/engine/engine.ts`, `src/core/sync/engine/keys.ts` | — |
| `RR-11` | `scripts/i18n/m2.py`, `src/options/shared.tsx` | `test/unit/m2-source-rules.test.ts` |
| `RR-12` | `src/core/service/sync-flows.ts`, `src/core/sync/engine/engine.ts`, `src/core/sync/engine/enroll.ts` | `test/unit/m3-edges.test.ts`, `test/unit/m3-enroll.test.ts`, `test/unit/m3-review.test.ts` |

## `M3R-n`: docs/audit/internal-reviews/M3-REVIEW.md

| ID | Cited in product code | Named in tests |
|---|---|---|
| `M3R-1` | `src/core/sync/engine/engine.ts`, `src/core/sync/engine/keys.ts` | `test/fault/m3-crash-round.test.ts`, `test/fault/m3-model.test.ts`, `test/unit/m3-read-budget.test.ts`, `test/unit/m3-review.test.ts` |
| `M3R-2` | `src/core/sync/engine/keys.ts` | `test/unit/m3-review.test.ts` |
| `M3R-3` | `src/core/sync/engine/enroll.ts`, `src/core/sync/engine/keys.ts` | `test/unit/m3-keys.test.ts`, `test/unit/m3-review.test.ts` |
| `M3R-4` | `src/core/sync/engine/engine.ts` | `test/unit/m3-review.test.ts` |
| `M3R-5` | `src/core/sync/engine/engine.ts`, `src/core/sync/engine/enroll.ts` | `test/unit/m3-rereview.test.ts`, `test/unit/m3-review.test.ts` |
| `M3R-6` | `src/core/sync/engine/enroll.ts` | `test/unit/m3-review.test.ts` |
| `M3R-7` | `src/core/sync/engine/engine.ts`, `src/core/sync/engine/keys.ts` | `test/unit/m3-review.test.ts`, `test/unit/m3rr-probes.test.ts` |
| `M3R-8` | `src/core/sync/engine/keys.ts` | `test/unit/m3-review.test.ts` |
| `M3R-9` | `src/core/sync/engine/engine.ts`, `src/core/sync/engine/enroll.ts` | `test/unit/m3-orphan.test.ts`, `test/unit/m3-rereview.test.ts`, `test/unit/m3-rev20.test.ts`, `test/unit/m3-review.test.ts`, `test/unit/m3rr-probes.test.ts` |
| `M3R-10` | `src/core/sync/engine/engine.ts` | `test/unit/m3-edges.test.ts` |
| `M3R-11` | — | `test/unit/m3-review.test.ts` |
| `M3R-12` | `src/core/sync/engine/engine.ts` | `test/unit/m3-review.test.ts` |
| `M3R-13` | `src/core/sync/engine/api.ts` | `test/unit/m3-review.test.ts` |
| `M3R-14` | `src/core/sync/engine/engine.ts`, `src/core/sync/engine/keys.ts` | `test/unit/m3-review.test.ts`, `test/unit/m3rr-probes.test.ts` |
| `M3R-15` | `src/core/sync/engine/engine.ts` | `test/unit/m3-rereview.test.ts`, `test/unit/m3-review.test.ts`, `test/unit/m3rr-probes.test.ts` |

## `M3RR-n`: docs/audit/internal-reviews/M3-REREVIEW.md

| ID | Cited in product code | Named in tests |
|---|---|---|
| `M3RR-1` | `src/core/sync/engine/keys.ts` | `test/unit/m3-rereview.test.ts`, `test/unit/m3rr-rotation-fuzz.test.ts` |
| `M3RR-2` | `src/core/sync/engine/engine.ts` | `test/unit/m3-rereview.test.ts`, `test/unit/m3-review.test.ts` |
| `M3RR-3` | — | `test/regression/m2-store.test.ts`, `test/unit/m3-orphan.test.ts`, `test/unit/m3-rereview.test.ts`, `test/unit/m3-review.test.ts` |
| `M3RR-4` | `src/core/sync/engine/keys.ts` | `test/unit/m3-rereview.test.ts` |
| `M3RR-5` | `src/core/sync/engine/keys.ts` | — |
| `M3RR-6` | `src/core/sync/engine/engine.ts`, `src/core/sync/engine/keys.ts` | — |
| `M3RR-7` | `src/core/sync/engine/enroll.ts`, `src/core/sync/engine/state.ts` | `test/unit/m3-review.test.ts`, `test/unit/m3rr-probes.test.ts` |
| `M3RR-8` | `src/core/sync/engine/enroll.ts` | `test/unit/m3-rev20.test.ts`, `test/unit/m3r5-review-killers.test.ts` |
| `M3RR-9` | `src/core/sync/engine/engine.ts` | `test/unit/m3-rereview.test.ts` |
| `M3RR-10` | `src/core/sync/engine/engine.ts` | `test/unit/m3-review.test.ts` |
| `M3RR-11` | — | `test/unit/m3-rereview.test.ts` |
| `M3RR-12` | `src/core/sync/engine/engine.ts` | `test/unit/m3-rereview.test.ts` |
| `M3RR-13` | — | `test/helpers/m3-model.ts`, `test/unit/m3rr-replay.test.ts` |

## `R3R-n`: M3-R3-REVIEW (third M3 review; report not retained)

| ID | Cited in product code | Named in tests |
|---|---|---|
| `R3R-1` | `src/core/sync/engine/engine.ts`, `src/core/sync/engine/state.ts`, `src/core/sync/local/outbox.ts` | `test/helpers/m3-model.ts`, `test/unit/m3-engine-units.test.ts`, `test/unit/m3-rev20.test.ts`, `test/unit/m3r3-review-probes.test.ts` |
| `R3R-1b` | — | `test/unit/m3r3-review-probes.test.ts` |
| `R3R-1c` | — | `test/unit/m3r3-review-probes.test.ts` |
| `R3R-1d` | — | `test/unit/m3r3-review-probes.test.ts` |
| `R3R-2` | `src/core/sync/engine/engine.ts`, `src/core/sync/engine/keys.ts`, `src/core/sync/engine/orphans.ts`, `src/core/sync/local/sync-local.ts` | `test/unit/m3-rev20.test.ts`, `test/unit/m3r4-review-probes.test.ts` |
| `R3R-2a` | — | `test/unit/m3r3-review-probes.test.ts` |
| `R3R-2b` | — | `test/unit/m3r3-review-probes.test.ts` |
| `R3R-3` | `src/core/sync/engine/engine.ts`, `src/core/sync/engine/keys.ts` | `test/unit/m3-rev20.test.ts`, `test/unit/m3r3-review-probes.test.ts` |
| `R3R-4` | `src/core/sync/engine/orphans.ts`, `src/core/sync/engine/state.ts` | `test/unit/m3-orphan.test.ts`, `test/unit/m3-rev20.test.ts`, `test/unit/m3r3-review-probes.test.ts`, `test/unit/m3r4-review-probes.test.ts` |
| `R3R-5` | `src/core/sync/engine/engine.ts`, `src/core/sync/engine/state.ts`, `src/core/sync/local/outbox.ts` | `test/fault/m3-faults.test.ts`, `test/helpers/m3-model.ts`, `test/unit/m2-sync-local.test.ts`, `test/unit/m3-engine-units.test.ts`, `test/unit/m3-rev20.test.ts`, `test/unit/m3r3-review-probes.test.ts`, `test/unit/m3r4-review-probes.test.ts` |
| `R3R-6` | `src/core/sync/engine/enroll.ts` | `test/unit/m3-rev20.test.ts`, `test/unit/m3r3-review-probes.test.ts` |
| `R3R-7` | — | `test/unit/m3r3-review-probes.test.ts` |

## `R4R-n`: M3-R4-REVIEW (fourth M3 review; report not retained)

| ID | Cited in product code | Named in tests |
|---|---|---|
| `R4R-1` | `src/core/service/sync-flows.ts`, `src/core/sync/engine/engine.ts`, `src/core/sync/engine/enroll.ts`, `src/core/sync/local/sync-local.ts` | `test/unit/m2-sync-local.test.ts`, `test/unit/m3r4-review-probes.test.ts`, `test/unit/m3r5-review-probes.test.ts` |
| `R4R-2` | `src/core/sync/engine/engine.ts` | `test/unit/m3r4-review-probes.test.ts`, `test/unit/m3r5-review-probes.test.ts` |
| `R4R-2b` | — | `test/unit/m3r4-review-probes.test.ts` |
| `R4R-3` | `src/core/sync/engine/keys.ts` | `test/unit/m3r4-review-probes.test.ts`, `test/unit/m3r5-review-probes.test.ts` |
| `R4R-4` | `src/core/sync/local/outbox.ts` | `test/unit/m2-sync-local.test.ts`, `test/unit/m3r4-review-probes.test.ts` |
| `R4R-5` | `src/core/sync/engine/engine.ts`, `src/core/sync/engine/orphans.ts`, `src/core/sync/local/outbox.ts` | `test/unit/m3-rev20.test.ts`, `test/unit/m3r4-review-probes.test.ts` |
| `R4R-6` | — | `test/unit/m3r4-review-probes.test.ts` |
| `R4R-7` | `src/core/sync/engine/orphans.ts` | `test/unit/m3r4-review-probes.test.ts` |
| `R4R-8` | `src/core/sync/engine/orphans.ts`, `src/core/sync/engine/state.ts` | `test/unit/m3r4-review-killers.test.ts`, `test/unit/m3r4-review-probes.test.ts`, `test/unit/m3r5-review-probes.test.ts` |
| `R4R-9` | — | `test/unit/m3r4-review-probes.test.ts` |
| `R4R-10` | — | `test/unit/m3r4-review-probes.test.ts` |
| `R4R-11` | — | `test/fault/m3r4-review-crash.test.ts`, `test/unit/m3r4-review-probes.test.ts` |
| `R4R-12` | — | `test/unit/m3r4-review-probes.test.ts` |
| `R4R-14` | `src/core/sync/engine/orphans.ts` | `test/unit/m3r4-review-killers.test.ts`, `test/unit/m3r4-review-probes.test.ts` |

## `R5R-n`: M3-R5-REVIEW (fifth M3 review; report not retained)

| ID | Cited in product code | Named in tests |
|---|---|---|
| `R5R-1` | `src/core/sync/engine/enroll.ts` | `test/unit/m3-rev20.test.ts`, `test/unit/m3r5-review-probes.test.ts` |
| `R5R-2` | `src/core/sync/local/sync-local.ts` | `test/unit/m2-sync-local.test.ts`, `test/unit/m3-rev20.test.ts`, `test/unit/m3r5-review-probes.test.ts` |
| `R5R-3` | `src/core/sync/engine/orphans.ts`, `src/core/sync/engine/state.ts` | `test/fault/m3r4-review-crash.test.ts`, `test/unit/m3-rev20.test.ts`, `test/unit/m3r4-review-probes.test.ts`, `test/unit/m3r5-review-probes.test.ts` |

## `MY-n`: docs/design/notes/M3-NOTES.md §7 (the implementer's mutants)

| ID | Cited in product code | Named in tests |
|---|---|---|
| `MY-01` | — | `test/unit/m3-rereview.test.ts` |
| `MY-04` | — | `test/unit/m3-rereview.test.ts` |
| `MY-07` | — | `test/unit/m3-rereview.test.ts` |
| `MY-08a` | — | `test/unit/m3-rereview.test.ts` |
| `MY-10` | — | `test/unit/m3-rereview.test.ts` |
| `MY-11` | — | `test/unit/m3-rereview.test.ts` |
| `MY-17` | — | `test/unit/m3-rereview.test.ts` |
| `MY-18` | — | `test/unit/m3-rereview.test.ts` |
| `MY-19` | — | `test/unit/m3-rereview.test.ts` |
| `MY-23` | — | `test/unit/m3-rereview.test.ts` |
| `MY-25` | — | `test/unit/m3-rereview.test.ts` |

## `MR-n`: docs/audit/internal-reviews/M3-REVIEW.md §5.2 (the review's mutants)

| ID | Cited in product code | Named in tests |
|---|---|---|
| `MR-02` | — | `test/unit/m3-review.test.ts` |
| `MR-04` | — | `test/unit/m3-review.test.ts` |
| `MR-06` | — | `test/unit/m3-review.test.ts` |
| `MR-09` | — | `test/unit/m3-review.test.ts` |
| `MR-11` | — | `test/unit/m3-review.test.ts` |
| `MR-12` | — | `test/unit/m3-review.test.ts` |
| `MR-14` | — | `test/unit/m3-review.test.ts` |
| `MR-16` | — | `test/unit/m3-review.test.ts` |
| `MR-19` | — | `test/unit/m3-review.test.ts` |
| `MR-20` | — | `test/unit/m3-review.test.ts` |
| `MR-21` | — | `test/unit/m3-review.test.ts` |
| `MR-22` | — | `test/unit/m3-review.test.ts` |
| `MR-28` | — | `test/unit/m3-review.test.ts` |

## FIXb, FIXa2: docs/history/PHASE0X-PLAN.md (fix packages FIXb, FIXa2)

| ID | Cited in product code | Named in tests |
|---|---|---|
| `FIXb` | `src/core/storage/store.ts` | `test/e2e/reset.spec.ts`, `test/helpers/store-main.ts`, `test/regression/a2-review.test.ts`, `test/regression/gm2-fixes.test.ts`, `test/regression/m2-service.test.ts` |
| `FIXa2` | `src/core/storage/store.ts`, `src/core/sync/engine/engine.ts`, `src/core/sync/engine/keys.ts`, `src/core/sync/engine/orphans.ts` | `test/fault/gm2-crash-matrix.test.ts`, `test/helpers/store-main.ts`, `test/regression/a2-review.test.ts`, `test/regression/gm2-fixes.test.ts`, `test/regression/m2-store.test.ts`, `test/regression/m3r3-review-phase0.test.ts`, `test/unit/m3-orphan.test.ts`, `test/unit/m3-rev20.test.ts` |
