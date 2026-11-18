# Sixkey extension

Chrome (MV3) 2FA authenticator. Roadmap: `../ROADMAP.md`. Security notes: `../docs/security/local-vault.md`.
Licence: MPL-2.0 (`../LICENSE.md`); the third-party notices are `../THIRD-PARTY-NOTICES.md` (`npm run notices`).

```
npm install
npm run verify      # typecheck, unit + fault tests, build, dist checks, end-to-end tests in real Chromium
npm run build       # -> dist/   (load this unpacked in chrome://extensions)
npm run build:test  # -> dist-test/, checked: the store build named "Sixkey (test)" with a fixed ID, for testing by hand ("Builds")
npm run build:dev   # -> dist-dev/ with source maps, the "(dev)" name and what the store build gates out
npm run build:e2e   # -> dist-e2e/ with clipboard permissions granted, used only by Playwright
npm run package     # the store package: a prod build, check-dist on it, then release/sixkey-<version>.zip from dist/
                    # (refused, before building, until Sixkey's STORE_ID is pinned and the site rules' bundle names
                    # its source; --id-draft: the first upload's ID draft, "do not publish"; --local-only: dist/
                    # checked for Load unpacked, no zip; "Publishing" below)
npm run format      # Prettier over the whole repository (npm run format:check only checks; Python: make format in api/server)
npm run notices     # regenerate ../THIRD-PARTY-NOTICES.md from the lockfile, node_modules and the server's pins (notices:check checks)
python3 scripts/messages.py   # regenerate _locales and catalogs/ from scripts/i18n/base.py plus one fragment per package (scripts/i18n/*.py)
```

Layout: `src/core` is pure logic with no `chrome.*` or DOM (TOTP, crypto, vault/merge, storage); `src/platform` adapts it
to Chrome; `src/popup`, `src/sidepanel` (the popup's screens in the browser's side panel), `src/options`,
`src/offscreen`, `src/background` are the extension contexts.
`scripts/check-dist.mjs` fails the build on a manifest that is not exactly the expected one (permissions, the one
optional host permission, the content-security-policy), a page without its own `connect-src 'none'` ahead of its first
script, inline scripts, content scripts, remote resources, a finder script (`inject/otp.js`) that is not the one classic script it must be (no extension API, network, storage or form submission) or is over its budget, the Fill button's chunk or text in a page's static graph, a network call anywhere but the service worker's site
rules updater (with its gate open) and the one read of the package's own site rules, in the lazy chunk the Fill button and the "same sign-in" lines load, a URL a script may not hold, the server sync's API origin in any shipped file of any build, a development-mode build, the settings page's Sync section (its chunk, catalogs, route, elements or text), the developer sync page or enrolment code in any build, the names of the server sync's records in a store build,
a popup or side panel over budget, the side panel's open-on-click behaviour (it loses `activeTab`), a build without its licence (`LICENSE.txt`) and third-party notices (`THIRD-PARTY-NOTICES.txt`), or one whose site rules (`rules/baseline.json`, `rules/LICENSE.txt`) are not the repository's bundle and its licence, or whose scripts hold the bundle's host lists (in any quotes or spacing; the build itself already refuses any module that imports a file under `rules/`).
The site rules' updater (signed bundles between releases, TOTP autofill Stage 3) is behind its own release gate,
`scripts/rules-update.mjs`, closed in the store build: there the build keeps its modules out of every module graph
(`scripts/rules-guard.mjs`) and check-dist refuses its marks (the signed manifest's format, its database's name, a rules
origin, its switch's key, its two messages, its switch's words and chunks); in every build only the service worker may
name that database, and a store build never holds the test signing keys (`test/fixtures/rules-keys/`). A build with the
gate open stops unless it has a rules origin and exactly two signing keys (`scripts/rules-keys.mjs`;
`../rules/SIGNING.md`); with it open (the dev and e2e builds), check-dist holds each of the updater's marks to where it
belongs, the CSP to exactly the rules origin's `/v1/` path more, and the worker to its budget plus the updater's room,
which no store build gets (`scripts/sw-budget.mjs`).
`--e2e` and `--dev` check those builds instead (`dist-e2e/`, `dist-dev/`), `--id-draft` the first upload's ID draft
(`dist-id-draft/`), and `--test` the test build (`dist-test/`). Only `npm run package` makes Sixkey's zip, and only from
a build that has just passed the check.

## Builds

Each build goes to its own folder; only `dist/` is ever packaged (and `dist-id-draft/`, for the first upload alone).

- `npm run build` (`dist/`): the store build. The store package is made from it (`npm run package`).
- `npm run build:test` (`dist-test/`, checked by `check-dist --test` as it is built): **for testing by hand**, on one
  computer or two. It is the store build in every respect (the same release gates, so no in-page suggestion or rules
  updater; no API origin; the same CSP and permissions) but three: its name is
  "Sixkey (test)"; its manifest carries a public key of its own (`manifest.test.json`), so its ID is
  `copndbnmkakfiohikpecmdaoldodaojc` wherever it is loaded, and copies on two computers share their data in Chrome sync,
  which is keyed by that ID; and the install-source check is off, since a copy loaded unpacked would always show its
  notice. Its ID is neither the dev build's nor the store's, so it can sit beside either in one profile, with a vault of
  its own. The prod check refuses it, and it is never packaged.
- `npm run build:dev` (`dist-dev/`): for developing Sixkey. It carries what the store build gates out (the in-page
  suggestion; the rules updater), unminified, with source maps and the fixed ID `pgnlbjikdnniepfeijffpefifnojjege`. A
  check by hand uses it only for a feature that is still gated out of the store build.
- No build has the server sync's client: the settings page's Sync section (sign-in by e-mail, the code, the join), the
  developer sync page that drove the engine, the engine itself, the worker's sync, the bridge, the transport and the API
  origin are gone from every build (OWNER-DECISIONS/25); the build's graph guard and check-dist refuse any of them in any
  build, and no build reaches any API. The dev and e2e builds' worker removes, at an install or an update, what that
  client left in a profile that once had it on (`src/platform/server-sync-leftovers.ts`).
- `npm run build:e2e` (`dist-e2e/`): for the Playwright tests alone.

## Publishing

What can be uploaded to the Chrome Web Store, and nothing else (`scripts/package.mjs`, `scripts/store-gates.mjs`):

- **The store package**, `npm run package` (`release/sixkey-<version>.zip`). It carries no manifest `key` (the store's
  item has its own). It is refused, before anything is built, while `STORE_ID` (`scripts/store-id.mjs`) is empty or the
  developer build's ID, and while the site rules' bundle names no source.
- **An ID draft**, for the first upload alone, which only gets the store's ID: `npm run package -- --id-draft`
  (`release/sixkey-<version>-id-draft-do-not-publish.zip`, named "Sixkey (ID draft, do not publish)"). It is refused
  once `STORE_ID` is set.
- `npm run package -- --local-only` builds Sixkey into `dist/` and checks it, for **Load unpacked** on this computer, and
  writes no zip.

The first store upload, in this order:

1. `npm run package -- --id-draft`. Upload the zip as a new item; do not submit it for review. Its ID is Sixkey's.
   Done.
2. Pin that ID: `STORE_ID` in `scripts/store-id.mjs`. Done: `bbfpkjnpfcddoagjiadebfafdfbckpho`.
3. Set the repository's public address (`REPO_URL` in `scripts/repo-url.mjs`) and rebuild the site rules' bundle
   (`../rules/README.md`, "Releasing a bundle"), so that the bundle names where its source is. Done:
   `REPO_URL` is <https://github.com/gpro-teams/sixkey>, and the bundle's source is its `rules/` folder at the tag
   `rules-v<version>`, which must be on the public repository before the package is uploaded.
4. `npm run package`: the store package. It is refused, before anything is built, until steps 2 and 3 are done.
5. Upload it to the item, in place of its draft, and submit it for review. The listing's privacy policy is
   <https://github.com/gpro-teams/sixkey/blob/main/docs/PRIVACY.md>.

Next are steps 4 and 5: build the store package with `npm run package` (`release/sixkey-<version>.zip`), and upload it
to the item the ID draft made, not as a new item.

Not verified yet, since only the ID draft has been uploaded: how the store treats a draft (that its package can be
replaced before it is submitted, and whether the replacement must have a higher version: if so, raise the version
first), and that an upload without a manifest `key` keeps the item's ID. Nothing here is published automatically.
