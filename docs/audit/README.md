# Audit trail: internal review records

Sixkey has **not had an external security audit yet.** What this folder holds is the project's internal review trail:
every security-relevant change was reviewed before it was merged, and the reviews were written down.

**What these reviews are.** Each record was written by an AI model (Anthropic's Claude; the records that name the model
say Opus) in a review session separate from the session that wrote the change, at the maintainer's request. The
reviewer read the design and the code, wrote probes that try to break the change, ran its own mutants against the
tests, and gave a verdict. The implementer then fixed the findings or recorded why not, and most probes were adopted
as regression tests. Older documents, including the revision log of `docs/SYNC-DESIGN.md`, call these sessions
"independent reviews" (独立评审). They were independent of the implementing session, **not** of the project: the same
maintainer commissioned both, and the same kind of model did both. A misreading shared by the design, the code and the
reviewer can pass all of them. Treat the records as evidence of process and as a map of what was checked, not as
assurance.

**What was edited.** The records are kept as written, except: the word "independent" was taken out of their headings
and reviewer lines; each has a note at the top; repository paths were updated to the current layout (table below);
absolute local paths were shortened to `scratchpad/…`; and the rows the first M3 review session left as "TODO" are
marked as unfinished.

**What is not here.** Paths under `scratchpad/` were the reviewers' and implementers' temporary working copies. They
were **not retained**: a probe, mutant or log exists only as far as a record quotes it or as it was adopted into the
test suite. The reports of several later review sessions are not in the tree either; where their findings are
recorded is listed below.

## External reviews

None has been done yet. Planned, in this order: a design and cryptography review of the sync protocol before sync is
released, a review of the local vault before the first store listing, and an implementation audit later
([ROADMAP.md](../../ROADMAP.md)).

The maintainer has decided that the reports of external reviews will not be published; the internal records in this
folder are published, with the notes described above. This limits what the public can verify: a reader can check the
internal records against the code and the tests, but cannot check an external reviewer's findings, or how each was
resolved, from this repository.

## The records

| Record                                                                      | Date       | Reviewed                                                                                   | Verdict                                                |
| --------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| [SYNC-DESIGN-REVIEW.md](internal-reviews/SYNC-DESIGN-REVIEW.md)             | 2026-10-15 | the sync design, first version                                                             | findings by severity (no single verdict line)          |
| [SYNC-DESIGN-FINAL-REVIEW.md](internal-reviews/SYNC-DESIGN-FINAL-REVIEW.md) | 2026-10-15 | the sync design, revision 3                                                                | ready after fixes                                      |
| [A1-REVIEW.md](internal-reviews/A1-REVIEW.md)                               | 2026-10-16 | package A1: master password before the first account, first-run flow                       | merge after fixes                                      |
| [A2-REVIEW.md](internal-reviews/A2-REVIEW.md)                               | 2026-10-16 | package A2: the key-change marker and fast popup reads                                     | merge after fixes                                      |
| [A3-REVIEW.md](internal-reviews/A3-REVIEW.md)                               | 2026-10-16 | package A3: password check before exports, the local security record                       | merge after fixes                                      |
| [GM2-REVIEW.md](internal-reviews/GM2-REVIEW.md)                             | 2026-10-16 | A1, A2 and fixes FIXb, FIXa2 as merged: the gate before sync storage work                  | sync storage work (M2) after fixes                     |
| [A4-REVIEW.md](internal-reviews/A4-REVIEW.md)                               | 2026-10-16 | package A4: the fixes for the gate review                                                  | merge after fixes                                      |
| [C6-REVIEW.md](internal-reviews/C6-REVIEW.md)                               | 2026-10-16 | package C6: exporting selected accounts, password before every export                      | findings that block the merge (no single verdict line) |
| [YUBIKEY-REVIEW.md](internal-reviews/YUBIKEY-REVIEW.md)                     | 2026-10-16 | the YubiKey design proposal                                                                | ready after fixes                                      |
| [M1-REVIEW.md](internal-reviews/M1-REVIEW.md)                               | 2026-10-16 | M1: sync cryptography (`src/core/sync/crypto`)                                             | ready after fixes                                      |
| [M2-REVIEW.md](internal-reviews/M2-REVIEW.md)                               | 2026-10-17 | M2: local sync state and the service layer                                                 | merge after fixes                                      |
| [M2-REREVIEW.md](internal-reviews/M2-REREVIEW.md)                           | 2026-10-17 | M2's fixes as merged                                                                       | the engine (M3) after fixes                            |
| [M4-REVIEW.md](internal-reviews/M4-REVIEW.md)                               | 2026-10-17 | M4: the sync API server                                                                    | merge after fixes                                      |
| [M3-REVIEW.md](internal-reviews/M3-REVIEW.md)                               | 2026-10-17 | M3: the sync engine and the test server, as a patch before merge                           | merge after fixes                                      |
| [M4-REREVIEW.md](internal-reviews/M4-REREVIEW.md)                           | 2026-10-18 | M4's fix pass                                                                              | merge                                                  |
| [M3-REREVIEW.md](internal-reviews/M3-REREVIEW.md)                           | 2026-10-18 | M3's revision 2                                                                            | merge after fixes                                      |
| [M6A-REVIEW.md](internal-reviews/M6A-REVIEW.md)                             | 2026-10-19 | M6 stage A: the Sync section of the settings page (turning sync on, joining)               | merge after fixes                                      |
| [M6A-REREVIEW.md](internal-reviews/M6A-REREVIEW.md)                         | 2026-10-19 | a re-review of M6 stage A's fix round (the r2 patch)                                       | merge after fixes (small)                              |
| [M6B-REVIEW.md](internal-reviews/M6B-REVIEW.md)                             | 2026-10-19 | M6 stage B: managing a sync account                                                        | merge after fixes                                      |
| [M6B-REREVIEW.md](internal-reviews/M6B-REREVIEW.md)                         | 2026-10-19 | a re-review of M6 stage B's fix round (the r2 patch)                                       | merge after fixes                                      |
| [M6C-REVIEW.md](internal-reviews/M6C-REVIEW.md)                             | 2026-10-19 | M6 part C: the `server_older_key` repair, find accounts, the dedupe after an approval join | merge after fixes                                      |
| [QUICKPIN-REVIEW.md](internal-reviews/QUICKPIN-REVIEW.md)                   | 2026-10-19 | the quick PIN (QUICK-UNLOCK stage 1)                                                       | merge after fixes                                      |
| [PWUX-REVIEW.md](internal-reviews/PWUX-REVIEW.md)                           | 2026-10-20 | "Generate for me", passphrases, known entropy (the `PWUX-r2` patch)                        | merge after fixes                                      |
| [ENROLLV2-REVIEW.md](internal-reviews/ENROLLV2-REVIEW.md)                   | 2026-10-20 | enrolment v2: the 128-bit pairing code                                                     | merge after fixes                                      |
| [HYPHEN-REVIEW.md](internal-reviews/HYPHEN-REVIEW.md)                       | 2026-10-20 | typing a generated master password back loosely (hyphen tolerance)                         | merge after fixes                                      |
| [BUDGET-REVIEW.md](internal-reviews/BUDGET-REVIEW.md)                       | 2026-10-20 | the read-budget patch: lazily loaded catalogs and the service split                        | merge after fixes                                      |

M3 was merged after further revisions; its notes ([design/notes/M3-NOTES.md](../design/notes/M3-NOTES.md)) record
every finding of these and the later rounds and what was done.

The M6A and M6B re-reviews cover a fix round only, as their headers say; they are not fresh reviews of the whole change.
The changes the later records reviewed are described in
[M6-NOTES.md](../design/notes/M6-NOTES.md), [M6C-NOTES.md](../design/notes/M6C-NOTES.md),
[QUICK-PIN-NOTES.md](../design/notes/QUICK-PIN-NOTES.md), [PASSWORD-SETUP-NOTES.md](../design/notes/PASSWORD-SETUP-NOTES.md),
[ENROLL-V2-NOTES.md](../design/notes/ENROLL-V2-NOTES.md) and [BUDGET-NOTES.md](../design/notes/BUDGET-NOTES.md); not
every note lists the findings one by one (QUICK-PIN-NOTES does not mention its review), so the record is the place to
read them. Each
record keeps its date and verdict as the review gave them; the verdict is the reviewer's, taken before the fixes.

Reviews whose reports were not retained, and where their findings are recorded:

| Review                                                                                              | Findings recorded in                                                          |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| M3-R3-REVIEW, M3-R4-REVIEW, M3-R5-REVIEW (third to fifth M3 reviews; IDs `R3R-n`, `R4R-n`, `R5R-n`) | `docs/design/notes/M3-NOTES.md` §0b, §0a, §0; SYNC-DESIGN §0.0t               |
| M5-REVIEW and the review of M5's second version (IDs such as `D-1`, `M-1`, `L-r2-2`)                | SYNC-DESIGN §0.0u to §0.0w; what was built is `docs/design/notes/M5-NOTES.md` |

SYNC-DESIGN §0.0x also cites `M6A-r2-NOTES`, an earlier version of the M6 notes that is not in the tree; the current
text is `docs/design/notes/M6-NOTES.md`.

## Finding IDs

Code comments and test names cite findings by ID. [INDEX.md](INDEX.md) resolves each one to its record, the code that
cites it and the tests that name it. Tests named after a review (for example `test/regression/m2-review.test.ts`) hold
that review's probes, turned into regression tests of the fix.

The records from M6A on number their findings `B1`, `M1`, `m1` and the like. Those IDs are only unique
inside their record; INDEX.md lists the few that code or tests cite, by record name (for example "HYPHEN review B1").

## Old paths

The documents were reorganised in 2026-10. Older text, including frozen files, may use these paths:

| Old path                                              | Now                                                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `docs/SECURITY.md` (also "SECURITY.md" in older text) | [docs/security/local-vault.md](../security/local-vault.md); the root `SECURITY.md` is now the disclosure policy            |
| `docs/FINGERPRINT-BROWSERS.md`                        | Moved to `docs/guides/FINGERPRINT-BROWSERS.md`, removed on 2026-11-12                                                      |
| `docs/sdk/`, `contract/plugin-sdk/`                   | Removed on 2026-11-12 with the plugin platform, as were `extension/plugins/` (its catalogs and samples)                    |
| `extension/test/fixtures/plugins/`                    | Removed on 2026-11-12 with the plugin platform                                                                             |
| `docs/YUBIKEY-DESIGN.md`                              | `docs/design/proposals/YUBIKEY-DESIGN.md`                                                                                  |
| `docs/M1-NOTES.md` … `docs/M6-NOTES.md`               | `docs/design/notes/`                                                                                                       |
| `docs/*-REVIEW.md`, `docs/*-REREVIEW.md`              | `docs/audit/internal-reviews/`                                                                                             |
| `docs/PHASE0X-PLAN.md`, `docs/M2-HANDOFF.md`          | `docs/history/`                                                                                                            |
| `PLAN.md` (also cited as "PLAN §n" or "PLAN n.n")     | [docs/history/PLAN-zh.md](../history/PLAN-zh.md), the original plan in Chinese; [ROADMAP.md](../../ROADMAP.md) replaced it |

`docs/SYNC-DESIGN.md` was left as it is (the contract's tools read it), so it still names `PLAN.md`, and code comments
cite "PLAN §n": both mean the original plan above. References to `OWNER-DECISIONS/` in code comments and design notes point
to the maintainer's private decision log, which is not part of the public repository; the outcome of each decision is
in the public document it affects (`LICENSE.md`, `SECURITY.md`, `TRADEMARKS.md`, `GOVERNANCE.md`, `ROADMAP.md`,
`docs/SELF-HOSTING.md`).

Two other kinds of reference also point outside the public repository. The short commit hashes cited in design notes
and in a few code comments and tests (for example `2468c75`) belong to the private history before the first public
commit; that history is not published, so those commits are not in the public repository
([RELEASING-THE-TREE.md](../RELEASING-THE-TREE.md)). Decision IDs such as `C7` or `C27` (cited as "the maintainers'
C27") and similar labels refer to the maintainers' decision notes, which are not published either, like the
`OWNER-DECISIONS/` log. "The maintainer", singular, is the project's owner, who keeps that log; "the maintainers" made
day-to-day decisions on the owner's behalf (in the Chinese documents, 所有者 and 维护者).

Two files keep an old path on purpose, because the database migration runner refuses a changed migration file:
`api/server/migrations/0001_sixkey.sql` (line 106, `docs/M4-NOTES.md`) and `api/server/migrations/0002_least_privilege.sql`
(line 1, `docs/M4-REVIEW.md`). `docs/SYNC-DESIGN.md` and `contract/M0-NOTES.md` did not move: the contract's tools and
its vector file name them.
