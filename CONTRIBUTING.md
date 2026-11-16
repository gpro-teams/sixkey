# Contributing to Sixkey

Thank you for helping. Sixkey keeps people's two-factor secrets, so the bar for changes is high and the rules below are
strict on purpose. Small, well-tested changes are the easiest to accept.

## Before you start

- **Security problems**: never in a public issue or pull request. See [SECURITY.md](SECURITY.md).
- **Larger changes**: open an issue first and describe the problem, not only the solution. A change to the
  cryptography, the storage format, the sync protocol or the permissions needs a design discussion before code.
- **Read** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and, for the area you touch,
  [docs/security/local-vault.md](docs/security/local-vault.md) or [docs/SYNC-DESIGN.md](docs/SYNC-DESIGN.md).

## Setting up

Node.js 22 and npm 10 for the extension; Python 3.14 and PostgreSQL 14 or later for the server. The commands are in
the [README](README.md#build-and-test). In short:

```
cd extension && npm ci && npm run format:check && npm run typecheck && npm test && npm run build && npm run check
cd api/server && make venv && make format-check && make check
node contract/tools/gen-vectors.mjs --check && python3 -I contract/tools/check_consistency.py && (cd api/server && make contract)
```

`npm run e2e` runs the end-to-end tests in Chromium (`npx playwright install chromium` once; port 127.0.0.1:8787 must
be free). `npm run verify` runs typecheck, unit tests, build, the dist check and e2e in one go.

## Formatting

Layout is decided by the formatters, not by hand: Prettier for TypeScript, JavaScript, JSON, CSS, YAML and the
top-level Markdown documents, and ruff for Python. `npm run format` in `extension/` formats the whole repository with
Prettier and `npm run format:check` only checks; `make format` and `make format-check` in `api/server/` do the same for
Python. The configuration is `.prettierrc.json`, `.prettierignore` and `ruff.toml` at the root; `.prettierignore` lists
what is never reformatted (generated files, the contract's data, test fixtures, the extension's HTML pages, and the
records and design history in `docs/`). CI fails on unformatted files.

## Licences and third-party notices

Each part of the repository has its own licence ([LICENSE.md](LICENSE.md); the exact map is `REUSE.toml`, checked by
`reuse lint`). A new file is covered by the map of the folder it is in; a file that does not fit, such as third-party
text, needs its own entry in `REUSE.toml`. `THIRD-PARTY-NOTICES.md` is generated from the dependency trees: after any
change to `extension/package.json`, the lockfile, `api/server/requirements*.txt` or the site rules' bundle and its
upstream pins (`rules/build/baseline.json`, `rules/upstream/SOURCES.json`), run `npm run notices` in `extension/` (a
unit test fails until you do). A new runtime dependency whose data or files carry terms of their own needs an entry in
`extension/scripts/notices-data.mjs`, and so do a new Python pin (its licence) and a new upstream source of the site
rules (`BUNDLED_DATA`).

## Rules for changes

1. **Every change to cryptography, storage or sync comes with tests.** A fix comes with a test that fails without it.
   Name the test after the behaviour it protects, and say in a comment what bug it would catch.
2. **Pure logic lives in `extension/src/core`** with no `chrome.*` and no DOM; Chrome-specific code goes in
   `src/platform`. Logic is written and tested before the interface that uses it.
3. **Storage writes go through the fault matrix.** A new write path in `src/core/storage` or `src/core/sync/local` must
   be covered by the crash and fault-injection tests in `test/fault/` (a crash before, after, half-way and torn at
   every write of the operation). Do not weaken an existing matrix to make a change pass.
4. **Mutation testing is how tests are judged.** For a change to a security- or data-critical rule, write down the
   plausible bugs (mutants) your tests must catch and check that each one fails a test. The server has a harness for
   this (`make mutants` in `api/server`; mutants in `tests/mutation/mutants.py`, each an exact replacement that must
   apply exactly once). The extension has no harness in the tree yet; describe the mutants you ran in the pull request.
5. **The network rules are hard rules.** No new permission, host, content script, remote resource or network primitive.
   `scripts/check-dist.mjs` fails the build otherwise; changing what it allows needs a design change first.
6. **No new runtime dependency** without discussion, and never a cryptography library: all crypto is WebCrypto.
   Dependencies are pinned to exact versions, in `extension/package.json` and `api/server/requirements*.txt`.
7. **The contract is shared.** A change to `api/openapi.yaml` or the vectors updates `docs/SYNC-DESIGN.md` in the same
   change; `contract/tools/check_consistency.py` and `gen-vectors.mjs --check` must pass. Migrations in
   `api/server/migrations/` are never edited once applied anywhere: add a new one (the migration runner refuses a
   changed file).
8. **All user-visible text goes through i18n** (English and Simplified Chinese). The text lives in
   `extension/scripts/i18n/`; run `python3 scripts/messages.py` in `extension/` to regenerate `_locales/` and
   `catalogs/`, which are generated files and never edited by hand. The settings page loads its text in parts, each with
   its own size budget: a new settings string is also placed in a part (`PARTS` in your fragment; see
   `docs/design/notes/BUDGET-NOTES.md` §3).
9. **Documents say what the code does.** If a change makes a statement in `docs/security/local-vault.md` or
   `docs/PRIVACY.md` untrue, the same change corrects it. Limits and residual risks are written down, not hidden.
10. **TypeScript stays strict**: no `any`, no `@ts-ignore`. Code comments and identifiers are in English.

## Pull requests

- Keep each pull request to one purpose, and explain what changed and why.
- List the commands you ran and their results (test counts, `check-dist` output, the popup size it reports).
- Changes to `src/core/crypto`, `src/core/storage`, `src/core/sync`, the manifests, `scripts/check-dist.mjs`,
  `scripts/build.mjs`, the server's request pipeline and signatures, `migrations/` and `contract/` need the maintainer's
  review.

## Sign-off (Developer Certificate of Origin)

Contributions are accepted under the licence of the files they change ([LICENSE.md](LICENSE.md)); you keep the
copyright of your work. There is no contributor licence agreement. Instead, every commit must be signed off, certifying
the [Developer Certificate of Origin 1.1](DCO.txt) ([developercertificate.org](https://developercertificate.org/)):
that you wrote the change or otherwise have the right to submit it under that licence. Add the line with
`git commit -s`:

```
Signed-off-by: Your Name <you@example.com>
```

The sign-off must name the commit's author, with the same name and address. Use a name and address you are willing to
have in the public history. A check on every pull request (`.github/workflows/dco.yml`) fails when a commit has no
matching sign-off, and commits without one cannot be merged. To add a missing sign-off to your last commit, run
`git commit --amend -s --no-edit`; for several commits, `git rebase --signoff <base>`.

## AI assistance

Sixkey itself is built by its maintainer with AI coding agents, and its internal review records are AI-model review
sessions ([docs/audit/README.md](docs/audit/README.md)). Contributions made with AI tools are welcome on the same terms
as any other, provided that:

- **you say so** in the pull request: which tool, and for which parts;
- **you understand and stand behind every line**: you can explain why the change is correct, and you have run the
  tests yourself;
- **you have the right to submit it**: the sign-off above applies to AI-assisted work too; do not submit output you
  have reason to believe reproduces someone else's code;
- **reviews stay honest**: an AI-model review of your change may help, but call it that, never an independent review.

## Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
