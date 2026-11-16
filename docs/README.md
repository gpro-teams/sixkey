# Sixkey documentation

Start with the repository [README](../README.md) for what Sixkey is and what state it is in, and
[ROADMAP.md](../ROADMAP.md) for what comes next.

## For users

| Document                                           | What                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| [PRIVACY.md](PRIVACY.md)                           | What the extension stores, where, and what it never does          |
| [security/local-vault.md](security/local-vault.md) | How the local vault is protected, from whom, and its known limits |

## How it works

| Document                                                                 | What                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)                                       | Modules, contexts, data flow, storage layout, trust boundaries, build flavours                                                                                                                                                                                                                                                                                              |
| [SYNC-DESIGN.md](SYNC-DESIGN.md)                                         | The design of end-to-end encrypted sync: threat model (§1), keys and labels (§2), protocol (§3), engine (§4), server (§5), tests (§8), plan (§9). In Chinese; it opens with its revision log (§0.0a onwards) and the design proper starts at §0. An English specification is planned. Its path is fixed: `contract/tools/check_consistency.py` and the vector file name it. |
| [SELF-HOSTING.md](SELF-HOSTING.md)                                       | Why self-hosting is not possible yet, and the chosen model (a separate self-host build)                                                                                                                                                                                                                                                                                     |
| [design/notes/](design/notes/)                                           | Implementation notes per milestone (M1 sync crypto, M2 local sync state, M3 engine, M4 server, M5 wiring, M6 user interface, M6C the items before the release gate): what was built, decisions the design left open, test and mutation results. The contract's notes are [contract/M0-NOTES.md](../contract/M0-NOTES.md).                                                   |
| [design/proposals/YUBIKEY-DESIGN.md](design/proposals/YUBIKEY-DESIGN.md) | Optional YubiKey support: a design proposal, not implemented (in Chinese)                                                                                                                                                                                                                                                                                                   |
| [design/proposals/QUICK-UNLOCK.md](design/proposals/QUICK-UNLOCK.md)     | Quick unlock: a PIN (stage 1, built; since 2026-10-30 it also opens Sixkey after a restart, its record on disk) and unlocking with Touch ID or Windows Hello (stage 2, built); approved design                                                                                                                                                                              |
| [design/proposals/TOTP-AUTOFILL.md](design/proposals/TOTP-AUTOFILL.md)   | Putting the code into the page: Stage 1 (Fill button and shortcut) is built ([notes](design/notes/AUTOFILL1-NOTES.md)); Stage 2 patch 1 (the shortcut while locked: unlock, then filled) is built ([notes](design/notes/AUTOFILL2-NOTES.md)); the rest of Stage 2 and Stage 3 (suggestions on sites the user turns on, a rule corpus) are proposals                         |
| [design/proposals/CLOUD-BACKUP.md](design/proposals/CLOUD-BACKUP.md)     | One-click backup to the user's own Google Drive: superseded. Its Google Drive path was built ([notes](design/notes/CLOUDBK-NOTES.md)), withdrawn on 2026-11-06 and replaced by the backup in Chrome sync on 2026-11-08 (next row); backing up to a chosen file in iCloud Drive or another drive is not started                                                              |
| [design/notes/CSB-NOTES.md](design/notes/CSB-NOTES.md)                   | The backup in Chrome's sync storage, in the build from 2026-11-08: what was built, the layout in `chrome.storage.sync`, the write rule, the records and messages, what its status may claim, capacity, known limits, tests and sizes                                                                                                                                        |

## Audit trail

| Document                                           | What                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| [audit/README.md](audit/README.md)                 | The internal review records: what each covered, its verdict, and how to read them |
| [audit/INDEX.md](audit/INDEX.md)                   | Every finding ID cited in the code, resolved to its record and its tests          |
| [audit/internal-reviews/](audit/internal-reviews/) | The records themselves (AI-model review sessions, not third-party audits)         |

## Testing and history

| Document                                       | What                                                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OWNER-CHECKLIST.md](OWNER-CHECKLIST.md)       | The manual checks automated tests cannot do, run on a real Chrome before a release (in Chinese)                                                                  |
| [research/](research/)                         | Background research: security incidents of other authenticators and extensions, antidetect browsers, MCP, UX, YubiKey OATH (in Chinese)                          |
| [history/](history/)                           | The original product plan (`PLAN-zh.md`, in Chinese, replaced by the roadmap) and the internal planning documents of Phase 0.x, kept for the record; not current |
| [RELEASING-THE-TREE.md](RELEASING-THE-TREE.md) | How the first public commit is cut from the working tree, and the repository settings to switch on                                                               |
