# The store build's `externally_connectable` while its catalog lists no plugin (2026-10-27)

A small fix after the plugin platform's waves 1a to 2b: the store build carried `"externally_connectable": {"ids": []}`,
and Chrome reported it on the extensions page. It now carries the built-ins' reserved ID alone, which no extension can
have, and every channel behaves exactly as before. The normative text is the SDK spec, revision 1.0-draft.12 (§3.3
item 1, §3.4, §8.5); the code is `extension/scripts/connectable.mjs`, `scripts/build.mjs` and `scripts/check-dist.mjs`.

## 1. The problem

- The owner loaded the store build (`extension/dist/`) as an unpacked extension, and `chrome://extensions` gave Sixkey
  an Errors button with this warning: `'externally_connectable' specifies neither 'matches' nor 'ids'; nothing will be
  able to connect`.
- `scripts/build.mjs` made `externally_connectable` as `{ids: [the catalog's official and listed IDs]}`, and the store's
  catalog (`extension/plugins/catalog.json`) lists no plugin yet, so `ids` was empty; `scripts/check-dist.mjs` required
  exactly that. The e2e and developer builds read `plugins/catalog.test.json` (three test plugins), so they never showed
  it, and no test loaded the store build with Chrome's developer mode on.
- The behaviour was what the platform needs; only the report was wrong. What any fix must keep (W1a's requirement C,
  OWNER-DECISIONS/16 "balanced"):
  - every extension outside the catalog is refused **by the browser**, with exactly the error of an ID that is not
    installed, for `runtime.sendMessage` and `runtime.connect` alike, so it cannot tell whether Sixkey is installed;
  - no web page can connect, and the worker drops every sender it cannot answer, one without `sender.id` included;
  - the key is never left out: an extension that does not declare it can be messaged by every other extension.

## 2. Measured first

Chromium 156.0.8078.4 (Playwright's bundled build, which the e2e suite runs). The probe (`ec-probe.mjs`, kept with this
fix's logs, outside the repository) loaded one small extension per shape, a caller extension, and a control with an
unknown manifest key.

- **How a warning is found.** Chrome's error console collects a manifest's warnings only for a load made while developer
  mode is on (with it off, `developerPrivate.getExtensionInfo` lists none, not even the control's). So: developer mode
  on (`developerPrivate.updateProfileConfiguration`), every extension loaded again (`developerPrivate.reload`), then its
  `manifestErrors`, and on the page its card's `#errors-button` (in the shadow DOM of `extensions-manager`,
  `extensions-item-list` and `extensions-item`), which reads "Warnings". The control's "Unrecognized manifest key" shows
  that the method finds what is there. (`--disable-error-console`, the stable channel's way, changed nothing here.)
- **"Refused"** below means: `sendMessage` rejected and `connect`'s `onDisconnect` gave `runtime.lastError` with exactly
  `Could not establish connection. Receiving end does not exist.`, the same string, for both, as for an ID that is not
  installed (`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`).
- **A web page** of a given host was served by Playwright (`context.route`), which stands in for a changed DNS answer
  and a certificate the browser trusts. The page at `https://sixkey.invalid/` had `chrome.runtime` because one of the
  probe's extensions declared its host; a page that no extension declares has none at all.

| `externally_connectable`                                   | Warning | Another extension           | The page at `https://sixkey.invalid/`                                |
| ---------------------------------------------------------- | ------- | --------------------------- | -------------------------------------------------------------------- |
| `{"ids": []}` (the store build before)                     | yes     | refused                     | refused                                                              |
| `{}`, `{"matches": []}`, `{"ids": [], "matches": []}`      | yes     | refused                     | not measured                                                         |
| `{"matches": ["https://sixkey.invalid/*"]}` (the brief's)  | no      | refused                     | **reached it**: `sendMessage` answered, the port opened; no `sender.id`, `sender.url` the page's |
| `{"matches": ["https://*.invalid/*"]}`                     | no      | refused                     | not measured                                                         |
| `{"ids": [], "matches": ["https://sixkey.invalid/*"]}`     | no      | refused                     | not measured                                                         |
| `{"ids": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}` (the fix)  | no      | refused                     | refused                                                              |
| no key                                                     | -       | **connected, and answered** | refused                                                              |

Chrome's check is on what the key holds: an empty `ids`, an empty `matches`, or neither, all warn.

## 3. The fix

- **With no official or listed plugin** in the catalog, `ids` is `["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]`; otherwise it is
  the catalog's official and listed IDs, as before. Never `matches`, never `"*"`, never an empty list, never the key
  left out (`scripts/connectable.mjs`, used by `scripts/build.mjs`).
- **Why that ID.** It is already the built-ins' reserved ID (`src/core/plugins/builtin.ts` `AUTOFILL_ID`; SDK §8.5). An
  extension's ID is the first 128 bits of the SHA-256 of its key, in the letters a to p; "a" 32 times is 128 zero
  bits, a hash nobody can find a key for (a search of about 2^128). An ID made from a known value would not do: anyone
  can put any bytes in an unpacked manifest's `key` and get the ID they hash to. And the worker drops a message or a
  port from the reserved ID in any case (`isBuiltin`, `src/platform/plugins/worker.ts`), so even an impossible sender
  would get nothing.
- **Why not the brief's `matches` of an `.invalid` host.** It ends the warning (measured), but it opens the key to web
  pages: Chrome then gives pages of that host `chrome.runtime` and delivers their messages and ports. `.invalid` never
  resolves in public DNS and no public authority issues a certificate for it, but a hosts entry or a proxy setting, with
  a root the browser trusts (a TLS-inspecting proxy has one), serves it. Measured: such a page reached the probe's
  extension, and, as an e2e mutant (E5 below), Sixkey itself: its worker dropped the message (no `sender.id`) and closed
  the port, but the page got a resolved `sendMessage` and a port closed without an error instead of "Receiving end does
  not exist", so it can tell Sixkey is installed, which is what requirement C rules out. The reserved ID keeps every
  channel exactly as `{"ids": []}` had it, and gives web pages no channel at all.
- **No ambiguity.** A catalog that lists the reserved ID stops the build (`externallyConnectable` throws) and fails
  `check-dist`, so in a manifest the reserved ID always means "no plugin".
- **`check-dist`** writes the ID out on its own (it does not import `connectable.mjs`) and requires exactly
  `{"ids": [the catalog's official and listed IDs]}`, or `{"ids": ["aaaa…"]}` when there are none, on the parsed value
  and byte for byte in `manifest.json` as the build writes it: the key once, its value in the build's own spelling (an
  escape, a second copy of the key or another layout fails, though a parser reads the same value).
- Nothing else changed in any build: the store build's `dist/` differs from the base's in `manifest.json` only, there
  in this key only; the e2e and developer manifests are unchanged.

| Store build's `manifest.json` | `externally_connectable`                                  |
| ----------------------------- | --------------------------------------------------------- |
| before                        | `{"ids": []}`                                              |
| after                         | `{"ids": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}`            |
| e2e and developer, unchanged  | `{"ids": ["mdmdmmfholobdjhebgkejafplfihedco", "keimndphgbedcdlfkkilohdncpaapaac", "npkmjlcijpgmbadinhbmfbfdianoaooe"]}` |

## 4. Files

- `extension/scripts/connectable.mjs` (new, with `connectable.d.mts` for the tests): the rule and `NO_EXTENSION_ID`.
- `extension/scripts/build.mjs`: the key from `externallyConnectable(catalog)`; a catalog with the reserved ID stops it.
- `extension/scripts/check-dist.mjs`: both shapes, value and bytes; the reserved ID in the catalog fails.
- Comments only: `src/platform/plugins/worker.ts`, `src/core/plugins/policy.ts`.
- Tests: `test/unit/externally-connectable.test.ts` (new), `test/unit/m5-check-dist.test.ts`,
  `test/unit/plugins-worker.test.ts`, `test/e2e/externally-connectable.spec.ts` (new).
- Documents: the SDK spec (1.0-draft.12: §3.3 item 1, §3.4, §8.5, the header) and its package's version
  (`contract/plugin-sdk`, 1.0.0-draft.12, following the spec's revision; no code changed there),
  `PLUGINS-W1A-NOTES.md` (§2, §2.1, §7), `docs/ARCHITECTURE.md`, `docs/security/local-vault.md`,
  `docs/OWNER-CHECKLIST.md` (item 49), this file.

## 5. Tests

- **Unit.** `externally-connectable.test.ts`, 8 tests: the rule (empty, blocked only, listed, official and blocked and
  listed in order; only `ids`; the reserved ID refused under every trust), the reserved ID is `AUTOFILL_ID`, a built-in
  and a well-formed ID; `check-dist`'s own copy and no import; the build's one use of the rule; and store builds made in
  a private copy of the sources from three catalogs: a blocked plugin only (the reserved ID alone, `check-dist` passes),
  a listed plugin (its ID alone, `check-dist` passes), each copy's `check-dist` failing the other's build, and the
  reserved ID listed (the build stops before it writes anything; `check-dist` fails a good build).
  `m5-check-dist.test.ts`, 28 new tests (111 in all): the three pristine builds' keys as the build spells them; the
  store shape against 13 wrong values (an empty `ids`, an empty `ids` and `matches`, the brief's `.invalid` `matches`,
  the reserved ID with an `.invalid` or a real host, `"*"`, the reserved ID with `"*"`, twice, a test plugin's ID
  instead or beside, another ID nobody can have, a string, `{}`) and the key missing; the test shape against 8 (empty,
  the reserved ID instead or beside, another order, one left out, a web page, `"*"`, `matches` instead) and the key
  missing; four byte-only changes (an escape, one line, the key twice, the test IDs on one line), each failing the byte
  rule alone. `plugins-worker`: a web page's message (no `sender.id`) and one from the reserved ID are dropped. Changed
  on purpose: `m5-check-dist`'s "externally connectable to web pages" now expects the reserved ID's message, not
  `{"ids":[]}`'s.
- **In Chromium** (`externally-connectable.spec.ts`, the store build in `dist/`, as the owner loads it):
  - (a) with developer mode on and both reloaded, the control (`{"ids": []}`) has exactly the warning above and its card
    a "Warnings" button; Sixkey has no manifest error, no install warning and no such button, and the manifest Chrome
    took has `{"ids": ["aaaa…"]}`;
  - (b) another extension, from its page and from its worker: `sendMessage` and `connect` to Sixkey give exactly what
    they give for `bbbb…` (not installed): `Could not establish connection. Receiving end does not exist.`, both; and
    Sixkey's request log stays empty (nothing reached its worker, which logs a refused port);
  - (c) a page of a host the caller declares (so it has `chrome.runtime`) is refused for Sixkey exactly as for `bbbb…`;
    a page at `https://sixkey.invalid/` and one at an ordinary host have no `chrome.runtime` at all.
  - (d) the e2e build's behaviour is unchanged: every plugin spec passes in the full run.
- **Full runs:** see §7.

## 6. Mutants

Each is one edit of a clone of the working copy; the named tests must fail on an assertion (not a type error, another
exception or a timeout); every run in a process group of its own, killed whole on a timeout (five times the pristine
run, 30 to 180 s), a timeout never counted as a kill. `m5` is `m5-check-dist.test.ts` run with
`-t "externally|pristine builds"`; the numbers are the failed tests. The Chromium ones rebuild the store build without
`check-dist` (which stops most of them first) and run `externally-connectable.spec.ts`. 25 of 25 killed by assertions.

| Mutant                                                            | Killed by                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| U01 empty catalog: the key left out (set only with a plugin)       | `externally-connectable` (the blocked-only build), `m5` (5)     |
| U02 empty catalog: `ids: ["*"]`                                   | `externally-connectable` (2), `m5` (5)                          |
| U03 empty catalog: `matches` of a real host                       | `externally-connectable` (2), `m5` (5)                          |
| U04 `check-dist` lets an empty `ids` pass                         | `m5` (2)                                                        |
| U05 the worker answers a sender without an ID                     | `plugins-worker`                                                |
| U06 empty catalog: the old empty `ids`                            | `externally-connectable` (2), `m5` (5)                          |
| U07 empty catalog: the brief's `.invalid` `matches`               | `externally-connectable` (2), `m5` (5)                          |
| U08 empty catalog: the reserved ID and an `.invalid` `matches`    | `externally-connectable` (2), `m5` (5)                          |
| U09 the build back to the base's line                             | `externally-connectable` (2), `m5` (5)                          |
| U10 `check-dist`'s value rule gone                                | `m5` (26)                                                       |
| U11 `check-dist`'s byte rule gone                                 | `m5` (5)                                                        |
| U12 `check-dist` no longer counts the key                         | `m5` (the key twice)                                            |
| U13 `check-dist` passes a catalog that lists the reserved ID      | `externally-connectable`                                        |
| U14 the build takes a catalog that lists the reserved ID          | `externally-connectable` (2)                                    |
| U15 a blocked plugin counted in `ids`                             | `externally-connectable` (3)                                    |
| U16 the reserved ID beside the catalog's IDs                      | `externally-connectable` (2), `m5` (3)                          |
| U17 `check-dist` expects another ID nobody can have               | `externally-connectable` (4), `m5` (19)                         |
| U18 the worker answers the reserved ID                            | `plugins-worker`                                                |
| U19 the rule's ID changed                                         | `externally-connectable` (5), `m5` (5)                          |
| E1 (Chromium) empty catalog: the old empty `ids`                  | (a): Sixkey's `manifestErrors` hold the warning                 |
| E2 (Chromium) the key left out                                    | (b): the worker answered `{"code": "invalid"}`, the port closed without an error; (a) |
| E3 (Chromium) `ids: ["*"]`                                        | (b), as E2; (a)                                                 |
| E4 (Chromium) the reserved ID and `matches` of a real host        | (c): that page's `sendMessage` resolved, its port closed by the worker; (a) |
| E5 (Chromium) the brief's `.invalid` `matches`                    | (c): the `.invalid` page had `chrome.runtime` and reached Sixkey; (a) |
| E6 (Chromium) the reserved ID and an `.invalid` `matches`         | (c), as E5; (a)                                                 |

## 7. Runs

On a copy of the live tree (HEAD ab03a03: e21c7f4 with waves 2a and 2b), the e2e copies with the API on a port of
their own (another project's server holds the usual one on that machine), every run nice'd, in a process group of its
own, under the shared heavy lock for the full ones:

- Gates: `messages.py` (its catalogs and `_locales` unchanged), `npm run typecheck`, the prod, e2e and dev builds each
  with `check-dist` (OK), `npm run format:check`, `npm run notices:check`; no stray `.orig` or `.rej`.
- Full unit (`npx vitest run --maxWorkers=2`): 284 files, 4,332 passed, 4 expected failures, 1 skipped (4,337), in
  1,028 s. This fix's share: one file more, 36 tests more (8 in `externally-connectable`, 28 in `m5-check-dist`).
- Full e2e: 420 passed, 1 skipped, none failed or flaky (34.4 min); `externally-connectable.spec.ts` 3 of 3, and every
  plugin spec on the e2e build (`plugins*.spec.ts`, `plugin-samples.spec.ts`).
- `e2e:sync`: 12 passed.
- Mutants: 19 of 19 at the unit level, 6 of 6 in Chromium, all by assertions (§6).

## 8. What is left

- **Branded Chrome.** Measured in Chromium 156 only. The stable channel shows a manifest's warnings as install warnings
  instead of through the error console; they are the same list, computed when the manifest is read, so the same result
  is expected, not measured. OWNER-CHECKLIST item 49 asks the owner to look in their own Chrome.
- **A later Chrome** could report something new for this key (an `ids` entry that names no installed extension, say).
  `externally-connectable.spec.ts` would see it: it requires Sixkey to have no warning at all.
- **The Chrome Web Store's review** sees an `ids` entry that is no plugin. How it reads it is not known (it cannot be
  tried without a submission, and nothing is published here); SDK §3.3 item 1 is the explanation to give. The
  alternatives, if it objects, are the empty list (the warning, for developers only) or the `.invalid` `matches` (a web
  page channel, §3).
- **The reserved ID's guarantee is SHA-256's** (a 128-bit preimage). Were it ever found, Chrome would let that one
  extension reach the worker, which still drops its messages and closes its ports (`isBuiltin`).
- The worker still logs `port-refused` for a port from any well-formed ID, the reserved one included; none can come.
- When the first plugin is listed in the store's catalog, `ids` becomes its ID alone and the reserved ID leaves the
  manifest (tested with a copy of the sources, §5).
