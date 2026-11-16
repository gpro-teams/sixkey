# M5 notes: the extension's sync wiring

Milestone M5 of `docs/SYNC-DESIGN.md` (revision 22; §9, the M5 row), built on the sync engine of M3 (`docs/design/notes/M3-NOTES.md`,
its hand-off in §10) and checked against the real API server of M4 (`docs/design/notes/M4-NOTES.md`). M5 connects the engine to the
extension: the one network transport, the service worker's timers, alarms and badge, the page bridge, the outbox at
every commit, the manifest and its checks, and the API host permission as the network switch. It does **not** give
users a way to turn sync on: that is M6's sync section of the settings page (§9, "M6 的'同步设置'一节存在之前不得发布'开启同步'").
Until then the only way in is a developer page that exists in dev and e2e builds only (§3.9 below).

SYNC-DESIGN.md, `api/` and `contract/` are not changed here. Where the design leaves a choice open or the code departs
from its text, the item is in §9 (departures) or §11 (for the design owner and the owner). This is the fourth version
of these notes; §13 lists what changed from the first, §14 from the second, §15 from the third, and why.

---

## 1. How to run

| Command (in `extension/`) | What |
|---|---|
| `npm test` | unit, fault and regression tests (vitest), M5's new files included (§5) |
| `npm run build`, `npm run check` | the prod build (`dist/`) and `scripts/check-dist.mjs` on it |
| `npm run build:dev`, `node scripts/check-dist.mjs --dev` | the dev build (`dist-dev/`: the local API origin, the developer sync page, source maps) and its check |
| `npm run build:e2e`, `node scripts/check-dist.mjs --e2e` | the e2e build (`dist-e2e/`: API origin `http://127.0.0.1:8787`, the developer sync page, the API permission required) and its check |
| `npm run package` | the store package: the prod build, `check-dist` on it, then `release/sixkey-<version>.zip` from `dist/` (§3.12) |
| `npm run e2e` | Playwright, the regular suite; it builds prod, e2e and dev and runs `check-dist --e2e` and `--dev` first; `test/regression/network.spec.ts` serves the in-memory FakeServer on the e2e origin, `permission-wire.spec.ts` uses the dev build |
| `npm run test:live` | the sync engine in Node against the **real** API server: `test/live/` (§5.2) |
| `npm run e2e:sync` | the extension in Chromium against the **real** API server: `test/sync/` (§5.3) |

The two live commands start the server themselves (`test/live/server.ts`): for each test file a private PostgreSQL
cluster in a new temporary directory (`api/server/scripts/pg.sh`, a unix socket only), the migrations, and the
unmodified `python -m sixkey_server` with the FakeAuthProvider on a free loopback port. They need what `api/server`
needs (Python 3.14 with its pinned dependencies, the PostgreSQL 14+ binaries; `api/server/README.md`). The Python is
`SIXKEY_API_PYTHON` if set, else `api/server/.venv/bin/python` (`make venv`). If either is missing they fail and say
what is missing; nothing is skipped. `npm run e2e:sync` also needs `127.0.0.1:8787` free on IPv4 (the e2e build's
origin; a listener on the IPv6 wildcard of the same port does not matter, the IPv4 loopback bind is more specific, and
the proxy checks that it answers itself before a test starts).

**Trying sync by hand** (dev build): `make run` in `api/server` (serves `http://127.0.0.1:8787`, one-time codes go to
`api/server/.pg/otp-inbox.jsonl`), `npm run build:dev`, load `extension/dist-dev/` unpacked, set a master password, then
open `chrome-extension://<id>/devsync/index.html`. The dev build declares the API origin as an optional permission, as
the store build does: click **Grant API access** first and accept Chrome's prompt (it must be a click; the console
cannot ask). Then use `sixkeyDevSync` from the console: `requestCode(email)`, `signIn(email, code)`,
`firstUpload({ password, recoveryCode, deviceName, email })` or `joinWithRecoveryCode({ recoveryCode, deviceName, email })`,
`round()`, `view()` (which says whether the permission is held), `turnSyncOff(password)` (which removes the permission
afterwards). A first upload or a join that ends any way but "done" or "unconfirmed" ("enrolled" for a join) gives
the permission back while sync is not on, as M6's flows will (§12). **Remove API access**, or withdrawing it in
`chrome://extensions`, pauses sync (`permission_removed`): nothing is lost or sent, and only the local upkeep a sync
round does anyway still runs; granting it again resumes.

---

## 2. What was built

| Piece | Where |
|---|---|
| The API origin, a build-time constant per build: prod `https://api.sixkey.app`, dev and e2e `http://127.0.0.1:8787` | `scripts/api-origin.mjs` (the build's), `src/platform/api-origin.ts` (`__API_ORIGIN__`), `scripts/check-dist.mjs` (its own copy) |
| The one network transport (fetch), service worker only | `src/platform/fetch-transport.ts` |
| The page bridge: pages hand finished, signed requests to the worker | `src/platform/bridge-page.ts` (page), `src/platform/bridge-worker.ts` (worker) |
| One engine per syncing context, over that context's runtime | `src/platform/sync-engine.ts` |
| The worker's sync: timers and alarms for the engine's wakes, the keep-alive, the badge, the entry points | `src/platform/sync-worker.ts`, wired in `src/background/sw.ts` |
| `tryWebLock` (Web Locks `ifAvailable`) for `sixkey-sync` | `src/platform/locks.ts` |
| The outbox writer at every commit, and "sync soon" from pages | `src/platform/runtime.ts` (`withOutbox`) |
| The TOTP clock helpers out of the engine, into a module the popup may load | `src/core/sync/local/time.ts` (`engine/clock.ts` re-exports them) |
| The developer sync page (dev and e2e builds only) | `src/devsync/` |
| The API host permission as the network switch: asked for, checked, removed; the gated transport; the engine's check before every round and push; the worker's permission events and the browser-start cleanup (§3.13) | `src/platform/api-permission.ts`, `src/core/sync/engine/engine.ts` and `deps.ts` (`networkAllowed`, `permission_removed`), `src/platform/sync-worker.ts`, `src/background/sw.ts` |
| Manifests: the API origin as the one optional host permission (required in the e2e build), the CSP, version 0.1.0 | `manifest.base.json`, `manifest.dev.json`, `manifest.e2e.json`, `package.json` |
| Each page's own `connect-src 'none'` | `src/popup/index.html`, `src/options/index.html`, `src/offscreen/index.html`, `src/devsync/index.html` |
| The build: production mode pinned, one output directory per flavour, the origin injected, the manifest checked against it, a prod build refused if its module graph reaches the developer page or the enrolment code; `--out <dir>` | `scripts/build.mjs` |
| `check-dist` rewritten for §7 (§3.8 below) | `scripts/check-dist.mjs` |
| The store package, only from a checked prod build | `scripts/package.mjs` |
| Tests | §5 |

In `src/core/sync/engine/` only `clock.ts` (the move) and the network switch changed: the optional `networkAllowed`
dependency, the `permission_removed` status, the check at the top of `round()` and `push()`, and
`permissionWithdrawn()` (§3.13). The engine is still pure (no `chrome.*`, network, timer or clock:
`test/unit/m3-source-rules.test.ts`); the permission itself is asked in `src/platform/`.

---

## 3. Design decisions

### 3.1 The API origin

One constant per build, injected by Vite (`__API_ORIGIN__`) and written into the manifest. It is the manifest's only
host permission (optional in prod and dev builds, required in the e2e build: §3.2), the CSP's only `connect-src`
source, the only origin the transport reaches, the host every request signature covers (§5.2), and the `apiOrigin` a
new device identity records (§2.5, so a dev identity and a prod one are never used for each other). `scripts/build.mjs`
stops a build whose manifest (base plus the overlay, merged shallowly) does not name exactly that origin in the
flavour's host-permission key and in the CSP, or that has the other host-permission key; `check-dist` checks the built
result against its own copy of the three values, so the build script and the check are two opinions, not one. A unit
test keeps the copies equal (`m5-source-rules`).

dev and e2e use the loopback origin of M4's `make run`, `http://127.0.0.1:8787` (§5.2 names it for e2e). The design asks
for a development **domain** for dev builds (§7, §9 M8: "另加一个开发域名"); there is none yet, and until the cloud
go-live all development runs against the local server (`OWNER-DECISIONS/10-m8-golive-resources.md`), so dev builds use
it. A further flavour (a development domain, or the self-host build of `OWNER-DECISIONS/08-self-hosting-model.md`'s
option a) is one more entry in `scripts/api-origin.mjs`, an overlay and `check-dist`'s table; the store build keeps its
single origin. See §11.

### 3.2 The manifest and the content security policy

- **The API origin is an optional host permission** (§7, revision 21). The prod manifest has
  `optional_host_permissions: ["https://api.sixkey.app/*"]` and **no** `host_permissions` key; the dev build the same
  with its loopback origin. Nothing is granted at install: no install-time warning, an update that adds sync does not
  disable an existing installation (a new *required* host permission would, until the user accepts it), and a user who
  never turns sync on never holds it. M6's settings page asks for it in the click that turns sync on and removes it when
  sync is turned off (§12). The e2e build declares it as a **required** `host_permissions` entry instead (its overlay
  removes the optional key with `null`, which `build.mjs` drops), because automated tests cannot answer Chrome's prompt;
  the request, removal and events are covered by unit tests with a stand-in `chrome.permissions`, and the real prompt is
  a manual check (§10).
- No other permission changed (`chrome.permissions` itself needs none); `optional_permissions` keeps its own allow-list
  (`clipboardRead`, `clipboardWrite`), apart from the rules M5 made exact, so a later feature that needs one (the YubiKey
  design's native messaging) adds it there deliberately.
- `connect-src 'none'` became `connect-src https://api.sixkey.app`. That is required, not optional: in MV3 the
  `extension_pages` policy covers the extension's pages **and its service worker**, and a host permission lifts CORS,
  not the CSP. With `'none'` the worker's fetch is blocked, to every host, even with the permission granted.
- **Each page carries its own policy**, `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`,
  ahead of its first script: the popup, the settings page, the offscreen document and the developer page. The browser
  enforces every policy a page has, so a request must satisfy the manifest's **and** the page's: no page reaches any
  host, the API origin included. A `<meta>` policy governs only what loads after it, hence before any script;
  `connect-src` may be delivered that way. The worker has no document, so only the manifest's policy covers it, and it
  is the one context that reaches the API. "Network only in the service worker" (§4.9) is therefore a property the
  browser enforces; `check-dist` checks that the policy is there, and the source rules and the `fetch` count remain as
  tripwires. Pages that sync go through the bridge (§3.4). `img-src 'self' data:` keeps the API origin out of images as
  before. Navigation (`location`, `window.open`) is not governed by `connect-src`; that was so in Phase 0 too.
- `version` 0.0.1 → **0.1.0**: M4's default `min_client_version`. Below it every round and every non-exempt write is
  `update_required`. `check-dist` now refuses a manifest version below 0.1.0.

### 3.3 The transport (`fetch-transport.ts`)

It sends the engine's request unchanged and nothing else but one fixed header:
- **URL**: the origin plus the request target exactly as signed. A target that is not a plain path and query, that
  starts with `//`, or that a URL parser would rewrite (`..`, `%2e`, a fragment) is refused before anything is sent; so
  is a target whose parsed origin differs (the two checks overlap on purpose, §6).
- **Headers**: exactly the engine's (`Content-Type`, `Authorization`, the `Sixkey-*` signature headers), plus
  `Accept-Language: *`. A request with a body must say `Content-Type: application/json`, exactly, without a charset (the
  server refuses anything but that or `; charset=utf-8`, §5.4; the body is the signed text and is never re-encoded); one
  without a body has no Content-Type.
- **`Accept-Language: *`** on every request. Without it Chrome sends the user's language list, a locale signal the
  server never needs (D3: no language is collected). The header is CORS-safelisted, so this changes nothing else about
  a request; the signature does not cover it. A request that already carries one is refused (the engine's never do).
  `User-Agent`, `Origin` and the client hints are the browser's and cannot be changed (§4).
- `credentials: "omit"` (no cookie is sent or stored), `cache: "no-store"`, `referrer: ""` with
  `referrerPolicy: "no-referrer"`, `redirect: "error"` (a redirect would re-send a signed request to another target),
  `mode: "cors"`, `keepalive: false`.
- **One attempt.** A retry is the engine's: it signs again with a fresh time. A transport that resent an old request
  would let it outlive the window the engine's reasoning assumes (§3.6.0: "not in effect" ten minutes after the last
  signature).
- **At most 60 s** per exchange, response body included (§9 M5), then the request is aborted.
- **At most 9 MiB of response body** (one envelope of at most 8 MiB, §4.3, plus the rest of the answer; the server's own
  request limit for one envelope, §5.4), counted as it streams, after any decompression; a `Content-Length` over it is
  refused before reading.
- **Every way of not getting a complete answer** (offline, timeout, a dropped connection, a redirect, an answer too
  large) rejects with `NetworkError`: the outcome is unknown, and the engine treats it so (`transport.ts`). An HTTP error
  status is an answer and comes back as one. A body that is not valid UTF-8 comes back empty, which the API client reads
  as `malformed_response`.
- Response header names are lowercase; the body is text. Nothing is logged; no error carries a URL, a header or a body.
- **In the worker the transport is gated by the API permission** (`permissionGated`, §3.13): a request is refused
  before it leaves (a `NetworkError`) while the permission is not granted, before the keep-alive below starts.

**The keep-alive.** By Chrome's documented MV3 lifetime rules, a service worker that has seen no event or extension API
call for 30 s is stopped, and an outgoing fetch is neither, so a response that takes longer may be cut. While any request
is out, the worker calls `chrome.runtime.getPlatformInfo()` every 20 s (`keptAliveWhileSending`), bounded by the 60 s
timeout; an extension API call resets that timer. This is tested with fake timers only: a stop during a slow request was
not reproduced in a real browser (§10). A worker stopped anyway (by the browser, or a crash) leaves a request whose
outcome is unknown, which every step of the engine already handles.

### 3.4 The bridge (`bridge-page.ts`, `bridge-worker.ts`)

**Who signs** (SYNC-DESIGN §4.9, §4.14). A page signs its own requests, and the worker relays a finished request
without signing it, storing it or inspecting it beyond four checks: the sender, the shape, the origin pin and the
target exactly as signed. The worker signs only its own rounds, pushes and polls.

A page that runs the engine (M6's settings page; the developer page now) signs with the device key it reads from
IndexedDB (non-extractable in IndexedDB, so every extension context can sign with it; its only exportable copy, in
`sk_sync_cfg`, is encrypted under the vault key, §2.5), then hands each finished
request to the worker (`chrome.runtime.sendMessage({ type: "sk-api" })`), which sends it with the same transport and
answers with the response. The bridge checks the sender and the shape; the fetch transport pins the origin and sends
the target exactly as signed (§3.3). A worker that signed whatever a page asked would be a signing service for any
code that can message it; this one signs for nobody.
- **Who**: only this extension's own pages, by `sender.id` and the page's path: the settings page, and in dev and e2e
  builds the developer page (`__SYNC_DEV__`). Not the popup (it never runs the engine), not the offscreen document.
  `runtime.onMessage` receives only this extension's own contexts. Another extension can message Sixkey only through
  `runtime.onMessageExternal` or `onConnectExternal`, and Sixkey registers a listener for neither (`check-dist` fails a
  build whose scripts name either); with no `externally_connectable` key, no web page can message it at all, and there
  are no content scripts.
- **A real boundary.** No page can reach the network itself (its own `connect-src 'none'`, §3.2), so code running in the
  popup reaches no host, directly or through the bridge, which refuses it. Without the page policies the list would
  mean little: a page could call `fetch` on the API origin itself.
- **What**: the engine's request shape only: its five methods, its seven header names (case-insensitive, each once),
  string values within size limits, a body string within the server's own limit. Anything else is answered `refused`
  and not sent.
- **Never the sync lock** (§4.9 D10): the page running a round holds `sixkey-sync`; the worker serving it must not, or
  the two would wait for each other. The worker stores nothing that passes through (an account session's token travels
  as the `Authorization` header and stays in the page's memory, §4.9).

### 3.5 Scheduling in the worker (`sync-worker.ts`)

The engine decides when (`schedule.ts`); the worker only carries it out. A wake under 30 s is a `setTimeout` (an MV3
worker lives at least that long after its last event), from 30 s on a `chrome.alarms` alarm (`sk-sync-sync`,
`sk-sync-kick`, `sk-sync-retry`), which survives the worker being stopped. A later wake of a name replaces the earlier
one, timer or alarm. Everything that must survive is in `sk_sync_state` (the pending "sync soon", the failure count, the
end of the backoff, the clock offset), so a new worker carries on: at every start it calls `engine.start()`, which
schedules a round when there is something to send, never before a stored backoff ends.

Triggers:
- **A commit with sync on, in a page** (§4.8 "sync soon"): the runtime's `afterCommit` writes the outbox and then sends
  `sk-sync-soon`; the worker calls `engine.kick()` (a round 3 s later, the 30 s backstop alarm). It is sent from inside
  the commit, right after the outbox write, which is the earliest moment the save is durable, so a page that closes at
  once (the popup in "lock every time") has already asked. The worker's own commits are its rounds' and send nothing.
  A `sk-sync-soon` that arrives with sync off (sent just before a turn-off) schedules nothing: no timer, no alarm.
- **A page showing the unlocked vault** (§4.8: a background round when the last success is over 30 s old): the popup
  and the settings page already send `sk-reschedule-autolock` then, and the worker runs its check there; no page code
  changed for it. The popup sends that message at **every render of its list**, on opening and at each reload after a
  change, not once per opening. So the round is held back:
  - while the last success (`lastOkAt`) is under 30 s old;
  - while a **keyless** round is under 30 s old and this worker **still has no key**: the stored status is one a round
    without the key ends with (`locked`, `identity_missing`), its `lastAttemptAt` is recent, and the worker's session
    holds no vault key. A worker without the key ("lock every time") only ever runs keyless rounds, which never write
    `lastOkAt`, so `lastOkAt` alone would let every render ask the server's status. Once the key is here (the user has
    just unlocked), the next render gets its round at once: it is the round that can pull, merge and restore a lost
    identity, which the keyless round before the unlock could not (an earlier version held it back for 30 s, and
    `test/sync/restart.spec.ts` caught it);
  - while the last page-shown round this worker started is under 30 s old, which covers two renders that arrive
    together, before the first round has stored its attempt (the second would otherwise find the sync lock taken and
    make the first run again).

  A stamp in the future (the clock went back) holds nothing back.
- **The API permission** granted (`chrome.permissions.onAdded`): with sync on, a round, at once or when a running
  backoff ends; withdrawn (`onRemoved`): `permission_removed` at once, the badge cleared, nothing sent (§3.13).
- **A browser start** (`runtime.onStartup`): a permission still held without a sync configuration is removed (§3.13).
- **The periodic alarm** `sk-sync-periodic`, every 30 minutes, created with a random first delay of 1 to 30 minutes, and
  only while sync is on (cleared otherwise, so a profile without sync is never woken by it).
- **A page that changed sync's state itself** (turned it on or off, ran a round) sends `sk-sync-changed`: the worker
  brings the badge and the periodic alarm up to date.

With sync off the worker reads its sync records once per start, per page shown, per stray "sync soon" and per
permission event (one storage read each), writes nothing, and sends nothing (the regression test checks that the API
gets no request).

### 3.6 The outbox at every commit

`createOutboxWriter` (M3) is the runtime port's `afterCommit` in every context (§4.7, D2). The service calls it only with
sync on. The popup's bundle gains `core/sync/local/outbox.ts` and nothing else of sync (§7); it encrypts the upload
envelope in the commit, as M3 measured, and decrypts or merges nothing (the popup module rules hold:
`m2-source-rules`, `m3-source-rules`).

It costs one storage read per edit with sync on, and that read cannot be shared with the edit's own: the writer must
read `lastSynced` inside the vault lock **after** the commit, because a recovery write in the same transact runs the
store's recovery hook after the edit's function (`store.ts write`: the decrypt fallback's restore), which clears
`lastSynced` and moves the outbox to the orphan list; an outbox built on the edit's earlier read would bring a pushable
record back over that. So `test/unit/read-budget-sync.test.ts` now expects two reads of the sync state with sync on (one
before the commit, the writer's after it, checked to come after the slot's write and read-back) and still one with sync
off (§8).

### 3.7 The badge

`chrome.action.setBadgeText` with the number of approval requests waiting (`pendingEnrollments`, written on change by
every round, locked ones too; "99+" above 99). Nothing while sync is off, and nothing in a state where no round asks
the server's status, so the stored count would go stale: `update_required` and `rejected_by_server` (M3-NOTES §10
item 7), `permission_removed`, and the stops before any request (`identity_missing`, `damaged`, `wrong_origin`,
`cloud_restore`, `join_unfinished`). It follows every round the worker runs, every permission event and every
`sk-sync-changed` from a page. No title text yet: the badge alone says nothing to a
screen reader, and the words for it are M6's (§12).

### 3.8 check-dist (`scripts/check-dist.mjs`)

Three flavours (`--e2e`, `--dev`, default prod) and `--dist <dir>`; without `--dist` each reads its own directory
(`dist/`, `dist-dev/`, `dist-e2e/`). It checks, besides everything it checked before:
- the manifest's top-level keys are exactly the expected set (no `content_scripts`, `externally_connectable`,
  `web_accessible_resources`, ..., and not the flavour's other host-permission key); `permissions` are exactly the
  expected list (the e2e build's adds the clipboard pair); prod and dev: `optional_host_permissions` is exactly the
  flavour's origin and there is no `host_permissions`; e2e: `host_permissions` is exactly its origin and there is no
  `optional_host_permissions`; the CSP is the exact string, and holds `extension_pages` only; `background` is exactly
  the module worker `sw.js`; the version is at least 0.1.0;
- every shipped HTML page (`.html` or `.htm`) starts with the doctype, `<html>`, `<head>`, `<meta charset="utf-8">`
  and then the exact `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`, with only whitespace
  between them: the policy's place is pinned, not searched for, so text that only looks like it (inside `<noscript>`,
  `<template>` or `<title>`, or after a `--!>` comment end) cannot pass; and no page holds `<noscript>`, `<template>`
  or `--!>` at all. All four source pages already had that order;
- every shipped file is of a kind a build ships (`.js`, `.mjs`, `.cjs`, `.css`, `.html`, `.json`; `.png`, `.woff2`; and
  a dev build's source maps), and every text kind is read, so a module cannot hide in an `.mjs` file; an HTML attribute
  value is read quoted or unquoted, and one with a scheme or protocol-relative (`//host/...`) is a remote resource; no
  page may refresh itself (`<meta http-equiv="refresh">`);
- no `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `WebTransport`, `RTCPeerConnection` or `importScripts`
  anywhere; `fetch` exactly once in `sw.js` and nowhere else; every http(s) or ws(s) URL in a script is the API origin
  or one of three XML namespace names and the hostname normaliser's `http://${host}/` (parsed, never fetched); `sw.js`
  carries the API origin; no script names `onMessageExternal` or `onConnectExternal`;
- prod and e2e: built in production mode (no `fileName`/`lineNumber`/`columnNumber` keys, which the JSX runtime's debug
  build writes), and no path of the build machine and no absolute file path in any shipped file (§3.12);
- prod: no developer marker (`localhost`, `127.0.0.1`, `(dev)`, the developer page's) in **any** shipped file (it was
  the manifest only), no `devsync/`, and none of the enrolment code's fingerprints (§3.9); e2e and dev: the developer
  page is there;
- the popup's and the full catalog's budgets are enforced for prod (dev and e2e builds carry test-only code; they print).

A dev build is not minified, so its comments name URLs and the word `fetch`: `--dev` skips those text rules (the
prod and e2e builds, minified from the same sources, are checked with them). Pristine prod, e2e and dev builds pass,
each fails the other flavours' rules, and 93 altered copies, one rule broken each, fail with that rule's message (71
in `test/unit/m5-check-dist.test.ts`, which builds all three flavours into a temporary directory, and 22 in
`test/unit/m5-check-dist-tamper.test.ts`).

### 3.9 Nothing in a prod build turns sync on

The claim, exactly: **no code a user can reach in a prod build can enrol a device or create a vault.**
- The only callers of the server's registration requests (`POST /v1/vault/init`, `/v1/enroll/requests`,
  `/v1/enroll/recovery`) and of the local join are `src/core/sync/engine/enroll.ts`'s flows. A prod build's module graph
  must not contain `enroll.ts`, the new-device state machine (`crypto/enroll-new-device.ts`) or `src/devsync/`
  (`scripts/build.mjs` fails the build otherwise), and `check-dist` checks the built files again for three string
  literals that exist only in `enroll.ts` (a unit test keeps that true) and for the developer page.
- The prod `sw.js` does contain `SyncApi`'s registration methods and `SyncFlows`' join methods: they are class methods,
  which a bundler cannot drop. Nothing calls them: the worker calls only the engine's `start`, `kick`, `wake` (a round),
  `permissionWithdrawn` and `view`, and no message it answers reaches anything else (`sk-api` forwards a request a page built; the prod pages
  build none, as the settings page has no engine until M6).
- So sync is off for every user of this version, and with sync off nothing is sent (the regression test).

The developer page (`src/devsync/`, dev and e2e builds only) offers the engine's own flows, unchanged, to the console and
to the end-to-end tests: the first upload (§3.1), the recovery-code join (§3.3), a round, the state, turning off.

### 3.10 The TOTP clock helpers

`totpOffset`, `clockNotice` and their constants moved from `core/sync/engine/clock.ts` to `core/sync/local/time.ts`,
which imports only `local/state.ts` (already in the popup's graph), so M6's popup can show codes on the corrected clock
without loading the engine (M3-NOTES §10 item 6). `engine/clock.ts` re-exports them; nothing else changed. The popup does
not use them yet (the switch is M6's).

### 3.11 Text

No new user-visible text: the sync UI, its errors and the badge's words are M6's. `scripts/messages.py`, its fragments
and `_locales` are unchanged; the full catalogs are as before (en 9.2 KB, zh_CN 10.4 KB gzipped, limit 12 KB). The
developer page's two buttons (§1) are English only; that page is never shipped.

### 3.12 Build directories, the build mode, the package

- **One directory per flavour**: prod `dist/`, dev `dist-dev/`, e2e `dist-e2e/` (`--out <dir>` for anything else). A
  dev or e2e build never sits where the store package is made from; it would fail the prod check anyway.
- **Production mode, always.** `build.mjs` sets `NODE_ENV=production` and Vite's `mode: "production"` for every
  flavour. Vite follows `NODE_ENV`, and a build made from a shell or a test runner with `NODE_ENV=development` or `=test`
  used the JSX runtime's debug build, which writes the builder's absolute file paths into the pages (and makes the popup
  larger). With the mode pinned, a prod build is byte for byte the same whatever `NODE_ENV` says (a unit test builds
  with `NODE_ENV=test` and compares every file). dev builds still differ only in what the flavour sets (no
  minification, source maps, the local origin, the developer page). `check-dist` refuses a development-mode build, and
  any path of the build machine, all the same.
- **`npm run package`** (`scripts/package.mjs`): the prod build into `dist/`, `check-dist` on it, and only if both
  succeed `release/sixkey-<version>.zip` of exactly `dist/`. Nothing else writes the zip. The archive
  (`scripts/zip.mjs`) is deterministic: entries in path order, the archive names compared by code unit, so the order
  does not depend on how a file system lists a directory (APFS lists names sorted, ext4 does not); one fixed timestamp;
  deflated; no extra fields. The same sources give the same bytes, which unit tests check (two package runs; files
  created in different orders; names whose per-directory and path orders differ), along with a build that fails the
  check leaving no package. It prints the file count, the size and
  the SHA-256. `dist-dev/`, `dist-e2e/` and `release/` are ignored by git.

### 3.13 The network switch: the API host permission

`src/platform/api-permission.ts` is the one module that names host permissions (a source rule):
- `API_PERMISSION` is `{ origins: ["<API origin>/*"] }`; `apiPermissionGranted()` asks `chrome.permissions.contains`
  (a failure to answer counts as "no"); `requestApiPermission()` asks the user (Chrome's prompt) and must be the first
  statement of a click handler, before any `await`, since a gesture spent on an earlier `await` is gone and Chrome then
  refuses; `removeApiPermission()` withdraws it, false when it cannot (the e2e build's required permission, or none
  held); `permissionGated(transport, granted)` refuses every request while the permission is not granted.
- **The engine asks in every round and every push, after the steps that send nothing** (`EngineDeps.networkAllowed`;
  `createSyncEngine` defaults it to `apiPermissionGranted`, so a page's engine asks too; SYNC-DESIGN §4.9, §4.2,
  revision 22). Those steps come first, inside the round's lock: the prelude's local stops (sync off; a damaged
  identity; an identity lost from IndexedDB, restored from its copy when the key is here; `cfg_missing`, where an
  unfinished turn-off's local half is finished, or with the vault lost `cloud_restore` is reported to the page; another
  origin) and, with the key here, step 0's orphan fold (a damaged orphan list cleared with it). They send nothing, so
  none of them waits for a grant: an unfinished turn-off is never stuck asking for a permission the user is removing.
  Then the check, before the first request. Not granted, with sync on: the status becomes `permission_removed` (written
  only if it is not already), and that is all. No request; not a failure
  (the failure count, the backoff and `lastErrorCode` stay as they were); beyond the local upkeep before the check,
  the vault, the outbox, the orphan list, `lastSynced`, the identity and the pins are not touched. Local edits keep writing the outbox (the commit path does not
  ask), and the first round after the grant carries on from there: `lastSynced` is still right, because nothing
  happened locally that it does not describe. With sync off the prelude answers `off` and nothing is written (D11).
  The browser-start cleanup (below) is independent of this order. A wake inside a running backoff starts no round at
  all, so its local steps wait for the backoff's end as before.
- **The worker's transport asks before every request**, its own or a page's through the bridge, so nothing leaves
  without the permission, not even a CORS preflight. A permission withdrawn between the engine's check and the request
  makes that request an ordinary network error (`offline`, counted once like any other); the next round's check says
  `permission_removed`. Key operations (rotation, a new recovery key, approval, revocation, turning off) go through
  the same transport: without the permission they fail as network errors, which is why M6 asks for it first (§12).
- **Events** (`src/background/sw.ts`, listeners at the top level): `chrome.permissions.onRemoved` →
  `SyncWorker.permissionRemoved()`: the status at once and the badge cleared, nothing sent (if the permission is back
  already, nothing changes). `onAdded` → `permissionAdded()`: with sync on, `wake("sync")`, a round now or when a
  running backoff ends (the server's `Retry-After` is still respected); until that round the stored status still says
  `permission_removed`. Events that name no host (the clipboard pair) are ignored; any event that names one is handled,
  since the manifest's only optional host permission is the API's and both handlers ask `contains` again, so nothing
  depends on how Chrome spells the pattern it reports.
- **A browser start** (`runtime.onStartup`, `SyncWorker.browserStarted()`): a permission held while there is no
  `sk_sync_cfg` is removed. That is an enable or join flow whose tab closed before it wrote the configuration (M6
  removes the permission itself when a flow fails or is cancelled). Not at every worker start, since a flow may be
  running in a tab then, and never in the e2e build, whose permission is required (read from its manifest).

---

## 4. Threat considerations

**The manifest.** The extension can reach one host, `api.sixkey.app`, only from its service worker, and only once the
user has granted the optional permission (§3.2, §3.13). No page can reach it: each page's own `connect-src 'none'`
leaves code running in a page (an XSS, say) no network channel of its own, neither to another host nor to the API,
where an attacker could otherwise keep an account of their own as a drop box. Such code can only ask the worker, which
carries only the engine's request shape, only for the settings page (§3.4). Pages and the worker share the extension's
origin, storage and IndexedDB, so code in a page holds the device key anyway; what the page policies take away is the
way out. The rest is unchanged: the extension's own code is trusted, a web page cannot reach it (no content scripts, no
`externally_connectable`, no `web_accessible_resources`, no listener for other extensions), and only signed requests
are accepted by the server. dev and e2e builds allow plain HTTP to the loopback address; those builds are never shipped
(`check-dist` refuses the loopback address and the developer page in a prod build).

**Before the grant.** Honest code sends nothing: the engine and the worker's transport both check the permission. Code
that skipped both checks (compromised extension code in the worker) is limited by the browser's cross-origin rules,
not stopped: without the grant, at most a CORS-simple request (a `no-cors` request with a simple body, which arrives
whole, but with no signature, no account session and a response the extension cannot read) or the preflight of any
other request can leave. A request with the engine's headers (`Content-Type: application/json`, `Authorization`,
`Sixkey-*`) never leaves whole; `test/regression/permission-wire.spec.ts` shows both on the dev build. That holds while
the server answers no CORS request: the production server is to be deployed with no CORS origins (§5.2;
`SIXKEY_CORS_ORIGINS` empty, M8). While CORS origins are configured, as M4's development setting allows, such code
could reach the server without the grant. M8's check is therefore: without the grant, no response is readable and no
signed or authenticated request is accepted (§11).

**The transport.** What leaves is exactly what the engine signed: no cookie, no referrer, no cache, no redirect, one
attempt within 60 s. What comes back is untrusted: its size and time are bounded here, its shape is checked by the API
client (`api.ts`), and its content by M1's and M3's checks (MACs, signatures, the guard). A server that answers slowly,
hugely or not at all costs this device a timeout and a backoff, nothing more.

**What the browser adds.** Observed on the wire from the service worker (Playwright's Chromium, the e2e origin):
besides the engine's headers, Chrome sends `User-Agent`, `Accept`, `Accept-Encoding`, `Sec-Fetch-Dest`,
`Sec-Fetch-Mode`, `Sec-Fetch-Site`, `Cache-Control: no-cache` and `Pragma: no-cache` (from `cache: "no-store"`), and on
requests with a body `Origin: chrome-extension://<id>`. `Accept-Language` would be the user's language list; the
transport sets it to `*` (§3.3, checked on the wire by `network.spec.ts`). Over HTTPS Chrome is expected to add the
`Sec-CH-UA` client hints as well (not observed: only the loopback HTTP origin was available). The extension cannot
remove the others. The server never records header values (§5.6, M4), and the M8 proxy must not either. They are worth
a line in the Phase 1 privacy text: D3 promises that the server does not *collect* a user agent; the browser still
*sends* one, with the extension's ID.

**The bridge.** It forwards only to the API origin, only the engine's request shape, and only for the extension's own
syncing pages; it holds nothing and decides nothing.

**Liveness.** A sustained outage costs one request per backoff step (5 s × 2ⁿ, at most 30 minutes, Retry-After as the
floor), across worker and browser restarts (tested against the real server, §5.3). The periodic alarm exists only while
sync is on, with a random phase.

---

## 5. Tests

### 5.1 vitest (`npm test`)

New files (number of tests in brackets):
- `test/unit/m5-fetch-transport.test.ts` (12): the exact fetch call, `Accept-Language: *` included; refused targets,
  methods, Content-Types and a request's own `Accept-Language`; no retry; timeout (headers and body), the cap, offline;
  caps by Content-Length (no byte of the body read) and while streaming; error statuses, empty and non-UTF-8 bodies; on
  the wire against a real HTTP server: exact target and body, no cookie or referrer after a `Set-Cookie`, the pinned
  language, redirects not followed, a refused connection.
- `test/unit/m5-transport-urls.test.ts` (10): every target the transport accepts reaches a real server as exactly that
  target; bodies that are not the signed text; header values the Fetch API rejects; a gzip bomb and an endless chunked
  body cut off at the cap; a wrong or non-numeric Content-Length; a trickle ended by the timeout; failures that say
  nothing of the request.
- `test/unit/m5-bridge.test.ts` (6): who may ask, what may be asked, the reply mapping, and the engine in a "page" with
  every request carried by the bridge to the FakeServer (which verifies every signature and body).
- `test/unit/m5-bridge-spoof.test.ts` (5): only `chrome-extension://<self>/options/index.html` passes (look-alike paths,
  other schemes, IDs and ports fail); every other shape is refused; whatever passes is sent to the API origin only;
  replies carry a reason only; the bridge's modules name no lock and no storage.
- `test/unit/m5-api-permission.test.ts` (15): the permission helpers (exactly the build's origin; a failure to ask says
  no; the gated transport); withdrawn: rounds (keyed and locked) and pushes send nothing, end as `permission_removed`,
  count no failure, change nothing but the status (every key of storage, the identity and the mirror compared), local
  edits keep writing the outbox, and granted again the edit goes up; withdrawn between the check and the request: one
  ordinary network failure, then `permission_removed`; a gate that throws; `onRemoved` and `onAdded`; sync off; the
  browser-start cleanup (removed without a configuration, kept with sync on, a required one never touched); and what a
  round does before it asks, without the permission, sending nothing and counting no failure: an unfinished turn-off
  finished (by a round and by a push), a lost vault reported as `cloud_restore`, step 0's orphan fold (the torn save
  back in the vault), a damaged orphan list cleared, an identity restored from its copy.
- `test/unit/m5-sync-worker.test.ts` (8): `badgeText` (every state without a fresh count); the scheduler (timers and
  alarms, replacing, cancelling); the keep-alive; and the worker over the engine and the FakeServer: sync off (one read,
  nothing sent, a stray "sync soon" arms nothing), sync on (the periodic alarm, "sync soon", a page shown), a sustained
  503 across worker restarts, a worker restart in `identity_missing` (the badge cleared), the badge through approval
  requests, the kill switch, a revocation and turning off.
- `test/unit/m5-worker-rules.test.ts` (8): the periodic alarm created once; the page-shown round's limits (a future
  `lastOkAt` or `lastAttemptAt`, two renders within 30 s with the key elsewhere, a new worker after one, two renders at
  once); one read with sync off; the keep-alive's end; "sync soon" only once the outbox is written.
- `test/unit/m5-permission-handlers.test.ts` (8): a re-grant waits for a backoff the server set; an `onRemoved` once
  the permission is back changes nothing; a browser start keeps the permission whatever the last status; a worker start
  never removes it; a refused request starts no keep-alive; and the page-shown round after an unlock: held back while
  the key is elsewhere, not once it is here (the round runs and the status is `ok`), a lost identity restored by it,
  and a recent keyed attempt holding nothing back for a keyless worker.
- `test/unit/m5-source-rules.test.ts` (7): one `fetch` in the source; who builds the transport; the worker's runtime and
  the pages'; the API origin in its five places (with each flavour's host-permission key); host permissions named in
  `api-permission.ts` alone; the worker's bridge imports nothing that signs or stores, and the three modules on that
  path say who signs in the same words as §3.4; the enrolment fingerprints; the developer page unreachable.
- `test/unit/m5-check-dist.test.ts` (61) and `test/unit/m5-check-dist-tamper.test.ts` (23): §3.8; the page policy
  in its pinned place (hidden in `<noscript>`, `<template>` or `<title>`, after `--!>`, after a classic or an
  uppercase script, after another `<meta>`), `.htm` pages, the repository's paths, meta refresh quoting, remote `href`,
  the dev build's external-listener rule.
- `test/unit/m5-build-guard.test.ts` (11): the prod graph guard (three injections); the prod worker without the
  developer page's path; the build byte for byte the same under `NODE_ENV=test`; a dev build in `dist-dev/`; the package
  deterministic and exactly `dist/`, and refused for a build that fails the check; two check-dist rules on real builds.
- `test/unit/m5-package-order.test.ts` (3): the archive in path order for names whose per-directory and path orders
  differ, the same bytes for files created in another order, every directory walk sorted.
- `test/unit/m5-sw-wiring.test.ts` (6) and `test/unit/m5-sw-locks.test.ts` (7): `src/background/sw.ts` itself, over fake
  `chrome.*` APIs: each listener registered once (the two permission events among them) and no event adds another; each
  alarm reaches only its own handler; a bridge request from the settings page sent exactly once to the API origin, one
  from the popup not at all, none without the permission; the browser-start cleanup, not in a build that requires the
  permission; permission events that name no host ignored; only a bridge message keeps a channel open; sync off costs
  one read per message; the keep-alive through `sw.ts`; and the engine of a syncing context under a recording Web Locks
  stub: the store's `sixkey-vault`, one shared `sixkey-sync` taken only if free, the manifest's version, the network
  switch wired to `chrome.permissions.contains` for the API origin (and not asked when the round stops locally first).
- `test/unit/m5-runtime.test.ts` (4): the runtime's outbox and "sync soon": nothing with sync off; the pushable outbox
  and one message with sync on; the message also when the outbox write fails; never from the worker's own runtime.
- `test/unit/m5-devsync.test.ts` (9): the developer page over stand-in APIs: a first upload that ends `done` or
  `unconfirmed` keeps the permission, one that ends `vault_exists` or `keyring_changed` (results, not exceptions) or
  throws gives it back; a join likewise; with sync on nothing is given back; turning off removes it last; the grant
  button asks before any await.
- `test/fault/m5-commit-crash.test.ts` (2): a crash at every storage write of a popup edit with sync on, through the
  real runtime wiring in "lock every time": a saved edit is never lost, the locked push never sends a stale outbox over
  newer data, and nothing is left behind after quiescence.

The whole suite: see §7.

### 5.2 The engine against the real server (`npm run test:live`, `test/live/`)

`test/live/m5-live.test.ts` runs seven scenarios, each twice: against the real server, through the extension's own
`FetchTransport` in Node, and against the FakeServer, with the same expectations (§8.5's "the same tests against both").
These are engine-level (in Node, not in Chromium) because they need control a browser test does not give: an
interleaving at an exact request, an answer lost after the server committed it, a reconciliation that cannot reach the
server, a server restart between two calls.
- two devices join (§3.3) and sync: edits on each reach the other and the server's head;
- a rotation racing another device's write (§3.8 P3): the rotation's `409 version_conflict` merges the write and sends
  the same new key again (`[409, 200]` on the wire); the other device adopts it with the password; the new code works;
- a rotation whose answer is lost and whose reconciliation cannot reach the server (§3.6.0): `unconfirmed`; the same
  handle later finds it in effect and commits, without sending it again;
- the kill switch raised between prepare and commit, for a rotation and a new recovery key (§5.2): the real server is
  restarted with `SIXKEY_MIN_CLIENT_VERSION=9.0.0`; both commits refuse `update_required` and only status queries reach
  the wire; lowered again, the same code handle commits;
- a sustained outage, the real server's database stopped (every request `503 unavailable`, `Retry-After: 5`): every
  failure counts, the gaps grow, Retry-After is the floor, a wake in the backoff sends nothing, a new engine over the
  same storage schedules no earlier than the stored end; the database back, the next round succeeds;
- an outbox and a torn active slot with no key in the context: the round's load recovers the older slot, the hook keeps
  the outbox as an orphan entry, the round pushes it (200) and retires it; unlocked, the save is back in the vault;
- a worker restart in `identity_missing` (IndexedDB wiped, locked): nothing on the wire, the stored offset kept;
  unlocked, the identity restored with the same device ID, no new device row, the offset learned again.

### 5.3 The extension in Chromium against the real server (`npm run e2e:sync`, `test/sync/`)

Each file: the real server (as above) behind a recording proxy on the e2e origin, real profiles
(`launchPersistentContext`), the developer page to turn sync on, the settings page and the popup for everything else.
- `join.spec.ts`: profile one turns sync on; profile two, with an account of its own, joins with the recovery key (the
  added mode); an edit in one settings page reaches the other through the workers; every request on the wire: exactly
  `application/json` on bodies, no cookie, no referrer, signed (two device IDs).
- `restart.spec.ts`: a browser restart with the extension's IndexedDB directory deleted (what some fingerprint
  browsers do at every stop): locked, the worker's round stops at `identity_missing`, nothing reaches the server, the
  stored offset stays; unlocked in the popup, the page shown asks for a round, the identity comes back with the same
  device ID, no enrolment request, the offset learned again.
- `outage.spec.ts`: the server's database stopped: the worker's backoff grows (10 s, then 20 s), nothing is sent inside it,
  not after a browser restart either (one status query, at the stored end, not before); the database back, the backoff
  clears and the edits go up.
- `always.spec.ts` ("lock every time"): the worker, without the key, pushes what a closed settings page committed
  (P10); a push that fails, the active slot torn on disk, then the worker's next load: the hook moves the outbox to the
  orphan list, the worker pushes it, `lastSynced` stays null; unlocked, a round brings the save back.

`test/regression/network.spec.ts` (the regular e2e suite) is rewritten per §7 with the FakeServer on the e2e origin and a
decoy: with sync off, the extension used, the API gets nothing; every primitive from every context to the decoy is
blocked; the worker reaches the API, while an image or a fetch from a page to it is blocked; then sync on through the
developer page and an edit synced by the worker: every request signed and accepted, every body through the contract,
exact Content-Type, no cookie or referrer, `Accept-Language: *`. `test/regression/page-csp.spec.ts` checks the page
policies in Chromium: a fetch to the API origin from the popup, the settings page and the developer page is blocked
with a policy violation, while the worker's fetch and the bridge reach it and the popup still renders.
`test/regression/permission-wire.spec.ts` shows, on the dev build without the permission, what code in the worker that
skipped the extension's checks could get onto the wire (a CORS-simple request whole, a request with the engine's
headers only as its preflight; §4), and that a policy hidden in `<noscript>` is no policy in Chromium (§3.8).

---

## 6. Mutation check

Hand-made mutants of M5's code, applied one at a time (each target must occur exactly once, or the runner stops), each
run against every test file of the suite that covers the mutated module (the runner is outside the repository).
**190 mutants, 188 killed, 2 equivalent.** The third version re-ran the 52 that touch what it changed (the engine's
check, the worker, the bridge, the engine's wiring) and added 10; the fourth re-ran the 17 on the page-shown limiter,
the pages and their check, the package and the build directory, retired 5 whose code it replaced, and added 21. The
others mutate modules a later version did not change.

| Set | Mutants | Killed | Not killed |
|---|---|---|---|
| The first version's set, re-run on this one: the transport (19), the worker (16), the bridge (9), the runtime (4), `sw.ts` (5), `check-dist` (19). Five were moved to the code that now carries the same rule (the badge's status list, twice; the page-shown limits, twice; the check of the flavour's host-permission key) | 72 | 70 | F10 (the origin check) and F11 (the `//` check): each alone is covered by the other (a target that passes the path pattern without starting with `//` cannot change the origin, and one that starts with `//` fails the origin check); both are kept as two independent guards on the one property that matters most |
| A second set written against the first version: the transport's request options and its origin, the bridge's sizes and sender checks, the page side's replies, the periodic alarm, the keep-alive, the routing in `sw.ts`, the lock names and `ifAvailable`, the client version, the dev markers, the URL template, the missing-key check and the prod graph guard. Three were moved as above (the page-shown limits, twice; the worker's transport, now with the gate around it) | 36 | 36 | |
| This version's changes: each page's policy (the check, its place, a commented-out copy, each page's own copy); the file kinds, `.mjs`, protocol-relative and unquoted URLs, the meta refresh, listeners for other extensions; the dev directory, the package without its check or with a clock timestamp; the build mode and the development-mode and machine-path rules; the page-shown limits; the badge in `identity_missing`, `damaged`, `permission_removed`; the stray "sync soon"; `Accept-Language`; the engine's gate in a round and in a push, a failing gate, a failure counted, `off` with sync off, `onRemoved` doing nothing or too much; the worker's transport ungated; `onAdded` doing nothing or rounding with sync off; the browser-start cleanup with sync on, of a required permission, never, not wired; the events not routed; the gated transport sending anyway; `contains` failing as "granted"; a wider origin pattern; events routed never or always; the e2e build's permission never required; a failed removal reported as done; the engine's default gate missing; the manifests (a required permission in the base, the e2e overlay keeping the optional key), the build keeping `null` keys; `check-dist`'s other-key rule and its per-flavour key. Three mutated the second version's check at the top of a round and a push and were replaced by the third version's set; two mutated the second version's page-shown limiter and three its page-policy search, replaced by the fourth version's | 51 | 51 | |
| The third version: the check before the local stops (inside the lock, and before the lock as in the second version), before step 0's fold, missing from a round, a push's check before its local stops or missing, a pause recorded as an ordinary outcome (the failures reset) or not recorded; the bridge's "never signs, never stores" gone, and the bridge importing the signing code | 10 | 10 | |
| The fourth version: the limiter's attempt hold-back ignoring the key, applied to any stored status, gone; the in-memory stamp ignored; the worker's key check wired to "never"; a re-grant ignoring a running backoff; the page policy searched for, or allowed anywhere after `<meta charset>`; `<noscript>`/`<template>`/`--!>` allowed; `.htm` not a page; machine paths of the extension directory only; a meta refresh only when quoted; `href` not read; the dev build's external-listener rule dropped; the archive in the walk's order, the walk unsorted; the developer page checking exceptions only, keeping the permission after `vault_exists`, giving it back with sync on, keeping it after turning off, asking for it after an await | 21 | 21 | |

By hand, once each: `scripts/build.mjs` stops a prod build whose service worker imports `enroll.ts` (the graph guard),
and with the guard disabled `check-dist` still fails that build on the three fingerprints; the build stops an e2e
overlay that names the prod host and a dev overlay without its CSP. In the e2e suite: pages that never send "sync soon"
make `network.spec.ts` fail (the edit is never uploaded). Not mutated: the developer page's permission handling (no
automated test can exercise it, §10), and leaving out the worker's explicit gate in `createWorkerSync`, which only
falls back to the same default.

---

## 7. Measurements

**Sizes** (prod build, gzip, the way `check-dist` counts; before = this tree without M5):

| | Before | After | |
|---|---|---|---|
| Popup (static + largest catalog it loads) | 55,187 B (53.9 KB) | **56,058 B (54.7 KB)** | +871 B; budget 61,440 B (60 KB), 5,382 B left |
| of which static | 51,195 B | 52,066 B | the outbox writer and "sync soon" |
| Full catalogs (settings page) | en 9,415 B, zh_CN 10,693 B | unchanged | limit 12,288 B (12 KB) |
| `sw.js` | 83,790 B (gzip 23,163 B) | 184,303 B (gzip 50,209 B) | the engine, the crypto, the merge, the transport, the permission gate; no budget |

M3 measured +791 B for wiring the writer alone; the other 80 B are the "sync soon" message and the wrapper. The
permission gate, the page policies and the other changes of this version (§13) add nothing to the popup (its `<meta>`
is in the HTML, which the budget does not count) and 2,507 B (gzip 548 B) to `sw.js` over the first version.

**Read budgets.** Sync off: unchanged (`read-budget.test.ts`, `perf.spec.ts`, which counts the popup page's own reads;
the worker's one read per page shown is outside them). Sync on: one more read per edit (§3.6). In the worker, "sync
soon" now reads the state once before the kick (to schedule nothing with sync off), and each permission event one read.

**Tests**, every run at `nice -n 19`, vitest with two workers, Playwright with one:
- typecheck clean; `npm test` **131 files, 1,908 passed, 5 expected fail, 1 skipped** (before M5: 113 files, 1,702
  passed, the same 5 and 1; the 5 are Phase 0's and M3's own), 9 min; `npm run build`, `npm run check`, and
  `check-dist --dev` and `--e2e` on their builds OK;
- `npm run e2e`: **102 passed** (6.6 min), with the rewritten `network.spec.ts`, `page-csp.spec.ts`,
  `permission-wire.spec.ts` and the prod build's `smoke.spec.ts` (the API permission optional and not granted); it
  builds prod, e2e and dev and runs `check-dist --e2e` and `--dev` first;
- `npm run e2e:sync` (the real server, Chromium): **4 passed** (1.9 min): join, the "lock every time" push and torn
  slot, the outage, and the restart with IndexedDB deleted, which the second and third versions failed (§15 item 1).
  The first run of this version failed `outage.spec.ts` at its last step: once the popup shows the unlocked vault,
  the worker now runs its page-shown round as §4.8 asks, and the developer page's round, started at once, was told
  `busy` (the worker held the sync lock). The spec now waits for that round (`busy`, then `ok`); the second run passed
  all four;
- `npm run test:live` (the engine in Node against the real server): **14 passed** (seven scenarios on each backend);
- `127.0.0.1:8787` was free before each Playwright run and after it (a listener of another program on the IPv6
  wildcard of that port does not stand in the way, §1).

The contract checks (`api/`, `contract/`) were not touched and not rerun.

---

## 8. Existing tests changed

Each change follows from the requirement, and none relaxes a rule that still holds:
- `test/unit/m2-source-rules.test.ts`: (1) "nothing builds SyncFlows or SyncLocal yet (M5)" → exactly
  `platform/sync-engine.ts` builds each, once; that module joins the allowed importers of the sync flows (it is in no
  popup graph: the graph tests). (2) The popup's exact module list gains `src/core/sync/local/outbox.ts`, as M3's
  hand-off asked ("M2's exact popup module list in m2-source-rules gains core/sync/local/outbox.ts deliberately").
- `test/unit/m3-source-rules.test.ts`: (1) "nothing outside the engine imports it (M5 wires it)" → the exact list of
  importers outside the engine: M5's seven wiring modules (the permission gate, `api-permission.ts`, is the seventh); the
  outbox writer is imported by exactly `platform/runtime.ts`.
  (2) The popup's graph: still no engine module, now also none of M5's wiring modules or the developer page; it does
  hold the outbox writer.
- `test/unit/sync-crypto-hygiene.test.ts`: the exact set of modules outside `core/sync` that import it gains M5's seven
  wiring modules; the popup, the settings page and the UI still import none of it.
- `test/unit/read-budget-sync.test.ts`: **a budget change.** With sync on, an edit reads the sync state twice (the
  outbox writer's read after the commit, §3.6), checked to come after the slot's write and read-back, and the pushable
  outbox checked to be written; with sync off, once, unchanged.
- `test/e2e/smoke.spec.ts`: `host_permissions` still absent; `optional_host_permissions` exactly
  `["https://api.sixkey.app/*"]`; and `chrome.permissions.contains` for it is false in a fresh profile (nothing granted
  at install).
- `test/regression/network.spec.ts`: rewritten as §7 of the design specifies (§5.3 above); what it checked before is all
  still checked.
- `test/helpers/m3-world.ts`: `contextOver` takes an optional `networkAllowed`, passed to the engine (absent: as
  before).

---

## 9. Departures from the design and the hand-off

1. **"Sync soon" is sent by the shared runtime, not by each page** (§4.8: "页面给 SW 发 sk-sync-soon"). Same message,
   same moment for every page that commits (popup, settings), from one place, inside the commit right after the outbox
   is written (§3.5). The worker does not send it to itself.
2. **"A page opened" is the existing `sk-reschedule-autolock` message** (§4.8). The popup and the settings page send it
   whenever they show the unlocked vault, the popup at every render of its list (opening, and each reload after a
   change); the worker runs its 30 s checks there (§3.5: the last success, the last attempt, the last page-shown round).
   A locked popup opening does not trigger a round (it has nothing to show, and in "lock every time" the worker has no
   key anyway).
3. **The dev build uses the local server's origin**, not a development domain (§7; §11).
4. **The keep-alive during a request** (§3.3) is not in the design; it keeps a long upload from being cut by the
   worker's idle timeout, within the 60 s bound.
5. **The response cap (9 MiB)** is not in the design; the brief asked for one.
6. **Old browser engines (Chromium 120 and 134)**: the M5 row asks for a CI pipeline and a smoke run on them; not done
   (§10).
7. **"Keys adopted back" as a visible event** (the M5 row, §1.3's accepted residual): the engine raises the
   `keys_adopted` notice (M3) and the security record gets `keys_adopted`, which the settings page's security card
   already lists, but its label ("Keys
   changed on another device were taken over here") does not tell an adoption *back* from an ordinary one, and no UI shows
   the notice yet. The words and where to show them are M6's; telling the two apart in the security record is a design
   decision (§11).
8. **The TS contract tests against `make run`** (A30): done as the paired live suite (§5.2: the same scenarios and
   expectations on the real server and the FakeServer), not as a separate contract-validation pass over live responses.
9. **Who signs: no longer a departure.** Revision 22 (§4.9, §4.14) describes what the code does (§3.4): a page signs
   its own requests, and the worker relays a finished request without signing it, storing it or inspecting it beyond
   four checks: the sender, the shape, the origin pin and the target exactly as signed. The worker signs only its own
   rounds, pushes and polls.
10. **With sync off a round answers `off`: no longer a departure.** Revision 22 puts the local stops before the check
    (§3.13), and the first of them is "sync off".
11. **`onAdded` schedules a round that still waits for a running backoff** (§4.9: "`onAdded` 安排一轮"). The grant is the
    user's, but a running backoff may be the server's (`Retry-After`). A withdrawn permission never starts or lengthens
    a backoff, so this matters only when one was already running; until that round the stored status still says
    `permission_removed`, so M6's panel should also ask `apiPermissionGranted()` (§12).
12. **The permission is also checked before every request, in the worker's transport** (§4.9 asks before every round and
    every push). It covers what the round's check cannot: a page's requests through the bridge, key operations, and a
    permission withdrawn during a round. It is also why no preflight leaves before the grant.
13. **The check's place in a round: no longer a departure.** Revision 22 (§4.9, §4.2) puts it after the steps that send
    nothing (§3.13); the code follows. Beyond the three the design names (step 0's fold, the turn-off's local half,
    the `cloud_restore` report), the other local stops of the prelude also come first, since they send nothing either:
    sync off, a damaged identity, an identity restored from its copy, another origin.
14. **`Accept-Language: *`** on every request (§3.3): not in the design; it removes a locale signal the server never
    needs (D3).
15. **The developer page handles the permission as M6 will** (§1): a button for the grant (a click is required), the
    removal after `turnSyncOff`, and after a first upload or join that fails before sync is on. It exists only in dev
    and e2e builds.
16. **`npm run package`** (§3.12): not in the design; the store package is made only from a prod build that has just
    passed `check-dist`.

---

## 10. Known residuals and not done

- **Old browser engines** (Chromium 120 = `minimum_chrome_version`, and 134): no pipeline and no run. Only current
  Playwright Chromium builds are installed here. Needed: Chrome for Testing 120 and 134 as `executablePath`, and a subset
  of `test/sync/` (join, the restart, the outage) run on each.
- **A page that runs the engine but cannot reach the worker** (the worker stopped mid-message): the bridge rejects with
  `NetworkError("unknown")`; the request may have gone out. The engine already treats it so.
- **"Lock every time" and `identity_missing`**: the worker never has the key, so it cannot restore the identity; that
  waits until a page with the key runs a round (M6's settings page). Nothing is lost meanwhile; nothing is signed either.
- **The badge has no title** (§3.7).
- **Not observed in a real browser**: a service worker stopped by Chrome during a slow request (the keep-alive, §3.3),
  and the client hints Chrome adds over HTTPS (§4).
- **Chrome's real permission prompt is not automated** (the e2e build's permission is required, §3.2). A manual check,
  on a dev build with the local server: "Grant API access" shows Chrome's prompt for the API origin alone; declined,
  nothing changes; accepted, `view().apiPermission` is true and sync can be turned on; withdrawn in
  `chrome://extensions`, the status is `permission_removed` at once, the badge goes, an edit still writes its outbox and
  nothing reaches the server; granted again, the next round uploads it; a browser restart with the permission held and
  sync off removes it. `OWNER-DECISIONS/12` lists the prompt among its manual checks; the steps above are the dev-build
  way to run it before M6.
- **How Chrome spells the origin in permission events**: not observed; nothing depends on it (§3.13).
- **The developer page's grant button against Chrome's real prompt** has no automated test (the e2e build's permission
  is required); its removals and the button's handler are unit-tested over stand-in APIs (`m5-devsync.test.ts`).
- **Equivalent mutants** (§7): the transport's two target checks cover each other; the `Content-Length` pre-check only
  saves reading a body the stream cap would refuse anyway.

---

## 11. For the design owner and the owner

1. **The dev origin** (§3.1, departure 3): a development domain (§9 M8) once it exists; until then dev builds talk to the
   local server, as `OWNER-DECISIONS/10` says development does. The self-host question (`OWNER-DECISIONS/08`) fits the
   same mechanism as its own build flavour.
2. **"Keys adopted back" in the security record** (departure 7): a separate kind (a format change of the security
   record, which counts its version) or a different label for both cases.
3. **The headers the browser adds** (§4): a line in the Phase 1 privacy text.
4. **Old browser engines** (§10): how the pipeline should get its binaries (Chrome for Testing downloads in CI).
5. **Release order** (decided in revision 21). With the API origin optional, a store build no longer warns at install
   or disables existing installations on update. The first store build that carries it is still to be M6's or a later
   one, the build that can turn sync on, released with the store's permission text and with `OWNER-DECISIONS/06`'s
   planned network sentence in place of the current one (§7; the decision itself is still the owner's).
6. **M8: `SIXKEY_CORS_ORIGINS` empty in production** (§5.2, §9 M8 item 11), and a check on the deployed service that,
   without the grant, no response is readable and no signed or authenticated request is accepted, while with it sync
   works. "Nothing goes out at all" is the wrong property: a CORS-simple request or a preflight can always leave (§4,
   "Before the grant").
7. **The permission check before the local stops**: decided in revision 22, implemented (§3.13, §9 item 13).
8. **§4.9's first bullet**: changed in revision 22 to what the code does (§3.4, §9 item 9).
9. **The manual prompt check** (§10): `OWNER-DECISIONS/12` has it; §10 adds the browser-start removal and the outbox
   written while paused, which it does not name.

---

## 12. The M6 hand-off

1. **The API permission** (§3.13; SYNC-DESIGN §0.0u item 4, §3.1, §3.10):
   - Turning sync on and joining: `requestApiPermission()` is the **first line** of the button's click handler, before
     any `await`: before the master password and the one-time code (requesting the code needs the network). Declined:
     say why sync needs it, and stop. Then keep the permission only when the flow ends "done" or
     "unconfirmed" (`firstUpload`'s two outcomes whose configuration is written; a join's "enrolled" and "unconfirmed").
     On **every other outcome** call `removeApiPermission()` at once (while sync is not on): a cancel, an exception, and
     also the results that are not exceptions, `firstUpload`'s `vault_exists` and `keyring_changed`, and an approval
     join that ends `failed`. The browser-start cleanup is only the backstop for a tab closed mid-flow. The developer
     page does exactly this (`src/devsync/main.ts`, `test/unit/m5-devsync.test.ts`).
   - Turning sync off and removing the sync identity: `removeApiPermission()` last. Turning off needs the network (the
     revocation); with the permission absent, ask for it in the same click, first line again; declined, offer the
     local-only "remove sync identity".
   - The `permission_removed` panel, with a "grant again" button whose handler calls `requestApiPermission()` first.
     Read `apiPermissionGranted()` as well: the stored status changes only with the next round (§9 item 11).
   - The store's permission text and `OWNER-DECISIONS/06`'s sentence change in the same release (§11 item 5).
2. **Turning sync on** goes into the settings page's sync section, built on `createSyncEngine({ rt, transport: new
   BridgeTransport() })` in that page (exactly as `src/devsync/main.ts` does), with the account session from
   `engine.api.signIn` in the page's memory only. Then: remove `enroll.ts` and the new-device machine from
   `PROD_FORBIDDEN` (`scripts/build.mjs`) and the enrolment fingerprints from `check-dist`'s prod gate, in that change.
3. After any change of sync's state in a page (on, off, a round), send `SYNC_CHANGED_MESSAGE` (`bridge-page.ts`).
4. The badge's title text (both languages) and P4's banner "devices waiting for approval".
5. In "lock every time", the settings page must run a round when it is unlocked (folding orphans, restoring an identity,
   merging): the worker never can.
6. The popup's corrected-clock TOTP uses `core/sync/local/time.ts` (`totpOffset`, `clockNotice`) with the stored offset;
   it must not import the engine (the popup graph tests).
7. HOTP: `kick({ immediate: true })` and the 2 s `Promise.race(round)` before a code (§4.12) are not wired: Phase 0
   generates no HOTP codes yet.
8. M3's hand-off items for M6 (M3-NOTES §10, items 14 to 17) are unchanged by M5.

---

## 13. What changed from the first version, and why

SYNC-DESIGN revision 21 (§0.0u) is the cause of the first two items.
1. **The API origin is an optional host permission**, asked for when sync is turned on (§3.2, §3.13): no install-time
   warning, no installation disabled by the update that adds sync, no host permission at all for a user who never turns
   sync on. The engine checks it before every round and push and the worker before every request; withdrawn, sync
   pauses (`permission_removed`): nothing is lost or sent (from the third version on, the local upkeep a sync round
   does anyway still runs, §14). The e2e build declares it as required.
2. **Each page carries its own `connect-src 'none'`** (§3.2). The manifest's policy must name the API origin for the
   worker, and it covers the pages too, so in the first version a page could have fetched the API origin itself; only
   the build's count of `fetch` stood in the way. Now the browser refuses it, and the bridge's page list is a real
   boundary (§3.4).
3. **check-dist reads what it skipped** (§3.8): every kind of shipped file (an `.mjs` module was not read at all),
   unquoted attribute values, protocol-relative URLs (a comment claimed they had already failed; they had not), a meta
   refresh, listeners for other extensions, a development-mode build and the build machine's paths.
4. **Build directories and the package** (§3.12): a dev build wrote into `dist/`, where a store package would be made
   from; now each flavour has its own directory and only `npm run package` makes the zip, from a prod build that has just
   passed the check.
5. **The build mode is pinned** (§3.12): a build made with `NODE_ENV=test` or `=development` in the environment was a
   development build, larger and carrying the builder's absolute paths.
6. **The page-shown round is held back by the last attempt too** (§3.5): with the key elsewhere, every render of the
   popup's list was a status query.
7. **Smaller items**: the badge clears in every state where no status query refreshes its count (§3.7); a stray "sync
   soon" with sync off schedules nothing (§3.5); `Accept-Language` is `*` (§3.3).
8. **Tests that pin what the first version's tests left open** (§5.1): the transport's URL handling, sender spoofing on
   the bridge, the worker's rules, the browser's Web Locks under a recording stub (the names, `ifAvailable`, the
   manifest's version as the client version), `sw.ts`'s routing and keep-alive, the build guard, a crash at every write
   of a popup edit, and the page policies in Chromium.
9. **Documentation**: who can message the worker (§3.4), what the host permission and the policy each do (`PRIVACY.md`,
   `docs/security/local-vault.md`: a permission grants, the policy restricts), when a page-shown round fires (§3.5, §9 item 2), and the
   signing departure (§9 item 9).

---

## 14. What changed from the second version, and why

SYNC-DESIGN revision 22 (§0.0v) settled the two questions the second version left to the design owner.
1. **The permission check comes after the steps that send nothing** (§3.13). The second version asked first, before
   the round's lock, so without the permission an unfinished turn-off waited for a grant the user was in the middle of
   giving up, a page was not told `cloud_restore`, and step 0's fold waited. Now `round()` and `push()` do their local
   stops and the fold first, then ask. A `permission_removed` round is recorded as the status alone, as before (the
   failures, the backoff and `lastErrorCode` untouched). Tests: the turn-off finished by a round and by a push, the
   `cloud_restore` report, the fold, a damaged orphan list, an identity restored from its copy, and a locked round;
   each with nothing sent and no failure counted.
2. **Who signs** (§3.4): the design now says what the code does, and the code and these notes say it in the same
   words: a page signs its own requests, and the worker relays a finished request without signing it, storing it or
   inspecting it beyond four checks: the sender, the shape, the origin pin and the target exactly as signed. The worker
   signs only its own rounds, pushes and polls. A source rule checks the sentence in the three modules on that path,
   that `bridge-worker.ts` still says it never signs and never stores what passes through, and that it imports nothing
   that could.

---

## 15. What changed from the third version, and why

1. **The first page-shown round after an unlock is no longer held back** (§3.5). The second version's limiter skipped
   the round while any attempt was under 30 s old, so a keyless round just before the unlock (a browser start, a "sync
   soon" while locked) held back the one round that could pull, merge and restore a lost identity, for 30 s or until a
   later trigger; `test/sync/restart.spec.ts` failed on it. The attempt now holds a round back only while the worker is
   in the same condition as that attempt: no key here, and a stored status a keyless round ends with (`locked`,
   `identity_missing`). The in-memory stamp still bounds the renders that arrive together. Unit tests for the unlock,
   a lost identity restored by that round, and a keyed attempt that holds nothing back; `npm run e2e:sync` passes again
   (§7). `outage.spec.ts` now lets the developer page's round wait out the worker's: after the unlock the worker's
   page-shown round may still hold the sync lock, and the page's is then told `busy`.
2. **The page policy's place is pinned** (§3.8): right after `<meta charset="utf-8">` at the start of `<head>`, with
   `<noscript>`, `<template>` and `--!>` refused in a page. A search for the text could be satisfied by a policy the
   browser does not apply. The four pages already had that order.
3. **What the documents claim** (`docs/security/local-vault.md`, `PRIVACY.md`, §4, §3.4, `api-permission.ts`, `bridge-page.ts`):
   - without the permission, code that skipped the checks can still send a CORS-simple request whole (no signature, no
     session, an unreadable response) or the preflight of any other request; only a request with the engine's headers
     is reduced to its preflight. M8's check is "no readable response and no signed or authenticated request accepted",
     not "nothing goes out" (§11 item 6);
   - a withdrawn permission pauses sync: nothing is lost or sent, and the local upkeep a round does anyway still runs
     (since the third version), so "nothing stored changes" was too strong;
   - the device key is non-extractable in IndexedDB, and its only exportable copy, in `sk_sync_cfg`, is encrypted under
     the vault key: "none can export it" was too strong.
4. **Tests for what the third version's left open**: a re-grant waiting for the server's backoff, `.htm` pages, the
   repository's paths, the package's order on any file system (the archive is now sorted by its own names,
   `scripts/zip.mjs`), meta refresh quoting, remote `href`, the policy ahead of a classic or uppercase script, the dev
   build's external-listener rule; and `test/regression/permission-wire.spec.ts` (`npm run e2e` now also builds and
   checks the dev build, which it needs).
5. **The developer page gives the permission back on every outcome but `done` and `unconfirmed`** (`enrolled` for a
   join): `firstUpload`'s `vault_exists` and `keyring_changed` are results, not exceptions, and kept it before. The M6
   rule says the same (§12 item 1); `test/unit/m5-devsync.test.ts` tests the page.
