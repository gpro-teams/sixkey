# M6C notes: what the release gate still waited for

`docs/SYNC-DESIGN.md` revision 25, §9 M8 item 17, lists what must be done before the release gate of the sync user
interface opens (`scripts/sync-ui.mjs`), and what may come later. This package builds four of those items, on top of
M6 (`docs/design/notes/M6-NOTES.md`):

1. the repair of `server_older_key` (§4.2: the server went back to an older vault key), so that every card that pauses
   sync has a way out (§1 below);
2. "find accounts" (§6 O13, D6's backstop): the server's history and this device's snapshots, in the Sync section (§2);
3. the dedupe after an approval join (§3.5, revision 24), listed as "may come later", built here as asked (§3);
4. the sentence `docs/security/local-vault.md` owes about what opens a locked page with sync on, and the same in
   `SECURITY.md` (§4).

Not here, as asked: the flip of the gate itself, the store link of "Update Sixkey", and the run on the old browser
engines (Chromium 120 and 134). `SYNC-DESIGN.md`, `api/` and `contract/` are not changed, and none needed to be: the
server's `POST /v1/keys/rotate` already serves the repair (its contract summary says "also: repair the cloud from this
device"), and its history endpoints (`GET /v1/vault/versions`, `GET /v1/vault/versions/{v}`, which §4.3's walk back
already uses) are what find accounts reads.

This is the second version. An independent review of the first found one blocker (the repair sent a password verifier
it had not checked), one major fault (the devices to revoke again came from a list that could miss them) and nine
smaller points; each is fixed as the sections below describe, or listed with the reason it is not (§9). The rules the
design does not have yet are collected for the design author in §9.

---

## 1. The repair of `server_older_key`

**The case.** An honest restore of the server's database to a point before a rotation (a point-in-time restore, PITR)
puts the server back on the old vault key VK1, its K_write and its bundle. Every device that took the rotation holds VK2,
with VK1 in its keyring's previous list, and stops at §4.2 step 2 ("the server went back to older keys"): no device
goes back to VK1 (F7), and until now nothing moved the server forward, so every one of them stayed paused. Part B left
the card with Sync now only (M6-NOTES §13.5 item 3).

**The rule as built** (engine `keys.ts repairKeys`, `revokeAgain`, `republishOverOlderKey`; `devices.ts
revokedBeforeRestore`; the card `model.ts`; the flow and form part B built for `keys_behind`, `repair.ts` and
`RepairView`):

1. **Offered** on the `server_older_key` card, as [Repair the cloud from this device] beside [Sync now] (a repair made
   on another device clears the card with the next round). While the card is up the key operations wait, as they do
   for `keys_behind` (§3.14: they would be refused at the pre-send check anyway).
2. **The form** asks for the current master password, the password the server's keys use if it differs (the restore may
   cross a password change), and this device's recovery key; and it names the devices the repair will revoke again
   first (item 5). When the server's keys need the password of that time, the form stays open and says so
   (`old_password_required`), as it does for a typo.
3. **Every local check comes before anything is sent.** The pre-send check (§3.14) runs against the server's current
   bundle, verified with the older VK this device's previous list really unwraps (R0); the password of the server's keys
   must open that bundle's password wrap, and its `auth.kdf` gives `pw_auth`. The recovery key must open this device's
   keyring (I9: never stored), so the code of the older keys is refused. **The current password must open this device's
   keyring too**: the new password verifier is computed from it, and a verifier the keys do not match would leave every
   device's `pw_auth` refused by the server, revoking among them, until a reset with the recovery key. A wrong one is
   "wrong password" on the same form, and nothing is sent. Part B's same-VK repair had the same gap; this check closes
   it there too. As in part B's other key operations, a wrong password typed here is not counted in the security record
   (only the adoption forms count theirs, as the lock screen does).
4. **Sent**: `POST /v1/keys/rotate` that changes no key here:
   - `if_version` and `if_kver`: the server's version and kver; `envelope`: this device's vault under its VK, at
     version + 1;
   - `write_proof` under K_write of the older VK (the restored server's write key); `new_write_key`: K_write of this
     device's VK;
   - `bundle`: this device's keyring, at `publishKver`, MACed under its VK, with the auth it adopted with that keyring
     (item 7);
   - `recovery_verifier` from the typed code, `password_verifier` from the current password and that auth (every wrap
     and the auth differ from the restored bundle's, so the rotate's P4 asks for both);
   - `device_names`: every name re-encrypted from the older VK to this one.
5. **First, the revocations the restore undid** (a rule §4.2 does not have; both repairs apply it). A restore to before a
   rotation is also a restore to before the "lost" revocation that rotation followed (§3.10): that device is active on
   the restored server again and holds the older VK, which the republished keyring's previous list opens, so the repair
   would hand it the newer keys, given the master password; a device on a key between the two would hand it the vault
   itself. So before the keys go, every device this device has seen revoked that the restored server lists as active is
   revoked again.
   - **Where "seen revoked" comes from**: the device list this device keeps (`sk_sync_state.devices`), in which a
     revocation is sticky. `revokeDevice` marks the device it revoked as soon as the server says 200; every refresh
     marks what the server says is revoked and never marks a device active again (a revocation is final for a device id:
     no flow brings one back, fork and rejoin make new ids, and only a restore of the server's database undoes it); and
     the refresh runs at step 1 of every round (§4.2 step 1), before the key checks, so a round that stops at them
     (`needs_password`, `server_older_key`, locked or not) still learns a revocation. The first version read a list
     that only rounds past those checks refreshed, which missed the Sync section's own "lost" flow (its round comes before
     its revocation) and any device still waiting for a newer key's password; tests drive the flow in its own order now.
   - **Named before the click**: the form lists those devices, by name (names under the older key open: the device list
     tries every key the keyring holds). The repair recomputes the list with the same rule and refuses (`stale`, the
     form again with the list as it is now) if it holds a device the form did not show, before anything is sent.
   - Each is revoked with the `pw_auth` the check computed (§3.14: revoking is never blocked), only while the vault is
     still open under the key the repair was built for (a lock since stops it, and nothing more is sent), recorded as any
     revocation is, marked in the list, and counted in one notice ("a device was removed from your sync"). A refusal or
     a network error stops the repair before its keys go; a network error is said as such ("can't reach the server"),
     not as an answer still awaited, since the keys were not sent and a revocation whose answer was lost is safe either
     way (the next form lists only the devices still active).
6. **The envelope is this device's vault, and the server's head is not merged into it.** §4.2 does not say what the
   envelope holds. A remote version under a previous key is used only by find accounts, by the user's explicit choice,
   and never merged automatically (§4.3, the R5 row; §4.6), and a device whose revocation the restore undid may have
   written to the restored head (the guard stops a changed secret or an erase, not an added account). What it holds:
   - the restored head stays in the server's history for as long as §5.8 keeps it: the newest 30 versions, and each
     UTC day's last version for 30 days, within 64 MiB. On a busy account a head that is not its day's last can go
     after 30 more uploads. Until then find accounts opens it with the previous key this device holds;
   - a device that only ever held the older key keeps its own writes, and merges them in when it takes the newer key
     (R3's continuity holds: the republished keyring's previous list unwraps VK1). So nothing is lost while a device
     that made a write is alive; a write whose only copy was on the server is reachable only within that window.
7. **Departure from §4.2 step 3: the auth is the adopted one, not a new salt.** The devices that took the rotation
   compare a bundle's auth with their `adopted.auth`. The same keyring under another auth is refused as
   `auth_without_password` (§3.9 R1), so a new salt would leave every one of them on the "keys refused" card: exactly
   the devices the repair is meant to free. The repair takes the auth this device adopted with its keyring, as the
   same-VK repair already does, and a new one only when it has none or it equals the server's. Reusing it gives the
   same `pw_auth` and verifier the server held before the restore, so nothing new is exposed.
8. **The head moved meanwhile** (`version_conflict`: a device still on the older key wrote): the upload is built again
   for the new head, with the same bundle text, at most three times; then the repair fails (`version_conflict`), having
   claimed nothing. The identical text also makes a retry after a lost answer the server's idempotent 200.
9. **The outcome** is judged by the exact bundle (its MAC) on the server, never by the vault key alone: another device's
   repair puts the same VK back, and is `changed_elsewhere` here. Then the local commit: M1's `published()` capability
   (a repair over an older VK is a case it already accepts), committed through `commitKeys`, its session carrying the
   lock epoch read just before the last pass's open-vault check, so a lock while the request is on the wire leaves the
   page locked (§3.6.0's rule, M6-NOTES §13.4).
10. **Afterwards**: a device that took the rotation rounds to "ok"; one that only held the older key sees the server
    "rotated" (R4) and takes the newer keys with its password. Like any rotate, the server voids the account's
    unfinished enrolment requests (§3.8 P3): a device waiting for approval then asks again.

**Not built, and why.**
- **A new recovery key inside the repair** (§4.2 step 2's second choice): the repair takes the keyring's code, as the
  same-VK repair's form does. A user without it cannot repair from this device (§4.2 says so); another device's repair
  frees this one too.
- **A revocation this device never saw** (made on another device, with no round of this one between it and the
  restore) is not in its list, so it is not done again here. The form says so: such a device is to be revoked again
  under Devices first (the list reads its name).
- **A warning that another device has newer keys than this one** (the server held a key this device never had before
  it went back): with the list refreshed at step 1, such a device still knows every revocation it saw, so the stale-list
  case is closed; its repair republishes the keys it has, and the device with the newest ones then finds the server
  older than itself and repairs in turn. Not built.
- **The notice after a death** between a revocation and its notice is lost; the form named the devices before the click,
  so the notice is only a confirmation.
- **A death right after a revocation's 200**, before `revokeDevice` marks the device in the stored list, leaves the mark
  to the next round's first step (a crash matrix checks it); only a restore of the server in that same window would
  leave the device out of a later repair's list, as a revocation made elsewhere would be.

**A residual of a double fault.** A device whose sync identity was restored from its copy has no adopted auth (§2.5);
if it is the one that repairs after a restore past a rotation, it publishes a new auth, and the devices that took the
rotation then refuse the bundle (`auth_without_password`, §3.9 R1) until one of them can repair; their card is "keys
refused". A repair from a device that kept its identity avoids it.

---

## 2. Find accounts (O13)

**What it is for.** D6 says plainly that the guard stops only a one-step erase: a holder of the vault key can delete
accounts into every device's trash and erase them a few minutes later, and what stands behind them is this device's
snapshots and the server's history (§5.8: the newest 30 versions and each day's last for 30 days), reached only through
find accounts. Until now the danger notice pointed to a backup only.

**Where.** The Sync section, with sync on: a box "Find accounts" (with the page unlocked), and the same action on the
notice that another device deleted accounts (both its warning and its danger form: §6 P4's "[找回]"; the danger text
names it now). It opens a managing flow (`options/sync/find.ts FindFlow`, `ManageViews.tsx FindView`; the engine is
`core/sync/engine/find.ts`, the edit `SyncFlows.recoverAccounts`).

**The steps.**
1. Chrome is asked for the API permission first, in the click (the server's history is read over the network);
   declined, the flow ends and reads nothing.
2. The sources:
   - the server's history, newest first, hour precision, at most 64 versions (an honest server keeps about 60): only
     versions under a key this device holds (the current one, or one its keyring's previous list really unwraps). A
     version under a previous key is marked "older keys": anyone who held that key then, a device revoked since among
     them, could have written it, with the server's help;
   - this device's snapshots, the store's own list (rolling and daily), newest first. Among them are an old vault's
     snapshots that a join re-encrypted under the cloud key and that keep that vault's id (§3.5 ⑥).
   If the history cannot be read (offline, an error), that is said in place of its list, and the local list stays. An
   empty list says "None". Each version's button is described by its list's heading for a screen reader.
3. One version opened: the accounts alive in it that are not alive in the vault now, neither by id (the same vault) nor
   as the same account under another id (identity, issuer and label, the added mode's rule); each account once. Shown by
   issuer and label only, and a row that resembles a live account says how: "its key is in the vault now, under another
   name" (bringing it back makes a second one), or "an account with this name is in the vault now, with another key"
   (the key was replaced since). Only those flags leave the engine, never a secret. A version that does not open here
   (another key, damaged, gone, a newer record format) says so; one of a newer schema says to update Sixkey; a server
   version of another vault is not used.
4. The user ticks some and brings them back, in **one ordinary local edit** (the service's `mutate`: the open-vault check,
   the size check with sync on, the outbox), synced like any edit. Each is checked again inside the edit against the
   vault as it is then: one that is alive again meanwhile is left alone.
   - The same vault, the entry in the trash now: declared again with new ticks under its own id, back from the trash
     with that version's names and settings. Its secret and type are the entry's own, and its HOTP counter stays this
     device's (a counter never goes back).
   - Erased now, not here at all, or from an old vault's snapshot: a new entry with that version's content (the added
     mode). An erased entry is never brought back to life under its id: nothing brings an erased entry back
     (`vault/model.ts`).

**What it does not do.** Nothing of a version is sent as it is, and nothing is merged automatically: only the edit's own
upload leaves, as for any edit. The kept vaults from before a join (`sk_prejoin`) are not a source: re-importing them is
a design of its own (§3.5 ④, §9 M8 item 17), since it would bring back accounts deleted since the join. The mirror's
copies are not listed separately (they hold daily copies of the same states). There is no "tick all".

**For the design author (§6 O13, §4.6).** "There then, not here now" is built as "alive then, not alive now": an account
in the trash now is listed and comes back under its id; an erased one comes back as a new entry. §4.6's "declared again
with new timestamps" holds for the first; the second is the added mode, for the reason above.

---

## 3. The dedupe after an approval join

**Why.** The approval join prepares against the synced vault without its accounts (they arrive with the first round:
the enrolment's payload carries the key bundle, not the vault), so an account both sides had is there twice after the
first round. Until now the join's summary said so and asked the user to delete the extra one (M6-NOTES §6 item 10).

**The rule as built** (§3.5, revision 24, with the twin rule below):
1. The approval join (`enroll.ts ApprovalJoin`, `JoinInput.dedupeAfterFirstRound`) records the ids of the accounts it
   adds, in its commit's first write: `sk_sync_state.joinAdded = {vaultId, ids, at}`, written with `lastSynced` cleared
   and `pendingPins` (`pins.ts begin`), before the commit point. Ids only: no content, no name.
   - A join that did not finish (its complete never landed) is undone before the next join (`requireOff`), which deletes
     sync's records, the record among them. The undo hands the record on, and when the next join is the merged one into
     that same vault (the profile already holds the copies the record names), it is kept, so the dedupe still runs.
   - Every other join writes none (a record an earlier join left is cleared).
2. After a round with the key that went through (`ok`, with `lastSynced` set: the synced vault is merged here), the
   engine (`engine.ts dedupeAfterJoin`) moves to the trash, never erasing, each account the join added that has a
   **twin** among the live accounts the join did not add (`SyncFlows.isTwinOf`), decided inside one ordinary local edit
   (`SyncFlows.trashJoinDuplicates`) against the vault as it is then. A twin:
   - has the same secret, issuer and label (`addedModeKey`) **and the same OTP parameters** (type, algorithm, digits,
     period): a copy whose codes differ is not a duplicate, and stays;
   - for HOTP, has a counter not behind the copy's (the counter that stays never goes back);
   - **comes first** in an order every device computes alike, `(createdAt, id)`. Two profiles that joined with the same
     account each see the other's copy outside their own record; without the order each could trash its own, and the
     account would be alive nowhere (a test reaches that state with one answer lost). With it, the earlier copy always
     stays. `createdAt` is the entry's own: never clamped, and a merge keeps the smaller, so the order converges. In the
     usual case the synced vault's account predates the join's copy, which goes.
   Two equal accounts the join itself brought keep each other (neither is outside the record); an account changed
   between the join and that round is no longer a match.
3. Then one write clears the record and, when anything moved, adds one notice ("N accounts this profile added when it
   joined were already in the synced vault: the extra copies are in the trash", with a link to the trash). The round
   goes round once more to upload the trash moves.
4. A round that does not go through (offline, locked, a review) moves nothing and keeps the record; a record of another
   vault moves nothing; one that does not parse is cleared.
5. The join's summary says that this profile's copy of any account the synced vault already has goes to the trash after
   the first sync.

**What the other devices see.** Normally nothing moves on them: the round that first uploads the copies also uploads
their trash moves, so the copies arrive already in the trash (a test). A device that runs a round between those two
uploads sees the copies come and then go, and when three or more go, its merge says another device deleted accounts
(§4.4's notice, pointing to its trash). That is accepted: it is true, and nothing is lost.

**Crash windows** (`test/fault/m6c-crash-join.test.ts` dies at every step of the join, the request to the complete;
`m6c-crash-dedupe.test.ts` at every step of the first round):
- before the join's commit point, a record naming ids that do not exist: nothing matches them, and the next round that
  goes through clears it (or the next join replaces it);
- after the local commit and before the complete: the join is unfinished, the next join carries the record (item 1);
- between the trash edit and the record's clearing: the moves are made and the notice is not given. The next round finds
  nothing more to move and clears the record without a notice. The matrix allows exactly this.

**Size.** The record holds at most one id per account added (5,000 at the entry limit, about 195 KB) and lasts until the
first round with the key that goes through; `sk_sync_state` is rewritten whole by each state write meanwhile.

**Normalisation.** Issuer and label are compared lower-cased only (the added mode's rule): a copy that differs by spaces
or by Unicode form is not a match, and stays alive. That errs on the safe side.

---

## 4. `docs/security/local-vault.md` and `SECURITY.md`

`local-vault.md` gains a section, "With sync on: what opens a locked page": the server's current master password
(§3.9 R3); while a key change is unconfirmed or the server is on an older key state, a former one after "adopt
anyway" (the "never locked out" residual); every wrong guess recorded as at the lock screen; and that whoever holds the
current vault key can, with the server's help, put a password wrap of their own choosing on the server, which then
opens a locked page through the same forms (§3.9 R2, R3: a same-VK bundle with a new password wrap is adopted once the
typed password opens it). It says that it applies only once sync is on, which the store build cannot do yet, and the
"Known gaps" line says the rest of the sync section comes with the gate. `SECURITY.md`'s list of accepted residuals
points to it in one sentence. This is §9 M8 item 17's sentence and M6-NOTES §13.5 item 13.

---

## 5. Measurements

Gzipped, as `scripts/check-dist.mjs` counts. "Before" is the tree this package starts from.

| | Before | After | |
|---|---|---|---|
| Popup, store build (gate closed) | 56,674 B | **56,674 B** | the same size, chunk by chunk |
| Popup, store build with the gate open | 58,476 B | **58,476 B** | unchanged (budget 61,440 B) |
| Popup, e2e build | 57,798 B | 57,798 B | |
| The Sync section's catalogs (built) | en 10,170, zh_CN 11,270 | **en 10,471, zh_CN 11,594** | limit 12,288 B, not raised; 15 keys new, one renamed; three texts reworded |
| Full catalogs | en 9,819, zh_CN 11,126 | unchanged | |
| The section's chunk (e2e build) | 28,430 B | 30,776 B | stylesheet 1,945 → 1,998 B |
| The engine chunk shared with the developer page (e2e) | 36,558 B | 38,107 B | |
| The section's chunk, store build with the gate open | 63,748 B | 67,627 B | the engine in it |
| `sw.js`, store build | 51,373 B | 52,580 B | the engine's dedupe, the step-1 device list, the flows' new edits (no budget) |

The popup carries none of this. Its module graph is unchanged (`m2-source-rules.test.ts`), and the gate-open popup is
unchanged too: the bundler shares whole modules, so the section using an export of a module the popup also loads, one
that was not exported from their shared chunk before, adds that export to the popup's chunk. A first version read the
snapshot index with `format.ts`'s parsers and grew the popup by 13 B that way; find accounts asks the store's own
`snapshots()` (through `SyncFlows`) and reads a snapshot record directly, with the envelope checks the rest of the
engine already imports.

Strings: the catalog had about 1 KB left in zh_CN; M6C's text takes 324 B of it, reusing part B's repair form.
No split was needed. What is left (694 B in zh_CN) is a few short lines; a later package that needs more should
split the catalog (for instance the managing flows' screens into a second, lazily loaded one) rather than raise the
limit.

---

## 6. Security and privacy (what M6C adds)

- **Permission first**: find accounts and the repair from the `server_older_key` card ask Chrome in the click's first
  statement (`permission.ts asking`), and `m6-wiring.test.ts` lists `onFind` among the openers bound directly. Sync is
  on for both, so nothing is given back when they end.
- **A lock ends the flows**: find accounts is a managing flow (`manage.ts`): a lock ends it at once and drops the opened
  version, unless its edit is under way, which then ends it with its own outcome. The repair keeps part B's rules; a
  lock before the send refuses it with nothing sent, a lock during its revocations stops them, and its commit's session
  carries the epoch read before the vault was found open (a lock on the wire leaves the page locked).
- **The repair never sends a verifier its keys do not match**: the current password must open this device's keyring
  first (§1 item 3), in both repairs.
- **A device revoked as lost does not get the newer keys back through the repair** when this device saw the revocation:
  the repair revokes it again first, from a list where a revocation is sticky and refreshed at every round's first step,
  and names it before the click (§1 item 5). A revocation made elsewhere and never seen here is the residual the form
  points to.
- **Secrets**: the opened version's entries are held by the engine for its handle only (a `WeakMap`), dropped when the
  flow leaves that screen (another version, Back, the edit made) or ends; the page gets issuer, label and the
  resemblance flags only. The join's record holds ids only. The repair's typed passwords and code are part B's form's,
  emptied as there.
- **No new plaintext leaves the device**: the repair sends what a rotation sends (an envelope, a bundle, verifiers,
  encrypted names) and revocations; find accounts sends signed GETs and, through its edit, the ordinary upload; the
  dedupe is an ordinary edit.
- **Untrusted server data**: a history version is opened only with a key this device holds, its vault id checked, and
  parsed as untrusted (`deserializeVault`); a server time is shown only when it is a plain number; the list of versions
  is cut at 64.
- **Destructive actions**: the revocations the repair repeats are listed on its form before the click (the user had
  confirmed each once already). Moving the join's duplicates to the trash is the design's automatic step, with its
  notice; nothing is erased, and one copy of every account always stays alive.
- Nothing new goes into a URL, the console, the diagnostics log (one fixed phrase when the dedupe waits) or the
  security record beyond the revocations it records as any.

---

## 7. Tests

New unit tests:
- `m6c-older-key.test.ts` (15): a restore to before a rotation: the repair, then the device that took the
  rotation in sync without typing, the one that never did taking the newer keys with its password and bringing its
  write; the device names readable again; the older head kept in the history and offered by find accounts; the code of
  the older keys refused before anything is sent; a wrong password of the server's keys; **a typo in the current
  password refused before the send, in both repairs, and revoking still works afterwards**; **a restore across a
  password change over the older key (the form stays open, then takes the password of that time)**; a lost answer; a
  write on the older key meanwhile (409, built again); another device's repair landing meanwhile (`changed_elsewhere`);
  a second repair refused (`not_behind`); a lock before the send; the card's way out through `RepairFlow` (asked in the
  click), a lock while it is on the wire (it lands, the page stays locked), a lock at the form.
- `m6c-revoke-again.test.ts` (8): the Sync section's "lost" flow (driven through RevokeFlow, its own order)
  and a restore before this device's next round: the form names the device (its name opened under the older key), the
  repair revokes it before the rotate, it is refused and cannot take the newer keys with the master password; a device
  on a key between the two learns the revocation at its round's first step and its repair keeps the stolen device out
  of what came after; a locked one too; the page's list stale (refused, the form again); a lock during the revocations;
  a network error said as such; a revocation the restore kept not sent again; a failed device list failing that round
  only.
- `m6c-find.test.ts` (15): accounts erased by another device found in the server's history (only issuer and
  label out) and brought back as new entries that reach the other device; from this device's snapshots offline; an
  account in the trash back under its id with that version's names; checked again inside the edit; locked; a handle
  used or dropped; versions under a key not held not offered, one that does not open said so, a server version of
  another vault not used; an old vault's snapshot; a newer record format and a newer schema; `missingFrom`'s rules;
  the rows that resemble a live account; versions under an older key marked; a very long history cut at 64; the flow
  (asked in the click, declined, a lock at once and during the edit).
- `m6c-dedupe.test.ts` (11): the duplicates to the trash after the first round with one notice, the copies
  arriving in the other device's trash without a notice there, nothing more on later rounds; two equal accounts the
  join brought; an account changed since; offline and locked first rounds; the recovery-code join records nothing; a
  record of another vault, and one that does not parse; **two profiles joining with the same account, one answer lost:
  a live copy stays everywhere**; other digits not a duplicate; HOTP counters; `isTwinOf`'s order; **a join that did
  not finish, made again: the record carried and applied**.
- `m6c-model.test.ts` (5): every card that pauses sync has an action but the one whose way out is an update of Sixkey;
  the `server_older_key` card's actions; the notices' new action and the dedupe's notice; the summary's words.

Crash matrices (`test/fault/`), each dying before and after every step (every storage write and request), with a
browser restart and the user's way back:
- `m6c-crash-repair.test.ts`: the repair after the Sync section's "lost" flow and a restore before this device's next
  round; the password and the code still open the vault, nothing is lost, the server and both devices end on the newer
  keys with the same data, and the device the restore had brought back is revoked again.
- `m6c-crash-dedupe.test.ts`: the joined device's first round (the merge, the upload, the dedupe's edit and record,
  the rerun's upload); every account alive exactly once, only the join's copies in the trash, nothing erased, the
  record gone, the notice at most once.
- `m6c-crash-revoke.test.ts`: a revocation (the new mark in the stored list after the server's 200); after the
  restart and one round, the stored list says the device is revoked exactly when the server does.
- `m6c-crash-join.test.ts`: the whole approval join of a profile with accounts of its own (the request, the
  approval's steps, the local commit with its record, the complete), then the user's way back (the join again where it
  did not finish); every account alive exactly once, the two duplicates in the trash, the record gone, both devices on
  the same vault.

**Mutation check.** Hand-made mutants of M6C's rules, applied one at a time (each target must occur exactly once; a
few change two places together, as moving a step does), each run against the test files that cover the mutated module
(the runner is outside the repository): **69 mutants, 69 killed**, each by a failing assertion. Among them are the two
that the first version's suite let through, as the review showed: no check of the current password, and the stolen
device left out of the revocations in the Sync section's own order. Others that survived a run on the way and led to
better tests: a snapshot record of a newer format whose envelope this build could open; a lock during find accounts'
edit; the same account twice in one version (a test had picked an entry by its place in a list ordered by random ids);
and the device names left under the older key, which the device list now opens anyway (the test now checks the key the
server holds them under, which a later rotation needs).

| Set | Mutants | Killed |
|---|---|---|
| The repair over an older key: a new auth (§4.2's "new salt"); no rotate (the same-VK PUT sent); the write proof under this device's key; the older K_write kept; the device names not re-encrypted; a landed repair judged by the VK; the commit's session at the epoch of its own moment; a 409 ending the repair; a lost answer always taken as in effect; the vault not opened again in each pass; the card without its repair | 11 | 11 |
| The repair's checks: the current password not checked before the send; the password of the server's older keys ending the flow | 2 | 2 |
| The revocations a restore undid: not done again; done after the keys; a device still revoked revoked again; every device on the list revoked; not said; a device the page did not show revoked; going on after a lock; a network error said as an answer awaited; a revocation made here not remembered at once; not sticky; the list refreshed after the key checks, in the full round and in the locked one; the form naming none; a changed list ending the flow; a name under the older key not opened | 15 | 15 |
| Find accounts, the engine: versions under keys not held offered; a server version of another vault used; an account alive under another id listed; one alive by its id listed; an account twice in a version listed twice; the history failing thrown; a newer record format opened; a newer schema said as unreadable; a used handle kept; `dropFound` doing nothing; versions under an older key not marked; a row resembling a live account not told apart; a history of any length offered whole | 13 | 13 |
| Find accounts, the edit and the flow: not checked again inside the edit; an entry in the trash added anew; an erased entry brought back to life; the entry back without that version's names; the page not told; a lock cutting the edit off; started without asking Chrome; the button behind an await; the deleted notices without the action | 9 | 9 |
| The dedupe: a join's copy counted as a twin; the duplicates erased; another vault's record applied; the record never cleared; no notice; a notice when nothing moved; the moves not sent up with the round; a record for every join; the approval join recording nothing; the record not written with the commit; a record that does not parse kept; the dedupe never run; the summary's old words; the record read on every round (the read budget); no order between twins; other OTP settings taken for a duplicate; HOTP's copy ahead trashed; the record not carried across an unfinished join; the merged join dropping it | 19 | 19 |

Not counted (equivalent in every reachable state, or defence in depth that no test can reach): the repair's check that
the vault key did not change between passes (the repair holds `sixkey-sync`, and every key change here takes it too),
and its minimum-version check in later passes (the first pass's is the version gate's); the dedupe's two timing
conditions (a round "ok", `lastSynced` set): a trash move needs a live twin outside the join's record, which only the
merged synced vault provides, so running it earlier moves nothing; the ids the join records being only those outside the
cloud's vault (the approval join's cloud vault is empty); `requireOff` handing the record on from its revoked-identity
branch (the merged join that would carry it needs an identity the server still knows). Not mutated: the views' new
bindings beyond the wiring rules (the ticked set emptied per version, the empty list's line, the buttons' descriptions,
the find box disabled while locked, the key operations disabled on the `server_older_key` card), checked by hand and
in the end-to-end test where it reaches them. One rule is not observable by a test and is held by review, as in part
B: that a find flow's end drops the opened version (its handle is the flow's private field; the engine side,
`dropFound`, is tested).

End to end against the real API server (`test/sync/m6c-section.spec.ts`, 2): an account erased for good comes back
through find accounts (the versions listed, the one that still holds it opened, nothing ticked for the user, the
account brought back and uploaded by the next round); a profile with an account the synced vault already has joins by
approval, its summary says the duplicates go to the trash, and after the first round the extra copy is in the trash on
both profiles, with the notice once. Every request on the wire: signed, exactly `application/json` on bodies, no cookie,
no referrer. The repair of `server_older_key` needs the server's database restored to before a rotation, which the
harness cannot do: it is checked against the in-memory server, whose rotate follows the real one's check order.

**Full runs** (the final state): unit tests 163 files, 2,228 passed, 4 expected failures (the existing `it.fails`
markers), 1 skipped, none failed; `tsc --noEmit` clean; the store build's `check-dist` with the gate closed and open;
`npm run e2e` (store, e2e and dev builds, each with `check-dist`, then the end-to-end and regression tests) 102 passed;
`npm run e2e:sync` 11 passed (the existing 9 and M6C's 2). After those runs only two code comments changed (the
history's bound, in `find.ts` and `keys.ts`) and three test files (`m6c-revoke-again`, the new `m6c-crash-revoke`, and
the revocation tests' ids taken from the form's rule); those files, and the mutants of the modules they cover, ran
again on their own.

---

## 8. Existing tests and code changed

Each follows from the requirement; none relaxes a rule that still holds.
- `m6-model.test.ts`: the `server_older_key` card has Repair before Sync now; the approval join's summary key is
  `syncSummaryAddedLater` (the duplicates go to the trash), no longer `syncSummaryAddedTwice`.
- `m6-approval.test.ts`: the summary over a profile with accounts now says the duplicates go to the trash, and after
  the first round the extra copy is in the trash, not alive twice.
- `m6-wiring.test.ts`: `onFind` joins the openers that must be bound directly; rule 1 counts one start more.
- The engine refreshes the device list at step 1 of a round (`engine.ts`, the full round and the locked one), before
  the key checks, as §4.2 step 1 says; before, it came after them. A round that stopped at a key check now also fails
  when that list cannot be read, and the next round reaches the key state (a test). `revokeDevice` marks the device it
  revoked in that list at once, so the device that revoked one no longer gets the "a device was removed" notice for
  its own revocation. No existing test changed for either.
- `listDevices` opens a name with whichever key of the keyring it is under, so names read while the server is on an
  older key.

---

## 9. Residuals, and for the maintainers

- **Before the gate opens** (§9 M8 item 17, after this package): the flip itself (with the store text and
  `OWNER-DECISIONS/06`), the store link of "Update Sixkey", and the old browser engines' run. With those, every item the
  design lists as required is done.
- **For the design author**:
  - §4.2: the repair checks the current password (and the recovery key) before anything is sent; it revokes again the
    revocations a restore undid, from a sticky device list refreshed at every round's first step, named on its form;
    its envelope is the local vault, not merged (§1 item 6); its auth is the adopted one (§1 item 7); the bound on the
    restored head in the history (§5.8);
  - §3.5: the dedupe's twin rule (OTP parameters, the HOTP counter, the `(createdAt, id)` order) goes beyond "secret +
    issuer + label"; the record carried across an unfinished join;
  - §6 O13 and §4.6 (§2's last paragraph); §3.13: `sk_sync_state.joinAdded`, and `devices` now sticky for revocations.
  M6-NOTES §6 item 10 and §13.5 items 3 and 7 are closed by this package.
- **Not done**: a new recovery key inside the repair; a revocation this device never saw, after a restore; a warning
  that another device has newer keys; the notice lost by a death between a revocation and its notice; the double fault
  of §1; a split of the Sync section's catalog (not needed yet, §5). The repair is checked against the in-memory server
  only (the end-to-end harness cannot restore the server's database).
