# Contributing site rules

The repository's `CONTRIBUTING.md` applies, with these additions for `rules/`.

- **Licence.** Rules, fixtures and tools are AGPL-3.0-or-later: contributions are accepted under the licence of the files
  they change, with a Developer Certificate of Origin sign-off on every commit (`git commit -s`), and no contributor
  licence agreement. Rules that are accepted can therefore never be relicensed.
- **Write it yourself.** A rule states facts you checked on the site's real page with your own account. Do not copy rules,
  selectors or lists from other projects or databases, whatever their licence (Bitwarden's equivalent-domains table,
  2fa.directory's data and password managers' rule sets among them): only the upstream files under `upstream/`, imported
  by `tools/import.mjs` and pinned, come from elsewhere.
- **Fixtures are synthetic.** Each rule has at least one page under `fixtures/<id>/` that you wrote to reproduce the code
  box's structure: the same element types, attributes and nesting, with made-up text. Never a saved page of the real site:
  it is the site's content and may hold your personal data. The browser test (`extension/test/e2e/rules-corpus.spec.ts`)
  serves each page at the rule's host, at its first page entry's path or at the one the page names in
  `<meta name="sixkey-path" content="/…">`, and the rule must find its box there and fill it.
- **One rule per site, exact hosts.** `sites/<id>.json` with the file named after the rule's id. List every host the rule
  is for (`www.` too); a host may belong to one rule only. A shared suffix (`github.io`, `co.uk`, ...) is refused.
- **`verified`** is the date you saw the rule work on the real page. A rule not checked for a year is reported, not
  removed.
- **The bundle goes with the change.** Run `node rules/tools/bundle.mjs` and commit `build/baseline.json` in the same
  commit; the checks fail on a stale one.
- **Upstream changes** (`tools/import.mjs fetch ...`) and `upstream/exclude.json` entries say why in the commit message.
