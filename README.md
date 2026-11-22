# Sixkey

Sixkey is a two-factor authenticator for Chrome: a Manifest V3 extension that keeps your TOTP secrets in an encrypted
vault in your browser profile and shows the 6-digit codes in its toolbar popup. This repository also holds an optional,
end-to-end encrypted sync service and its API contract, which are not released yet. Sixkey is a product of the g.pro
family, published and maintained by VIEW TECH LTD.

[中文说明](README.zh-CN.md)

> **Status (22 November 2026): the extension is in the Chrome Web Store; the rest is unreleased.**
>
> - **The extension (`extension/`)** is in the
>   [Chrome Web Store](https://chromewebstore.google.com/detail/bbfpkjnpfcddoagjiadebfafdfbckpho), as a **local-only**
>   authenticator. Its store build makes no network requests and has no way to turn sync on. It can link with the Sixkey
>   app on the same Mac (Settings › Advanced), through Chrome and on that computer only; Sixkey for Mac is not
>   published yet.
> - **The server sync is set aside.** The extension's sync client (its engine, its worker and transport, and the
>   settings page's Sync section, sign-in by e-mail) is gone from every build, development builds included; it can be
>   found in the history. The server and the API contract stay, tested, for a possible paid cloud. Devices of one person
>   are to sync through Chrome sync instead.
> - **The sync server (`api/server/`) and the API contract (`api/openapi.yaml`, `contract/`) are unreleased.** The
>   server only runs in development and test mode: it refuses to start in production until a production sign-in
>   provider exists.
> - **Self-hosting is not possible yet.** [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) explains why.
> - **YubiKey support is a design proposal only** ([docs/design/proposals/YUBIKEY-DESIGN.md](docs/design/proposals/YUBIKEY-DESIGN.md)).
> - **No external security audit has been done.** The review records in [docs/audit/](docs/audit/README.md) are
>   AI-model review sessions, not third-party audits.
> - **Open source**: MPL-2.0 for the extension, AGPL-3.0-or-later for the server, Apache-2.0 and CC0-1.0 for the
>   contract, CC-BY-4.0 for the documents (see [Licence](#licence)).
>
> What comes next, and in which order: [ROADMAP.md](ROADMAP.md).

## What it does

- Shows TOTP codes (RFC 6238; SHA-1, SHA-256 or SHA-512; 6 or 8 digits), with the accounts that match the current
  site listed first. HOTP accounts are stored and backed up but cannot generate codes yet.
- Adds accounts from `otpauth://` links, Google Authenticator export QR codes (from a screenshot, or scanned with the
  computer's camera in the settings page), a QR code on the current page or in a pasted screenshot, plain key lines,
  other apps' unencrypted exports (link lists, Aegis, 2FAS, andOTP, Raivo, Bitwarden, FreeOTP+, Proton Authenticator,
  CSV), and Sixkey backup files. After an import from a file it offers to delete that file.
- Encrypts the vault with a key protected by your master password and by a recovery key. Without both, the data
  cannot be recovered by anyone, by design. The master password is one you choose; the random recovery key can be split
  into shares, any 2 of 3 or 3 of 5 of which bring it back.
- Unlocks for every day with a PIN of 4 to 8 digits, also after a browser restart, or with Touch ID or Windows Hello.
- Fills the current code into the page's code box when you click Fill or press the Fill shortcut, for an account
  registered for that site. On sites you turn on, one at a time, the toolbar icon also shows when a code can be filled.
  It never submits a form.
- Backs up automatically into the browser's own sync storage, in the build from 2026-11-08: an encrypted copy of the
  vault, written about 30 seconds after each change (also while Sixkey is locked), which Chrome's sync carries to your
  other computers signed in to the same Google account; a new computer restores it with your master password or
  recovery key. For a new vault in a profile only you use, its box at the end of first run is ticked; an existing vault
  takes one click; its status is always in view. Sixkey can confirm it handed the copy to Chrome, not that Chrome
  uploaded it ([notes](docs/design/notes/CSB-NOTES.md)). The encrypted backup file (Settings › Backup) stays. The Google
  Drive backup through a separate plugin was withdrawn on 2026-11-06.
- Can show its list in the browser's side panel instead of the popup.
- Keeps several local copies (two slots, rolling and daily snapshots, a second copy in IndexedDB) so that a crash or a
  damaged write does not lose saved data, and reminds you to export an encrypted backup.
- Asks for the master password again before every export, and keeps a local record of wrong passwords and exports.
- Lets you change how the list looks without leaving the popup: the Appearance button (a sun, beside the search field)
  sets the theme, standard or compact rows, the order, and whether codes are hidden until you ask, the same four
  choices as Settings › Appearance, in the popup and in the side panel.

How the local vault works, what it protects against and what it does not: [docs/security/local-vault.md](docs/security/local-vault.md).
What it stores and where: [docs/PRIVACY.md](docs/PRIVACY.md).

## What it promises, and what enforces each promise

| Promise                                                                                                                                                                                                                                                                                  | Where it is enforced or checked                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The store build sends no network request for its backup: Chrome's own sync carries the encrypted copy in `chrome.storage.sync`, which only the service worker writes, and only once the browser has closed it to scripts in web pages.                                                   | `extension/manifest.base.json` (no Google origin); `extension/src/platform/csb-area.ts`; `extension/test/unit/source-rules.test.ts`; `extension/test/e2e/csb-probe.spec.ts`                    |
| The core can reach its sync API only after you enable sync and accept Chrome’s permission prompt; only from its service worker.                                                                                                                                                          | The core manifest CSP and `extension/src/platform/api-permission.ts`; `check-dist.mjs`; `extension/test/regression/network.spec.ts`                                                            |
| No host permission at install, no declared content scripts, no remote code, no `nativeMessaging`. Its own script runs in a page only on your click or shortcut, for an account registered for that page, or on a site you turned code suggestions on for, after your own click in a box. | `extension/manifest.base.json`; `check-dist.mjs` fails a build that differs from the expected manifest or contains inline scripts or remote resources                                          |
| It answers its own pages. Its script on a site you turned on can send one message, which gets no answer; no other extension and no web page can message it.                                                                                                                              | `extension/src/platform/sender-policy.ts` checks every message's sender; `extension/src/platform/content-channel.ts`; no `externally_connectable`; `check-dist.mjs` refuses external listeners |
| All cryptography comes from the browser's WebCrypto; no third-party crypto library.                                                                                                                                                                                                      | `extension/package.json` (no crypto dependency); [docs/security/local-vault.md](docs/security/local-vault.md) §Cryptography                                                                    |
| No analytics, tracking or crash reporting.                                                                                                                                                                                                                                               | No network path (above); the server's log fields are an allow-list (`api/server/sixkey_server/applog.py`)                                                                                      |
| With sync (not released): the server never sees your secrets, vault key, master password or recovery key.                                                                                                                                                                                | End-to-end encryption by design: [docs/SYNC-DESIGN.md](docs/SYNC-DESIGN.md) §1.2 (attacker A1) and §2; the known-answer vectors in `contract/vectors/`                                         |
| Local features will never be locked behind the paid hosted service.                                                                                                                                                                                                                      | A project commitment, not code: [GOVERNANCE.md](GOVERNANCE.md)                                                                                                                                 |

The limits of each of these are written down rather than glossed over: see "Limits you should know about" and "Known
gaps" in [docs/security/local-vault.md](docs/security/local-vault.md), and the residual-risk column of the sync threat
model (SYNC-DESIGN §1.2, in Chinese; an English version is planned).

## Build and test

Requirements: Node.js 22 and npm 10 for the extension; Python 3.14 and PostgreSQL 14 or later (`initdb`, `pg_ctl`) for
the server. No Docker. Commands run from the directory named in each block.

**Extension** (`extension/`):

```
npm ci
npm run typecheck     # TypeScript, strict
npm test              # unit, fault-injection and regression tests (vitest)
npm run build         # the store build -> dist/ (load it unpacked at chrome://extensions)
npm run check         # check-dist: the built extension against its hard rules
npm run build:test    # the store build with a fixed ID, named "Sixkey (test)", for testing by hand -> dist-test/
npm run build:dev     # a development build, with what the store build gates out -> dist-dev/
npm run e2e           # end-to-end tests in Chromium; needs `npx playwright install chromium` once and a free port 127.0.0.1:8787
```

**Server** (`api/server/`):

```
make venv             # once: .venv with the exact versions in requirements-dev.txt
make check            # starts a private PostgreSQL in .pg/ (unix socket only) and runs the test suite
make run              # serves the API on http://127.0.0.1:8787 (no build of the extension talks to it any more)
```

**Contract** (from the repository root):

```
node contract/tools/gen-vectors.mjs --check            # recomputes every known-answer vector; fails if the file differs
python3 -I contract/tools/check_consistency.py          # the design document against api/openapi.yaml
(cd api/server && make contract)                        # the Python reference checks, with the venv's cryptography
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the rules for changes, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains
how the pieces fit together.

## Repository map

| Path               | What                                                                                                                                                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/`       | The Chrome extension (TypeScript, Preact, Vite). `src/core` is pure logic (TOTP, crypto, vault, storage, backups); `src/platform` adapts it to Chrome; `src/popup`, `src/sidepanel`, `src/options`, `src/background`, `src/offscreen` are the extension's contexts. [extension/README.md](extension/README.md) |
| `api/server/`      | The sync API (FastAPI, PostgreSQL), unreleased. [api/server/README.md](api/server/README.md)                                                                                                                                                                                                                   |
| `api/openapi.yaml` | The API contract: 29 operations, errors, limits, request signatures (JSON syntax, valid YAML)                                                                                                                                                                                                                  |
| `contract/`        | Known-answer test vectors shared by the extension and the server, a vector generator, a separately written Python reference implementation, and a checker that compares the design document with the contract. [contract/M0-NOTES.md](contract/M0-NOTES.md)                                                    |
| `docs/`            | Design, security and privacy documents, and the audit trail. [docs/README.md](docs/README.md) is the index                                                                                                                                                                                                     |
| `tools/`           | Development tools outside the extension: `webauthn-probe/`, a dev-only extension that measures passkeys on real hardware for the quick-unlock design                                                                                                                                                           |
| `LICENSES/`        | The licence texts; `REUSE.toml` maps every path to its licence ([LICENSE.md](LICENSE.md))                                                                                                                                                                                                                      |

## How this project is built

Sixkey is designed and maintained by one maintainer working with AI coding agents (Anthropic's Claude). Code, tests
and most documents were written in that process, and security-relevant changes were reviewed in separate AI-model
review sessions before they were merged. Those review records are published in [docs/audit/](docs/audit/README.md) with
what became of each finding. They are not independent audits: an external audit has not been done yet. Contributions
from people are welcome under the rules in [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please report vulnerabilities privately, through GitHub private vulnerability reporting or to
[security@g.pro](mailto:security@g.pro), as described in [SECURITY.md](SECURITY.md). Do not open public issues for
security problems. There is no paid bug bounty.

## Licence

Every part is open source, each under the licence that suits it ([LICENSE.md](LICENSE.md) has the reasons;
`REUSE.toml` maps every path):

| Part                                                          | Licence           |
| ------------------------------------------------------------- | ----------------- |
| The extension (`extension/`, `tools/`)                        | MPL-2.0           |
| The sync server (`api/server/`)                               | AGPL-3.0-or-later |
| The contract's code (`contract/tools/`, `contract/py/`)       | Apache-2.0        |
| The contract's data (`api/openapi.yaml`, `contract/vectors/`) | CC0-1.0           |
| The documents                                                 | CC-BY-4.0         |

Contributions are signed off under the Developer Certificate of Origin ([CONTRIBUTING.md](CONTRIBUTING.md)). The paid
offering is limited to the hosted sync service ([GOVERNANCE.md](GOVERNANCE.md)). Third-party components keep their own
licences: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

"Sixkey" and the Sixkey icon are trademarks of VIEW TECH LTD (not registered); see [TRADEMARKS.md](TRADEMARKS.md).
