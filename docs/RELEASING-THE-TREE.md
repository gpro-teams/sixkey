# Releasing the tree: the first public commit

How the first public commit of Sixkey is made, where it is pushed, and the repository settings to switch on after it.
This is a plan: none of these steps has been run yet. Once history is public it cannot be taken back, so every check
below comes before the push.

## What is published

One commit with no parent, `Sixkey: first public commit`, on `main` of <https://github.com/gpro-teams/sixkey>, and the
tag `rules-v1` on it (the site rules' bundle names that tag as its source: `extension/scripts/repo-url.mjs`). Its tree
is the tree of the maintainer's last commit, byte for byte: the same tree hash.

Everything tracked at that commit is in it, and nothing else:

- what `.gitignore` ignores is not tracked (build output, `node_modules/`, virtual environments, the local test
  database, logs, archives, keys and signing material, editor files);
- nor are the paths listed in `.public-exclude` (the maintainer's private decision notes, `OWNER-DECISIONS/`).

Code comments and design notes that cite `OWNER-DECISIONS/nn` keep doing so; `docs/audit/README.md` explains what
those references are.

The maintainer's history before that commit is not published. Sixkey was developed in a private repository from
2026-10-22; that history stays with the maintainer. Design notes and a few code comments cite its commits by short
hash (for example `2468c75`): they name pre-release states that are not in the public repository, and the first
public commit holds the last of them. A single new commit, rather than that history, is published so that what
becomes public is exactly the tree checked below: no earlier version of a file, no old commit message and no old
identity comes with it.

The commit is pushed to a new repository that never held the private history. The repository that held it is renamed
and stays private, so no object of the private history can be reached from the public one.

## Before the commit

1. **Licence texts.** The texts in `LICENSES/` are the standard texts, copied from other open-source packages' copies
   because the canonical SPDX downloads were not available when they were added. Optionally replace them with the
   SPDX versions (the legal text is the same; the layout may differ): delete the files and run
   `pipx run reuse download --all` at the root. `DCO.txt` is the canonical text from
   <https://developercertificate.org/>, with the page's copyright line and verbatim-copy notice.
2. **REUSE.** `reuse lint` must report the repository compliant: every file has a copyright and a licence from
   `REUSE.toml`, the licences used are exactly `AGPL-3.0-or-later`, `Apache-2.0`, `CC-BY-4.0`, `CC0-1.0`,
   `LicenseRef-DCO`, `MIT` and `MPL-2.0`, and none is missing from or unused in `LICENSES/`. `MIT` covers a test
   fixture, `extension/test/fixtures/shares-slip39.json` (values derived from SLIP-39's official test vectors), which
   is never shipped with the extension; Apple's files kept verbatim in `rules/upstream/apple/`; and, with
   `AGPL-3.0-or-later`, the site rules' bundle `rules/build/baseline.json`, which every build carries. CI runs the same
   check (`ci.yml`, "licensing").
3. **The whole verification**, as in `CONTRIBUTING.md`: in `extension/`, `npm ci`, `npm run format:check`,
   `npm run typecheck`, `npm test`, `npm run build`, `npm run check`, `npm run notices:check`, `npm run e2e`; in
   `api/server/`, `make venv`, `make format-check`, `make check`, `make contract`; at the root,
   `node contract/tools/gen-vectors.mjs --check` and `python3 -I contract/tools/check_consistency.py`.
4. **Nothing private.** Search every tracked file for absolute local paths, user names, e-mail addresses other than
   the project's contact and test labels, tokens and keys. The search of 2026-11-16 found absolute paths of the
   maintainer's working folders, or their names, in seven design documents under `docs/design/`; they are shortened
   to `scratchpad/…`, as `docs/audit/README.md` says of the older records.
5. **CI pins.** Each `uses:` in `.github/workflows/*.yml` is pinned to the full commit SHA of a release, with the
   release's tag as a comment (the header of `ci.yml` says how to look one up).
6. **The repository's address.** `REPO_URL` in `extension/scripts/repo-url.mjs` is the public repository, and the
   site rules' bundle is rebuilt with it (`rules/README.md`, "Releasing a bundle"): the bundle's `source` is
   `https://github.com/gpro-teams/sixkey/tree/rules-v1/rules`. `STORE_ID` in `extension/scripts/store-id.mjs` is the
   store's ID for Sixkey's item, so the store package can be built (`extension/README.md`, "Publishing").

## Making the commit

The commit is made in a new, empty folder, from the maintainer's last commit, never in the maintainer's repository.
`git archive` writes only the files tracked at that commit. From the new folder:

```
git -C <maintainer's repository> archive --format=tar HEAD | tar -x -f -
git init -b main
git config user.name  "<public author name>"
git config user.email "<public author address>"
git add -A
git write-tree                                 # must equal: git -C <maintainer's repository> rev-parse 'HEAD^{tree}'
git ls-files > ../sixkey-first-commit.txt      # review this list: it is exactly what will be public
git ls-files | grep -E '^OWNER-DECISIONS/'     # must print nothing
GIT_AUTHOR_DATE=<date>T00:00:00Z GIT_COMMITTER_DATE=<date>T00:00:00Z git commit -s -m "Sixkey: first public commit"
GIT_COMMITTER_DATE=<date>T00:00:00Z git tag -a rules-v1 -m "Sixkey site rules, version 1"
git count-objects -v                           # only this commit's objects; no other refs (git show-ref)
```

Use a commit identity meant for public history, not one the maintainer's repository has used. The security mailbox is
for reports, so a separate address for commits is better. The dates are set in UTC, so neither the commit nor the tag
carries a local time zone.

## Publishing it

1. In the maintainer's repository, install a pre-push guard and point the remote at the renamed private repository,
   before the new one exists, so that nothing pushed from there can reach the public name. The guard refuses any push to
   the public repository, whatever form its address takes, and any push of the private history to anywhere but the
   renamed private repository.
2. Rename the private repository on GitHub, and keep it private.
3. Change the remote of every other clone of the private repository (on other computers, in CI, in backups), or delete
   the clone, before the new repository is created. Once a new repository takes the name, the old name no longer
   redirects to the renamed one, so a push from such a clone would land in the new repository; the guard of step 1 is
   in one working copy only.
4. Create `gpro-teams/sixkey` as a new private repository, push `main` and `rules-v1` to it in one atomic push, and check
   what it holds: one commit, those two refs, the files of `../sixkey-first-commit.txt`, and the CI run on the push.
5. Right before making it public, check again that it holds only that commit and that tag, at the same hashes and with
   the same tree, and that every check of the CI run on that commit passed. Then make it public.
6. Check that the store listing's privacy policy,
   <https://github.com/gpro-teams/sixkey/blob/main/docs/PRIVACY.md>, opens, and the rules folder at the tag `rules-v1`.

## After the first push

- **Private vulnerability reporting**: Settings › Code security › "Private vulnerability reporting" › Enable.
  `SECURITY.md` names it as a way to report.
- **Branch protection** for `main`: pull requests only, with every check of `ci.yml` (one per unit-test shard among
  them) and the sign-off check of `dco.yml` required, each by the name its workflow gives it and from GitHub Actions.
  Renaming a job, or changing the number of shards, changes the required checks with it.
- **Tag ruleset** for `rules-v*`: such a tag can be created, but not moved or deleted. The site rules' bundle names its
  tag as its source.
- **Secret scanning and push protection**: on.
- **Actions**: allow only the actions the workflows use, pinned by SHA; workflow tokens read-only by default.

## The maintainer's working copy

After the public repository has been checked, the maintainer's working copy moves onto the public history: its `.git`
is kept aside as the private archive (with a `git bundle` of it), a new `.git` is fetched from the public repository
and reset to its `main` without touching the files, and the lines of `.public-exclude` go into `.git/info/exclude`.
Every later commit is made on the public history.
