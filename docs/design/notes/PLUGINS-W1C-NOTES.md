# Plugin platform, wave 1c: the SDK package, two sample plugins, their end-to-end test

Wave 1c is the last part of wave 1 (MOD-PLATFORM §7.1, row W1). It adds:

- **the plugin SDK package**, `@sixkey/plugin-sdk`;
- **two sample plugins**: a password generator and a full-page screenshot tool;
- **a two-extension end-to-end test**;
- **a developer guide**;
- **W1b's follow-up S-1.**

The owner's ask: _SDK 规范要写的足够标准……随机生成密码的插件、截图全网页的插件要做得到_. The normative text stays the
SDK specification (`docs/sdk/SIXKEY-PLUGIN-SDK.md`, now revision 1.0-draft.9). Where it and the code of W1a and W1b
differed, the code won and the text was changed. Section 5 lists every such change.

Nothing in Sixkey's pages changes. Sixkey's size change is noise, a few bytes either way (§9). Sixkey gets no new
permission, and nothing of the SDK or the samples is in any Sixkey build.

**r2.** The independent review (`REVIEW.md`, 修改后通过) found the screenshot sample wrong on common pages, the SDK's
pairing too trusting, two guards with holes, and F-1 reachable. §12 is r2: every finding, what was done, and the test
that now holds it (each of the review's probes and surviving mutants is one, failing on r1). Where an earlier section
says what r1 did and r2 changed it, it says so.

## 1. Where things are

| What                     | Where                                                                                    | Licence (`REUSE.toml`)                     |
| ------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------ |
| The SDK package          | `contract/plugin-sdk/src/` (TypeScript), `package.json`, `tsconfig.json`                 | Apache-2.0 (contract code, OWNER-DECISIONS/01) |
| Its JSON Schemas         | `contract/plugin-sdk/1/plugin-sdk.schema.json`                                           | CC0-1.0 (contract data)                    |
| The samples              | `extension/plugins/examples/{password-generator,full-page-screenshot}/`, `build.mjs`     | Apache-2.0, as the SDK (§7, OQ-1)          |
| Their READMEs, the guide | `extension/plugins/examples/**/README.md`, `contract/plugin-sdk/README.md`, `docs/sdk/GETTING-STARTED.md` | CC-BY-4.0                |
| The tests                | `extension/test/unit/plugin-sdk-{cross,client,package}.test.ts`, `sample-{password,stitch}.test.ts`, `autofill-gate-off-touch.test.ts`; `extension/test/e2e/plugin-samples.spec.ts` | MPL-2.0 |

- **Nothing is published.** `package.json` is `"private": true`. Plugins vendor the folder, as the guide says.
- **How the package is checked.** `extension/tsconfig.json` now includes `plugins/examples` and `../contract/plugin-sdk/src`,
  so `npm run typecheck` checks them both. The package also typechecks on its own with
  `contract/plugin-sdk/tsconfig.json`.

## 2. The SDK package

- **An independent implementation.** No MPL-2.0 code was copied. Its validators were written from the specification and
  Appendix A, then held to Sixkey's own code by tests (below). It has no run-time dependency.
- **The network and the browser.** It uses neither the network nor `console`. In Chrome it uses only `chrome.runtime`,
  plus `chrome.storage.local` for pairing, all in `client.ts`. A test checks that.
- **`types.ts`.** Hand-written. There is no generator, and none is needed while the types are held to Sixkey's reader.
- **`descriptor.ts`: `checkDescriptor`.** It gives Sixkey's verdict, the normalised descriptor, `unavailable` (cut at 32,
  as Sixkey cuts it) and the negotiated version, plus `problems`, a reason in words for each dropped item. Beside it are
  `negotiate`, `onlyHarmless`, `contributionsHash` and `OFFERED_W1`.
- **`envelope.ts`.** Each request type's body, as Sixkey checks it. `makeRequest` throws a `TypeError` on a request
  Sixkey would refuse as `invalid` or `too-large`, so a plugin's mistake is its own exception, not a silent 10-second
  wait.
- **`client.ts`: `createClient`.**
  - **By message**, for official and listed plugins: `hello()`, `env()`, `request()`.
  - **`acceptPort()`**, for everyone else. It takes Sixkey's surface ports and says `hello` at once. A hello it cannot
    make or post (a descriptor over the size limit, a port already gone) closes the port at once.
  - **`on()`** takes events from a known Sixkey ID only, never answers one and never `return true`s.
  - **Pairing:** `storagePairing`. The specification now describes it in §3.3 item 3.
  - **No answer is `unavailable`**, with `detail` saying why: no answer, a late one, a non-answer, or the browser's
    error.
- **`testing.ts`: `fakeSixkey`.** It answers through `answer()`, a pure mirror of Sixkey's `dispatch` for wave 1:
  - the order of checks of §10.6, the limits and the errors;
  - the plugin's state as Settings › Plugins keeps it;
  - surface ports with Sixkey's 2 s hello deadline;
  - clicks on entries.

  **Not modelled:** the catalog pin and `minVersion` of a listed plugin, `management`, pauses after denials, the
  waiting-plugins limit, and the 30 s idle close of a port.

**How the SDK is held to Sixkey** (`plugin-sdk-cross.test.ts`):

- **The descriptor.**
  - **Hand-picked cases.** 135 of them, at and across every edge of §4.3, each read with wave 1's offer and with every
    capability and slot offered. More than 40 of them are valid.
  - **Random cases.** 1,500 random changes to a valid descriptor, each field set to a random JSON value or taken out.
  - **What is compared:** the verdict, the descriptor (`toStrictEqual`), `unavailable` and the version.
- **The other rules:**
  - `onlyHarmless` on every pair of valid descriptors;
  - `contributionsHash` on every valid descriptor;
  - JCS on 800 random JSON values;
  - plain text and the shortcut grammar on 3,000 strings, controls, bidirectional marks and lone surrogates among them.
- **The fake against `dispatch`.** The run covers:
  - 28 states: four trust levels × none, approved (four grants), disabled, suspended;
  - 10 senders: the port, a worker, a declared worker, a page, a page in a tab, a page framed in a site, a content
    script, another extension, no ID, and a web page without a tab;
  - 58 messages: every request type with a body Sixkey takes and one it refuses, every fault of the envelope, and
    hello's own cases.

  **That is 16,240 runs.** In each, the answer and the side effects (the hello kept, the plugin paused) must be Sixkey's.
  Every outcome of wave 1 occurs. A run of 72 requests also checks the rate limits: the same refusal at the same count,
  with the same wait.

**The fake differed from Sixkey in three places.** The cross-check found all three, and the fake was fixed in each:

- **A turned-off plugin whose descriptor changed.** Sixkey pauses it (suspended is tighter than disabled), and reports
  the change again for one already paused. The fake did neither.
- **When answering throws.** Sixkey answers `internal` on a message and closes a port. The fake threw.
- **A test could not stand for a new version of the plugin.** `reload()` now drops the old listeners.

## 3. The samples

Both samples are unlisted plugins, added by ID. Each asks Sixkey for **`ui.slots` only**, which is less than P0. Neither
sends Sixkey any request but `hello`. Their pages run only their own scripts, under
`script-src 'self'; object-src 'none'; base-uri 'none'; connect-src 'none'`. They are built with Vite (`build.mjs`),
which is Sixkey's own build tool: an earlier draft imported `rolldown`, a dependency of a dependency.

- **The password generator.**
  - **The flow.** A click on _Generate password_ opens its window (`windows.create`). While Sixkey's popup is open,
    `action.openPopup()` needs a gesture, so a window it is. Its toolbar icon opens the same page as a popup.
  - **The draw.** Rejection sampling over `crypto.getRandomValues`, so there is no modulo bias. A password that misses a
    chosen set is thrown away whole.
  - **The options:** the length (4 to 128), four sets, and leaving out look-alikes.
  - **Its permission:** `storage`, for the pairing, which has no warning. Copying with `navigator.clipboard.writeText`
    on the user's click needs no `clipboardWrite`.
  - **Connecting.** It has a _Connect to Sixkey_ button, which opens `connectUrl` (§9.2).
- **The full-page screenshot.**
  - **Its permissions:** `activeTab`, `scripting`, `contextMenus` and `storage`. Chrome shows no warning for that set
    (measured, §6).
  - **How it starts.** Its own icon, Alt+Shift+S or its context-menu item gives it `activeTab`.
  - **A click in Sixkey's menu.** Sixkey's `slot.invoked` carries the tab. The window captures if the plugin already
    holds `activeTab` there, and otherwise says how to start.
  - **Stitching** (`stitch.ts`'s `walk`): scroll, wait two frames, take a part, draw it where the page was. It steps by
    what each part really showed, the last part sits flush with the bottom, and the picture ends where the parts end.
    Fixed and sticky elements are hidden after the first part. The page's scroll position and its hidden elements are
    put back afterwards.
  - **The trade-off against `debugger`** is in its README, with Chrome's real warnings for each.
  - **Pairing** is shown with **Forget**. It has no Connect button: add it by ID.
- **Both samples pair** with the first Sixkey page that connects. The developer build's ID is known without pairing.

## 4. The guide, followed once

**Where it is.** `docs/sdk/GETTING-STARTED.md` writes a _Hello Plugin_: descriptor, worker, page, a `fakeSixkey` test,
a Vite build, loading and connecting. Every file in the guide was copied as written into an empty folder, with the SDK
folder copied in as `vendor/plugin-sdk/`.

**What was run, and the result:**

- `tsc --noEmit`: clean;
- `vitest run`: 2 tests, both passed;
- `node build.mjs`: `dist/` with `sw.js`, `hello.js`, `manifest.json` and `hello.html`;
- **in Chromium, beside Sixkey's e2e build:**
  1. Settings › Plugins › **Plugin ID** › **Continue**;
  2. **Allow Hello Plugin?** › **Allow**;
  3. the popup's **Plugins** › **Say hello**.

  Each step went by its visible label. The plugin's window said "Hello from a Sixkey plugin".

**One difference from the guide.** `npm install` was not run, so as to fetch nothing. The folder used Sixkey's own
`node_modules`, which pins the versions the guide names.

## 5. Changes to the specification (code wins)

Every change, in `docs/sdk/SIXKEY-PLUGIN-SDK.md`:

| §               | Was                                                                       | Now (and why)                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| header          | revision 1.0-draft.8                                                      | 1.0-draft.9, wave 1c, pointing here                                                                                                                                                                                |
| 3.3 item 3      | "`hello` first"                                                           | `hello` first **within 2 s** of the port's opening, or the port is closed and the plugin taken as not answering; a message before it ends the port; Sixkey sends `grants.changed` after the answer on every port (W1a's `port.ts`: `HELLO_MS`, the event after the hello) |
| 3.3 item 3      | (none)                                                                    | **Pairing**: MAY pair with the first Sixkey page on the port name, from an extension page of that ID; SHOULD show it and offer to forget; the one exception to item 4, with what it risks                          |
| 3.3 item 4      | ignore senders not "built for"                                            | … or the one it paired with                                                                                                                                                                                        |
| 3.3 item 4      | SHOULD declare `externally_connectable` ids                               | SHOULD once Sixkey's IDs are fixed; the samples do not, because a declaring plugin can be reached only by the listed IDs, and only the developer build has a fixed ID                                              |
| 3.4             | developer and e2e builds "fixed by a public test key"; `SIXKEY_E2E_ID` in the SDK; W1a's "no build carries a key" | the developer build's key is in `manifest.dev.json` (added for passkeys, PRF-NOTES), `SIXKEY_DEV_ID` = `pgnlbjikdnniepfeijffpefifnojjege`, worked out from it by a test; the e2e build has none, so no `SIXKEY_E2E_ID`; `SIXKEY_STORE_ID` stays, empty, held equal to `scripts/store-id.mjs` by a test, and taken by default once set |
| 10.8            | surface ports: closed with the surface or after 30 s                      | plus the plugin's `hello` within 2 s                                                                                                                                                                               |
| 11.1            | `schemas/`; types "generated"; `client` with `arm()`, `forPage()`; `ids.ts` with three IDs; the fake "with fixture accounts" | `1/`, verbatim from Appendix A; types written by hand, their names held to Sixkey's by tests (not the messages' shapes); the client as built (`hello`, `env`, `request`, `on`, `acceptPort`, `check`, `lastHello`, `holds`, `storagePairing`), no `arm` or `forPage` until W3; `ids.ts`: `SIXKEY_STORE_ID` (empty), `SIXKEY_DEV_ID`, `PORT_NAME`, `connectUrl`; the fake of wave 1 (no accounts: there is no account request), what it models and what not; the cross-checks; `private` |
| 11.2            | the examples "and `hello/`"                                               | `password-generator/` and `full-page-screenshot/` with READMEs and `build.mjs`, repository-only (Q-A (ii)), refused by check-dist (r2: by the build's module-graph guard first, §12.1 W1C-06); no `hello/` (the guide's); the import sample with W2                         |
| 11.3            | Sixkey, the plugins and a hostile extension; raw CDP via `--remote-debugging-pipe` only; every package with a test key | Sixkey's e2e build and one sample; the hostile-extension case is W1a's `plugins.spec.ts`; `ServiceWorker.stopWorker` on a page's session stops a worker under Playwright too (measured), `Extensions.triggerAction`, Sixkey's popup clicked with `Input.dispatchMouseEvent`; no keys |
| 11.4            | a developer page that lists messages and fakes a click                    | not built in wave 1: the request log in every build; `fakeSixkey` fakes the click in tests                                                                                                                       |
| 12.1            | (the flow)                                                                | W1c notes: the sample asks for `ui.slots` only, holds `storage`, copies without `clipboardWrite`, opens a window, draws without bias                                                                              |
| 12.2            | (the flow)                                                                | W1c notes: the sample's permissions, no `<all_urls>`, the measured warnings, the debugger comparison, the stitching rules; on `slot.invoked` it opens its window for the event's tab and captures if it still holds `activeTab` there |

**What did not change.** Appendix A is unchanged. A test now holds `contract/plugin-sdk/1/plugin-sdk.schema.json` equal
to its block, and both are formatted by Prettier.

## 6. The end-to-end test and what the probes found

`extension/test/e2e/plugin-samples.spec.ts` takes about 18 s for both tests. It is in the default suite, because it is
not slow. It builds the samples into a temporary folder in `beforeAll`.

**The password generator's test:**

1. Add by ID, then check the approval screen: the name, _Third-party · not reviewed_, and one item.
2. Allow.
3. Pairing: _Paired with Sixkey <ID>._
4. _Connect to Sixkey_: Sixkey's Settings with the ID filled in, and no approval opened.
5. Stop the plugin's worker with DevTools (seen `stopped`).
6. Click the entry in Sixkey's popup. The worker runs again and the generator window opens.
7. A password of 32 letters and digits with all three kinds, then without look-alikes, five times.
8. Sixkey's request log: hellos, ports and the click, nothing else.

**The screenshot's test**, on a page 3,000 px tall with a fixed black header and five coloured bands:

1. Click the entry in Sixkey's real toolbar popup. The window says how to start, and shows the pairing.
2. The plugin's own action (`Extensions.triggerAction`). The window captures.
3. The entry in Sixkey's popup again. The plugin now holds `activeTab`, so the window captures.

**How each capture is checked.**

- **The bands.** The picture is sampled every 50 CSS px and at the top of every part, against the page's bands. That
  shows the header appears once and nothing is empty below the viewport.
- **The size** is checked.
- **The page is restored:** `scrollY` 0, and the header visible.
- **The request log** holds two clicks and nothing but hellos and ports.
- **Missing text.** No key was shown without text: the pages are watched as `harness.ts` watches them, and the popup
  through the DevTools session.

**The first draft failed four ways, and each failure was a fact:**

- **An untrusted click does nothing.** Sixkey takes only `isTrusted` clicks on an entry (`Entries.tsx`). The test uses
  Playwright's clicks on `openPopup`'s tab, or `Input.dispatchMouseEvent` in the real toolbar popup. That popup is not a
  Playwright page; it is reached through the browser's DevTools session.
- **`connect-src 'none'` blocks `fetch()` of a `data:` URL.** The capture decodes `captureVisibleTab`'s PNG with
  `atob` instead.
- **Playwright lays pages out at 1280 × 720 in a window that shows only 633 rows.** Each part then showed less than
  `innerHeight`, which left an 87-row gap after every part.
  - **The fix in the sample.** It steps by what the part showed and cuts the picture where the parts end.
    `sample-stitch.test.ts` has this exact case.
  - **The fix in the test.** It launches with `viewport: null`, as a real browser has. `harness.ts` is frozen
    (export-helpers.ts), so the spec has its own launch.
- **At a fractional device pixel ratio, rounding left the last row empty.** The ratio 2.625 showed it. The sample now
  places the last part flush with the bottom, and treats a part as tall as the viewport, to the device pixel, as all of
  it.

**What the property test found later.** At a ratio of 1.1, a part one CSS pixel short of the viewport has the
viewport's height to the device pixel, so it cannot be told from a whole part. It is drawn flush with the bottom, at most
two device pixels from where the page was, and it leaves no gap. The test's bound is that rounding, and the case is now a
fixed test as well.

**Chrome's warnings, measured** with `chrome.management.getPermissionWarningsByManifest` in the bundled Chromium, in
English:

| Manifest                                         | Warnings                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| the screenshot as shipped                        | none                                                                                 |
| with `debugger` (with or without `activeTab`)    | "Access the page debugger backend", "Read and change all your data on all websites" |
| with `<all_urls>`                                | "Read and change all your data on all websites"                                     |
| with `tabs`                                      | "Read your browsing history"                                                         |
| the password generator                           | none                                                                                 |

The debugger's infobar ("… started debugging this browser") is Chrome's documented behaviour. It was not probed:
headless Chromium shows no infobar.

## 7. For the owner: both decided (OWNER-DECISIONS/18)

- **OQ-1. The samples' licence.** The samples were MPL-2.0, as everything under `extension/**`. They are meant to be
  copied into other people's plugins. MPL-2.0 is file-level copyleft, so a copied file stays MPL-2.0. A permissive
  licence would avoid that: Apache-2.0, as the SDK has, or MIT-0 or CC0-1.0. The same question applies to the guide's
  code snippets, which are CC-BY-4.0 as a document.
  - **Decided (2026-10-30, as recommended): Apache-2.0, as the SDK**, for every sample (the import sample of wave 2b
    too); the guide says that its code snippets may also be used under Apache-2.0.
  - **What the change took.** One `REUSE.toml` entry, for `extension/plugins/examples/**`, after the extension's and
    before the documents' (the READMEs stay CC-BY-4.0); the Apache-2.0 text as `extension/plugins/examples/LICENSE`;
    LICENSE.md, the READMEs and the guide. `plugin-sdk-package.test.ts` holds the entry's place and the text.
- **OQ-2. Publishing the SDK to npm.** This needs an npm account, the owner's (§11.1).
  - **Decided (2026-10-27): later.** The package stays `private` and vendored.
- **No other decision.** The samples stay repository-only, under Q-A (ii) of OWNER-DECISIONS/16. Nothing here touched
  `OWNER-DECISIONS/`.
- **Checklist.** OWNER-CHECKLIST items 43 and 44 try the two samples in a real Chrome.

## 8. Found in W1a's code (F-1 fixed in r2)

r1 added no code to Sixkey but S-1 and check-dist's rule. **r2 fixes F-1** (§12.1, W1C-08): the review's probe E8 showed
it reachable, and in W2 a stored issuer or label holding one would break an account's export and QR code.

- **F-1. A lone UTF-16 surrogate passes `isPlainText`, and JCS refuses it later.** For example, a descriptor `name` of
  `"Generator \uD800"`.
  - **What happens.** `readDescriptor` accepts it. `onlyHarmless` then throws on a stored plugin's next hello, so the
    worker answers `internal` and a port is closed. Approving such a plugin fails at the grant record's tag, which is
    computed over JCS.
  - **Reachable.** Chrome carries a lone surrogate through a message (JSON escapes it). [inferred: JSON.stringify writes
    it as `\uD800`, and the receiver's JSON parser keeps it.]
  - **Harm.** None beyond the plugin itself: no other plugin's record is written, and nothing is stored.
  - **The SDK** reads it as Sixkey does, so the cross-check passes, and adds a `problems` line.
  - **The fix (r2).** Plain text refuses a lone surrogate (`\ud800-\udfff` in the `u` pattern: an unpaired half only);
    `readDescriptor` refuses a descriptor that holds one anywhere (a URL, a key); `dispatch` answers `invalid` to a
    request that holds one anywhere, at the schema check (§10.6 step 3), before its body is read (the sender and state
    refusals before it still come first: an unapproved plugin's such `env.get` is `not-approved`, as the cross-check
    shows). Appendix A's pattern is unchanged (a pattern
    cannot tell a pair's half from a lone one in every dialect); §2.3 says the rule in words.
- **F-2. A sparse array makes `readDescriptor` throw.** For example, `contributions: [<hole>, {...}]`.
  - **Why.** `every` skips holes, then a hole is read as `undefined`.
  - **Not reachable over messaging.** [inferred: Chrome serialises extension messages as JSON, which has no holes; a hole
    arrives as `null` and is refused as `invalid`.] The review's E8 confirmed it: `[1, , 3]` arrives as `[1, null, 3]`.
    The SDK throws the same way. The cross-check removes array items rather than leaving holes, and says why. Nothing
    else to do (the maintainers' ruling), and r2 changes nothing here.

## 9. Measured

**Sixkey's budgets**, prod build, zh_CN where it is the larger:

| Budget                                   | Base (live)    | W1c            | Change | Limit           |
| ---------------------------------------- | -------------- | -------------- | ------ | --------------- |
| popup gzip, the release gate open        | 59,262         | 59,259         | −3     | ≤ 59,551 (wave 1's cap); 2,181 left of 61,440 (floor 1,500) |
| popup gzip, the gate closed              | 58,000         | 58,001         | +1     | 61,440          |
| side panel gzip, gate open / closed      | 61,491 / 60,237 | 61,488 / 60,235 | −3 / −2 | 63,488       |
| settings, every part (zh_CN)             | 12,123         | 12,123         | 0      | 12,288          |
| a vault's page with every lazy catalog   | 15,048         | 15,048         | 0      | 15,360          |

The popup's few bytes are gzip noise from S-1's one-line change in `Fill.tsx`.

**The samples' builds:**

- password generator: `sw.js` 1.1 KB, `generator.js` 3.7 KB, the SDK chunk 22 KB;
- screenshot: `sw.js` 1.9 KB, `capture.js` 6.5 KB, the SDK chunk 22 KB.

None contains `eval`, `Function`, `fetch` or a web address (`plugin-sdk-package.test.ts`).

**Gates and full runs** are recorded in §11.

## 10. Tests and mutants

**New unit tests:**

| File                             | Tests | What                                                                                                   |
| -------------------------------- | ----- | ------------------------------------------------------------------------------------------------------ |
| `plugin-sdk-cross.test.ts`       | 11    | §2's cross-checks                                                                                      |
| `plugin-sdk-client.test.ts`      | 13    | the client against `fakeSixkey`: ports, pairing (and what it refuses), a silent port and a hello it cannot make, messages, events, timeouts, envelopes |
| `plugin-sdk-package.test.ts`     | 14    | the schema file against Appendix A, the developer ID from its key, the store ID as Sixkey's, no hidden character in any file, Sixkey's names, not published, the source and built-code rules, the manifests, P0 only and hello only, check-dist's rule |
| `sample-password.test.ts`        | 12    | the draw with scripted values at the rejection limit, the default source is `crypto.getRandomValues`, every alphabet size, χ² over 90,000 draws, whole-password rejection, look-alikes, limits |
| `sample-stitch.test.ts`          | 9     | `walk` on a model page: whole parts, parts shorter than `innerHeight`, fractional ratios, short and stuck pages, the canvas limit, 400 random pages |
| `autofill-gate-off-touch.test.ts` | 2    | S-1                                                                                                    |

**Mutants.** 64 mutants were run by `w1c-mutants-r3.py` (a copy is in `scratchpad/w1c/`), under the heavy lock. Each is one edit, and each must fail an
assertion of the named tests. They cover:

- **the SDK's validation:** the descriptor, the bodies, request IDs, responses, the client's sender and pairing checks,
  and the fake's order of checks;
- **the samples' security-relevant parts:**
  - the draw: no rejection, an off-by-one limit, `Math.random`;
  - a missing set patched in;
  - capabilities beyond `ui.slots`, a request beyond `hello`;
  - `eval`, `fetch`, `new Function`, `unsafe-eval`, `<all_urls>`, `debugger`;
- **the stitching** and **check-dist's rule**;
- **S-1.**

The results are in §11.

## 11. Gates and runs

All of these ran on the delivered tree.

- **Gates.** All passed:
  - `messages.py`: no catalog changed;
  - `npm run typecheck`, which now covers the SDK and the samples;
  - `tsc -p contract/plugin-sdk`;
  - the prod, e2e and dev builds, each with check-dist and its new rule;
  - the store build with the sync interface (the gate open), with check-dist;
  - `npm run format:check`, through the project scripts only.
- **check-dist's new rule, seen to fail.** In the e2e copy, the SDK's mark was appended to a prod build's `sw.js`.
  check-dist failed with "sw.js: the plugin SDK's or a sample plugin's code in the build", and passed again once the
  file was restored.
- **Unit, full**, under the heavy lock: 267 files; 4,000 passed, 4 expected fail, 1 skipped, 0 failed. Base was 261 files
  and 3,939 passed; W1c adds 6 files and 61 tests.
- **e2e, full**, in a copy with the API port moved off 8787 and no `/e2e/` in its path: 384 passed, 1 skipped, 0 failed,
  in 30.1 minutes. W1b had 382 passed; the two new tests took 4.8 s and 12.5 s. **`e2e:sync`:** 12 passed.
- **The guide**, followed literally on the final text (§4): it typechecks, its 2 tests pass, it builds, and it connects in
  Chromium.
- **Mutants: 64 of 64 killed by assertions.**
  - **The first run killed 53 of 61.** Five did not apply, because Prettier had reformatted their targets. One was
    equivalent: two checks swapped that cannot both hold, so it was replaced by "not-approved before blocked". Two
    survived, a `Math.random` draw and a minimum length of 3; tests were added for both (the source of randomness
    spied, the limits stated absolutely).
  - **The reruns.** All were killed, except the fake's ignored hello deadline, which needed a test of a silent port;
    with it, that mutant was killed too.
  - **Added later:** the hidden-character rule and `Math.random` in the SDK.
  - **The final run, on the delivered tree:** 64 killed, 0 survived.
  - **The stitch mutants** were run again after the property's counterexample (§6): all 5 killed.
- **Licence coverage.** There is no `reuse` tool here. `reuse-cover.py`, in the snapshot folder, applies `REUSE.toml`'s
  globs with its "last match wins" rule to every new or changed file and checks that each licence's text is in
  `LICENSES/`. All 51 files are covered: Apache-2.0 for the SDK's code, CC0-1.0 for its schema and the repository files,
  MPL-2.0 for the samples and tests, CC-BY-4.0 for the documents.
- **Hidden characters.** The first draft of the SDK's `text.ts` and of the cross-check had the invisible characters of
  §2.3 written literally, including bidirectional controls. The tool that wrote them had decoded the `\uXXXX` escapes.
  - **The fix.** They are escapes now. The SDK's pattern is character for character Sixkey's, and a test refuses any
    hidden character in the SDK's and the samples' files.
  - **The patch.** It was scanned for the same characters before delivery.

## 12. r2: the review's fixes (`REVIEW.md`, 修改后通过)

Every probe and surviving mutant the review named is now a test.
- **The probes** (E1 to E7, P-U1 to P-U6, F-1's E8): each such test was run on r1 and failed there, on an assertion
  (`r1-unit-check.log`, `r1-e2e-check.log` in the snapshot folder): 30 unit tests and all 9 browser tests.
- **The surviving mutants** (M01, M02, M09, M22, M23, M25 to M28, M31): r1's code was right there, its tests had gaps,
  so the tests that close them pass on r1 too (the body-rule edges, the M09 client test, the repository-wide guard). The
  evidence is the reviewer's own script: they survived r1 in its log, and r2's tests kill them (§12.4).

### 12.1 Required (W1C-01 to W1C-08)

| Finding | What r2 does | The test that holds it (failed on r1) |
| --- | --- | --- |
| **W1C-01** smooth scrolling (E1) | Every scroll is `behavior: "instant"`, the restoring one too. The page's position is read before and after each part, and a part taken while the page moved is taken again (twice at most), else the capture stops and says why | `sample-screenshot-pages.spec.ts` E1 (Bootstrap 5's `scroll-behavior: smooth` page) |
| **W1C-02** fixed and sticky (E2, E3) | Sticky elements are made `position: static !important` for the capture: in the flow, they appear once where the page has them. Fixed elements are looked for again before every part after the first, so one the page pins only after scrolling is hidden too. What remains imperfect is in the sample's README (a page that animates or loads while scrolled, fixed elements not at the top, inner scrolling) | E2 (a header pinned by script below 1,000 px, so a one-time scan misses it), E3 (a sticky heading, sampled every 5 px, so no copy anywhere else) |
| **W1C-03** growing pages (E4, P-U6) | `walk` draws the last part flush with the bottom only when that is rounding (within two device pixels of where it was); a page that grew is drawn where each part was, and the canvas, the page as measured, cuts the rest | E4; `sample-stitch.test.ts` P-U6 and a property over 300 growing pages at six ratios |
| **W1C-04** interrupted captures (E5, E6) | The page's side keeps the capture's state in the plugin's isolated world under a token, and listens on a port the capture window opens (`tabs.connect`): when the port closes, the window is gone, and the page puts itself back. A late call for an old token does nothing. **Capture again** is disabled, and guarded, while a capture runs. No data attribute is left in the page, nor an empty `style` | E5 (window closed in the middle: back at 0, header visible, no attribute), E6 (the button disabled, then a second capture, the page back each time) |
| **W1C-05** pairing (P-U1, P-U2, P-U3, P-U3c) | The pairing is read afresh on every decision; a port's events are dropped once its ID is forgotten; a forgotten ID is not paired again by itself (`storagePairing` keeps the list; a pasted ID pairs explicitly, the samples' **Connect to Sixkey**); one decision at a time; a paired ID is trusted on ports only, never for messages or as a request's target. The specification's §3.3 item 3 says all of it, and that an impostor keeps the real Sixkey out until Forget | `plugin-sdk-client.test.ts`: P-U1 (three cases), P-U2, P-U3, P-U3c, and a new worker on the same storage |
| **W1C-06** check-dist's two marks (M22, M23) | The rule is on the module graph now: every build of `scripts/build.mjs` fails if any entry's graph holds a module of `contract/plugin-sdk/` or `plugins/examples/` (`foreignCodeGuard`). check-dist sees only the built files, where M22's trace is a regular expression Sixkey has too, character for character; its marks stay as a second look. A source rule checks that no import under `src/` resolves there | `plugin-sdk-build-guard.test.ts` (a real build of a copy with M22's and M23's imports fails, naming both); `plugin-sdk-package.test.ts` (every `build()` call has the guard) |
| **W1C-07** the hidden-character guard (M25 to M28) | `[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]` but tab and newline, over every text file of the repository. r2 listed seven files that held such characters, by count; r3 escapes them all and keeps no list (§13, R2-01) | `plugin-sdk-package.test.ts` "no hidden character in the repository's text" |
| **W1C-08** F-1 (E8) | §8 above: plain text, the descriptor, and every request | `plugins-lone-surrogate.test.ts` (6 tests, by message and on a port); `plugins-lone-surrogate.spec.ts` (Chromium: an approved plugin's hello with a lone surrogate is `invalid`, not `internal`, and it stays approved); the cross-checks |

### 12.2 Suggestions (W1C-09 to W1C-18): taken and skipped

- **Taken:**
  - **W1C-09.** The cross-check's messages now include every body rule at and across its edges (handles of 15 to 17
    letters, key names of 32 and 33, counts and lengths ±1, the character sets): M01 and M02 die. A new
    `plugin-sdk-port-cross.test.ts` runs ten plugin behaviours against Sixkey's own `openPort` (over a stand-in
    `chrome.*` whose ports carry JSON) and against the fake's port, for a waiting, an approved and a blocked plugin, and
    compares how each ends and what the plugin received. It found two more differences, both fixed in the fake: a
    blocked plugin's port (P-U4: Sixkey refuses it, the fake took it), and the approval screen's port (Sixkey keeps it
    open and answers on it, the fake closed it). M09 dies there. The fake's transport and ports carry JSON, as Chrome's
    do (E8).
  - **W1C-10.** The developer build's ID is opt-in (`sixkeyIds`); the default is the store build's, empty until it has
    one.
  - **W1C-11.** `npm run typecheck` also runs `tsc -p ../contract/plugin-sdk`, whose tsconfig now has
    `exactOptionalPropertyTypes`; the two lines it caught are fixed (M31 dies).
  - **W1C-12.** Both samples' pages: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:;
    base-uri 'none'; form-action 'none'`; the guide's manifest too.
  - **W1C-13.** A page no extension may capture is named as such (E7); the capture stops if another tab is brought to
    the front (a test of its own); the README says what an inner-scrolling page gives.
  - **W1C-14.** The guide: dropping `acceptPort()` answers at once; the impostor-blocks-Sixkey risk, in the guide and
    the README; the password README says what clipboard history keeps.
  - **W1C-15.** Dead code and comments: the screenshot's `now` flag, `password.ts`'s impossible check (and the test's
    comment), `build.mjs`'s unused export, a revoked object URL per capture, the S-1 test's copied header and unused
    parts, the stale S-1 comments; the envelope types renamed (`RequestEnvelope` ..., not the Fetch API's names);
    `HelloResult.trust` without `blocked`; `deliver()` checks the slot and the tab; the samples spec's own launch is
    `launchWithSample`.
  - **W1C-16.** `contract/plugin-sdk/LICENSE` is the Apache-2.0 text (a test holds it to `LICENSES/Apache-2.0.txt`).
    No licence changed.
  - **W1C-17.** `touchSwitch`'s comment says what an unchanged write does to a record whose tag fails (P-U7).
  - **The guide's generator length.** A fractional length is rounded, not refused with a misleading line.
- **Skipped, with reasons:**
  - **A fixed key for the e2e build** (§2.6 of the review): a Sixkey manifest change, and a decision for the next wave,
    as the review says.
  - **Holding the hand-written message types to the schemas:** the specification now says they are not (§11.1).
  - **The well-formedness check on W2's vault write path:** W2's; F-1's refusal at the protocol already covers every
    plugin string.
  - **W1C-18** (offscreen-race under load): nothing to change; see §12.4 for this round's runs.

### 12.3 What changed besides

- The SDK client checks a request before looking for its target (a mistake throws even with no Sixkey ID known).
- `checkDescriptor` refuses a lone surrogate as `invalid`, with a `problems` line, as Sixkey does; `makeRequest` too.
- `fakeSixkey().open()` leaves the port open (the approval screen's), and `reload()` stands for a new version.
- The screenshot window has the generator's **Connect to Sixkey** field, which pairs with the pasted ID.
- The specification's §2.3, §3.3, §3.4, §11.1, §11.2 and §12.2 say the above; Appendix A is unchanged.

### 12.4 Measured and run (r2, the delivered tree)

**Sixkey's budgets** (prod; zh_CN where it is the larger):

| Budget | Base (live) | r1 | r2 | Limit |
| --- | --- | --- | --- | --- |
| popup gzip, the release gate open | 59,262 | 59,259 | 59,259 (−3) | ≤ 59,551; 2,181 left of 61,440 (floor 1,500) |
| popup gzip, the gate closed | 58,000 | 58,001 | 58,006 (+6) | 61,440 |
| side panel gzip, gate open / closed | 61,491 / 60,237 | 61,488 / 60,235 | 61,486 / 60,234 | 63,488 |
| settings, every part (zh_CN) | 12,123 | 12,123 | 12,123 | 12,288 |
| a vault's page with every lazy catalog | 15,048 | 15,048 | 15,048 | 15,360 |

r2's few bytes are F-1's (a pattern range and the well-formedness walk, in the plugin platform's code). No permission,
no manifest, no catalog of Sixkey's changed.

- **Gates.** All passed:
  - `messages.py`: no catalog changed;
  - `npm run typecheck`, which now includes `tsc -p ../contract/plugin-sdk`;
  - the prod, e2e and dev builds, and the store build with the sync interface (gate open), each with check-dist; every
    build with the foreign-code guard;
  - `npm run format:check`.
- **Unit, full** (heavy lock): 270 files; 4,053 passed, 4 expected fail, 1 skipped, 0 failed, no unhandled error. (A first
  r2 run passed every test but reported three unhandled errors from a port-cross scenario posting on a port Sixkey had
  already refused; the scenario now catches Chrome's throw, as a plugin must, and the suite ran again clean.)
- **e2e, full** (a copy with the API port moved off 8787, no `/e2e/` in its path): 393 passed, 1 skipped, 0 failed, in
  30.2 minutes (r1: 384; r2 adds the 8 page tests and the F-1 test). `offscreen-race` passed under the full load this
  time. **`e2e:sync`:** 12 passed.
- **r1 against r2's tests** (`r1-unit-check.log`, `r1-e2e-check.log`): 30 unit tests fail on r1 (every probe of the
  review's and the F-1, guard, port and stitch cases), and all 9 new browser tests. One new test passes on r1 by design:
  M09's (r1's fake already ended a port on a request before hello; no test held it).
- **Mutants** (heavy lock):
  - mine, `w1c-mutants-r3.py`: 89, all killed by assertions (one, the pairing kept between reads, was first written
    as an equivalent edit and survived; rewritten, it was killed);
  - the browser's, `w1c-e2e-mutants.py`: 7, all killed (E1 to E7's behaviours: instant scrolls, sticky made static,
    fixed elements looked for before every part, the page's port, one capture at a time, the tab check, the refusal's
    words);
  - the reviewer's, `REVIEW-mutants.py` on a copy of r2: 25 killed, M01, M02, M09, M25 to M28 and M31 among them. M21,
    M22 and M23 now stop the build itself ("the plugin SDK's or a sample plugin's code in the build", naming the
    modules), which the script reports as "build failed" rather than as check-dist's refusal. M10, M11 and M17 no
    longer apply (the code they edit moved); their equivalents are in my set.
- **The guide**, followed literally again on r2's text: it typechecks, its 2 tests pass, it builds, and it connects in
  Chromium.
- **Licence coverage:** `reuse lint` (reuse 5.0.2, the reviewer's) on a copy of live with the r2 patch applied:
  compliant with REUSE 3.3, 1,150 of 1,150 files with copyright and licence information (macOS's `.DS_Store` files
  removed from the copy first). `reuse-cover.py` over every new or changed file agrees.

## 13. r3: the r2 delta review's fixes (`REVIEW-r2.md`, 修改后通过)

r2 had two required fixes (R2-01, R2-02) and three suggestions (R2-03 to R2-05). r3 makes all five; R2-06 and R2-07
were information. r3's own full run found one more bug, in the SDK, now fixed (§13.5). Each new test was run on r2 and
fails there on an assertion (§13.7).

### 13.1 R2-01: no hidden character left, and no list

r2's guard let seven files hold 18 literal hidden characters, by count per file, so one could be swapped for another
(the review's A1). r3 writes all 18 as escapes, and the guard keeps no exception.

| File | Characters | Written now | Why this form, and the proof |
| --- | --- | --- | --- |
| `contract/py/test_contract.py` | 1: U+FEFF in a test string | `"\ufeff{}"` | a Python escape in an ordinary (not raw) string is the same `str`; the module's syntax tree (`ast.dump`) is equal to r2's; its 47 checks pass |
| `docs/SYNC-DESIGN.md` | 1: the U+200D that joins 👩 and 💻 in O3's quoted hint | `👩&#x200D;💻` | a CommonMark numeric character reference: the rendered text is unchanged, and the source shows what is there. Markdown parsed by Prettier's own parser (remark) gives the same text for that row in r2 and r3, U+200D in it. The file is cited by line and Prettier leaves it alone; the line count is unchanged. `check_consistency.py` reads it: 0 mismatches before and after |
| `extension/src/core/sync/crypto/device-name.ts` | 11: the bidirectional controls and zero-width characters of two `u` character classes | `/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u` and `/[\u200B-\u200D\u2060\uFEFF]/u` | in a regular expression `\uXXXX` is the same code point; the two expressions of r2 and r3 tested on every code point from 0 to U+10FFFF (lone halves too) and on a pair: the same answers. TypeScript's syntax tree is equal to r2's. The device-name, sync-crypto, vectors and property tests pass |
| `extension/test/unit/contract-openapi.test.ts` | 1: U+FEFF | `"\uFEFF{}"` | the same string, evaluated; the syntax tree equal; the test passes |
| `extension/test/unit/m5-transport-urls.test.ts` | 1: U+2028 | `"/v1/x\u2028"` | the same string; the tree equal; the test passes |
| `extension/test/unit/sync-crypto-enroll.test.ts` | 2: U+202E | `"a\u202Eb"`, `"evil\u202Etxt.exe"` | the same strings; the tree equal; the test passes |
| `extension/test/unit/sync-crypto-hygiene.test.ts` | 1: U+202E in a template | `` `${PW}\u202E` `` (not `String.raw`) | the same string; the tree equal; the test passes |

The scripts and their log are in the snapshot folder: `escape-equiv.mjs` (30 literals evaluated, the regular
expressions on every code point), `escape-ast.cjs` (TypeScript trees), `py-ast-equiv.py`, `md-entity-equiv.mjs`;
`r3-escape-equiv.log`.

**The built extension.** base, r2 and r3 were each built at the same path, r2 and r3 in all four flavours, and compared
file by file with the hashes in file names set aside (`build-diff.py`, `r3-bcmp.log`):

- **prod** (the store build, gate closed): identical. The device-name rule is sync code, and the gate keeps sync out.
- **e2e:** one change, in one file (`sync-engine-*.js`): the two regular expressions, written with `\u` escapes where
  r2 had the characters. The bundler keeps a regular expression's text as written; the expressions are the same.
- **gate open** (the store build with `SYNC_UI_IN_STORE_BUILD`): the same single change, in `sync-ui-*.js`.
- **dev:** the same change in `sync-engine-*.js`, written twice (unminified), and that chunk's source map (its
  `sourcesContent`). Nothing else.

Sixkey's own code changed, so the full e2e suite and `e2e:sync` ran again (§13.8).

**The guard reads what git lists.** `git ls-files -co --exclude-standard`: the tracked files and the new ones not
ignored. `OWNER-DECISIONS/` is excluded in `.git/info/exclude` and is never read: the test checks the list before it
reads a file. Tracked files alone (`-c`) would miss every file not committed yet: in the live tree today, W1b's 13 new
files, and with the patch applied every file W1c adds, the SDK and the samples among them. The test's own check that
those files are read would then fail there.
Git's list is taken only when the folder is the work tree's top level. Outside one (a copy without `.git`, as the
scratch copies are, or such a copy inside another repository), the test walks the files. The walk leaves out the build
and tool folders and the top-level folders that `.public-exclude` names (`/OWNER-DECISIONS/`).

A second test makes a new git repository with a tracked file, a new one, an ignored and an excluded one, and a copy
inside it without `.git`. It holds what each branch lists. On a copy of the r3 tree with live's `.git` copied in, git's
branch is taken: 1,024 files, none under `OWNER-DECISIONS/`, no hidden character. A1 planted there fails as
`extension/src/core/sync/crypto/device-name.ts:18: U+202E` (`r3-gitcheck.log`).

### 13.2 R2-02: sticky elements unstuck as relative

- **What it does now.** For the capture, sticky elements get `position: relative !important; inset: auto !important`.
  They stay in the page's flow where the page has them, so they appear once and in place. They stay the containing
  block of their absolutely placed children, so a badge or a menu stays with them, and their `z-index` still applies.
- **The one difference left.** A sticky element always forms a stacking context; a relative one forms one only when its
  `z-index` is set. A child with a negative `z-index` inside a sticky element whose `z-index` is `auto` may then be
  drawn behind it. The sample's README lists this under "not perfect". `isolation: isolate` would close it, but no probe
  covers it, and the fix the review asked for is the relative one.
- **Put back.** The inline values and priorities of `position`, `top`, `right`, `bottom` and `left` are saved.
  - The style attribute comes back to the letter when nothing but the capture changed it: no other change, and no
    reordering (R2-06).
  - If the page's own script changed it meanwhile, each saved property comes back with its value and priority, and the
    page's own change is kept.
  - `inset` is saved as its four longhands. That is all `inset` is, and the to-the-letter path brings back an `inset`
    written in the attribute as written.
  - Hidden fixed elements are put back the same way, `visibility` being the property.
- **Tests** (`sample-screenshot-pages.spec.ts`):
  - **E13**, the review's probe, made a test: a sticky heading with `top: 12px`, so a missing `inset: auto` shows too,
    and an absolutely placed badge, sampled every 5 px.
  - **E10:** five sticky headings in every inline form come back to the letter. A sixth, whose style the page's script
    changes mid-capture, keeps the page's change and loses the capture's.
  - **E12:** see §13.4.
  - E1 to E7 and the tab check pass, and so do the review's own probes (§13.8).

### 13.3 R2-03: paths as the disk spells them

- **`foreignCodeGuard`** (`scripts/build.mjs`) compares the `realpathSync.native` of every module ID and of the two
  folders: the disk's own letter case, links followed. A virtual module (no file) is compared as it is.
- **check-dist:**
  - its folder rule (`plugins/examples/` in the build) is case-blind;
  - in a build with source maps (dev), every source a map names is resolved through `realpathSync.native` and refused
    under the SDK or the samples.

  check-dist sees only built files, and only a dev build names its sources, so this is a second look, as its marks are.
- **The source rule** (a test) resolves each relative import under `src/` the same way: its deepest part that exists,
  through `realpathSync.native`, and the rest as written. So `./text.js` for a `text.ts`, a `?raw` suffix, or a path in
  another case is still compared. Every relative import counts, as in r2. r3's first draft resolved imports to files
  and skipped those it could not find; that draft was not delivered (§13.6).
- **This disk is case-insensitive (APFS), so the tests use real case-different paths:**
  - a real build of a copy importing `Contract/Plugin-SDK/src/TEXT` and `Plugins/Examples/…/PASSWORD` fails, naming
    the files as the disk spells them (r2's build passed: the review's G4);
  - a build importing through links inside `src/` fails (G5);
  - check-dist fails a dev build whose map names `Contract/Plugin-SDK/src/TEXT.ts`, or that holds a
    `Plugins/Examples/` file;
  - the source rule finds the SDK behind `.js`, a query, a link and another case.
- **On a case-sensitive disk** (CI's), such paths do not resolve, and the build fails anyway; the tests say so and
  check only that.
- **Later, when the SDK is on npm:** `node_modules/@sixkey/plugin-sdk/` must be added to `FOREIGN` too (the review).

### 13.4 R2-04, R2-05

- **R2-04.** When another capture's token holds the page, the page's side now answers TAKEN (−2). When its state is
  gone (the page reloaded or went elsewhere, so the isolated world is new) or was put back, it answers GONE (−1), as
  before. The window says "The capture stopped: another capture started on this page." for the first. For the second it
  still says "…the page changed (it reloaded, or went to another address)."
  - The new words are the sample's own, inline like its other messages. Sixkey's catalogs are untouched:
    `messages.py`'s output is the same as r2's.
  - The same answer also replaces two wrong reasons: a gone page found by the read before or after a part (it said
    "kept moving by itself"), and the hiding step's bare "the page changed".
  - E12: two capture windows on one page. The first says the new words; the page is back at 300, its header visible,
    its heading sticky, no `style` attribute left on either.
- **R2-05.** The `types.ts` row of the specification's §11.1, the module's own header and §5's row now say the same:
  the names (capabilities, slots, icons, request types) are held to Sixkey's by tests, and the messages' shapes are not.

### 13.5 Found by r3's full run: the SDK's reader threw on a JSON value

- **The failure.** The random test "the SDK reads a descriptor as Sixkey does: on random changes to a valid
  descriptor" (1,500 runs, a new seed each run) failed once in r3's first full unit run, at seed −2066004132. A
  capability whose `name` is the JSON object `{"toString": 0}` made `checkDescriptor` throw `TypeError: Cannot convert
  object to primitive value`. Sixkey's own reader drops that capability.
- **The cause.** The SDK wrote the dropped item into its `problems` line with `String(c.name)`, and the same for a
  contribution's `id`. For an object whose `toString` is not a function, `String()` throws. The code is from r1; r2's
  runs had not drawn such a value.
- **The fix** (`contract/plugin-sdk/src/descriptor.ts`): the two lines name the value with `named()`. That is what
  `String()` gives, or, when it throws, what `Object.prototype.toString` gives (`[object Object]`). Every other value
  reads as before.
- **The test.** A hand-picked test in `plugin-sdk-cross.test.ts` covers a capability name `{"toString": 0}`, one in an
  array, and a contribution id. Each is a JSON round trip, as a message brings it. The test asserts that the reader
  does not throw, that the SDK and Sixkey read it the same way, and the problem line. On r2's `descriptor.ts` it fails
  on its `not.toThrow` assertion. Mutant 104 (`String()` alone) is killed by it.
- **Nothing else of the kind.** The same file's three properties ran at 50 times their runs, twice, with new seeds
  (75,000, 40,000 and 150,000 runs each time): all passed.

### 13.6 Taken over mid-revision

A first r3 draft stopped at a session restart before anything was run on its final state. All 17 files it changed were
kept, and these were fixed before any run counted:

- **The notes' §13 draft** held the 18 characters themselves in its table, where it meant to show the escapes. The new
  guard fails on that. It also gave results not yet measured. It was rewritten from the measurements.
- **The source rule** resolved imports to files and skipped those it could not find. r2 compared every import, so the
  draft was a regression. Fixed as in §13.3.
- **"Still a stacking context"** (the code's comment and the README) is not true of `relative` with `z-index: auto`.
  Reworded, and listed under "not perfect".
- **SYNC-DESIGN.md** had the emoji described in words, with a reason that does not hold ("no escape exists in Markdown
  text"). It now uses the character reference.
- **Smaller:**
  - a new local in `capture.ts` named `again` hid the **Capture again** button's;
  - the four new e2e tests sat between `midCapture`'s comment and the function;
  - the window's new message was shortened to the review's words;
  - the hidden-character test checks that `OWNER-DECISIONS/` is not listed before it reads any file;
  - the git branch is taken only at the work tree's top level, and a test covers a copy inside another repository;
  - the README's restore paragraph says what is put back and when.

### 13.7 Each new test fails on r2

r3's changed tests were run on r2's code: `r3-on-r2.log`, plus the SDK case of §13.5. Each fails there on an assertion.

| Test | On r2 |
| --- | --- |
| no hidden character, no list (`plugin-sdk-package.test.ts`) | fails: the 18 characters, listed by line |
| the build, in another letter case (G4) | fails: r2's build passes (`expected 0 not to be 0`) |
| check-dist: a `Plugins/Examples/` file; a map naming the SDK's `text.ts` | both fail: r2's check-dist passes them |
| E13: a badge inside a sticky heading | fails: rows wrong, the badge at the page's top |
| E10: put back to the letter | fails: the declarations reordered (R2-06) |
| E12: two capture windows | fails: the first said "the page kept moving by itself" this time; the review saw "the page changed …". Both are wrong, and r3 corrects both (§13.4) |
| the SDK: a name `String()` cannot turn into text (§13.5) | fails on `not.toThrow` |

The rest pass on r2, as they should: the git listing test, the source rule (its rule is the test's own code), the
plain-path and link builds. r2 already refused those.

### 13.8 Measured and run (r3, the delivered tree)

All of these ran on the delivered tree, after the fix of §13.5. The logs are in the snapshot folder.

- **Gates** (`r3-gates.log`), all passed:
  - `messages.py`: the generated catalogs are the same as r2's;
  - `npm run typecheck`, the SDK's own tsconfig included;
  - the prod, e2e and dev builds and the store build with the gate open, each with check-dist;
  - `npm run format:check`;
  - no stray `.orig` or `.rej`.
- **Sixkey's budgets** (prod; zh_CN where it is the larger), base / r2 / r3:

  | Budget | base | r2 | r3 | Limit |
  | --- | --- | --- | --- | --- |
  | popup gzip, the release gate open | 59,262 | 59,259 | 59,259 | ≤ 59,551; 2,181 left of 61,440 (floor 1,500) |
  | popup gzip, the gate closed | 58,000 | 58,006 | 58,006 | 61,440 |
  | side panel gzip, gate open / closed | 61,491 / 60,237 | 61,486 / 60,234 | 61,486 / 60,234 | 63,488 |
  | settings, every part | 12,123 | 12,123 | 12,123 | 12,288 |
  | a vault's page with every lazy catalog (the plugins' text in) | 15,048 | 15,048 | 15,048 | 15,360 |

  r3's budgets are r2's, to the byte.
- **Unit, full**, under the heavy lock (`r3-unit.log`): 270 files; 4,060 passed, 4 expected fail, 1 skipped, 0 failed, no
  unhandled error, 981 s. r2 had 4,053 passed. The 7 new tests: the git listing (1), the build guard (5), the SDK's
  never-thrown case (1).
- **e2e, full**, in a copy with the API port moved off 8787 (in 18 files, both manifests checked) and no
  `/e2e/` in its path (`r3-e2e-full.log`): 396 passed, 1 skipped, 0 failed, in 33.5 minutes. r2 had 393; the 3 new
  tests are E13, E10 and E12. `offscreen-race` passed in it.
- **`e2e:sync`:** 12 passed (`r3-e2e-sync.log`).
- **The plugin specs and the review's probes** (`r3-e2e-targeted.log`):
  - `plugin-samples`, `sample-screenshot-pages`, `plugins`, `plugins-w1b`, `plugins-lone-surrogate`: 35 of 35;
  - the review's unit probes (`REVIEW-probes.test.ts`, P-U1 to P-U7, P-U6 among them): 11 of 11;
  - the review's e2e probes (`REVIEW-r2-probes.spec.ts`): 11 of 12. E1 to E10 and E13 pass; their E10 now passes to the
    letter. E12 fails on their own `styles: 0`: the page's 10 bands carry inline styles, as REVIEW-r2 §1.5 says. The
    probe's own record shows the page put back (`y` 300, the header visible, the heading sticky) and the first window's
    words, "The capture stopped: another capture started on this page."
- **Mutants, all killed by a failing assertion:**
  - **`w1c-mutants-r3.py`, 104 of 104** (`r3-mutants.log`): r2's 89, one re-anchored (check-dist's marks, whose
    condition r3 split over lines), and 15 new ones. The new ones were run again with each log kept
    (`r3-mutants-new.log`, `mutlogs-r3/`): every one fails on an `AssertionError`.
    - **R2-01, 8:** A1 as r3 can have it (an escape made a literal U+FEFF again, a U+202E planted), the plant alone, the
      Python escape, the emoji's character reference; `ls-files` without `--exclude-standard`, `-c` only; the walk
      without `.public-exclude`; git's list in any work tree.
    - **R2-03, 6:** the source rule without realpath, or skipping what it cannot find; the build guard without
      realpath; check-dist's map sources without realpath, or no look at maps; its folder rule case-bound.
    - **§13.5, 1:** `String()` alone.
  - **`w1c-e2e-mutants.py`, 15 of 15** (`r3-e2e-mutants.log`, `e2e-mutlogs-r3/`): r2's 7 (E3's re-anchored to
    relative), and 8 new ones.
    - **R2-02, 5:** `static` again, `relative` without `inset: auto`, only `position` saved, put back property by
      property only, put back to the letter always.
    - **R2-04, 2:** the window says the old words; the page's three functions answer GONE.
    - **E12, 1:** the takeover without putting the first capture back.

    Each is matched to its own test by its `E<n>:` prefix. E1's mutant fails `toHaveAttribute("data-done")`: the capture
    stops part-way, so it never finishes.
  - **The review's own script, 30 of 30** (`REVIEW-r2-mutants-r3.py`, `r3-review-mutants.log`): their 29, with A1
    re-anchored as A1r (an escape made a literal again, a U+202E planted) and A1p (the plant alone). M22 and M23 stop
    the build (the guard's refusal), and M31 fails typecheck.
- **The escapes:** `r3-escape-equiv.log` (§13.1).
- **The build comparison:** `r3-bcmp.log` (§13.1).
- **The git branch on the real repository's list:** `r3-gitcheck.log` (§13.1).
- **Licence coverage:** `reuse lint` (reuse 5.0.2) on a copy of live with the r3 patch applied, without `OWNER-DECISIONS/`,
  `node_modules`, build output, ignored caches and local data: compliant with REUSE 3.3, 1,014 of 1,014 files with
  copyright and licence information (the review's count for r2 was 1,014 too; r3 adds no file).
- **Not done, and why:**
  - `isolation: isolate` for the stacking context (§13.2): outside the fix asked for, and no probe covers it;
  - `node_modules/@sixkey/plugin-sdk/` in `FOREIGN`: there is no npm package yet;
  - the samples' licence: unchanged (MPL-2.0), an owner decision (decided since: Apache-2.0, §7).
