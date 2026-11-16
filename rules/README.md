# Sixkey site rules

The data Sixkey's code box finder can use on top of its own heuristics: where the verification-code box is on a
site's 2FA pages, and which sites are the same sign-in. Data only: no expressions, conditions, waits or scripts. A rule
never adds a site to an account and never fills anything by itself; it can only help the finder pick a box on a page
the user has already registered for an account (TOTP autofill Stage 3, `docs/design/notes/AUTOFILL3-NOTES.md`).

The format is checked by the extension's own code (`extension/src/core/rules/format.ts`) and described for other
implementations by the JSON Schemas in `contract/rules/1/`.

## What is here

| Path                    | What                                                                                                                                                                                     | Licence                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `sites/<id>.json`       | One site rule per file (none yet: the first ones come from checks on real sign-in pages)                                                                                                 | AGPL-3.0-or-later                          |
| `fixtures/<id>/*.html`  | The synthetic pages each rule is tested on                                                                                                                                               | AGPL-3.0-or-later                          |
| `upstream/apple/`       | Apple's [password-manager-resources](https://github.com/apple/password-manager-resources) files, verbatim: the shared sign-in groups and the sites that want the code after the password | MIT, Apple's (`upstream/apple/LICENSE.md`) |
| `upstream/SOURCES.json` | Each upstream file's pin: the commit it came from, its SHA-256, when it was fetched                                                                                                      | AGPL-3.0-or-later                          |
| `upstream/exclude.json` | Hosts and groups taken out of the upstream data (it can only take out)                                                                                                                   | AGPL-3.0-or-later                          |
| `version.json`          | The next bundle's version (a counter) and date                                                                                                                                           | AGPL-3.0-or-later                          |
| `build/baseline.json`   | The bundle built from all of the above, committed: what a Sixkey release carries                                                                                                         | AGPL-3.0-or-later AND MIT                  |
| `tools/`                | `bundle.mjs`, `import.mjs`, `worklist.mjs`, `upstream.mjs`, `sign.mjs`                                                                                                                   | AGPL-3.0-or-later                          |
| `NOTICE`                | What the licences cover, and the upstream notices                                                                                                                                        | —                                          |
| `SIGNING.md`            | How live bundles are signed between releases: the two keys, signing, changing keys, a lost or stolen key                                                                                 | CC-BY-4.0                                  |

The Sixkey extension itself, including the code that reads these files, is MPL-2.0; the JSON Schemas are CC0-1.0. See
`NOTICE` and the repository's `LICENSE.md`.

## The tools

They need Node 22.18 or later, which loads the extension's checker (a TypeScript file) directly; on Node 22.6 to 22.17,
run them with `node --experimental-strip-types`. They need no install and, except where said, no network.

- `node rules/tools/bundle.mjs` writes `build/baseline.json` from the sources. `--check` fails when the committed file is
  not what the sources give (stale); `--report` prints what was taken, what was dropped and the internationalised names
  to look at (`idn`). The same sources always give the same bytes.
- `node rules/tools/import.mjs` checks every upstream file against its pin and its source's shape, and refuses on any
  difference. `node rules/tools/import.mjs fetch apple <commit>` downloads Apple's files at that full commit id (no
  redirect followed, at most 2 MiB each), checks the shape of every one, and only then writes them and pins them: the only
  step that uses the network, run by hand. Review its diff like any other change.
- `node rules/tools/worklist.mjs --from <file>` (or `--fetch`) lists the sites 2fa.directory says take authenticator codes
  that have no rule yet. It prints and writes nothing: nothing of 2fa.directory is stored here or shipped.
- `node rules/tools/sign.mjs` signs a live bundle for the builds whose updater is let in, offline, with a key file or a
  hardware key, and checks what it signed with the extension's own code before it writes it: `SIGNING.md`.

Each tool refuses a command line it does not know (another word, an option, a missing argument) with its usage and exit
code 2, so a misspelt command never passes as a check.

## Adding a rule

1. Check the site's real 2FA page yourself, with your own account, and note the path of the step that asks for the code
   and how its box (or boxes) can be selected.
2. Write `sites/<id>.json` (`contract/rules/1/site-rule.schema.json`; the hosts are exact, so list `www.` hosts too) and
   at least one synthetic page under `fixtures/<id>/` that reproduces the box's structure. **Never a saved copy of a real
   page**: it is the site's content and may hold personal data. Set `verified` to the date you checked. A page is tried
   at the path of the rule's first page entry, or at the one its `<meta name="sixkey-path" content="/…">` names.
3. Run `node rules/tools/bundle.mjs`, then the extension's tests (`cd extension && npx vitest run test/unit/rules-*`, and
   the browser test of every rule against its pages: `npm run build:e2e && npx playwright test
test/e2e/rules-corpus.spec.ts`), and commit the rule, its fixture and `build/baseline.json` together, with a DCO
   sign-off (`CONTRIBUTING.md`).

## Re-importing upstream data

At each release, or when Apple's list changes:

1. Take the commit id from the history of Apple's own `main`, and check it there: in a clone of
   `https://github.com/apple/password-manager-resources`, `git merge-base --is-ancestor <commit> origin/main` must
   succeed. GitHub serves a fork's commits under the parent's address too, so a commit id from anywhere else (an issue, a
   pull request) may be someone else's.
2. `node rules/tools/import.mjs fetch apple <commit>`, then read the diff of `upstream/apple/`.
3. Run `node rules/tools/bundle.mjs --report` and read its `idn` list: every name with an `xn--` label or a character
   beyond ASCII, kept or dropped. A look-alike of a known site (`xn--pypal-4ve.com` beside `paypal.com`) would be there,
   and nothing else in the tools can tell one from a real site. `dropped` lists the hosts Sixkey would not accept (an IP
   address, a shared suffix, a reserved name) and the groups it could not take.
4. Add to `upstream/exclude.json` whatever should not be offered (with the reason in the commit), bump `version.json`,
   run `bundle.mjs` and commit.

## Releasing a bundle

`version.json`'s `version` goes up by one for every bundle released or published. The commit that releases it is tagged
`rules-v<version>`; the bundle's `source` points there once the repository's address is set in
`extension/scripts/repo-url.mjs`.

Every Sixkey build carries `build/baseline.json` as `rules/baseline.json`, byte for byte, with `rules/LICENSE.txt` (this
folder's `NOTICE` and the AGPL-3.0 text) beside it; the build stops on a bundle the extension's reader would refuse or
that is not in `bundle.mjs`'s form, and on any module that imports a file of this folder: the bundle is read from the
package, never built into the code (check-dist also looks for its host lists in every built script). The store package
(`npm run package` in `extension/`) is refused while the bundle's `source` is empty, or is not the address the
repository's settings give: set the address, run `bundle.mjs`, commit, then package.

## For forks

Everything here is yours to use under its licence. A fork that changes the rules and gives the bundle to others, in a
build or as a download, passes on the same rights: the changed rule files, the fixtures and the tools, under
AGPL-3.0-or-later, with a `source` that says where they are. Apple's files keep Apple's notice.
