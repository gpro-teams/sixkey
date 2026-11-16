# AUTOFILL3 notes: TOTP autofill, Stage 3 (the rule corpus, alias suggestions, and rule updates)

`docs/design/proposals/TOTP-AUTOFILL.md` §12.2 gives Stage 3 the rule corpus and its updates. Its plan (r2, with the
independent review's findings answered; kept with the project's working notes, not in this tree) splits it into patches.
Each patch has a section here, in the order they land. Stages 1 and 2 are `AUTOFILL1-NOTES.md` and `AUTOFILL2-NOTES.md`.

What Stage 3 is, in short: a closed, versioned rule format; a corpus under `rules/` (AGPL-3.0-or-later, the owner's D1)
built into each release as one JSON file; the code box finder's rule hook (`inspect`'s optional argument, AUTOFILL1 D16);
"same sign-in" suggestions from Apple's MIT list (AUTOFILL1 D8, the proposal's §5.2). Rule updates between releases (a
signed static file, D2 and D3) are built behind a build gate that is closed in the store build. A downloaded bundle holds
site rules only: alias groups and the "code after the password" hosts change with releases only.

## 1. AF3-1a: the format in code

> **Round 2** (after the review, `REVIEW-AF3-1a.md`, verdict "merge after fixes", no MUST): §1.7 lists its two SHOULDs and
> six NITs, each with its fix, its test and its mutant. The rest of this section describes the code as it is now.

**Nothing imports it yet.** The store build is byte for byte the build before this patch (§1.6). No text, no permission, no
manifest key, no page and no script changes.

### 1.1 What was built

| Part | Where | Licence |
| --- | --- | --- |
| The format: types, the closed checker `validate(raw, kind, {canonicalHost, isShared}, opts)` for a site rule file (`"rule"`), a baseline bundle and a live bundle, the selector grammar (`selectorOk`), and the fields and bounds as constants (`SHAPE`, `LIMITS`, `FILLS`, `FLAGS`) | `extension/src/core/rules/format.ts` | MPL-2.0 (the extension) |
| The rules in effect (`inEffect`: a live bundle's, whole, when it is newer than the baseline; else the baseline's), the rule for a page (`ruleFor`: exact host), the finder's argument made of it (`hintOf`), the site's `minLeft`, the "code after the password" hosts (`appendsOn`) | `extension/src/core/rules/lookup.ts` | MPL-2.0 |
| "Same sign-in": the members a page is offered (`offeredOn`) and the accounts to offer with the site that makes them so (`aliasRelated`) | `extension/src/core/rules/alias.ts` | MPL-2.0 |
| The format for other implementations: a site rule, a baseline bundle, a live bundle | `contract/rules/1/site-rule.schema.json`, `baseline.schema.json`, `live.schema.json` | CC0-1.0 (contract data: `REUSE.toml`, `LICENSE.md`) |
| Tests | `extension/test/unit/rules-format.test.ts`, `rules-alias.test.ts`, `rules-lookup.test.ts`, `rules-contract.test.ts` | MPL-2.0 |

### 1.2 The format, as built

- **A site rule file** (`rules/sites/<id>.json`, AF3-1b): `id`, `hosts` (1 to 16 exact hosts), `pages` (1 to 8: a path
  prefix, a selector `field`, `segments` 0 or 4 to 8, `fill` `auto` / `chars` / `paste`), `verified` (a date, not after
  today), `fixtures` (1 to 8 synthetic pages in the rule's own folder), and optionally `flags` (`["sent"]`), `minLeft`
  (5 to 20) and `note`. One box takes `fill: "auto"` only.
- **A bundle**: `format: "sixkey-rules"`, `kind`, `schema: 1`, `version` (a counter, 1 to 2^31 − 1), `created`, `license`,
  `source`, `rules` (by id: pages, flags, minLeft), `hosts` (each exact host → its rule's id). A **baseline** also has
  `upstream` (the pinned files its imported data came from, MIT only), `aliases` (groups `{s}` shared, `{f, t}` one way,
  2 to 64 hosts each) and `appends`. A **live** bundle has none of these three: one that carries any of them, even an
  empty list, is refused whole with its own reason ("a live bundle carries no …: they ship with releases only"). A live
  bundle must name its source (an https address, never empty), and when it is in effect it replaces the baseline's rules
  and hosts whole (`inEffect`): a wrong rule is taken out by leaving it out. It is in effect only when its version is
  above the baseline's: a release that brings a newer baseline wins over an older download.
- **Paths** are literal prefixes of `location.pathname` as the browser gives it: printable ASCII without what a browser
  always percent-encodes in a path (space, `"`, `#`, `<`, `>`, `?`, `\`, `^`, backtick, `{`, `}`) and without `*`, which
  a contributor could take for a wildcard.
- **Hosts** everywhere are host names as the URL parser writes them (`canonicalHost(h) === h`), of two labels or more,
  never an IP address or a shared suffix (`isShared`), and never under `.test`, `.example`, `.invalid` or `.localhost`
  unless the caller asks (`allowReserved`, for the e2e build's test rules in AF3-3a).
- **The selector grammar**: compound selectors joined by exactly one space or ` > ` (`a>b` is refused), at most 8; a
  compound is an optional type and then any of one `#id`, `.class`, `[name]`, `[name="value"]`, `[name^="value"]`,
  `[name~="word"]`. Ids and classes are CSS identifiers without escapes (an optional `-`, a letter or `_`, then letters,
  digits, `_`, `-`): `#1a` and `.2fa`, which a browser's `matches()` refuses, are refused here; an id such as `:r1:` is
  `[id=":r1:"]`, a class such as `2fa-code` `[class~="2fa-code"]`. Values are printable ASCII without `"` or `\`; a word
  the same without spaces, not empty. No pseudo-classes, `:has()`, lists, `*`, `~` or `+` combinators.
- **The bundle's own consistency**: every host points at a rule of the same bundle (an own key: `constructor` or
  `__proto__` is no rule), every rule has a host, at most 16 hosts per rule, the licence is `AGPL-3.0-or-later`, plus
  `AND MIT` exactly when `upstream` is not empty, aliases and appends only with an upstream file named, and a `source`
  that is empty (a baseline of a build that names no repository) or an https address with a host of two labels or more
  and no user name or password. **Which tag it names is not checked here**: its form is the forge's (`/tree/<tag>/` is
  GitHub's, `/-/tree/<tag>/` GitLab's, `/src/tag/<tag>/` Gitea's), and the template that puts the version in it lives with
  the repository's address (`extension/scripts/repo-url.mjs`, AF3-1b).
- **Alias matching**: a host is at a member when the two are equal once one leading `www.` is taken off each (Apple
  has three `www.` members: `www.seek.com.au`, `www.seek.co.nz`, `www.vistaprint.ca`; "Remember" stores `seek.com.au` for
  `www.seek.com.au`, site-domains.ts `preferredChoice`); a shared group offers every
  other member, a one-way group offers its `f` hosts on its `t` hosts only (Apple's `twitter.com → x.com`: an account
  registered for twitter.com is offered on x.com, not the reverse); an account is offered when it is not registered for
  the page and one of its usable registered sites is at an offered member, and the answer names that site. Never on an
  IP address.
- **The hint** names the host the rule was found for (the top page's) and nothing else, so the finder applies a rule in
  the top page and its same-host frames only. **The appends** cover their host and its subdomains on label boundaries
  (E*TRADE signs in on `us.etrade.com`).

### 1.3 Decisions and deviations from the plan, with reasons

| # | Decision | Why |
| --- | --- | --- |
| A1-1 | `upstream` entries are per file, with a `path` (the plan's §4.2 listed `{id, url, commit, sha256, license}`) | One SHA-256 needs one file; Apple's data comes from two files of one commit |
| A1-2 | `validate` returns `rules` and `hosts` as `Map`s, with `hostsOf` (each rule's hosts) worked out once | A lookup by a page's host can then never reach `Object.prototype`; a rule's hosts are what the 16-host bound counts, and what the bundler and the tools list |
| A1-3 | A site rule file may say `flags: []`; a bundle's rule says `flags` only when it has one (`["sent"]`) | Contributors may write an empty list; the bundle is generated and keeps the shortest form |
| A1-4 | `alias.ts` imports `match.ts` (`matchTier`, `usableDomain`, `isIpHost`); `format.ts` and `lookup.ts` import nothing at run time | Only the checker and the lookup are needed by `rules/tools/` (AF3-1b), which loads them through Node's type stripping; the alias rule's "not registered for the page" is match.ts's own rule and must not be a copy |
| A1-5 | `format.ts` repeats match.ts's IP test (`isIp`) instead of taking it as a third check | As `site-domains.ts` does, so its callers pass the two checks the plan names; a test checks that the two agree on canonical IP hosts |
| A1-6 | The manifest's schema (signed bundles) is not here | It belongs to AF3-U1 with its checks |
| A1-7 | Duplicate keys in a bundle's JSON text cannot be seen after `JSON.parse` (the last one wins) | A host claimed by two rules is caught where the rules are separate files: the bundler (AF3-1b) |
| A1-8 | The schemas are hand-written documents, held to the constants by a test, not generated, and no JSON Schema library is added | As the plugin SDK's schema; the test compares fields, required lists, enums, bounds and the selector pattern without one |
| A1-9 | **A live bundle replaces the baseline's rules whole** (the r2 recheck's R4-1), not host by host, and has no tombstones | Taking a wrong rule out between releases is the updater's main use; host-by-host replacement could not do it without a rule built to match nothing. Whole replacement keeps one bundle in effect (one thing to audit), needs no second way to say "absent", and costs little: a live bundle holds every rule, tens of KB, under its 512 KiB cap, and its version is always above the baseline's. Aliases and appends are not part of it: they always come from the baseline |
| A1-10 | Selector identifiers follow CSS (R4-2), the combinators' spacing is exact, and `[name~="word"]` is allowed | So the checker never passes what `matches()` throws on; a class that starts with a digit can still be named. The finder will still catch a throwing entry and skip it (AF3-2) |
| A1-11 | `atMember` takes one leading `www.` off both sides (R4-3) | Apple's three `www.` members against what "Remember" stores |
| A1-12 | `source`'s form is not checked beyond "https", and a live bundle must have one (R4-5) | The tag's place in the address differs by forge; a live bundle's rules may be outside contributions, for which AGPL asks the source's place |
| A1-13 | `hintOf`'s `d` is the found host alone (R4-6) | The lookup is by the top page's host only; listing the rule's other hosts would let a frame of another of them use a rule found for this page |
| A1-14 | `appendsOn` covers subdomains (R4-4) | It is one note on a page already registered; the sites sign in on subdomains |
| A1-15 | The checker's "plain object" helper is `plain()`, not `record()` | `budget3-rules.test.ts` holds every `record(…)` call in `src/` to the security record's kinds |

### 1.4 What a schema cannot say, and only `format.ts` checks

Hosts in the URL parser's form, shared suffixes and reserved names; one `#id` per compound; `verified` not after today;
a fixture under its own rule's folder; hosts pointing at rules of the same bundle, every rule pointed at, at most 16
hosts per rule; the licence following `upstream`; a source's port in range (the URL parser); an upstream path without
`.` or `..` segments; aliases and appends only with an upstream file; at most 64 hosts in a one-way group and none twice.
Each schema's `description` says so; `rules-contract.test.ts` lists each of these differences by its samples (§1.7 S1).
Neither the schemas nor `format.ts` can see a JSON key written twice (A1-7): that is checked on the raw text, by the
bundler (AF3-1b) and by the signing tool (AF3-U1).

### 1.5 Tests

- `rules-format.test.ts`: a site rule read in full and normalised; an unknown field refused at every level (the file, a
  page; a bundle, its rule, a page of it, an upstream entry, each kind of alias group; `__proto__` as JSON makes it; a
  site rule's `aliases` or `twoFactorPage`), every missing field, a wrong type in every field, a non-plain object; every
  bound (hosts, pages, path, segments, fill, flags, minLeft, id, note, fixtures, verified); hosts (not canonical, IP,
  single label, shared, reserved with and without `allowReserved`); the selector grammar (24 accepted, 50 refused); the
  baseline's header, licence, source, host and rule links, alias groups, appends and upstream entries; the live bundle:
  read, and refused whole with any of `aliases`, `appends`, `upstream` (with data and empty), and never read as the
  other kind.
- `rules-alias.test.ts`: six real Apple entries in the bundle's form: one-way both ways (twitter.com → x.com,
  discordapp.com → discord.com, wikia → fandom), shared both ways (chatgpt.com, openai.com, chat.com), `www.` only on
  either side, no user-content subdomain (`community.fandom.com`), a subdomain or parent of an account's site not
  counted, an account registered for the page never offered (and nothing offered is ever `registered`), stored sites
  that are not usable ignored, IP addresses and empty input; and Apple's `www.` members: an account remembered as
  `seek.com.au` offered on `login.seek.com`, `vistaprint.ca` on `account.vistaprint.com`, one way only.
- `rules-lookup.test.ts`: the live bundle in effect whole (a rule left out is gone, one renamed is the live one),
  exact hosts, `www.` apart, no answer for `constructor`, the hint's fields and strategies and its one host, the hint a
  copy, `minLeft`, the appends with their subdomains on label boundaries.
- `rules-contract.test.ts`: `format.ts` and `lookup.ts` have no run-time import (`alias.ts` only `../match`); a child
  `node --experimental-strip-types` loads them with `match.ts` and `site-domains.ts` and checks a live bundle, a shared
  host and a live bundle with aliases, as `rules/tools/` will; the three schemas: 2020-12, their ids, closed everywhere,
  the same fields, enums, constants and bounds as `SHAPE` and `LIMITS`, and a selector pattern that agrees with
  `selectorOk` on 22 samples (except one `#id` per compound, which only the checker holds); `REUSE.toml` gives each
  schema CC0-1.0 by its own last-match rule and the checker MPL-2.0; `LICENSE.md`'s contract-data row names them.

**Mutants** (hand-made, one at a time, against the four rules test files; each file restored byte for byte after each run,
SHA-256 checked; the harness is not in the tree, CONTRIBUTING rule 4): **25 mutants, 25 killed**, and the no-change
baseline Z0 passed. The closed check (unknown fields kept: M01); M1, a live bundle with aliases, appends or upstream read
(M02); the selector's identifiers (M03), a `~` combinator (M04), an empty `~=` word (M21), two ids in a compound (M22);
one-way groups read as shared (M05), any subdomain of a member (M06), `www.` taken off one side only, r2's rule (M06b), an
account registered for the page offered (M07); one box with `chars` (M08); shared suffixes (M09), an inherited name as a
rule id (M10), reserved names by default (M11); the version unbounded (M12); a fixture in another rule's folder (M13); a
host twice in a rule (M14); a live bundle without a source (M15); aliases without an upstream file (M16); the baseline in
effect over a live bundle (M17); a subdomain given its parent's rule (M18); the hint naming more than its host (M19);
appends without label boundaries (M20); objects that are not plain (M23); `verified` in the future (M24). Each was
killed by the behaviour test written for it (the log names them).

### 1.6 Checks

In a worktree of `bbac7ea` under the project's scratch directory, every run through the shared runner (`nice -n 19`, the
shared lock) after the one-minute load was under 24; vitest with `--maxWorkers=2`. The main working tree was not touched.

| Check | Result |
| --- | --- |
| `python3 scripts/messages.py` | no change in `_locales/` or `catalogs/` (this patch adds no text) |
| `npm run typecheck` | clean |
| prod build + `check-dist`; dev build + `check-dist --dev`; e2e build + `check-dist --e2e` | all OK |
| **The store build against `bbac7ea`'s** (a separate worktree of `bbac7ea`, built the same way) | `diff -r` empty, the SHA-256 list of its 139 files identical: byte for byte the same |
| Budgets (prod) | unchanged: popup 59,099 of 61,440 B, side panel 61,339 of 63,488 B, worker 101,505 of 106,496 B, finder 6,087 of 8,192 B |
| `npm run format:check`, `npm run notices:check` | clean; the notices are up to date (nothing new ships) |
| REUSE | no `reuse` tool here (CI runs `fsfe/reuse-action`); `rules-contract.test.ts` applies REUSE.toml's own last-match rule to the new paths |
| The rules tests and `budget3-rules` | 5 files, 67 tests passed |
| Full unit run | 341 files, 5,474 passed, 4 expected fail, 1 skipped |

**Found by the first full run, and fixed:** `budget3-rules.test.ts` reads every `record(…)` call in `src/` as one of the
security record's, and `format.ts` had a helper of that name; it is now `plain(…)`. That run also reported one uncaught
error from `autofill4-surface.test.ts` (`Fill.tsx` `focusFill`'s retry timer firing after that test's page was torn down,
under a load of about 30): it is not this patch's (no Fill code changed) and did not occur in the second full run, after
the rename. The rename came after the messages, notices, dev and e2e checks; it is in a module nothing imports, and the
prod build and its comparison were made again after it.

### 1.7 Round 2: the review's findings, and what was done

| Finding | Fix | Test | Mutant(s) |
| --- | --- | --- | --- |
| **S1** the contract test held the schemas' fields, enums and bounds but not their patterns or the page's if/then; four schema mutants survived (the live path allowing `?#`, the live source allowing `""`, capitals in the baseline's hosts, one box allowed `chars` in the baseline) | The schemas' path and source patterns follow the checker (below) | `rules-contract.test.ts`: for every patterned field (page path, host, date, id, `source`, each upstream field, fixture, note) a table of samples judged by the schema's `RegExp(pattern, "u")` with its lengths and by `validate` on a minimal object, in every schema that has the field; equal, except the samples listed as the checker's alone (an IP address, a shared suffix, a reserved name, invalid punycode, a calendar date, a port out of range, a fixture in another rule's folder, `.`/`..` in an upstream path). The page's if/then in all three schemas, structurally and by behaviour; the host, date, id, path and selector patterns the same in all three | the review's S01 to S04, killed (and S05, the id with capitals, killed as before) |
| **S2** `inEffect` was `live ?? baseline`: a live bundle older than the baseline won | `inEffect` takes a bundle of the right kind only, and the live one only when its version is above the baseline's; expiry stays the updater's | `rules-lookup.test.ts`: live v2 with baseline v5 gives the baseline (and its rule); equal versions give the baseline; a baseline passed as the live one, or a live one as the baseline, is never used | V01 (the version comparison removed), V02 (the kinds unchecked) |
| N1 the unknown field's name went whole into the reason (1 MB in, 1 MB out) | cut to 80 characters, as everywhere else | a 1,000,000-character key: the reason is under 120 characters | V03 |
| N2 §1.4 said the source's tag was checked | §1.2 and §1.4 now say it is not, and where the template is | — | — |
| N3 paths took characters a pathname never holds, and `*` | refused: space, `"`, `#`, `<`, `>`, `?`, `\`, `^`, backtick, `{`, `}`, `*` (the schemas' pattern the same) | each of them refused; a path with every other kind of character accepted; the parity table | V04 |
| N4 duplicate JSON keys | stated (§1.4): on the raw text, in the bundler (AF3-1b) and the signing tool (AF3-U1) | AF3-1b's | — |
| N5 `appendsOn` given a live bundle answered `false` | it throws: only a baseline has appends | `rules-lookup.test.ts` | V05 |
| N6 `source` was checked by its prefix only (`https://x`, `https:///` passed) | an https address with a host of two labels or more, no user name or password, parsed by `URL` (a port out of range refused); the schemas' pattern the same, except the port's range | `rules-format.test.ts` and the parity table | V06 |

**Round 2's mutants** (one at a time, against the four rules test files, each file restored byte for byte, SHA-256 checked):
**35 mutants, 35 killed**, and the no-change baseline Z0 passed. They are round 1's 25 on the round-2 code (M17, the
version-less `inEffect`, gave way to V01 and V02), the review's five schema mutants (S01: the live schema's path allowing
`?` and `#`, written against the new path pattern; S02: the live schema's source allowing `""`; S03: capitals in the
baseline schema's hosts; S04: one box allowed `chars` in the baseline schema; S05: capitals in the live schema's ids) and
round 2's own: V01 (a live bundle in effect whatever its version), V02 (the kinds unchecked), V03 (the whole unknown name
in the reason), V04 (the old path rule), V05 (`appendsOn` answering `false` for a live bundle), V06 (`source` checked by
its prefix only).

### 1.8 Round 2's checks

In a worktree of `bbac7ea` with round 1 applied, every run through the shared runner after the one-minute load was under 24.

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| The rules tests and `budget3-rules` | 5 files, 82 tests passed |
| Mutants | 35 of 35 killed, Z0 passed |
| **The store build against `bbac7ea`'s** | the SHA-256 list of its 139 files identical to the pristine build's (§1.6): byte for byte the same; budgets unchanged |
| `npm run format:check`, `npm run notices:check` | clean; up to date |
| Full unit run | 341 files, 5,489 passed, 4 expected fail, 1 skipped |

`scripts/messages.py`, and the dev and e2e builds, were not run again: round 2 adds no text and touches only modules nothing
imports, the schemas and tests.

### 1.9 What it leaves for the next patches

- **AF3-1b**: `rules/` itself (README, NOTICE, CONTRIBUTING, VERSION, the hash-pinned Apple files and `SOURCES.json`, the
  exclusion list, `tools/import.mjs`, `tools/bundle.mjs` with `--check`, `tools/worklist.mjs`, `build/baseline.json`),
  `scripts/repo-url.mjs`, the rest of `REUSE.toml` (`rules/**` AGPL, `rules/**/*.md` CC-BY, `rules/build/**` `AGPL-3.0-or-later
  AND MIT`, `rules/upstream/apple/**` MIT last, as an override), `LICENSE.md`'s rows for `rules/`, `.prettierignore`.
  `contract/rules/1/` holds schemas only: a document added there would take the contract data's CC0 by REUSE.toml's
  order, as one in `contract/plugin-sdk/1/` would.
- **AF3-2**: the finder's side of the hint (its `Hint` type is the one `lookup.ts` makes), the token kinds, the boost
  conditions and the every-box checks.
- **AF3-3a, AF3-3b, AF3-4**: the first importers of these modules (the package's reader, the Fill paths, the alias rows).

## 2. AF3-1b: `rules/` and its licences

**Nothing in `extension/` reads `rules/` yet.** The store build is byte for byte `bbac7ea`'s (§2.5, and §2.7 for round 2). The bundle is built
and committed, and checked against its sources; AF3-3a puts it in the package.

### 2.1 What was built

| Part | Where | Licence |
| --- | --- | --- |
| Apple's password-manager-resources files, verbatim: `quirks/shared-credentials.json`, `quirks/websites-that-append-2fa-to-password.json`, `LICENSE.md`, at commit `e6a7cf40fe91aa8897b1be07b0ab416332c31488` | `rules/upstream/apple/` | MIT, Apple's (REUSE override, last) |
| Their pins: source, address, commit, path, place, use, SHA-256, licence, date fetched | `rules/upstream/SOURCES.json` | AGPL-3.0-or-later |
| What is taken out of them (empty) | `rules/upstream/exclude.json` | AGPL-3.0-or-later |
| The next bundle's version (a counter) and date | `rules/version.json` | AGPL-3.0-or-later |
| The bundle, generated and committed | `rules/build/baseline.json` | AGPL-3.0-or-later AND MIT, both copyright lines |
| The tools: `upstream.mjs` (the sources' table, the pins' and shapes' checks), `import.mjs` (verify by default; `fetch <source> <commit>` by hand), `bundle.mjs` (the bundle, `--check`, `--report`), `worklist.mjs` (2fa.directory, printed only); each refuses any other command line (§2.6) | `rules/tools/` | AGPL-3.0-or-later |
| What the licences cover, the project's reading, Apple's notice | `rules/NOTICE` | AGPL-3.0-or-later |
| For contributors and forks | `rules/README.md`, `rules/CONTRIBUTING.md` | CC-BY-4.0 |
| The repository's address (empty) and the rules' source template made from it | `extension/scripts/repo-url.mjs` (+ `.d.mts`) | MPL-2.0 |
| `REUSE.toml` (four entries), `LICENSE.md` (three rows, one reason), `.prettierignore` (`rules/build/`, `rules/upstream/`) | the repository's root | — |
| Tests | `extension/test/unit/rules-tools.test.ts`; `plugin-sdk-package.test.ts`'s REUSE line; REUSE as reuse-tool reads it, `test/helpers/reuse-toml.ts` (round 2), also used by `rules-contract.test.ts` | MPL-2.0 |

### 2.2 How a bundle is made

`bundle.mjs` reads `version.json`, every `sites/<id>.json` (none yet), the upstream files through `upstream.mjs`, and
`exclude.json`; writes `{format, kind: "baseline", schema, version, created, license, source, upstream, rules, hosts,
aliases, appends}` with two-space indentation and a final newline; and before it writes anything, checks the whole bundle
with the extension's own checker (`format.ts validate(…, "baseline", …)`). No clock, path or machine goes into it, so the
same sources give the same bytes; `--check` compares them with the committed file and fails on any difference.

- **Upstream** (`upstream.mjs`): the sources and their files are a table in code; `SOURCES.json` pins exactly those files,
  each field checked (the place, path, use, address and licence must be the table's; commit 40 hex digits; SHA-256 64),
  no other file and none missing. Every read hashes the vendored bytes and refuses on any difference from the pin, then
  checks the shape exactly as Apple's own schema has it (`{shared}` or `{from, to, fromDomainsAreObsoleted?}`, lists of
  names; a list of names; the MIT notice), refusing any other.
- **The transform**: each Apple entry becomes `{s}` or `{f, t}` with its hosts sorted and deduplicated, the groups sorted;
  a name Sixkey would not accept as a host (not as the URL parser writes it, an IP address, a single label, a shared
  suffix, a reserved name) is dropped, and so is a group left too small; `--report` lists both. Nothing is dropped from
  Apple's files today (a test pins it): 131 groups, 3 appends.
- **A key written twice** in any JSON file the tools read (a site rule, `version.json`, `exclude.json`, `SOURCES.json`,
  Apple's files) is refused: the keys are found on the raw text and compared as JSON reads them, escapes decoded
  (`upstream.mjs repeatedKey`): `JSON.parse` keeps the last one and nothing after it can see the first (the AF3-1a review's N4; the signing tool will do the same, AF3-U1).
- **Exclusions**: exactly `{hosts, groupsWith}`: hosts taken out of every group and of the appends, groups taken out
  whole. It cannot add: there is no field for that, and an entry that takes nothing out is refused, so the list cannot
  go stale.
- **Site rules**: each file is checked by `format.ts`, named after its id, with each fixture present under `fixtures/`;
  a host may be claimed by one file only (format.ts cannot see duplicate keys after `JSON.parse`, A1-7).
- **The source**: `repo-url.mjs`'s `RULES_SOURCE` with `{version}` filled in, `""` while it is empty (the format allows
  that for a baseline; the store package will refuse it, AF3-3a).

### 2.3 Decisions and deviations, with reasons

| # | Decision | Why |
| --- | --- | --- |
| B-1 | `rules/version.json` (`{version, created}`), not the plan's `rules/VERSION` | Two values, read as JSON with a closed check; a bare file would need a format of its own |
| B-2 | `SOURCES.json` has one entry per file, with its `use` (`aliases`, `appends`, `licence`); the bundle's `upstream` names the data files only | One hash per file; the licence text is pinned too, but it is no data of the bundle (A1-1) |
| B-3 | Apple's files were fetched again at the pinned commit, into a new empty folder, and compared by SHA-256 with the copies the plan measured before they were vendored | So what is vendored is exactly that commit's, not whatever `main` was at the first download |
| B-4 | The bundle is written with two-space indentation | It is the file reviewers read when data changes; it is 19,864 B raw, 3,756 B gzipped; AF3-3a may write a compact copy into the package |
| B-5 | `sites/` and `fixtures/` do not exist yet | There is no rule yet (Q4), and git keeps no empty folder; the tools treat a missing `sites/` as no rules |
| B-6 | `repo-url.mjs` holds `REPO_URL`, empty, and `RULES_SOURCE`, made from it (round 2, N9); nothing refuses on them yet | The maintainers' brief: the package gate is AF3-3a's |
| B-7 | The tools need Node 22.18 or later, or `--experimental-strip-types` before it; the tests pass the flag | They load `format.ts`, `match.ts` and `site-domains.ts` as they are (C10) |
| B-8 | `REUSE.toml`: `rules/**` after the component entries; `rules/**/*.md` in the "documents inside the component folders" entry, which `plugin-sdk-package.test.ts` pins by its exact line, so that test's line changed with it; `rules/build/**` after the contract data; Apple's files last, as an override | REUSE.toml's last-match rule (the review's S5). Round 1 also listed `rules/*.md`, not knowing whether `**/` matches no folder at all; it does (the REUSE specification: "`**` and `**/` match everything including forward slashes"; reuse-tool writes no `/` after `**`), so round 2 dropped it (§2.6) |
| B-9 | `bundle.mjs`'s host filter repeats `format.ts`'s host rules from the same functions, and the whole bundle is checked by `format.ts` after it | A drift between the two fails the build of the bundle instead of shipping |
| B-10 | `worklist.mjs` prints the domains and the attribution and writes nothing; `--from` reads a saved copy | C7 and Q2: 2fa.directory is a maintainer's worklist only |
| B-11 | Repeated keys are found by a small scanner of the raw text (strings and escapes read as JSON reads them), after `JSON.parse` has accepted the text | No JSON parser of Node's reports them; the scanner needs only to find keys, never to parse values |
| B-12 | Rebased onto AF3-1a round 2 (r2): nothing in the tools changed for it | Its changes are in the checker and the lookups; the tools call `validate` as before |

### 2.4 Tests

`rules-tools.test.ts` runs the tools as a maintainer does (`node --experimental-strip-types`) on copies of `rules/` in a
temporary folder; nothing in it reaches the network.

- The committed bundle: `--check` passes; it passes the extension's checker as a baseline; its header, licence, source,
  upstream field (the pinned data files) and counts; deterministic (two builds and the committed file, the same bytes);
  `--check` fails on another version and on a changed byte; Apple's one-way and shared groups as written, hosts and
  groups sorted, every host one of Apple's; the report: nothing dropped.
- Upstream: verify passes; a changed byte in any of the three files refused by `import.mjs` and by the bundler (`hash
  mismatch`); eight shapes refused even when pinned (an extra field, a non-boolean flag, a missing `to`, an empty list, an
  object for a list, not JSON, an object of hosts, a text that is not the MIT notice); pins: another file, another place,
  another path, another address, another licence, a short commit, a missing pin, an extra field, an entry twice; a
  shared suffix, an IP address and a non-canonical name dropped and reported, a group left with one host dropped.
- A key written twice: refused in a site rule, `version.json`, `exclude.json`, `SOURCES.json` and Apple's file (by the
  bundler and by `import.mjs`); a selector, a note or an escaped quote that mentions a key is no repeated key.
- Exclusions: hosts and whole groups out (the bundle without them a subset of the full one), appends out; an `add`
  field, a missing field, a list that is not a list, an entry that takes nothing out: refused.
- Site rules: bundled with pages, flags and minLeft, each host to its rule, the result passing the checker; refused by the
  checker's own reason, a file not named after its id, a bad file name, a missing fixture, a shared host; a host claimed
  by two files.
- The worklist: no flag, no network (exit 2); `--from` lists the sites without a rule, names 2fa.directory, writes
  nothing; a wrong shape refused; only `import.mjs fetch` and `worklist.mjs --fetch` contain a `fetch`.
- `repo-url.mjs`: empty, so the source is empty; the template filled for two forges; bad templates refused.
- Licences: REUSE.toml's last-match rule gives every file under `rules/` and each kind of path its licence (AGPL, CC-BY
  for documents, AGPL AND MIT with both copyright lines for the bundle, MIT for Apple's files, `LICENSE.md` included);
  `NOTICE` carries Apple's notice word for word; `.prettierignore` and `LICENSE.md`'s rows.

**Mutants** (hand-made, one at a time, against `rules-tools.test.ts`; every file restored byte for byte, SHA-256 checked;
the harness is not in the tree): **16 mutants, 16 killed**, and the no-change baseline Z0 passed. The upstream hash check
gone (B01); unknown Apple fields accepted (B02); a pin for a file the tools do not list (B03); a pin that moves a file
(B04); other fields in `exclude.json` (B05); an exclusion that takes nothing out (B06); `--check` always passing (B07);
groups unsorted (B08); one-way groups written the other way (B09); a host claimed by two rule files (B10); a missing
fixture (B11); a rule file not named after its id (B12); shared suffixes kept from upstream (B13); the licence text not
checked (B14); the worklist reaching the network without `--fetch` (B15); a key written twice not seen (B16).

### 2.5 Checks

In a worktree of `bbac7ea` with AF3-1a round 2 applied (the tree of `05f782f`), every run through the shared runner after
the one-minute load was under 24; vitest with `--maxWorkers=2`. The main working tree was not touched.

| Check | Result |
| --- | --- |
| `bundle.mjs --check --report`; `import.mjs` (verify) | up to date; 3 upstream files matching their pins and shapes; nothing dropped |
| `python3 scripts/messages.py` | no change in `_locales/` or `catalogs/` |
| `npm run typecheck` | clean |
| prod, dev and e2e builds with `check-dist` | all OK |
| **The store build against `bbac7ea`'s** | the SHA-256 list of its 139 files identical to that of a pristine `bbac7ea` build (AF3-1a's reference): byte for byte the same; budgets unchanged |
| `npm run format:check`, `npm run notices:check` | clean; the notices are up to date (nothing new ships) |
| REUSE | no `reuse` tool here (CI runs `fsfe/reuse-action`); `rules-tools.test.ts` applies REUSE.toml's last-match rule to every file under `rules/` and to each kind of path (B-8 on `**/`) |
| The rules tests, `plugin-sdk-package` and `budget3-rules` | 7 files, 124 tests passed |
| Full unit run | 342 files, 5,513 passed, 4 expected fail, 1 skipped |

### 2.6 Round 2: the review (修后合入, no MUST)

`REVIEW-AF3-1b.md` found three SHOULDs and nine NITs. All are fixed in this round, the whole patch again against
`05f782f`.

| Finding | What changed | Test and mutant |
| --- | --- | --- |
| **S1** `import.mjs` without `--root` dropped its first word, so README's `fetch apple <commit>` failed and a misspelt command ran the check, exit 0 | `parseArgs`: `[verify]` or `fetch <source> <commit>`, `--root <dir>` once; anything else prints the usage, exit 2. `fetch` refuses an unknown source (an own key of the table: `__proto__` is none) and a commit that is not 40 lower-case hex digits before anything is read or sent | the command lines without `--root` (README's form) and with it; R01 (round 1's bug back), R02, R03 |
| **S2** `fetch` had no test | `rules-tools.test.ts` runs `import.mjs fetch` against a fake upstream: an HTTP server on 127.0.0.1 in the test, and a module preloaded into the tool (`--import`) that sends its requests there instead of `raw.githubusercontent.com`, made by the real `fetch` with the tool's own options, and logs those options. Every file is downloaded and its shape checked before the first is written (round 1 already; now pinned) | written exactly as served, each pin's commit, SHA-256 and date, the other pin fields kept, then verified; GET, `credentials: "omit"`, `redirect: "error"`, a time limit; a redirect refused and its target never asked for; a bad first file stops at one request, a bad last one (and a key written twice) writes nothing; HTTP 404 writes nothing; a bad commit asks for nothing. The reviewer's T09 and T10, and T10b (each file written as it arrives), R10 to R12 |
| **S3** backstops unproven | tests only | 2,001 groups pass the transform and are refused by the final check of the whole bundle, nothing written (2,000 pass); `"\u0073hared"` beside `"shared"` is the same key twice; groups of 65 hosts (shared, and one-way) and a host on both sides dropped and listed, a group of 64 kept. T01, T07, T08, T15 |
| N1 `bundle.mjs` took `check` or `-check` as nothing and wrote the bundle | the same strict command line (`--check`, `--report`, `--root`, `--out`, each once), usage and exit 2, nothing written | R04, R05 |
| N2 `.DS_Store` in `sites/` refused the build | names starting with `.` are skipped; any other stray file is still refused | R06 |
| N3 a punycode look-alike in Apple's file passes silently | `--report` gains `idn`: every upstream name with an `xn--` label or a non-ASCII character, kept or dropped; README's re-import step says to read it | R07, R08 |
| N4 a raw address serves a fork's commit under the parent's name | `fetch` says to check the commit is on upstream's own `main`, and how (`git merge-base --is-ancestor <commit> origin/main` in a clone of upstream); README's step 1 says so | the message is pinned |
| N5 the size cap was checked after reading everything; the worklist had none | `upstream.mjs readCapped`: refused at once on a Content-Length over the cap, else counted as the bytes arrive, and leaving the loop cancels the body (2 MiB per upstream file, 16 MiB for the worklist) | a 64 MiB body sent in chunks without a length: refused, and the server had sent under 16 MiB when the tool hung up; a declared 2 MiB + 1; R09 |
| N6 the tests' REUSE reading took `**/` as at least one folder | one helper for both tests, a transcription of reuse-tool's glob translation (`test/helpers/reuse-toml.ts`); `rules/*.md` dropped from `REUSE.toml` as redundant (`rules/**/*.md` matches `rules/README.md`); `extension/README.md` and `api/server/README.md` pinned as CC-BY | fourteen glob cases; R14, R15 (`rules/**/*.md` dropped too: the documents would be AGPL) |
| N7 small gaps | tests: a value equal to a later key is no repeated key (T02); a pin's date and a short SHA-256 (T04); `--check` on a trailing newline, a leading space, a missing final newline (T06); the worklist prints only `[a-z0-9.-]` names with a dot (T12) and quotes a refused name as JSON writes it, so a control character reaches the terminal escaped; it takes exactly one of `--from` and `--fetch` | T02, T04, T06, T12, R16, R17 |
| N8 README and these notes said `fetch apple <commit>` worked | it does now; README's re-import is four steps | — |
| N9 `REPO_URL` and `RULES_SOURCE` could disagree | `RULES_SOURCE` is made from `REPO_URL` and `RULES_AT_TAG` (GitHub's `/tree/rules-v{version}/rules`), `""` while `REPO_URL` is | the definition pinned; R13 |

**Mutants of round 2**: round 1's 16 (B01 to B16), the reviewer's 16 (T01 to T16) and T10b, and 17 new (R01 to R17),
each alone against `rules-tools.test.ts` and `rules-contract.test.ts`, every file restored byte for byte: see §2.7.

### 2.7 Checks of round 2

In a worktree of `05f782f` with round 1 applied and changed in place, every run through the shared runner after the
one-minute load was under 24; vitest with `--maxWorkers=2`. The main working tree was not touched.

| Check | Result |
| --- | --- |
| Mutants (§2.6) | **50 of 50 killed**, Z0 passed; every file restored byte for byte (SHA-256) |
| `rules-tools.test.ts` | 41 tests (24 in round 1), among them six against the fake upstream |
| `bundle.mjs --check --report`; `import.mjs` | up to date, nothing dropped, `idn` empty; 3 upstream files matching their pins and shapes |
| `npm run typecheck` | clean |
| The rules tests, `plugin-sdk-package` and `budget3-rules` | 7 files, 141 tests passed (124 in round 1) |
| `python3 scripts/messages.py` | no change |
| **The store build against `05f782f`'s** | the SHA-256 list of its 139 files identical to a pristine `05f782f` build's: byte for byte the same; budgets unchanged (finder 6,087 B) |
| `npm run format:check`, `npm run notices:check` | clean; up to date |
| Full unit run | 342 files, 5,530 passed, 4 expected fail, 1 skipped |
| The patch | applied to a clean `05f782f`, it gives the worktree's tree |

The dev and e2e builds were not run again: round 2 changes nothing under `extension/src/`.

### 2.8 What it leaves

- **AF3-2**: the finder's hint (independent of this patch).
- **AF3-3a**: `rules/build/baseline.json` and `rules/LICENSE.txt` (the AGPL and MIT texts with `NOTICE`) into every build,
  the package's refusal of an empty `source`, check-dist's rules for them, the notices section for Apple's data.
- **AF3-6**: the first `sites/` and `fixtures/`, from the owner's real-site checks.

## 3. AF3-2: the finder's hook

> **Round 2** (after the review, `REVIEW-AF3-2.md`, verdict "merge after fixes", one SHOULD): §3.7 lists its SHOULD and
> NITs, each with its fix, its test and its mutant. The rest of this section describes the code as it is now.

**The Fill paths look with `null` for now**: no rule reaches the finder until a later patch (AF3-3b) passes `hintOf`'s
output. With `null`, the finder reports what it reported before on every fixture page (§3.5); what changes for today's
users is §3.4.

### 3.1 What was built

| Part | Where |
| --- | --- |
| `inspect(hint?)`: the hint re-checked in the page (`readHint`: its shape and bounds, the selector grammar, the path rule), applied where `location.hostname` is its host and `location.pathname` starts with an entry's path; the boost conditions (`boostable`, `Scored.neg`); the token kinds; `Found.r`; the strategy per entry; every box of a group checked at the look and at the fill | `extension/src/inject/otp.ts` |
| The look passes its one argument on (`inspectStub(hint)`, `scan(tabId, hint = null)`, `args: [hint]`); `readInspected` accepts `r: 1` | `extension/src/platform/autofill.ts` |
| The look call as built: all frames, a function, exactly one argument; a call is told by its target (`files`, `documentIds`, neither) | `extension/scripts/check-dist.mjs` |
| Tests | `test/unit/rules-engine.test.ts` and `test/e2e/rules-engine.spec.ts` (new); the look's argument and the read-backs in `autofill1-source-rules`, `autofill1-check-dist`, `autofill1-platform` and `plugins-w1b-source-rules`; the fakes and probes of E-8 |

### 3.2 How the finder takes a hint

- **The argument tells the looks apart.** A look called with an argument, the hint or `null`, is a Fill path's (the popup,
  the side panel, the shortcut: `scan`); one with none is the content script's (`suggest-core.ts qualifies`). The finder
  reads `arguments.length`, and check-dist holds the Fill paths' look to exactly one argument.
- **Re-checked in the page** (`readHint`): exactly `{d, p, sent}`; `d` 1 to 16 strings of at most 253 characters; `p` 1 to
  8 entries of exactly `{at, sel, n, how}`, `at` a path as `format.ts` has it (at most 128), `sel` in the selector grammar
  (`selOk`, a copy of `format.ts selectorOk` that the unit test holds to it on its samples and on 20,000 generated
  strings), `n` 0 or 4 to 8, `how` 0, 1 or 2, and 0 for one box. Anything else: no hint, the heuristics alone.
- **Where**: `location.hostname` (without a final dot) one of `d`, which `hintOf` makes the top page's host alone (R4-6), so
  a rule applies in its host's top page and same-host frames only; `location.pathname` starting with the entry's `at`.
- **Matching**: each entry runs `el.matches(sel)` over the inputs the look already collected (at most 600, open shadow
  roots included) in a `try`: an entry whose selector throws is skipped, nothing else (R4-2). It counts its **usable**
  matches only (a hidden copy does not void it).
- **Boost conditions (S1)**: an entry is void whole if any of its usable matches has a veto, a hard negative (`neg`, new in
  `Scored`: the −60 signals, a negative name token or negative words) or is `type=password`. `n = 0`: exactly one match,
  not a box of a heuristic group. `n = N`: exactly N matches, in document order, on one line and of about one size
  (`oneRow`, the heuristic groups' own test, now a function of its own). **The group as the page names it** passes the
  same conditions too (round 2): its own score, its first box's features with the words two levels up (`groupFeat`, which
  the heuristic groups use as well), so boxes under "Card number" or "Phone number" are no rule's group even when each box
  alone says nothing. A match already named by an earlier entry voids the later one. What an entry names gets
  `RULE_BOOST` (100) on its score and the rule's `sent` flag.
- **Tokens (M2)**: one per first box **and kind**: `h` the heuristics', `r` a rule's (`ids: WeakMap<Element, {h?, r?}>`;
  `live: Map<token, {els, kind, how}>`). A look reports no heuristic candidate that shares a box with one of its rule
  entries. `of(el)` returns `h` tokens only. `Found.r` is `1` for a rule's entry and absent otherwise.
- **Who owns the `r` entries (R3-1)**: a look with an argument drops every `r` entry at its start and writes the ones it
  makes; a look without one never touches them, so a rule's group and its strategy survive any number of content-script
  looks between the Fill path's look and its fill. Every look drops the entries of which any box left the page.
- **The fill**: every box of the entry connected, usable, seen (`look`) and with no veto (before: the first box's veto
  only); for an `r` entry also no hard negative and no password box, each box, and the group's own score as at the look
  (round 2); an `h` entry with a box that lies in a live
  `r` entry of more than one box is refused (`gone`): a box a rule groups is never filled alone. The strategy is the
  entry's: 0 the heuristics' order (chars, then a paste), 1 chars only, 2 a paste first, then chars. `fill()` keeps its five
  arguments.

### 3.3 Decisions and deviations, with reasons

| # | Decision | Why |
| --- | --- | --- |
| E-1 | `Found.r` is `1` or absent, not the plan's `0 \| 1` | A look with `null` (or none) then reports exactly the objects it reported before, which §3.5 compares byte for byte; `readInspected` refuses any other value |
| E-2 | The finder keeps its own copy of the selector grammar and the path rule (`selOk`, `PATH_OK`) rather than importing `format.ts` | The finder is one classic script with no imports (check-dist); a test holds the copy to the original |
| E-3 | A heuristic group is no candidate when any of its boxes has a veto (at the look, as at the fill) | So the look never offers what the fill would refuse; S1 asks for every box at both |
| E-4 | `oneRow` is the heuristic groups' width and line test, factored out | A rule's group is held to the same test as a heuristic one (the plan: "groupsOf's checks without maxlength = 1") |
| E-5 | The rule entries are built before the heuristic candidates, and the look's time budget stops them like the rest | One budget for the look; a rule cannot make a look slower than the page's inputs allow |
| E-6 | `scan(tabId, hint = null)`: every caller passes no hint yet | The plan's order: AF3-3b wires `hintOf` into the Fill paths; a source test pins that every caller passes `tab.id` alone until then |
| E-7 | The M2 guard holds while the rule's entry is live: once its token is spent by a fill (or the next look with an argument drops it), the content script's look still sees a rule's first box as a box of its own, as it does today | The content script stays without rules (C4, deferred); the guard keeps a Fill path's group from being split between its look and its fill, which is what M2 is about |
| E-8 | The tests' fakes and probes of `chrome.scripting` told the fill from the look by `args` (six unit test files; `autofill1.spec.ts`'s call record for F6 and `visual-guard.spec.ts`'s stub); they now tell it by its target (`documentIds`), as check-dist does | The look has an argument too: the first e2e run's two F6 failures were that record calling the look a fill |
| E-9 | The finder takes the hint's type from `lookup.ts` (`import type`), which the build erases | One definition of the hint; the finder stays a script without imports (its source test reads it with types removed) |

### 3.4 What changes for today's users

The look passes `null`, so no rule applies. What does change, for a group of one-character boxes found by the heuristics:

- **At the fill**, every box is checked for a veto, not only the first. A group one of whose later boxes became a non-code
  box after the look (a `name`, `id` or `class` token `password`, `pin`, ...; an `autocomplete` such as `tel` or `cc-*`;
  captcha words next to it) is refused (`gone`) instead of filled.
- **At the look**, such a group is not offered (before: offered on its first box's score). A box cannot change its type
  into a vetoed one and stay in a group (the group takes text, tel, number and password boxes of one character only), so
  this is about names, `autocomplete` and the words around the later boxes.
- An entry is dropped at the next look when any of its boxes left the page, not only its first. Such an entry could never
  be filled (the fill wants every box connected); the content script's `of(el)` can no longer name it.

On the fixtures this changes nothing (§3.5): no fixture has a group with a vetoed later box, which is what a real page
would need to see a difference.

### 3.5 Tests and the proof of no change

- **Unit**, `rules-engine.test.ts` (9 tests): S1 with the real `score()`: seventeen boxes a rule must not promote (a
  neutral-named password box, an OTP box typed password, card number, CVV, phone, mobile, search, coupon, zip, amount, user
  name, e-mail, captcha, a password by name, `cc-number`, `type=search`), each of which the boost alone would lift over the
  threshold, none promoted; six others (a neutral box, `one-time-code`, a verification-code label, `token`, an SMS code, a
  tel box) each promoted; `neg` is the −60 signal exactly and the scores are what they were. The hint `hintOf` makes of a
  checked bundle is read whole, and its JSON copy too; thirty malformed hints are no hint, and the bounds themselves pass.
  The grammar's copy agrees with `format.ts selectorOk` on 33 samples and on 20,000 strings made of the grammar's own
  characters (fixed seed; over 500 of them accepted), the path rule on 20 paths.
- **Unit**, the tests that changed: the look passes `[null]`, or the hint it is given (`autofill1-platform`); `r` is kept
  when 1 and refused otherwise; the look's call and stub as written, every Fill path calling `scan(tab.id)` alone, every
  box's veto, a rule entry's own checks and the M2 guard before the first write, the read-backs (`autofill1-source-rules`,
  `plugins-w1b-source-rules`); a built look without its argument, with two, by frame ID, or to one document fails
  check-dist, prod and e2e (`autofill1-check-dist`); the fakes of six test files tell the fill by its target (E-8).
- **Chromium**, `rules-engine.spec.ts` (12 tests): M2 (a hint, then the content script's look with the focus in the first
  box: the first box's own token is refused, the rule's token fills all six with its paste); the three strategies on a
  page that takes only a paste; R3-1 (after another path, a seventh box, a box turned vetoed, or a look with `null`, the
  old group's token is gone and the first box fills as a box of its own; three content-script looks leave the rule's
  entry); S1 on real boxes with selectors that match them (`#p1`, `input[type="password"]`, `#c1`, `input[name=
  "cardNumber"]`, `input[type="tel"]`, search, coupon, user name, zip: nothing promoted and the look's answer unchanged;
  a neutral box promoted and filled); a rule group with a password box (no group at the look, refused when one is swapped
  in after it), a hard negative put on a later box after the look; a heuristic group's later box vetoed after the look
  (refused, then not offered, then back when the box is a code box again); the counts (two matches, a hidden copy, a box
  of a heuristic group, the group itself, wrong counts, not one line, not one size, an entry overlapping an earlier one);
  order, the `sent` flag, the path as a prefix, another host; a frame of the rule's host and one of another; a selector
  that throws; hints that are none.
- **The proof of no change** (a spec of its own, not in the tree: `logs/` holds it and its output): on each of the 41
  fixture pages of `test/helpers/autofill-pages.ts`, `05f782f`'s e2e finder and the new one, each in a fresh page: both
  looks (the new finder with no argument and with `null`), the fill of the best box, every input's value after it and the
  page's own event and box logs, compared with the tokens named by order of appearance. **41 of 41 the same**, among them
  every way a fill ends today (`single`, `chars`, `paste`, `digits`, `refused`, `moved`, no box).
- **Mutants** (one at a time; the engine built alone as the build builds it, byte for byte the same when unchanged; files
  restored byte for byte): **29 of 29 killed**. M2a one token per box (K01), M2b a content-script look resetting a rule's
  strategy (K02), M2c the guard gone (K03), `of()` naming a rule's entry (K04); R3-1 a content-script look dropping the
  rule's entries (K05), old rule entries kept (K06); S1 `neg` ignored (K07), password promoted (K08), a rule entry's first
  box checked only at the look (K09), the first box only at the fill, as `otp.ts:590` was (K10), a heuristic group's later
  boxes not checked at the look (K11); the counts: a heuristic group's box taken (K12), not one line or size (K13), every
  match counted (K14), an entry overlapping an earlier one (K23, killed once its test was added); a selector that throws
  (K15); host (K16), path (K17), strategy (K18), the hint not checked again (K19), heuristic candidates beside the rule's
  (K20), no boost (K21), `sent` ignored (K22); `readInspected` keeping any `r` (U01), the look passing no hint (U02), the
  stub dropping its argument (U03), the grammar loosened (U04), one box with a strategy (U05), check-dist taking a look
  without its argument (U06).

### 3.6 Checks

In a worktree of `05f782f`, moved onto `8261ceb` (AF3-1b round 2) once that was merged: every run through the shared runner
after the one-minute load was under 24; vitest with `--maxWorkers=2`, Playwright with one worker. The main working tree was
not touched.

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| The changed and nearby unit tests (14 files) | 359 passed |
| `python3 scripts/messages.py` | no change |
| prod, dev and e2e builds with `check-dist` | all OK |
| **The store build against `05f782f`'s** (which `8261ceb`'s is, byte for byte) | changed: `inject/otp.js` (13,068 → 15,552 B; **6,087 → 7,113 B gz of 8,192**), `sw.js` (365,547 → 365,633 B; 101,505 → 101,529 B gz of 106,496), `assets/Fill-*.js`, the lazy Fill chunk (15,735 → 15,792 B); eight files only renamed with it (the chunks and pages that name the Fill chunk: their bytes are the same once the names are); popup 59,099 → 59,103 B of 61,440, side panel 61,339 → 61,340 B of 63,488 |
| `rules-engine.spec.ts` | 12 passed |
| The proof of no change | 41 of 41 pages the same |
| Every `autofill*` spec (engine, 1, 2, 2-content, 2-sites, 4-page, 4b-measure, 4b-suggest) | 200 passed, 6 skipped (`autofill4b-measure`'s measurements, run only on request), 2 failed: F6's pair, on the test's own call record (E-8); with it fixed, `autofill1.spec.ts` again: 33 passed |
| `visual-guard.spec.ts` (its stub of `executeScript` told the fill by `args`) | 2 failed, and the same two with the same findings on a pristine `8261ceb` (the settings page's backup section: 1,667 and 1,620 px tall at 1400 × 900; a zh_CN check label of 662 × 24): the base's own, not this patch's; nothing else found |
| `perf.spec.ts`, `perf-idle.spec.ts`; W2B-04 | 2 passed; passed |
| Mutants | 29 of 29 killed (K23 on a second run, after the test it showed missing was added), Z0 passed |
| `npm run format:check`, `npm run notices:check` | clean; up to date |
| Full unit run | 343 files, 5,549 passed, 4 expected fail, 1 skipped; one uncaught error after `autofill4-surface.test.ts`'s tests had passed (`Fill.tsx focusFill`'s retry timer firing once that test's page was gone; seen once before, at `bbac7ea` during AF3-1a, without this patch); that file alone, three times: 16 passed, no error |
| The patch | applied to a clean `8261ceb`, it gives the worktree's tree |

### 3.7 Round 2: the review (修后合入, one SHOULD)

| Finding | What changed | Test and mutant |
| --- | --- | --- |
| **S1** a rule's group was judged box by box only: a group's own score reads the words two levels above its first box, and "Card number" or "Phone number" there (a −60 hard negative) did not stop a rule (measured by the review: 4 boxes under "Card number" offered at 55, 6 one-character boxes under "Phone number" at 60) | `ruleCands` also requires `boostable` of the group's own score (`groupFeat`); `fill()` checks it again for an `r` entry. `groupFeat` is the heuristic groups' own reading, factored out, so their score is what it was | `rules-engine.spec.ts`: the review's two pages (the heuristics offer nothing, and with a rule the look's answer is the same); a page naming the group "Phone number" after the look: refused at the fill, and filled once named as a code again. K24 (no group check at the look), K25 (none at the fill) |
| N1, N5 the budgets | the budget note in `check-dist.mjs` says the size; the finder is now 7,144 B gz of 8,192, **1,048 B left**; the renamed Fill chunk costs the counted popup **+4 B** and the side panel **+1 B** (the chunks that name it), which AF3-4t's headroom (C23: 286 B and 96 B) has to count | — |
| N2 the `pin` veto blocks PIN-style code widgets (Chakra's `chakra-pin-input`, Mantine's `PinInput`, `pin-1` to `pin-6`), which neither the heuristics nor a rule can then fill | not changed here: the plan's open item **C26** (its §10.2), with the options and a recommendation (a baseline rule only, never a live one, may name such a group, decided with the first real page, AF3-6) | — |
| N3 the wiring is AF3-3b's in the plan, not AF3-4's | these notes say AF3-3b | — |
| N4 a future `inspect(undefined)` would count as a Fill path's look | a source rule: the only `.inspect(...)` calls in `src/` are the content script's `finder.inspect()` and the Fill paths' stub `inspect(hint)`, and no other module names `inspect` | U07 (the content script passing `undefined`) |

**Mutants of round 2**: the 29 of round 1 again and three new (K24, K25, U07), one at a time as in §3.5: **32 of 32 killed, Z0 passed (the engine built alone byte for byte the full build's)**.

### 3.8 Checks of round 2

On `8261ceb` with round 1 applied and changed in place, every run through the shared runner after the one-minute load was
under 24; vitest with `--maxWorkers=2`, Playwright with one worker. The main working tree was not touched.

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| The changed and nearby unit tests (14 files) | 360 passed |
| prod and e2e builds with `check-dist` | OK |
| **The store build against `8261ceb`'s** | as round 1's (§3.6), with the finder 15,552 → 15,600 B (7,113 → **7,144 B gz of 8,192**); `sw.js` 101,529 B gz, popup 59,103 B, side panel 61,340 B: unchanged from round 1 |
| `rules-engine.spec.ts`, `autofill-engine.spec.ts` | 99 passed (`rules-engine` 13, with the new test; `autofill-engine` 86) |
| Mutants | 32 of 32 killed, Z0 passed (the engine built alone byte for byte the full build's) |
| `npm run format:check`, `npm run notices:check` | clean; up to date |
| Full unit run | 343 files, 5,550 passed, 4 expected fail, 1 skipped, no error |
| The patch | applied to a clean `8261ceb`, it gives the worktree's tree |

`visual-guard.spec.ts` was not run again: its two failures are the base's own (§3.6), being fixed apart. The other e2e
specs of §3.6 were not run again: round 2 changes the finder's rule path only, which no other spec reaches with a hint.

### 3.9 What it leaves

- **AF3-3a**: the bundle in the package and its reader. **AF3-3b**: `hintOf(ruleFor(host, inEffect(...)))` into `scan` in
  the three Fill paths, which turns the hook on; the source test of E-6 changes with it.
- **C26** (the plan's open item): the `pin` veto and PIN-style widgets.

## 4. AF3-3a: the baseline in the package

> **Round 2** (after the review, `REVIEW-AF3-3a.md`, verdict "fix and review again", two MUSTs, two SHOULDs, eight NITs):
> §4.7 lists each finding with its fix, its test and its mutant; §4.8 the checks. **Round 3** (after the second look,
> "merge after fixes", one SHOULD and one NIT): §4.9. The rest of this section describes the code as it is now; §4.5 and
> §4.6 are round 1's.

**Every build carries the bundle; nothing reads it yet.** `rules/build/baseline.json` is in every build as
`rules/baseline.json`, byte for byte, with `rules/LICENSE.txt` beside it. The reader exists and is tested in Chrome, but
no fill, page or worker calls it until AF3-3b. No script of any build changes (§4.6): no permission, manifest key,
network request, storage area, text or page.

### 4.1 What was built

| Part | Where |
| --- | --- |
| The one reader of a bundle's text, `parseBaseline` (at most `BASELINE_MAX_BYTES`, 1 MiB; JSON; then `format.ts validate(…, "baseline", {canonicalHost, isShared})`), and the one path, `BASELINE_FILE` | `extension/src/core/rules/baseline.ts` |
| The extension's read of its own package file, `readRules()` | `extension/src/platform/package-data.ts` |
| What a build carries and how: the bundle checked as the build may carry it (`checkedBaseline`), the two licence texts, check-dist's probes (`dataProbes`), the store package's source gate (`sourceGate`) | `extension/scripts/rules-package.mjs` (+ `.d.mts`) |
| The build: the bundle and both licence texts read and checked before anything is built; every module graph refused if it holds a file of the repository's `rules/` (`rulesDataGuard`, round 2); the bundle, its licence file and the licence's first line written | `extension/scripts/build.mjs` |
| check-dist: the rules of §4.2 in place of `RULE_DATA_NAMES` and "rules/ in a build" (N13); the build's `LICENSE.txt`; Apple's notice in the built notices | `extension/scripts/check-dist.mjs` |
| The third packaging gate | `extension/scripts/package.mjs` |
| Apple's data and notice in the notices, read from the bundle and its pins (`bundledData`; `BUNDLED_DATA` says what each source is) | `extension/scripts/notices.mjs`, `notices-data.mjs`, `THIRD-PARTY-NOTICES.md` |
| Docs | `docs/ARCHITECTURE.md` (§3: in no storage area; §7: in every flavour, the gate), `LICENSE.md`, `CONTRIBUTING.md`, `extension/README.md`, `rules/README.md`, the cloud plugin's README (step 6) |
| Tests | `test/unit/rules-package.test.ts` and `test/e2e/rules-package.spec.ts` (new); cases in `autofill1-check-dist`, `m5-check-dist-tamper`, `m5-build-guard`, `m5-source-rules` and `notices`; the tests that build a copy of the extension link `../rules` beside it, as they link `../LICENSES` (`budget-check-dist`, `devread-build`, `externally-connectable`, `m6-gate`, `plugin-sdk-build-guard`, `quickview-check-dist`, `m5-build-guard`, and `plugins-own.spec.ts`) |

### 4.2 How a build carries the bundle, and who holds it to that

- **The build** (`build.mjs`, before Vite runs): `checkedBaseline()` loads `baseline.ts` through Vite's `runnerImport` (as
  the developer catalog's check does) and refuses, saying why, a bundle the reader refuses or one that is not in
  `bundle.mjs`'s form (`JSON.stringify(JSON.parse(text), null, 2) + "\n"` must be the text: a hand edit or a key written
  twice, which `JSON.parse` hides, does not survive it). It reads `rules/NOTICE` and the licence texts there too, and a
  missing file is named with what to do (build in the repository, beside its `rules/`; or make the bundle). Exit 1,
  nothing built. Then it writes the text as read, `rules/LICENSE.txt` (`rules/NOTICE`, a rule of `=`,
  `LICENSES/AGPL-3.0-or-later.txt`) and `LICENSE.txt` (one line, a blank line, `LICENSES/MPL-2.0.txt`; the line: "The
  files under rules/ are under AGPL-3.0-or-later and MIT: see rules/LICENSE.txt. The third-party software and data listed
  in THIRD-PARTY-NOTICES.txt keep their own licences. Everything else: the Mozilla Public License 2.0, below.", P-14).
  Every flavour, the ID draft included.
- **The guard** (`build.mjs rulesDataGuard`, round 2; on the pages', the worker's, the finder's and the content script's
  builds): a module of any entry's graph under the repository's `rules/` folder, however it is imported (a JSON module, a
  named import, `?raw`, `?url`, `import()`), fails that build with the file and the modules that import it; and so does
  an asset the build emits whose source file is there (round 3: `new URL("…/rules/…", import.meta.url)` in a page reaches
  no module graph, and the page build copies the file into `assets/`). Paths are compared as the disk spells them, as the
  foreign-code guard's are. This is the first line against the bundle's data in the code (the plan's §4.4, no JavaScript
  data module); check-dist is the second, and P-13 says which covers what.
- **The reader** (`readRules()`): `fetch(chrome.runtime.getURL("rules/baseline.json"))` with `AbortSignal.timeout(5000)`
  over the whole read (a lost answer ends it); the body counted as it arrives, the read cancelled at the first chunk past
  1 MiB; decoded as strict UTF-8; `parseBaseline`. Anything wrong (no file, an error status, too large, too slow, not
  UTF-8, not JSON, not a baseline bundle) is `null`, and the finder works on its heuristics, as before Stage 3. Calls
  that come while it reads share that read. What the file says (the bundle, or an error status, too large, not UTF-8, not
  JSON, not a baseline bundle) is kept for the context's life; a read that was lost (the request failed, or the 5 s ran
  out) is not, and the next call reads again (round 2, P-4). Nothing of it is written anywhere: no `chrome.storage` area,
  IndexedDB, `localStorage` or cache (plan §4.4).
- **check-dist**, every flavour:
  - under `rules/` exactly `rules/baseline.json` and `rules/LICENSE.txt` (another file, a folder, or neither: refused);
  - the bundle byte for byte the repository's `rules/build/baseline.json`, accepted by `checkedBaseline` (the reader and
    the form), within the reader's 1 MiB and **64 KB gzipped** (`RULES_BUDGET_GZ`, the plan's §4.6; it prints the size);
  - `rules/LICENSE.txt` as the build writes it; `LICENSE.txt` the line and then exactly the MPL text (white space
    before its title allowed: the file starts with spaces);
  - the manifest naming no `rules/` (never web-accessible, never a content script);
  - **no shipped file but the bundle holding its host lists** (`dataProbes`; rounds 2 and 3): each list of two hosts or
    more of the repository's bundle (each alias group's lists, the appends) is looked for in every shipped text file
    (scripts, pages, styles, JSON, the notices; source maps too) read with one kind of quote, no escaping backslash and no
    white space (`normalised`), so the pages' minified ``[`a.com`,`b.com`]``, the worker's indented lines with double
    quotes and an escaped string of JSON all match. No keys and no selectors (P-8). These replace the design's field
    names (`twoFactorPage` and the like), which no file has any more. A bundle that is not JSON is reported as such, and
    the rest of check-dist still runs;
  - **no copy of the bundle under another name** (any file byte for byte the repository's bundle but
    `rules/baseline.json`), and **no JSON `data:` URL in any script** (`data:application/json`: how a library build
    writes a file it is given by address into the code; no script of Sixkey's has one) (round 3);
  - `THIRD-PARTY-NOTICES.txt` carrying, white space aside, the licence file `SOURCES.json` pins for every upstream source
    the shipped bundle names (Apple's MIT notice today).
- **The store package** (`package.mjs`): refused, before anything is built, while `REPO_URL` is empty (the bundle then
  names no source; the repository's public address is still open), or while the committed bundle's `source` is not what
  `REPO_URL` and `RULES_AT_TAG` give for its version (built before the address was set, or for another), or while
  `REPO_URL` is no address the source can be made of (that reason given like the others, not thrown). Listed after the
  two ID gates, in one refusal with them. `--local-only` and `--id-draft` are not store packages and are unaffected, as
  are dev and e2e builds.
- **The notices**: `THIRD-PARTY-NOTICES.md` gains "Data in the site rules' bundle", and the build's
  `THIRD-PARTY-NOTICES.txt` the same data and the licence text: what the data is and whose (`BUNDLED_DATA`), the
  address, each file at its pinned commit, the licence, and the pinned `LICENSE.md` verbatim. A source the bundle names
  and the table does not describe stops `notices.mjs`.

### 4.3 Decisions and deviations, with reasons

| # | Decision | Why |
| --- | --- | --- |
| P-1 | The package holds the committed file as it is, two-space JSON (19,864 B, 3,716 B gzipped), not a compact copy (10,669 B, 3,414 B) as B-4 allowed | 302 B gzipped against a file anyone can compare with the repository's, and that check-dist does compare byte for byte; the extension reads it only on demand (AF3-3b) |
| P-2 | One reader, `parseBaseline`, for the build, check-dist and the extension; the scripts load it through Vite's `runnerImport` | `baseline.ts` imports `match.ts` and `site-domains.ts` without extensions, as the extension's modules do; the build then needs no Node type stripping (the tools' C10/B-7) |
| P-3 | The build checks the reader and the form, not `bundle.mjs --check` (the bundle against its sources) | The build reads one committed file; staleness against the sources is `rules-tools.test.ts`'s and CI's; a build must not depend on the tools' Node version |
| P-4 | What the file says is kept for the context, a failure the file gives included; a lost read (the request failed, or took too long) is not (round 2) | A package file does not change while the extension runs, so a second read would say the same; a lost read says nothing about the file, and a side panel can stay open for hours after one slow moment (the review's NIT-1) |
| P-5 | The reader counts bytes as they arrive instead of reading `text()` | The bound holds whatever the file is, without trusting a length; the 5 s covers the body as well as the answer (the signal is the fetch's; round 2 tests it with Node's `fetch` and a server that stops half way) |
| P-6 | Two limits: the reader's 1 MiB, check-dist's 64 KB gzipped | The budget is the plan's; the reader's limit is a backstop (fifty times today's file) that also holds a build to what the extension would read |
| P-7 | The gate compares `source` with what `REPO_URL` gives, not only "not empty" | A bundle built before the address was set, or for a fork's address, points nowhere useful; the plan's §3.6 says `source: ""`, this is that and its stale form |
| P-8 | Probes are the bundle's lists of two hosts or more, compared with normalised script text; no keys, no selectors, no one-host lists (round 2) | The bundlers write an imported list in several ways, which normalising makes one; a key such as `aliases` (AF3-4's module may well have one), a selector a rule shares with the finder, or `["x.com"]` can be ordinary code. The build's guard is the first line, this the second |
| P-9 | Apple's notice is generated from the bundle's `upstream` and the pins, not written by hand; check-dist requires the pinned licence text in the built notices | The notice follows the data: a new upstream file or source cannot ship without its notice |
| P-10 | The e2e test bundles `package-data.ts` with Vite and runs it in Chrome's worker and the popup | Nothing in the build calls `readRules` yet, so no built chunk holds it; AF3-3b's Fill chunk will |
| P-11 | `m5-build-guard`: the copies made for a store package sit beside a `rules/` whose bundle names the test's address; the other copies link the repository's `rules/` | The tree's check-dist compares a build's bundle with the repository's, so only the store package's copies may differ, and they are checked by their own copy of check-dist |
| P-12 | `CONTRIBUTING.md` says when to run `npm run notices` for the rules | The notices now depend on `rules/build/baseline.json` and `rules/upstream/SOURCES.json` too |
| P-13 | **A deviation from the plan's N6**: the bundle's data in a script is not assumed to look like a JSON fragment (rounds 2 and 3) | N6 took `"hosts":{"` and the groups as written for probes. Vite 8 writes an imported bundle as ``{s:[`chat.com`,…]}`` in the pages and the finder, and over indented lines in the worker (the review's probe builds): none of round 1's 438 probes matched. So the build refuses the file itself, and check-dist compares normalised text. **What covers what**, each with its test: an import of a `rules/` file in any build (a JSON module, a named import, `?raw`, `?url`, `import()`): the guard's module graph (`m5-build-guard`, six real builds); `new URL("…/rules/…", import.meta.url)` in a page: the guard's emitted assets (a real build), and check-dist's copy rule and host lists (a copy in `assets/`); the same in a library build (the worker, the finder, the content script), which writes the file in as a data: URL: check-dist's `data:application/json` rule (a real worker build, and a tampered `sw.js`); the data written into any shipped text file some other way (pasted, generated): check-dist's host lists, normalised (a page chunk, `sw.js`, a page, a style, a dev source map, an escaped string) |
| P-14 | **A deviation from the plan's §4.1 sentence**: `LICENSE.txt`'s first line also says that the third-party parts keep their own licences (round 2) | "Everything else: the Mozilla Public License 2.0" would cover the fonts (OFL-1.1, whose §5 lets them be distributed under that licence only), the EFF word list and OpenSubtitles data (CC BY 3.0 US), and the MIT code bundled into the scripts, which `THIRD-PARTY-NOTICES.txt` in the same package lists under their own (the review's MUST-2) |
| P-15 | The plan's §4.6 `fetch` rules (the worker's, and the page chunk's that holds `package-data.ts`) and the worker's +0.6–1.0 KB (§R2.1) move to AF3-3b | No built chunk holds `package-data.ts` yet, so there is nothing to hold to the rule or to count; the first caller brings both (the review's NIT-7) |

### 4.4 Tests

- **Unit**, `rules-package.test.ts` (15 tests): the reader reads the committed bundle and refuses not JSON, over 1 MiB, a
  live bundle, an unknown field, a shared suffix, a reserved name; `readRules` with `chrome.runtime` and `fetch` stubbed
  (nothing else of `chrome`, so a storage call would throw): one request to `chrome-extension://…/rules/baseline.json`,
  the same object for every later call; in a fresh context, two calls made before the answer and a third: one request,
  one object, and for a file the format refuses one request and `null` for all (round 2); `null`, read once, for a 404,
  not JSON, not UTF-8, a live bundle, an unknown field; `null` for a failed request and for a read past the time limit,
  then the bundle at the next call (round 2); 16 MiB offered in 256 KiB chunks: cancelled after the fifth or sixth,
  `null`, kept; a bundle padded to exactly 1 MiB accepted; a body that stops half way (Node's `fetch`, a local server)
  ended by the time limit's signal (round 2); its source: one `getURL`, of `BASELINE_FILE`, no storage of any kind, no
  importer yet, and `baseline.ts` imported by it alone. What a build carries: the committed bundle; refused for a live
  bundle, written compact, without its final newline, a key written twice (which the reader alone accepts); the two
  licence texts and the line; the probes (the lists of two hosts or more; the bundlers' four shapes read as the probe;
  no source file holds one); the gate (empty template, empty or stale `source`, the right one, not JSON, two templates
  the source cannot be made of) and its place in `package.mjs`.
- **Unit**, on real builds: the build refuses, before building, a live bundle, a shared suffix, a key written twice, a
  compact file, an empty one, no bundle and no `rules/NOTICE` (round 2), and refuses six imports of `rules/` files in
  four builds, naming each importer (round 2) (`m5-build-guard`); the store package refused with all three reasons in
  order, refused with the two IDs set and `REPO_URL` empty, set but the bundle not rebuilt, set to `git@…` (round 2), and
  for another address; packaged with all three set (`m5-build-guard`); check-dist on tampered prod builds: an extra
  file, a folder, no `rules/`, a changed byte, compact, a key twice, a live bundle, the licence file changed, the bundle
  web-accessible, over 64 KB gzipped (in form and readable: its size alone), over 1 MiB, not JSON (its reason, no
  stack; round 2), the bundlers' shapes of a group in the popup's chunk, `sw.js` and the dev build's `sw.js` (round 2)
  (`autofill1-check-dist`); `LICENSE.txt` without the line, the notices without Apple's (`m5-check-dist-tamper`); the
  prod, e2e and dev builds' bundles the repository's; `fetch` in `package-data.ts` once, of `getURL(BASELINE_FILE)`
  (`m5-source-rules`); Apple's data, files, commit and notice in both notices (`notices`).
- **Chromium**, `rules-package.spec.ts`: the worker and the popup (its `connect-src 'none'` checked, and in force: a
  `data:` URL refused) fetch the file and get the repository's bytes; the extension's own `readRules`, run in each,
  accepts it (Chrome's URL parser inside `canonicalHost`) and gives the bundle Node reads (kind, version, rules, hosts,
  every alias group, the appends), one object for two calls made together and one after; the licence file beside it; a web page's fetch of the file
  refused; Chrome's `new URL()` writes each of the bundle's 533 hosts as the bundler wrote it.

### 4.5 Mutants (round 1)

One at a time, each against the tests named for it only, every file restored byte for byte and its SHA-256 compared (and
the whole patch's files compared after the last); the harness is not in the tree. **19 of 19 killed**; the no-change
run is §4.6's full unit run of the same tree.

- **The build**: the bundle copied without the check (X01: the five refusals of `m5-build-guard` fail), the form check
  gone (X02: the key written twice and the compact file are built), a bundle the reader refuses taken (X03).
- **check-dist**: the probes without their escaped forms (X04), no probe looked for (X05), the size rule gone (X06), the
  budget raised to 1 MiB (X07), a bundle that is not the repository's taken (X08), Apple's notice not looked for (X19).
- **The store package**: no source gate (X09: the three reasons in one refusal, and the gate's own case, which then
  packages), the source not compared (X10: a bundle not rebuilt after the address was set is packaged).
- **`readRules` and the reader**: no byte limit (X11: the 16 MiB body is not cancelled), the limit doubled (X12: ten
  chunks read, not six), no time limit (X13), a read at every call (X14), a failure read again (X15), the bundle's size
  kept in `chrome.storage.session` (X17); `parseBaseline` without its size limit (X16).
- **The notices**: the build's notices without Apple's licence text (X18).

### 4.6 Checks (round 1)

In a worktree of `ab62dcf`, moved onto `b3ece49` (Settings › Backup's layout, which touches no file of this patch)
before the checks below; every run through the shared runner after the one-minute load was under 24; vitest with
`--maxWorkers=2`, Playwright with one worker. The main working tree was not touched.

| Check | Result |
| --- | --- |
| `python3 scripts/messages.py` | no change (44 generated files) |
| `npm run typecheck` | clean |
| `bundle.mjs --check`; `import.mjs` | up to date; 3 upstream files matching their pins and shapes |
| prod, dev and e2e builds with `check-dist` | all OK. The first run failed all three on `LICENSE.txt`: the check wanted the MPL text's title right after the line, and the file starts with spaces; it now checks the line, then the title after any white space, then the whole text |
| **The store build against `b3ece49`'s** | 139 files → 141. Changed: `LICENSE.txt` (15,648 → 15,788 B), `THIRD-PARTY-NOTICES.txt` (32,263 → 33,976 B). New: `rules/baseline.json` (19,864 B; **3,716 B gz of 65,536**), `rules/LICENSE.txt` (38,473 B). Every other file byte for byte the same: `sw.js` 101,529 B gz of 106,496, the popup 59,103 B of 61,440, the side panel 61,340 B of 63,488, the finder `inject/otp.js` 7,144 B of 8,192, all unchanged |
| The e2e and dev builds against `b3ece49`'s | the same two files changed and two new; nothing else |
| `npm run format:check`, `npm run notices:check` | clean; up to date |
| The store package (`node scripts/package.mjs`) | refused before anything is built, with its three reasons in order (Sixkey's `STORE_ID`, the cloud plugin's ID, the rules' source); no `dist/`, no `release/` |
| Full unit run | 344 files, 5,573 passed, 4 expected fail, 1 skipped, and 2 failed, both this patch's own tests: `m6-gate`'s closed-gate copy had no `rules/` beside it (its build stopped at the rules check, before the graph guard the test expects), and the padded bundle was one byte short of 1 MiB. Both fixed; those two files again: 18 passed |
| e2e, one worker: every `autofill*.spec.ts`, `rules-engine`, `rules-package`, `perf`, `perf-idle`, `plugins-w2b-r2`, `cloud-plugin`, `plugins-own` (it builds a copy: changed here) and `visual-guard` | 245 tests: 238 passed, 6 skipped (`autofill4b-measure`, on request only), 1 failed: `plugins-own`, whose plugin's `hello` once got no answer after 217 tests. Alone it passed on `b3ece49` and twice on this tree. `visual-guard` passes (`b3ece49` fixed Settings › Backup) |
| Mutants | 19 of 19 killed (§4.5); every file restored byte for byte |
| The patch | applied to a clean `b3ece49`, it gives the worktree's tree |

### 4.7 Round 2: the review (fix and review again, two MUSTs)

`REVIEW-AF3-3a.md` found two MUSTs, two SHOULDs and eight NITs; the maintainers took each as the review proposed. All
are done in this round, on `b3ece49` with round 1 applied.

| Finding | What changed | Test and mutant |
| --- | --- | --- |
| **MUST-1** the data probes saw nothing the bundlers really write (``{s:[`chat.com`,…]}``, indented lines), and the build let a module import `rules/` | (1) `build.mjs rulesDataGuard` on all four builds: any module under the repository's `rules/` (a JSON module, a named import, `?raw`, `?url`, `import()`) fails the build, naming the file and its importers. (2) check-dist reads each script normalised (one kind of quote, no `\` before `"`, no white space) and looks for the bundle's lists of two hosts or more, also normalised; the key and selector probes are gone (P-8, P-13). README, `rules/README.md` and §4.2 say so | `m5-build-guard`: six real builds in copies, each with one import (a page module's JSON import, another page's `?url`, the worker's `?raw` and a named import, the finder's import of an upstream file, the content script's `import()`): each fails, naming the file and the importer. `autofill1-check-dist`: the minified backtick form in the popup's chunk, the indented double-quoted form in `sw.js`, a string of escaped JSON, the compact form in the dev build's `sw.js`: each fails with the group; `rules-package`: the four shapes normalise to the probe, and no source file holds a probe. X04 (the backslash kept), X05, X20 (the guard blind), X21 (no normalising), X22 (white space kept) |
| **MUST-2** `LICENSE.txt`'s first line called the fonts, word lists and MIT code MPL-2.0 | The line names the third-party parts (P-14) | the two pinned strings (`rules-package`, `m5-check-dist-tamper`); X27 (the plan's sentence back) |
| **SHOULD-1** calls that come together in a fresh context were not tested | a test: two calls before the answer, then a third: one request, one object; the same for a file the format refuses (one request, `null` for both and after). The e2e test calls twice together, then once | X23 (the review's mutant: the value kept, not the promise) |
| **SHOULD-2** the inline test appended the probe itself | the real shapes (MUST-1's tests) | X04, X05 again on the new tests |
| NIT-1 a timeout was `null` for the context's life | a lost read (the request failed, or the 5 s ran out) resets the cache; what the file says is still kept (P-4) | a failed request, then the bundle at the next call; the time limit, then the bundle; X15 (a refused bundle read again), X24 (a lost read kept) |
| NIT-2 the timeout test passed without the timeout; a stalled body was not tested | the stub's answer never comes without a signal; a test with Node's `fetch` and a local server that sends half the file and stops, the time limit's signal aborted by hand | X13 (no signal: both tests time out) |
| NIT-3 a bundle that is not JSON crashed check-dist | the notices and probe parts skip what does not parse; the rules part reports it | `autofill1-check-dist`: `{` as the bundle: its reason, the summary, no stack; X26 |
| NIT-4 a `REPO_URL` the source cannot be made of threw | `sourceGate` returns `rulesSource`'s message as its reason | `rules-package` (two bad templates), `m5-build-guard` (`git@…` in a copy: refused with the reason, no stack); X25 |
| NIT-5 an internal question number in a message every packager sees | dropped; "until the repository is public" kept | `rules-package` |
| NIT-6 a bare `ENOENT`; `rules/NOTICE` read after Vite | `need()` names the missing file and what to do; the licence texts are read with the bundle, before Vite | `m5-build-guard`: no bundle, no `rules/NOTICE`: refused with the message, nothing built; X28 (the texts read late), X29 (a bare `ENOENT`) |
| NIT-7 two deferrals only in "what it leaves" | P-15; §4.10 says AF3-3b's e2e rules on `.test` hosts need an e2e-only `allowReserved` | — |
| NIT-8 "about 3.8 KB" | 3,716 B | — |

### 4.8 Checks of round 2

On `b3ece49` with round 1 applied and changed in place (a new worktree); every run through the shared runner after the
one-minute load was under 24; vitest with `--maxWorkers=2`, Playwright with one worker. The main working tree was not
touched.

| Check | Result |
| --- | --- |
| `python3 scripts/messages.py` | no change (44 generated files) |
| `npm run typecheck` | clean |
| `bundle.mjs --check`; `import.mjs` | up to date; 3 upstream files matching their pins and shapes |
| prod, dev and e2e builds with `check-dist` | all OK: no graph of any build holds a file of `rules/`, and no script of today's builds holds a probe once normalised (no false positive) |
| **The store build against `b3ece49`'s** | the same 141 files as round 1, and against round 1's build only `LICENSE.txt` differs (15,788 → 15,881 B: the longer line). Every script byte for byte `b3ece49`'s; `rules/baseline.json` 3,716 B gz of 65,536 |
| The e2e and dev builds | likewise: against round 1's, `LICENSE.txt` alone |
| `npm run format:check`, `npm run notices:check` | clean; up to date |
| The store package | refused before anything is built, with its three reasons in order, the third without the internal question number; no `dist/`, no `release/` |
| Full unit run | 344 files, 5,586 passed, 4 expected fail, 1 skipped, and 1 failed: `m6-gate`'s closed-gate copy had no `LICENSES/` beside it, which the build now reads before Vite (NIT-6). Linked; that file and `rules-package` after its last change: 21 passed |
| e2e, one worker: `rules-package`, `plugins-own`, `visual-guard`, `perf` | 5 passed |
| Mutants | **29 of 29 killed**: round 1's 19 on round 2's code (X04 is now the escaping backslash kept, X15 a refused bundle read again) and X20 to X29 (§4.7); every file restored byte for byte, and the patch's files compared after the last. The first run killed X14, X15 and X23 by a time-out of the concurrency test (its second request was never answered); the test now answers every request, and the three again were killed by its assertions (X23: three requests, not one) |
| The patch | applied to a clean `b3ece49`, it gives the worktree's tree |

### 4.9 Round 3: the second look (merge after fixes, one SHOULD, one NIT)

The second look ("## r2 复核" in `REVIEW-AF3-3a.md`) found every round-2 finding resolved, and two new ones; the
maintainers took the SHOULD now rather than later. Done on `b3ece49` with round 2 applied (a new worktree).

| Finding | What changed | Test and mutant |
| --- | --- | --- |
| **r2-SHOULD-1** `new URL("…/rules/…", import.meta.url)` reached neither line: a page build copied the bundle into `assets/` (byte for byte, the guard silent, check-dist OK), a library build wrote it into the script as `data:application/json;base64,…` (stopped only by chance: the worker's budget) | (a) check-dist looks for the host lists in every shipped text file but the bundle, source maps included, and refuses any other file byte for byte the bundle; (b) it refuses `data:application/json` in any script (none in today's builds); (c) the guard also refuses an emitted asset whose source file is under `rules/` (`generateBundle`, `originalFileNames`), naming it. P-13 says which covers what | `m5-build-guard`: the line in the popup's entry, a real build: refused, naming `rules/build/baseline.json` and its asset; the line in the worker, a real build: built, with the data: URL in `sw.js`, and check-dist refuses it. `autofill1-check-dist`: a copy of the bundle in `assets/` (both rules), the list in a page, a style and a dev build's source map, a JSON data: URL in `sw.js`: each fails. Y01 (a: scripts only again), Y02 (a: no copy rule), Y03 (b gone), Y04 (c gone) |
| r2-NIT-1 a plan's question number in public notes | reworded ("the repository's public address, still open") in §4.2, §4.7, §4.8 and §4.10, and in `extension/scripts/repo-url.mjs` (AF3-1b's), whose note on the gate is brought up to date | `git grep` over the tree for the phrase: one line left, `docs/sdk/SIXKEY-PLUGIN-SDK.md`'s, which this patch does not touch |

Checks of round 3, through the shared runner after the one-minute load was under 24, vitest with `--maxWorkers=2`,
Playwright with one worker; the main working tree was not touched:

| Check | Result |
| --- | --- |
| `python3 scripts/messages.py`; `npm run typecheck`; `bundle.mjs --check`; `import.mjs` | no change (44 generated files); clean; up to date; 3 upstream files matching their pins |
| prod, dev and e2e builds with `check-dist` | all OK: no shipped text file of today's builds holds a probe once normalised, source maps included; no file but `rules/baseline.json` is the bundle; no script has a JSON data: URL |
| **The builds against round 2's** | prod, dev and e2e: every file byte for byte round 2's (141 files in the store build); against `b3ece49`'s, as in round 2 |
| `npm run format:check`, `npm run notices:check`; the store package | clean; up to date; refused with its three reasons |
| The unit files that build or run check-dist, and the changed ones (17: `m5-build-guard`, `autofill1-check-dist`, `rules-package`, `m6-gate`, `plugin-sdk-package` and every `*-check-dist*` file) | 545 passed |
| `rules-package.spec.ts`, one worker | passed |
| Mutants | **4 of 4 killed** (Y01 to Y04, §4.9); every file restored byte for byte, and the patch's files compared after the last |
| The patch | applied to a clean `b3ece49`, it gives the worktree's tree |

### 4.10 What it leaves

- **AF3-3b**: `readRules` in the Fill paths (`hintOf(ruleFor(host, inEffect(null, baseline)))` into `scan`) and the
  worker's shortcut; check-dist's `fetch` rule for the page chunk that holds `package-data.ts` (the plan's §4.6: one
  call, with `getURL` of the `rules/` path) and for the worker; the e2e overlay's test rules, with which the e2e build's
  bundle is no longer the repository's, so check-dist's byte-for-byte rule changes with it; those rules use `.test`
  hosts, which `parseBaseline` refuses, so the reader needs an option (`allowReserved`) that only the e2e build turns on.
  The plan's +0.6–1.0 KB for the worker (§R2.1) falls there: nothing here reaches a script (P-15).
- **AF3-4**: the alias module reads `readRules`.
- **The repository's public address** (still open): until it is set, the store package is refused (by design).

## 5. AF3-3b: the Fill paths

**The popup's and the side panel's Fill paths take the page's site rule; the keyboard shortcut does not yet.** With the
store build's bundle (no site rule yet) no page has a rule, and the look's argument is `null` as before (§5.6). The e2e
build carries two test rules on its fixture hosts, which its tests fill. The worker reads no rule and carries no reader
(the maintainers' C27, §5.3); since round 2 it shares the one look and the one wait with the Fill paths, which it
carries for 60 B gz in the store build and 54 B in the e2e build (§5.7).

### 5.1 What was built

| Part | Where |
| --- | --- |
| The page's rule as a Fill path takes it, `ruleForPage(url)`: the top page's host (exact), the rules in effect (`inEffect(null, readRules())`: the package's baseline, no live bundle), the finder's hint (`hintOf`) and the site's `minLeft`; no rule on anything wrong | `extension/src/platform/site-rule.ts` (new) |
| `scan(tabId, hint)` takes the hint or the rule still being read (a promise), read while the finder is installed; `waitFor` and `fillCand` take a site rule's `minLeft` (`FillDeps.minLeft`): one look and one wait for every Fill path (round 2; round 1 had two new functions beside them, §5.7) | `extension/src/platform/autofill.ts` |
| The Fill chunk's look reads the rule (`scanPage`, with `scripting` held), keeps its `minLeft` with the look (`Seen.ready`), and its fill passes it | `extension/src/popup/main/Fill.tsx` |
| The reader takes reserved names when asked (`parseBaseline(text, {allowReserved})`); the package's read asks in the e2e build only (`__SK_RULES_TEST_HOSTS__`) | `extension/src/core/rules/baseline.ts`, `src/platform/package-data.ts` |
| The e2e build's test rules: two site rule files and their pages, laid out as `rules/` is | `extension/test/fixtures/rules/` (new) |
| The e2e build's bundle: the committed one with the test rules (`e2eBaselineText`), checked with reserved names allowed; the define | `extension/scripts/rules-package.mjs`, `scripts/build.mjs` |
| check-dist: the e2e build's bundle; the read in the Fill chunk alone (not the worker); the reserved names' option folded on in the e2e build's Fill chunk and off elsewhere; the format's list of reserved names, the one "localhost" a store build may hold; the Fill chunk's limit, 12 KB gz (round 2) | `extension/scripts/check-dist.mjs` |
| Docs | `docs/ARCHITECTURE.md` (§3), `extension/README.md`, `rules/README.md` and `rules/CONTRIBUTING.md` (the fixture's path, the browser test) |
| Tests | `test/unit/rules-fill.test.ts`, `test/e2e/rules-fill.spec.ts`, `test/e2e/rules-corpus.spec.ts` (new); cases in `rules-package`, `autofill1-check-dist`, `autofill1-source-rules`, `plugins-w1b-source-rules`; `rules-package.spec.ts` holds the e2e build's bundle; the fixture server serves the rules' pages, and the worlds map their two hosts; `devread-build`'s copy of the extension takes the test rules, which its e2e build needs |

### 5.2 How a Fill path takes a rule

- **The look** (`Fill.tsx scanPage`, the popup's and the side panel's): unless autofill is switched off (no look at
  all, as before) or `scripting` is not held (the look says a click must ask first, and no rule is read),
  `ruleForPage(tab.url)` starts, and `scan(tab.id, rule.then((x) => x.hint))` installs the finder (the first
  `executeScript`) while the rule is read; the look (the second) waits for both and passes the hint as its one argument,
  or `null` (no rule, a failed read, a host that is no http(s) host). The answer keeps the rule's `minLeft`
  (`Seen.ready.minLeft`).
- **The rules in effect**: `inEffect(null, baseline)`, the package's baseline: the live bundle is AF3-U2's, whose build
  gate is closed. **The rule**: `ruleFor(host)`, the top page's host exactly (no parent, no child, no `www.` variant);
  `hintOf` makes it the finder's argument, which names that host alone (R4-6), and the finder checks it again in the
  page (AF3-2).
- **The fill** (`fillCand` with `minLeft: s.minLeft`): `waitFor(entry, left, minLeft)`, one formula for every Fill
  path: it waits for the next code when less of the period is left than `min(minLeft, period / 2)` (MIN_LEFT_S, 5 s,
  when there is no rule; the plan's N5), with fillCand's own seams (`waiting`, `sleep`, `cancelled`, and `away` after
  the wait, F7), and works out the code after the wait.
- **Once per context**: the Fill chunk reads the package file once for the life of the popup or the side panel
  (AF3-3a's `readRules`); a popup opens anew each time, so each opening with an account for the page reads it once.
  Nothing reads it at an open with no account for the page: the Fill chunk is not loaded then.
- **The shortcut** (`fill-command.ts`) looks with `scan(tab.id)`, no argument but its default `null`, as before (C27).

### 5.3 Decisions and deviations, with reasons

| # | Decision | Why |
| --- | --- | --- |
| F-1 | **The keyboard shortcut takes no rule in this patch** (a departure from the plan's §4.4 and its AF3-3b row; the maintainers' C27, after the measurement in the next column) | The worker would carry the format's checker: measured on a first build, `sw.js` +4,390 B gz (101,529 → 105,919 of 106,496: 577 B left) in the store build and over its budget in the e2e build (104,501 → 108,881), against the plan's +0.6–1.0 KB. The plan's K5 allows no budget raise in the minimal subset. Revisit at AF3-6, when real rules exist, or with AF3-U2, which brings the checker to the worker anyway; any worker budget raise then needs the owner. Until then, on a page only a rule can find a box on, the shortcut says "no code box" and the popup fills it |
| F-2 | One look (`scan`, whose hint may be a promise) and one wait (`waitFor`, with a `minLeft`; `fillCand`'s `d.minLeft`) for every Fill path. Round 1 had `scanWithRule` and `fillCandFor` beside them, so that the worker stayed byte for byte | The review's SHOULD-1: the two copies could drift, and its two drift mutants lived. The maintainers relaxed C27's byte identity for this alone: the worker may change if its behaviour is the same and it grows by at most 100 B gz. It grows by 60 B gz (store) and 54 B (e2e): the look's `Promise.all`, `waitFor`'s parameter and `fillCand`'s `d.minLeft ?? 5`, and nothing else once the minifier's names are set aside; no rules code (§5.7) |
| F-3 | The rule is read in parallel with the finder's install, and the look waits for both | The plan's §4.4; a slow or lost read (5 s at most, AF3-3a) delays the look, never fails it: the hint is then `null` |
| F-4 | The e2e build's test rules are site rule files with their pages under `extension/test/fixtures/rules/`, added to the committed bundle by the build (`e2eBaselineText`, as `bundle.mjs` adds a rule) | The plan's "e2e overlay" names no place: there they are checked by the format's own checker like any rule, tried by the same corpus test, and never near `rules/` (they are the tests', MPL, not AGPL data) |
| F-5 | A fixture page names the path it is served at, `<meta name="sixkey-path" content="/…">`, else the rule's first page entry's | A rule's page entries are path prefixes; a fixture is one page at one address. The convention is in `rules/README.md` and `CONTRIBUTING.md` |
| F-6 | Reserved names reach the reader through a build define used in the call itself, so the minifier folds it into `allowReserved:!0` (the e2e build's Fill chunk) or `!1`, which check-dist reads both ways | A store build whose reader accepted `.test` hosts would still carry none (check-dist reads its bundle without them), but the define is one more thing the store build must not get wrong, so it is checked where it lands |
| F-7 | check-dist's `fetch` rule: one more call, `fetch(chrome.runtime.getURL(…))` of the rules' path, in the Fill chunk only; none in the worker, none in a page's counted code | The plan's §4.6 rule, without the worker's half (F-1) |
| F-8 | "localhost" in a store build's script: the format's list of reserved names (`["test","example","invalid","localhost"]`, as the minifier writes it) is taken out of the text before the dev markers are looked for; nothing else is | The checker reaches the Fill chunk, and the word is a dev marker. The maintainers' call: a narrow exemption by the exact text, the literal not obfuscated in the source; tested with a dev address in the same chunk and with three near-misses |
| F-9 | The Fill chunk grows by the format's checker: 5,704 → 9,710 B gz (+4,006 B, against the plan's +0.5 KB; 9,753 in round 1) | It is lazy, loaded with the first account for the page, and counted in no page's budget; since round 2 check-dist holds it to 12 KB gz (the review's NIT-3). Its time is measured (§5.6): the rule's read and check (about 3 ms) run beside the finder's install (about 4 ms), so the look waits no longer |
| F-10 | The plan's "zero opens of `sixkey-rules-live` in pages" and "a failing rules read leaves the heuristics" | The first is AF3-U2's (nothing opens a database here); the second is tested in units (a failed read is no hint, the look goes on with `null`) and in `rules-package.spec.ts` (Chrome's reader) |

### 5.4 Tests

- **Unit**, `rules-fill.test.ts` (11 tests): `ruleForPage` on the e2e build's bundle (both rules' hints and `minLeft`,
  exact hosts: no parent, child, `www.` or other host; no read at all for a page that is no http(s) page; a failed or
  refused read is no rule; the store build's bundle gives no rule for any host; every fixture host but the two rule hosts
  has none); `scan` given the rule still being read (the install does not wait for the rule, the look does; the hint as
  the one argument; the same calls and stub as with a plain hint and with none; a failed read is `null`; a frame without
  a string document ID or a frame number dropped; a look that never answers is slow; no `scripting`: ask; a page that
  cannot be scripted: blocked); `waitFor` with a `minLeft` (a table: the default, 20 s capped at half the period, 10 s;
  an 8 s period) and `fillCand` with `deps.minLeft` (none, `null` or 5: no wait with 12 s left; 20 and 10 s: `waitFor`'s
  wait, then `away`, then the fill; a cancel and a page left after its wait); the source (the Fill chunk alone imports
  `site-rule.ts`, reads the rule only with `scripting` held, calls `scan(tab.id, rule ? rule.then(...) : null)` once and
  `fillCand(..., { code, minLeft: s.minLeft, ...})` once; the shortcut's `fill-command.ts` names no rule; no second copy
  of the look or the wait anywhere).
- **Unit**, other files: the reader with and without reserved names (`rules-package`); the e2e overlay (the two rules as
  `bundle.mjs` writes a rule, rules and hosts sorted, nothing else changed, accepted with reserved names only; refused: a
  field the format refuses, a file not named after its id, a missing fixture, a host of another rule, an unknown field);
  check-dist on real builds (`autofill1-check-dist`): the e2e build's bundle with its test rules (the committed one alone,
  or a test rule changed: refused), a store build's bundle with a test rule (refused, reserved names), the read in the
  Fill chunk alone (a read in the worker, in the popup's counted chunk, a second one, none: each refused), reserved names
  on in a store build or off in the e2e build, the define left unreplaced, a dev address in the Fill chunk beside the
  exempt list and three near-misses of it, a Fill chunk over 12 KB gz (round 2); the source rules of
  `autofill1-source-rules` and `plugins-w1b-source-rules` (the shortcut's look with no rule, the Fill chunk's with its
  rule, three injections, every one behind the gate).
- **Chromium through the extension**, `rules-fill.spec.ts` (4 tests): the side panel on rules.fix.test finds the rule's
  box (the heuristics offer nothing there), fills it, and finds nothing on the same page at app.fix.test; the popup on
  rules2.fix.test finds the rule's group, shows the rule's sent-code note, and types one digit into each of the six
  boxes; the rule's `minLeft`: answered with 8 to 12 s left, the fill waits and types the next period's code; an open
  with no account for the page loads no Fill chunk (so reads nothing), and one with an account finds the heuristics' box
  as before.
- **Chromium, the finder alone**, `rules-corpus.spec.ts`: every rule (the repository's, none yet; the e2e build's two)
  on its own pages at its own https host and path: its box found (`r: 1`) and filled; a negative page under each of its
  paths with its own selector and six that match the negative boxes, as one box and as the rule's own entry (its box
  count and way of typing): nothing promoted; for a group rule, rows of its own box count that are no code (a PIN, a card
  number, a phone number): nothing promoted, beside a plain row that is (round 2); a rule verified over 365 days ago: an
  annotation.
- **`rules-package.spec.ts`** (AF3-3a's): the e2e build's bundle, read by Chrome's worker and page, and the reader bundled
  with the e2e build's define.

### 5.5 Mutants (round 1)

One at a time, each against the tests named for it only, every file restored byte for byte and its SHA-256 compared
(and the whole patch's files compared after the last); the harness is not in the tree. **15 of 15 killed**; the no-change
run is §5.6's full unit run of the same tree.

- **The page's rule**: no host looked up (B01); the hint not passed on, the look with `null` (B02); the rule read before
  the finder's install instead of beside it (B03); a failed read failing the look (B04).
- **The rule's wait**: `minLeft` ignored (B05); not capped at half the period (B06); no `away` after the wait, F7 (B07).
- **The Fill chunk**: its fill without the look's `minLeft` (B08); its look without the rule (B09).
- **The reader and the e2e bundle**: the reserved-names option ignored (B10); a test rule's host taken twice (B11); the
  e2e build without its test rules (B12).
- **check-dist**: the read let anywhere (B13); the "localhost" exemption widened to the whole Fill chunk (B14); the Fill
  chunk accepting reserved names in every build (B15).

### 5.6 Checks (round 1)

In a worktree of `2468c75`; every run through the shared runner after the one-minute load was under 24; vitest with
`--maxWorkers=2`, Playwright with one worker. The main working tree was not touched.

| Check | Result |
| --- | --- |
| `python3 scripts/messages.py`; `npm run typecheck`; `bundle.mjs --check`; `import.mjs` | no change (44 generated files); clean; up to date; 3 upstream files matching their pins |
| prod, dev and e2e builds with `check-dist` | all OK |
| **The worker, against `2468c75`'s** | `sw.js` byte for byte the same in the store build (101,529 B gz of 106,496) and the e2e build (104,501 B gz): the SHA-256 lists (`logs/dist-base-*.sha256`, `dist-after-*.sha256`) |
| **The store build against `2468c75`'s** | 141 files, as before. Changed: the Fill chunk, 15,792 → 26,107 B, **5,704 → 9,753 B gz** (lazy, counted in no budget); nine files only because they name it (`AddMenu`, `EditDialog`, `Remember`, `boot`, `late`, `popup`, `sidepanel` chunks and the popup's and the side panel's pages): byte for byte the same once the hashed names are written without their hash. The finder `inject/otp.js` (7,144 B gz of 8,192), the worker and every other file the same |
| The e2e build against `2468c75`'s | the same, and its `rules/baseline.json` with the two test rules (19,864 → 20,362 B); its Fill chunk 6,363 → 10,403 B gz |
| **The popup and the side panel, the sync gate open** (built in copies with `SYNC_UI_IN_STORE_BUILD` true; `logs/syncopen.log`) | `2468c75`: popup 59,654 B of 61,440 (1,786 left, **286 above the owner's 1,500 B floor**), side panel 61,894 B of 63,488 (1,594 left, **94 above it**); this patch: the same bytes |
| **The time a Fill costs** (`logs/measure-*.jsonl`, `time-read.jsonl`; 127.0.0.1/otc, no rule) | The rules' read and check run beside the finder's install: in a real popup, the cold read and check of the e2e bundle took a median 3.1 ms (max 4.9), the install 3.7 ms (max 4.4), so the look's critical path grew by a median 0.0 ms (max 0.8 ms); a warm read 0.0 ms. Through the extension, 16 rounds each, `2468c75` then this patch: popup open to "Code box found" 370 → 369.5 ms median (measured by polling, so to about 100 ms), popup Fill click to the code typed 4.0 → 4.0 ms, side panel 11.0 → 12.0 ms |
| **Behaviour without a rule: the 41 fixture pages** (`logs/compare-*.jsonl`; each through the popup's Fill path on the e2e builds of `2468c75` and of this patch: the strip, the row, the note after a Fill click, the page's boxes and event logs) | 41 of 41 the same, but for `/late`'s own boxes after the click: that page adds its box 1.5 s after it loads, and one run read it before, the other after; its strip and notes are the same in both |
| `npm run format:check`, `npm run notices:check`; the store package | clean; up to date; refused with its three reasons |
| Full unit run | 345 files: 344 passed, and `devread-build` failed in its setup: its copy of the extension had no `test/fixtures/rules`, which its e2e build now needs. The copy takes them; that file and the two changed since (`rules-package`, `autofill1-source-rules`): 68 passed. In all: 5,588 passed, 4 expected fail, 19 skipped (18 of them `devread-build`'s, under its failed setup) |
| e2e, one worker: every `autofill*.spec.ts`, `rules-engine`, `rules-package`, `rules-fill`, `rules-corpus`, `perf`, `perf-idle`, `visual-guard` | 233 tests: 227 passed, 6 skipped (`autofill4b-measure`, on request only), none failed; `perf`'s read counts (gates) unchanged |
| Mutants | 15 of 15 killed (§5.5); every file restored byte for byte, the patch's files the same after the last |
| The patch | applied to a clean `2468c75`, it gives the worktree's tree |

### 5.7 Round 2: the review (merge after fixes, one SHOULD)

`REVIEW-AF3-3b.md` found no MUST, one SHOULD and five NITs; the maintainers took the SHOULD as one shared core, relaxing
C27's byte identity for it alone (F-2). Done on `2468c75` with round 1 applied (a new worktree).

| Finding | What changed | Test and mutant |
| --- | --- | --- |
| **SHOULD-1** `scanWithRule` and `fillCandFor` copied `scan` and `waitFor`, with nothing to hold the copies together: the review's two drift mutants lived | Both gone. `scan(tabId, hint)` takes the hint or a promise of it (read beside the install, a failed read `null`); `waitFor(e, left, minLeft = MIN_LEFT_S)` and `fillCand`'s `d.minLeft` are the one wait. The worker: +60 B gz (store, 101,529 → 101,589 of 106,496) and +54 B (e2e, 104,501 → 104,555); its code against `2468c75`'s, the minifier's names set aside, differs only there (the look's `Promise.all`, `waitFor`'s parameter, `d.minLeft ?? 5`; `logs/swdiff.log`), and names no rules path, reader or check (check-dist's no-read rule for `sw.js` holds). Its calls are the same: the look's two with `[null]`, the fill's one | `rules-fill.test.ts`: a frame without a string document ID dropped and a look that never answers slow, each through the Fill chunk's call; the same calls with a promise, a plain hint and none; the `waitFor` table. R1 (drift-frames) and R2 (drift-slow) on the one look, B05, B06 and B18 on the one wait |
| NIT-1 the package read's note said the worker's shortcut reads rules; `site-rule.ts` named `scan` and `fillCand` as round 1 did not use them | both brought up to date: the Fill chunk alone, with `scripting` held; not the worker (C27, and check-dist refuses the read there) | — |
| NIT-2 the rule was read without `scripting` | `const rule = held && !offHint() ? ruleForPage(tab.url) : null`: no `scripting`, no read (the look says a click must ask first) | `rules-fill.test.ts` and `plugins-w1b-source-rules` (the source); B17 |
| NIT-3 no limit on the Fill chunk | check-dist reports it in every build and holds it to 12,288 B gz in the store and the e2e build (9,710 and 10,356 B today) | `autofill1-check-dist`: the pristine builds report it; 9,000 letters no compressor shortens, appended: refused in both builds. B16 |
| NIT-4 the corpus's negatives only as one box | each negative selector also as the rule's own entry (a group rule's 6 boxes, its way of typing); and for a group rule a page of rows of its box count that are no code, a PIN (password boxes), a card number and a phone number, each laid out as a code row under its own words, beside a plain row the rule does promote (so the layout is not what keeps them out) | `rules-corpus.spec.ts`; in real e2e builds, E1 (the review's S1 off: killed, as by round 1's spec) and E2 (a group's own words not checked: the phone row, whose boxes say nothing alone, is promoted; killed at `#tel input (n: 6)`, and round 1's spec lets it live) |
| NIT-5 the commit message said the popup's and the side panel's counted bytes were unchanged | it gives them: with the sync gate closed, popup 59,103 → 59,101 B, side panel 61,340 → 61,343 B (61,341 in round 1), from hashed file names alone | the store build's files against `2468c75`'s, names set aside (`logs/names.log`) |

### 5.8 Checks of round 2

On `2468c75` with round 1 applied and changed in place (a new worktree); every run through the shared runner after the
one-minute load was under 24; vitest with `--maxWorkers=2`, Playwright with one worker. The main working tree was not
touched.

| Check | Result |
| --- | --- |
| `python3 scripts/messages.py`; `npm run typecheck`; `bundle.mjs --check`; `import.mjs` | no change (44 generated files); clean; up to date; 3 upstream files matching their pins |
| prod, dev and e2e builds with `check-dist` | all OK; `2468c75`'s builds made again give round 1's lists of its files |
| **The worker, against `2468c75`'s** | store build 365,633 → 365,736 B, **101,529 → 101,589 B gz** (+60, of 106,496); e2e build 375,293 → 375,396 B, **104,501 → 104,555 B gz** (+54); dev build (not held) 212,780 → 213,051 B gz. The change is the shared look and wait alone (SHOULD-1's row); no rules code |
| **The store build against `2468c75`'s** | 141 files, as before. Changed in content: the Fill chunk (15,792 → 25,836 B, **5,704 → 9,710 B gz**, of 12,288) and the worker; nine files only because they name the Fill chunk, as in round 1 (`logs/names.log`). Counted bytes, the sync gate closed: popup 59,103 → 59,101 B of 61,440, side panel 61,340 → 61,343 B of 63,488, from those names alone |
| The e2e build against `2468c75`'s | the same, and its `rules/baseline.json` with the two test rules (19,864 → 20,362 B); its Fill chunk 10,356 B gz |
| `npm run format:check`, `npm run notices:check`; the store package | clean; up to date; refused with its three reasons |
| Full unit run | 345 files: 5,609 passed, 4 expected fail, 1 skipped, none failed |
| e2e, one worker: every `autofill*.spec.ts`, `rules-*.spec.ts`, `perf`, `perf-idle`, `visual-guard` | 233 tests: 226 passed, 6 skipped (`autofill4b-measure`, on request only), and 1 failed: the corpus's group rule at its new plain row, which was not promoted. A fault of the test page: the rows shared one parent, so the plain row's group read the other rows' words ("Card number"); each row now has its own. The corpus spec again: 3 passed. `perf`'s read counts (gates) unchanged |
| Mutants | **20 of 20 killed** in unit runs: round 1's 15 on round 2's code (B05 to B07 on the one wait), R1 and R2 (the review's drift mutants, on the one look), B16 to B18 (§5.7); every file restored byte for byte, and the patch's files compared after the last. E1 and E2 in real e2e builds against the corpus spec: both killed (§5.7); the e2e build made again from the restored tree is the gates' byte for byte |
| The patch | applied to a clean `2468c75`, it gives the worktree's tree |

### 5.9 What it leaves

- **The shortcut's rules** (C27): at AF3-6, when real rules exist, or with AF3-U2; the worker's budget then needs the
  owner (F-1).
- **AF3-4**: the alias module reads `readRules` (the Fill chunk's read is one per context, so the two share it in a page
  that loads both).
- **AF3-6**: the first real rules, with their pages, tried by `rules-corpus.spec.ts`.

## 6. AF3-4t: room for the alias suggestions

The plan's R2 and the maintainers' C23: before AF3-4, a trim of the popup's and the side panel's counted bundles,
measured with the sync and the in-page suggestion (4d) release gates open, where both pages were under the owner's
1,500 B floor (the popup by 147 B, the side panel by 340 B). Done as `BUDGET-NOTES.md` §9 records, where the popup's
budget relief is written down: the settings page's chips, code box and own eight icons, and the Add view's choices,
left the files the two pages count; nothing on screen changed. With both gates open: popup 60,087 → 59,218 B (722 B
above the floor), side panel 62,328 → 61,455 B (533 B above), so AF3-4's 200 B leaves 522 and 333 B. The larger moves
measured but not made (the Add view's and the account dialogs' text in a lazy catalog; the lock screens' dial and icons
in their chunk) are listed there with their numbers and costs.

## 7. AF3-5: the "code after the password" note

**On a site that wants the code typed right after the password, in the same box, the popup's and the side panel's Fill
card says so where it finds no code box.** Those sites are the baseline's appends, Apple's list (today
`auth.redhat.com`, `etrade.com`, `usaa.com`), each with its subdomains on label boundaries (E*TRADE signs in on
`us.etrade.com`). The note is text in the Fill card's lazy catalog: what a Fill press does, what it fills, and the copy of
the card's code are the same on every page, and no other host shows it. The store build changes in the Fill chunk and
its two text chunks, and in the files that name the Fill chunk (§7.6).

### 7.1 What was built

| Part | Where |
| --- | --- |
| `ruleForPage(url)` gives `appends` too: `appendsOn(baseline, host)` on the package's baseline, the bundle it already read, never on the rules in effect; `NO_RULE` has it false | `extension/src/platform/site-rule.ts` |
| The look keeps it (`Seen.ready.appends`); `noBox`, the "no code box" text of the strip and of a press, says the note first on such a site | `extension/src/popup/main/Fill.tsx` |
| The text, `afAppend`, English and Chinese, in the Fill card's own catalog; a new fragment for Stage 3's text (AF3-4 adds its own there) | `extension/scripts/i18n/autofill3.py` (new); `catalogs/autofill-en.json`, `autofill-zh_CN.json` (generated) |
| The e2e build's test host: `appends.json` beside the test rules, added to Apple's by `e2eBaselineText`, which now also checks the whole bundle as a baseline bundle | `extension/test/fixtures/rules/appends.json` (new), `extension/scripts/rules-package.mjs` |
| Docs | `docs/ARCHITECTURE.md` §7 (the e2e build's bundle holds `test/fixtures/rules/`, since AF3-3b) |
| Tests | `test/unit/rules-appends.test.ts`, `test/e2e/rules-appends.spec.ts` (new); cases in `rules-fill` and `rules-package`; the worlds map the three test hosts (`autofill-helpers.ts APPEND_HOSTS`) |

### 7.2 Where the note shows, and where it does not

- **The strip** (`FillBar`), when the look found no code box for the accounts listed: the note, in place of the "no code
  box" advice in all three of its forms (no box: open the step that asks for the code; a frame of another site; too many
  boxes or a look cut short). The strip keeps its "Look again".
- **Under the card, after a Fill press** that found no box (the press's own look, and its second look): the note, in place
  of the same advice, drawn as that advice was (the press filled nothing).
- **Not where a box is found**: the strip says "Code box found" and a press fills it, as on any page (§7.3 G-3).
- **Not without a look of the page**: without `scripting` (the first Fill click asks for it, and no rule is read before), with
  autofill switched off, on a page Sixkey cannot look at, a slow look, a page whose storage cannot be closed: each keeps
  its own line, as before. A press that gets `scripting` in its click looks, and says the note if it finds no box.
- **On no other host**: the host must be one of the baseline's appends or a subdomain of one, on a label boundary
  (`notetrade.com`, `etrade.com.evil.test`, `redhat.com` are not); the baseline's only, whatever a live bundle may say once AF3-U2 exists
  (`appendsOn` refuses a bundle of another kind, and `ruleForPage` then gives `NO_RULE`).

### 7.3 Decisions and deviations, with reasons

| # | Decision | Why |
| --- | --- | --- |
| G-1 | The note where no box is found, in place of the "no code box" text, and only there | The maintainers' minimum. On such a site the "no code box" advice is wrong: "open the step that asks for the code" sends the user to a step the sign-in does not have |
| G-2 | It replaces all three forms of that text, the frame's and the size's too | A sign-in page often holds frames of other sites (an analytics or a captcha frame): with the frame's text first, the note would be hidden on the pages it is for, and that text points at a box such a sign-in does not have. "Type the code yourself" (too many boxes) is what the note says, with where |
| G-3 | **Not where a box is found** | The finder never offers a password box (vetoed since Stage 1, and no rule can promote one: AF3-2's S1), so a box it finds on such a site is one for the code alone (another step, or another way of signing in that the site also has), and Fill fills it as on any page. The note would contradict "Code box found" and send the user to the password box instead |
| G-4 | Once in the strip, and under a card only as a press's answer; no line beside each card's Copy | The strip is the card's one line about the page; each card's code is copied as on every page, and the note says what to do with it ("right after your password, in the same box") without naming a button |
| G-5 | `appendsOn(baseline, host)` on the bundle `readRules` gave, not on `inEffect(…)` | The plan's M1: appends change with releases only. Today the two are the same bundle; once AF3-U2 puts a live bundle in effect, its rules may change the hint, never the note |
| G-6 | The e2e build's test host is `test/fixtures/rules/appends.json` (`{"hosts", "note"}`), added by `e2eBaselineText` to Apple's, none already there, sorted as `bundle.mjs` sorts them, and the whole bundle then checked by the format's checker (reserved names allowed) | A rule file has no appends (the format keeps them bundle-level), so the overlay needs a file of its own. It is the e2e build's baseline only: check-dist holds every other build's bundle to the committed one byte for byte (AF3-3a/3b), and the format refuses appends in any live bundle. The whole check is new: before, the test rules were checked one by one and the merged bundle only by the build afterwards |
| G-7 | The wording: the maintainers' draft in English as it is; in Chinese, in the card's own words (此网站, 输入框, as `afNone` and `afPick` say them) | One short line, no jargon, a full sentence like the card's other lines |
| G-8 | A new fragment, `scripts/i18n/autofill3.py`, with this key only | The plan's AF3-5 row names it; AF3-4 adds its alias text there |

### 7.4 Tests

- **Unit**, `rules-appends.test.ts` (11 tests): `ruleForPage`'s `appends` on the store build's bundle (Apple's three
  hosts, `us.etrade.com`, `www.etrade.com`, `sso.auth.redhat.com`, `www.usaa.com`, an upper-case host with a trailing
  dot, an http page with a port: the note and no rule; `notetrade.com`, `xusaa.com`, `etrade.com.evil.test`,
  `us.etrade.com.evil.test`, `etrade.co`, `etrade.com-login.test`, `redhat.com`, `sso.redhat.com`, `example.com`,
  `127.0.0.1`: none); a page that is no http(s) page: nothing, and the package not read; a failed or refused read, or no
  bundle: nothing; a live bundle with the baseline's lists (as a forgery would be): nothing, no rule either; the e2e
  build's bundle: Apple's hosts and its test host with its subdomains, never `notappend.fix.test` or
  `append.fix.test.evil.test`, and a rule's host with its hint and no note. The Fill card, drawn into a minimal document
  over a stand-in `chrome.*`: on `us.etrade.com` with no box, the strip says the note, the Fill button is there, a press
  says it under the card, fills nothing, and looks again as before; on `etrade.com` with a frame of another site or a
  look cut short, the note and not their texts; in Chinese, the Chinese note; on `us.etrade.com` with a box, "Code box
  found", no note, and a press fills it ("Code filled"); on `notetrade.com` and `etrade.com.evil.test`, the three texts as
  before, in the strip and under the card; without `scripting`, no read and no strip.
- **Unit**, other files: `rules-fill.test.ts` (the rules' cases now say `appends: false`; every fixture host of the
  worlds has no rule, and only the two appends hosts the note); `rules-package.test.ts` (the e2e build's bundle: Apple's
  appends kept, the test host added and sorted, nothing else changed; refused: no `appends.json`, a list, no host, no
  note, another field, a host twice, one of Apple's, an upper-case host, a shared suffix, not JSON).
- **Chromium through the extension**, `rules-appends.spec.ts` (4 tests): the popup on `append.fix.test`'s
  sign-in with no code box (`/nofield`) says the note in the strip, not "No code box"; Fill asks the http question, then
  says the note under the card; the page's boxes stay empty and saw no key event; the card's Copy copies; the side panel
  on `us.append.fix.test` says the note, and on `notappend.fix.test` and `app.fix.test` "No code box found on this page."
  without it; the popup on `append.fix.test`'s code box (`/otc`) finds it and fills it with no note; the popup in Chinese
  says the Chinese note.
- **Behaviour unchanged elsewhere**: every `autofill*.spec.ts` and `rules-*.spec.ts`, `perf`, `perf-idle` and
  `visual-guard` (§7.6).

### 7.5 Mutants

One at a time, each against the tests named for it only (`rules-appends`, and `rules-package` for the overlay's),
every file restored byte for byte and its SHA-256 compared, and the patch's files compared after the last; the harness
is not in the tree. **10 of 10 killed** in unit runs, each by an assertion; the no-change run is §7.6's full unit run of
the same tree.

- **The card** (`Fill.tsx`): the note never said (B01); said where a box is found too (B02); the look not keeping it
  (B05); the frame's and the size's texts before it (B06); a press's answer without it, `afNone` (B07).
- **The flag** (`site-rule.ts`, `lookup.ts`): matched without the label boundary, `endsWith(a)` (B03: `notetrade.com`);
  every host of a read bundle (B04); a live bundle's appends used (B10).
- **The e2e overlay** (`rules-package.mjs`): `appends.json` not read (B08); the merged bundle not checked whole (B09:
  the upper-case host and the shared suffix pass).

Three of them again in real e2e builds against `rules-appends.spec.ts`: B01 (the test host, its subdomain and the
Chinese note fail), B02 (the code box on the test host fails) and B08 (the three note tests fail): **3 of 3 killed**; the
e2e build made again from the restored tree is the gates' byte for byte.

### 7.6 Checks

Made on `6f330fd`, then moved onto `32b7f41` (AF3-4t, which shares only these notes with it) and checked again there;
the results below are `32b7f41`'s. Every run through the shared runner after the one-minute load was under 24; vitest
with `--maxWorkers=2`, Playwright with one worker. `32b7f41`'s own builds were made in a second, throw-away worktree.
The main working tree was not touched.

| Check | Result |
| --- | --- |
| `python3 scripts/messages.py` | of the 44 generated files, two change: `catalogs/autofill-en.json` and `autofill-zh_CN.json` (`afAppend`); the Fill card's catalog 43 → 44 keys, **1,579 → 1,619 B gz** (zh_CN, the larger) of 4,096. A second run changes nothing |
| `npm run typecheck`; `bundle.mjs --check`; `import.mjs` | clean; up to date; 3 upstream files matching their pins |
| prod, dev and e2e builds with `check-dist` | all OK (AF3-4t's rule too: none of its 29 rules and 8 icons in a counted file) |
| **The worker and the finder** | `sw.js` and `inject/otp.js` byte for byte `32b7f41`'s in all three builds (store: 101,589 B gz of 106,496; the finder 7,144 B gz of 8,192) |
| **The store build against `32b7f41`'s** | 141 files, 129 byte for byte the same. Changed in content: the Fill chunk (25,836 → 26,129 B, **9,707 → 9,807 B gz** of 12,288) and its two text chunks (en 1,263 → 1,304 B gz, zh_CN 1,579 → 1,619 B gz, of 4,096). Nine only because they name a renamed chunk (the `AddMenu`, `EditDialog`, `Remember`, `boot`, `late`, `popup` and `sidepanel` chunks, the popup's and the side panel's pages): byte for byte the same once the hashed names are written alike (`logs/names.log`). **Counted bytes**, the gates as shipped: popup 58,226 → 58,223 B of 61,440, side panel 60,467 → 60,464 B of 63,488, from those names alone |
| **Counted bytes with both release gates open** (sync and in-page suggestion, set with `sed` in each worktree as AF3-4t measured, and put back) | popup 59,218 → 59,213 B of 61,440 (2,227 left, 727 above the owner's 1,500 B floor), side panel 61,455 → 61,449 B of 63,488 (2,039 left, 539 above it): **no counted growth**, the few bytes from the renamed chunks' names alone (`logs/both-names.log`); the worker 103,166 B gz either way; the Fill chunk 10,363 → 10,469 B gz |
| The e2e build against `32b7f41`'s | the same files, and its `rules/baseline.json` with the test host among the appends (20,362 → 20,385 B); its Fill chunk 10,357 → 10,464 B gz; popup 59,441 → 59,438 B, side panel 61,683 → 61,678 B (names) |
| The dev build (not held) | the same files and their source maps; its Fill chunk 19,089 → 19,456 B gz |
| `npm run format:check`, `npm run notices:check` | clean; up to date |
| Full unit run | 347 files: 5,632 passed, 4 expected fail, 1 skipped, none failed (on `6f330fd`: 346 files, 5,620 passed) |
| e2e, one worker: every `autofill*.spec.ts`, every `rules-*.spec.ts` (with `rules-appends`), `perf`, `perf-idle`, `visual-guard` | 237 tests: 231 passed, 6 skipped (`autofill4b-measure`, on request only), none failed; `perf`'s read counts (its gates) hold. `rules-appends.spec.ts` alone on `6f330fd` too: 4 passed |
| Mutants | 10 of 10 killed in unit runs, 3 of 3 in e2e builds (§7.5), on `6f330fd` and again on `32b7f41` |
| The patch | applied to a clean `32b7f41`, it gives the worktree's tree |

### 7.7 What it leaves

- **The shortcut** says "no code box" on such a site (its toolbar title); it reads no rule yet (C27, §5.3 F-1), so the
  note is the popup's and the side panel's until the shortcut takes rules.
- **AF3-4** adds its alias text to `scripts/i18n/autofill3.py`.
- **Real pages**: the three sites' sign-in pages were not tried (no account there); the e2e build's test host stands in
  for them, and `rules-appends.test.ts` holds the real hosts, and their look-alikes, to the flag. Whether a site still
  wants the code after the password is Apple's list's word, re-imported with releases (`rules/README.md`).

## 8. AF3-4: "same sign-in" suggestions

> **Round 2** (the review, `REVIEW-AF3-4.md`, "merge after fixes", no MUST): §8.10 lists its two SHOULDs and seven NITs,
> each with its change, its test and its mutant; round 2's sizes and checks are §8.11 (the maintainers' C30 for the
> counted bytes).
>
> **Round 3** (the second review, `REVIEW-AF3-4-r2.md`, and the maintainers' two MUSTs): §8.12. §8.1 to §8.3, §8.5 and
> §8.7 describe the code, the tests and the mutants as they are now; §8.4, §8.6 and §8.8 are round 1's.

**On a page no account is registered for, an account registered for a site that Apple's list says shares the page's
sign-in is listed under "Possibly related", with a line that names its own site: "Same sign-in as twitter.com" on
`x.com`.** It is `related`, never `registered`: no This site, no Fill button; the related rows' "Remember" registers the
page's host, as before. The groups are Apple's (shared-credentials.json), in the package's baseline, never a downloaded
bundle's (the maintainers' C29). The work is a lazy chunk loaded after the first code; the popup's and the side panel's
counted code grows by 213 to 214 B as shipped, 216 to 217 B with both release gates open and up to 224 B with one open,
over the 200 B aim by what rounds 2 and 3 fixed, within the maintainers' C30 (§8.12). Four NITs of the AF3-4t and AF3-5 reviews are done with it (§8.4).

### 8.1 What was built

| Part | Where |
| --- | --- |
| `aliasNotes(entries, host)`: reads the package's baseline (`readRules`, a baseline bundle only), runs the §3.4 rule (`core/rules/alias.ts aliasRelated`, AF3-1a's), and gives each account offered its line, in the Fill card's lazy catalog's words, keyed by `aliasKey` (its id, a space and its sites); nothing when no text can be read. `ask(entries, host, at, redraw)` keeps an answer with lines as that page's and calls `redraw` when it came within 300 ms of `at`, the lookup's start in Main (before this chunk was loaded: round 3), and changes something; `shown(entries, host)` gives the list the page's lines, none once an account is registered for it (round 2); a lock empties what it keeps (round 3) | `extension/src/popup/main/aliases.ts` (new, a lazy chunk) |
| The lookup: after the first code, on a page `askHost` asks about, when some account has a site; again when the page or the accounts' ids and sites change (in no order), never on a reload of the same ones nor on a new order (rounds 2 and 3). Its start, `at`, is taken there, before the chunk's import. The list reads `shown` only when it is rebuilt anyway, or when `ask` redraws it | `extension/src/popup/main/Main.tsx` |
| `filterRows(entries, q, host, alias?)`: an account with a line (by `aliasKey`) that does not belong to the page otherwise is `related`, with it (`Row.note`); one that does keeps its tier and has none | `extension/src/popup/main/model.ts` |
| The row's line, under its label | `extension/src/popup/main/List.tsx` |
| The text, `afAlias`: en "Same sign-in as $1", zh_CN "与 $1 用同一账户登录" (the maintainers' C29) | `extension/scripts/i18n/autofill3.py`; `catalogs/autofill-*.json` (generated) |
| The exception to "stop guessing once a site is registered", stated | `extension/src/core/match.ts` (its header), `docs/design/notes/AFMATCH-NOTES.md` §7 |
| check-dist: the site rules' reader, now a chunk of its own that the Fill chunk and the "same sign-in" chunk load (§8.3 H-3); the two held together to the Fill chunk's 12 KB; the "same sign-in" chunk: one, lazy only, ≤ 2 KB gz | `extension/scripts/check-dist.mjs` |
| The e2e build: a test group (`old.alias.test` → `new.alias.test`, one way) added to Apple's from `test/fixtures/rules/aliases.json`, as AF3-5's `appends.json` | `extension/scripts/rules-package.mjs`, `extension/test/fixtures/rules/aliases.json` (new) |
| The four NITs (§8.4) | `scripts/css-selectors.mjs` (new), `scripts/check-dist.mjs`, `src/popup/main/Fill.tsx`, tests |
| Tests | `test/unit/rules-alias-list.test.ts`, `test/e2e/rules-alias.spec.ts` (new); cases in `rules-fill`, `rules-package`, `rules-appends`, `autofill1-check-dist`, `budget4t-check-dist`; `add-popup.spec.ts`, `rules-appends.spec.ts`; the worlds map the alias hosts (`autofill-helpers.ts ALIAS_HOSTS`) |

### 8.2 How a list gets its lines

- **When**: Main asks once the list shows a code (`codes.size > 0`), on a page `askHost` asks about (no account
  registered for it, not searching, a host that could be registered), and only when some account has a registered site;
  asked again when the page (the side panel follows the tab) or the accounts change, the accounts by their ids and sites
  in no order (`accounts`, the `aliasKey`s sorted, as one text), so a reload that gives the same accounts as new objects
  (a View menu choice, a plugin's proposal answered, the side panel following a setting changed elsewhere: round 2, S1)
  or in a new order (a drag, or another device's order synced in: round 3) asks nothing. Nothing is asked on a page an
  account is registered for, on a page that is no web page, or with no account that has a site.
- **What**: `import("./aliases")` (with the reader and the Fill card's text, each loaded once per popup or panel), then
  `aliasNotes(entries, host)`: the package's baseline (`readRules`; a bundle of any other kind gives nothing), Apple's
  groups through `aliasRelated` (AF3-1a: equal once one leading `www.` is off each side, no other subdomain, never an
  IP address, one-way groups one way, an account registered for the page left out), each account's line made with its
  first usable site at an offered member. No text read: no lines (never a key name).
- **When it is shown**: `aliases.ts ask` keeps an answer with lines by page (a map from the host to its lines; an answer
  with none is not kept, round 3). If it came within 300 ms of the lookup's start and changes something (not an empty
  answer where there was none: round 2, N5), it has Main draw the list again at once; the list then changes before the
  user can aim at a row (the plan's N9, C22). The start is `at`, `Date.now()` in Main's effect before it imports the
  chunk, so the chunk's load counts in the 300 ms (round 3: round 2 had taken it in `ask`, after the load, so on a cold
  or busy open a row could move at the load's time plus 300 ms); the answer's time is `Date.now()` when it is in.
  Otherwise nothing is drawn for it: Main reads `shown` only when the list is rebuilt anyway, when the search, the page
  or the accounts' ids and sites change. A reload of the same accounts, a new order, a render a click caused (a copy's
  toast), the codes' ticks or a reveal read nothing, so no row moves then. A late answer for a page the side panel has
  left is kept under that page and never read for another. A lock empties what is kept (the lock epoch every lock bumps
  in `chrome.storage.session`, which the chunk follows itself: round 3); an unlock asks again.
- **Never a stale line**: a line is keyed by `aliasKey`, the account's id with its sites as they were when the line was
  made, so it is not read once the account's sites change (an account whose `twitter.com` was taken off keeps no "Same
  sign-in as twitter.com", even before the next answer: round 2, N3); and `shown` gives none once an account is
  registered for the page, in this opening as in the next, which asks nothing there (round 2, N4).
- **What the row is**: `filterRows` makes an account with a line `related` unless it belongs to the page otherwise (a
  stale line for an account remembered for the page since: it keeps "registered" and has no line). `buildSections` puts
  it under "Possibly related", where `List` draws "Remember: <host> belongs to this account" beside it, as for a name
  guess, and the line under the account's label. `candidatesFor` takes registered accounts only, so no Fill button.

### 8.3 Decisions and deviations, with reasons

| # | Decision | Why |
| --- | --- | --- |
| H-1 | The lookup starts after the first code, and its 300 ms window from the lookup's start in Main's effect, before the chunk is imported, so the chunk's load is in the 300 ms (round 3); in the side panel, a new page's lookup starts when its list is drawn (the codes are there already) | The plan's "within 300 ms of the first code" for a popup's open; for the side panel following a tab, the first code was long ago, and the moment that matches it is the new page's list. Either way the rows change, if at all, within 300 ms of the list being drawn for that page, however long the chunk took to load |
| H-2 | The answer is kept by page (a map from the host), each line keyed by the account's id and sites; the lookup runs again when the accounts' ids and sites change, not when a reload gives the same ones (round 2) | A late answer for a page the panel has left must never land on another page, nor overwrite that page's own answer; an account edited or removed must not keep a stale line, and an edit of another account must move no row (a line keyed by its own account's sites stays read). The lookup's work is a lookup in memory once the chunk and the bundle are loaded |
| H-3 | The site rules' reader becomes a chunk of its own, which the Fill chunk and the "same sign-in" chunk both load; check-dist's AF3-3b rule ("the read in the Fill chunk alone") says so now: one reader, loaded with those two chunks and no other, never in a page's own scripts or the worker; and the Fill chunk is held to its 12 KB with that reader | The bundler splits a module two lazy chunks share into one chunk of its own (`fill-text-*.js` here: the Fill card's text, the package's read and the format's checker). The plan's §4.6 names "the page chunk holding package-data.ts", not the Fill chunk |
| H-4 | The line is the row's second `<i>`, under the label (the label kept: two accounts of one site are told apart by it) | No new style rule in the counted stylesheet: `.who i` is the label's muted, one-line, cut-with-an-ellipsis style; the compact list puts it on the row's one line |
| H-5 | The Main code asks when some account has any site (`domains?.length`); `aliasNotes` reads only the usable ones | The plan says "a usable registered domain"; the counted code's check is the cheaper one, and the module's is the rule. An account whose only sites are unusable costs a lookup that finds nothing |
| H-6 | In the e2e build, a test group (`old.alias.test` → `new.alias.test`, one way) is added to Apple's from `test/fixtures/rules/aliases.json`, as AF3-5's appends | The browser tests serve their pages at reserved names (`.test`) only, never at a real site's name, as for the test rules and AF3-5's host; the test group is the e2e build's baseline alone (check-dist holds every other build's bundle to the committed one), and a live bundle never carries groups. Apple's real groups are held to the rule in the unit tests |
| H-7 | The first version measured +201 B counted with both gates open; only this patch's own lines were made shorter (the 300 inlined, `domains?.length`, `!tier &&`): +190 B, and +194 B in round 1 as merged for review | The maintainers' limit was 200 B; nothing else was moved or trimmed |
| H-8 | Round 2 moves the timing, the "something changed" test and the "registered now" test into the lazy `aliases.ts` (`ask`, `shown`); Main keeps the call, the module, a counter, the accounts' text and two memos. The counted code grows by 206 B with both gates open (round 1: 194) | The maintainers' C30 (replacing round 1's 200 B limit): 200 B stays the aim; the bytes S1, N3, N4 and N5 need are accepted if both pages stay at least 300 B above the owner's floor with both gates open (popup ≤ 59,640 B, side panel ≤ 61,688 B); what can live in the lazy module lives there |

### 8.4 The four NITs (the AF3-4t and AF3-5 reviews; round 1)

| NIT | What changed | Test and mutant |
| --- | --- | --- |
| 1. AF3-4t: the settings page's `link` icon has the very path of a plugin's own `link` (`src/ui/plugins/Entries.tsx`), so "still shipped" could be met by the plugins' chunk, and a failure would name the wrong thing | check-dist now also asks that each of the settings page's icons be in a script the settings page loads with its page (its HTML's scripts and what they import statically); the plugins' chunk is lazy, so it no longer stands in | `budget4t-check-dist`: the settings page's `link` taken out of its own script while the plugins' chunk keeps one of the same path: refused, naming the settings page. C04 |
| 2. AF3-4t: check-dist's `selectorsOf` read a keyframes block's steps (`from`, `to`, `50%`) as selectors, the test's reader did not | One reader for both, `scripts/css-selectors.mjs`, which skips a keyframes block's steps (alone or in a list, `12.5%` too); check-dist and `budget4t-check-dist` import it | `budget4t-check-dist`: the reader's own cases (lists, parentheses, pseudo-elements, at-rules, keyframe steps, names that merely start so). C05 |
| 3. AF3-4t: the Add view's first-frame test covered the popup only | `add-popup.spec.ts`: the same test in the side panel's page | E04 (the view without its stylesheet: both fail) |
| 4. AF3-5: after a Fill press, the appends note was drawn as a refusal (`.fillnote.bad`, red, with the alert mark) | A press that finds no box on such a site says it as a note: `Per` "note", drawn `.fillnote` with the info mark; every other "no code box" press is a refusal as before | `rules-appends.test.ts` (the note's class, and `fillnote bad` on other hosts), `rules-appends.spec.ts` (the class in Chromium). A14, E05 |

### 8.5 Tests

As they are after round 3 (round 1 had 17 cases in `rules-alias-list.test.ts`, with a stand-in for the alias module;
round 2 25, with the real one).

- **Unit**, `rules-alias-list.test.ts` (30 tests):
  - `aliasNotes` on the committed bundle: one way (`twitter.com`'s accounts on `x.com` and `www.x.com`, nothing on
    `twitter.com`, `www.twitter.com`, `mobile.x.com`, look-alikes or an IP address); both ways (`chat.com`,
    `chatgpt.com`, `openai.com`, an account's first usable site named; `platform.openai.com` none); `fandom.com` from
    `wikia.com`, `community.fandom.com` none, one way; `login.seek.com` from `seek.com.au` (R4-3); an account registered
    for the page left out; Chinese; nothing from a failed read, no bundle, a live bundle with Apple's groups in it, or no
    text.
  - `ask` and `shown`: in time kept and redrawn, late kept and not redrawn, 299 and 300 ms, an empty answer where there
    was none not redrawn and not kept, one where there was a line redrawn; the 300 ms counted from `at`, not from the
    call (a chunk that loaded late leaves less); none shown once an account is registered for the page, none for no page
    or another page; a lookup that fails keeps what the page had; a lock empties what is kept, another session change
    does not.
  - `filterRows` and `buildSections` with lines: related with its line; a registered account keeps its tier and has
    none; no lines, or another page's, as before; search; a line keyed for the account's old sites not read; no two
    accounts share a key (the second review's crafted ids).
  - Main and List with the real `aliases.ts`, drawn into a minimal document over stand-ins (Main over a fresh copy of
    the vault at every paint, as `openView` gives it), the package's read and the clock in the test's hands: an answer
    in time (the row under Possibly related, its two lines, Remember, no Fill, the question beside it, asked once); a late
    one (nothing moves, not on a copy's render, not on the codes' tick; the next search shows it, and clearing it); a late
    one, then three reloads of the same accounts (S1); a late one, then a new order, by the list's own drag and synced
    in (round 3); 299 and 300 ms; the chunk's load held 300 ms, then a fast answer: nothing moves, and 299 ms: shown
    (round 3); an account's site taken off with the next answer late, and another given a site of the group (N3); the side
    panel's pages; not asked (an account registered for the page, no account with a site, no web page); a read that
    fails, or a chunk that cannot be loaded; Remember through the real sheet; another account remembered for the page
    (N4).
- **Unit**, other files: `rules-package` (the e2e bundle's test group, sorted; `aliases.json` refused in eight ways; the
  reader's two callers), `rules-fill` (the reader's importers; Main loads the alias chunk only by `import()`),
  `autofill1-check-dist` (the reader's chunk in the prod and e2e builds; refused: a read in the worker, in the popup's
  counted chunk, none, the reader loaded statically by another lazy chunk, not loaded by the alias chunk, in the popup's
  own scripts, in the offscreen document's page, by `import()` whatever its path, query or fragment, the format's
  checker in `boot` or in `sw.js`; the Fill chunk and its reader held together; the alias chunk over 2 KB, missing,
  imported statically by the side panel), `budget4t-check-dist` and `rules-appends` (§8.4).
- **Chromium through the extension**, `rules-alias.spec.ts` (3 tests): the side panel, watching the list from a
  registered page before it moves to `new.alias.test`: the delay from the new page's list to the line measured and
  reported; the only change after the list is drawn is the line coming; after it nothing moves for 3 s, a copy's click
  included; `www.new.alias.test` has the line, `m.new.alias.test` not; the popup: the row under Possibly related with its
  line and Remember, no Fill, no This site; Remember's sheet names `old.alias.test`; saved, the account is This site with
  its Fill button; one way: an account remembered for `new.alias.test` has no line on `old.alias.test`.

### 8.6 Sizes (round 1: the store build, gzip as check-dist counts it, against `85e4e52`)

Counted bytes, the popup's and the side panel's, in the four ways the store build can be made (the sync and the in-page
suggestion's release gates, each set with `sed` in a worktree and put back, as AF3-4t measured; `logs/variants.log`).
The owner's floor is 1,500 B under each budget: at most 59,940 B for the popup and 61,988 B for the side panel.

| Gates | Popup (of 61,440) | Side panel (of 63,488) |
| --- | --- | --- |
| as shipped (both closed) | 58,223 → 58,405 (+182) | 60,464 → 60,646 (+182) |
| sync open | 58,783 → 58,976 (+193) | 61,019 → 61,213 (+194) |
| in-page suggestion open | 58,639 → 58,833 (+194) | 60,881 → 61,075 (+194) |
| **both open** | **59,213 → 59,407 (+194; 533 above the floor)** | **61,449 → 61,643 (+194; 345 above it)** |

All of it is the `boot` chunk (the popup's and the side panel's shared counted code): Main's lookup, its preload of the
two new chunks (their names in the bundler's list), `filterRows`'s note and the row's second line. The first version
measured +201 B with both gates open, and only this patch's own lines were shortened (§8.3 H-7).

| Not counted (lazy) | `85e4e52` | This patch |
| --- | --- | --- |
| The Fill chunk (`Fill-*.js`) | 9,807 B gz | 6,078 B gz |
| The site rules' reader, now its own chunk (`fill-text-*.js`: the reader, the format's checker and the Fill card's text lookup) | (in the Fill chunk) | 4,065 B gz |
| The Fill chunk with the reader it loads (held to 12,288 B) | 9,807 B | 10,143 B (+336) |
| The "same sign-in" chunk (`aliases-*.js`, held to 2,048 B) | — | 497 B gz (641 B in round 2: §8.11) |
| The Fill card's text, en / zh_CN (held to 4,096 B) | 1,304 / 1,619 B gz | 1,319 / 1,639 B gz |
| The e2e build's bundle (`rules/baseline.json`, the test group added) | 20,385 B | 20,491 B |

The worker (`sw.js`, 101,589 B gz) and the finder (`inject/otp.js`, 7,144 B gz) are byte for byte `85e4e52`'s in all
three builds. Of the store build's 141 files, 129 are the same, two are new (the two chunks above), the Fill chunk, its
two text chunks and `boot` changed in content, and eight only by the names they hold (the `AddMenu`, `EditDialog`,
`Remember`, `late`, `popup` and `sidepanel` chunks and the two pages): the same once the hashed names are written alike
(`logs/names.log`).

### 8.7 Mutants

One at a time, each against the tests named for it only, every file restored byte for byte and its SHA-256 compared, and
the patch's files compared after the last; the harness is not in the tree. Round 1: 24 of 24 killed (19 in unit runs, 5
in real e2e builds); round 2: 33 of 33 (round 1's on round 2's code, and its own 9); round 3: 34 of 34, every earlier
one on `Main.tsx`, `aliases.ts`, `model.ts`, `List.tsx`, the rule, `Fill.tsx` and check-dist's reader rules on round 3's
code (26) and its own 8, each by an assertion but A08 and R1, whose tests failed on their own waits ("never came:
www.x.com's line", "asked again", "GitHub's line, asked again"). Round 3 did not run again the ones outside those files
(C04, C05 and the five in e2e builds), whose code it did not change.

- **The lookup and the rule** (`rules-alias-list`): a bundle of another kind's groups used, a live one (A01); no guard for
  missing text (A02); a registered account given the line (A03); the line without making the account related (A04); a
  late answer shown at once (A05); 300 ms counted as in time (A06); the last answer used whatever its page (A07); not
  asked again for another page (A08); asked on a page an account is registered for (A09); asked before the first code
  (A10); the line not drawn (A11); a member's subdomains offered, N8 (A12); a one-way group offered both ways, S3 (A13).
- **Round 2's**: not asked again when the accounts change (R1, the review's, which had lived); the lines read on any
  reload (S1a); asked again on any reload (S1b); a line kept on an account whose site it named is gone (N3); lines kept
  once an account is registered for the page (N4); an empty answer redrawn (N5); the format's checker let anywhere (S2);
  three pages only (N1); `import()` of the reader let anywhere (N2).
- **Round 3's**: the window's start moved back into `ask` (W1) or taken once the chunk is in (W2); the accounts' order
  counted as a change (O1); no separator in the key (K1); `import()` of the reader looked for as `./` only (I1) or with
  no query or fragment (I2); an answer with no line kept (P1); a lock leaving what is kept (P2).
- **The NITs of round 1**: the appends note after a press drawn as a refusal (A14, `rules-appends`); a settings icon found
  anywhere, a plugin's own too (C04, `budget4t-check-dist`); keyframe steps read as selectors (C05, the same).
- **check-dist** (`autofill1-check-dist`): the reader loaded by any chunk (C01); the Fill chunk held without its reader
  (C02); no limit on the "same sign-in" chunk (C03).
- **In real e2e builds** (rounds 1 and 2): the line not drawn (E01); a one-way group offered both ways (E02); a member's
  subdomains offered (E03); the Add view without its stylesheet (E04, NIT 3); the appends note as a refusal (E05, NIT 4).

### 8.8 Checks (round 1)

In a worktree of `85e4e52`; every run through the shared runner after the one-minute load was under 24; vitest with
`--maxWorkers=2`, Playwright with one worker. `85e4e52`'s builds were made in a second, throw-away worktree. The main
working tree was not touched.

| Check | Result |
| --- | --- |
| `python3 scripts/messages.py` | of the 44 generated files, two change: `catalogs/autofill-en.json` and `autofill-zh_CN.json` (`afAlias`); the Fill card's catalog 44 → 45 keys, 1,619 → 1,639 B gz (zh_CN) of 4,096. A second run changes nothing |
| `npm run typecheck`; `bundle.mjs --check`; `import.mjs` | clean; up to date; 3 upstream files matching their pins |
| prod, dev and e2e builds with `check-dist`, and the store build four ways (§8.6) | all OK |
| The worker and the finder | byte for byte `85e4e52`'s in all three builds |
| The builds against `85e4e52`'s | §8.6 (`logs/names.log`); the e2e build also its bundle with the test group |
| `npm run format:check`, `npm run notices:check` | clean; up to date |
| Full unit run | 348 files: 5,653 passed, 4 expected fail, 1 skipped, none failed (a first run found one stale assertion of this patch's, the "localhost" case now in the reader's chunk: fixed) |
| e2e, one worker: every `autofill*.spec.ts` and `rules-*.spec.ts` (with `rules-alias`), `add-popup`, `afmatch`, `sidepanel`, `visual-guard`, `perf`, `perf-idle` | 259 tests: 253 passed, 6 skipped (`autofill4b-measure`, on request only), none failed; `perf`'s read counts (its gates) hold |
| The delay measured (`rules-alias.spec.ts`) | the side panel: the line 4 ms and 14 ms (two runs) after the list for `new.alias.test` was drawn, the first lookup of the panel's life (the chunk, the reader and the text loaded then); the popup: the line already drawn when the test attached, 91 ms after the popup's start. Both well inside the 300 ms window; the only change after the list was drawn was the line coming |
| Mutants | 24 of 24 killed (§8.7) |
| The patch | applied to a clean `85e4e52`, it gives the worktree's tree |

### 8.9 What it leaves

- **2fa.directory's groups** are not shipped (the maintainers' C29); adding a source later changes data and the import,
  not this code.
- **The shortcut** reads no rule yet (C27); it has no list, so no lines.
- **AF3-5's other NIT** (the note and the rule share one `try` in `site-rule.ts`) is AF3-U2's.
- **When AF3-U2 lets the worker check a live bundle**, check-dist's "the format's checker in the site rules' reader
  alone, never in `sw.js`" (round 2, S2) must change together with "`sw.js` reads no package file" (AF3-3b, C27): the
  worker will carry the checker then (the second review's r2-e).

### 8.10 Round 2: the review (merge after fixes, no MUST)

`REVIEW-AF3-4.md` found no MUST, two SHOULDs and seven NITs, and checked every number of round 1. Done on `85e4e52` with
round 1 applied (a new worktree).

| Finding | What changed | Test and mutant |
| --- | --- | --- |
| **S1** a late answer was read on a reload that changed nothing: the service's reload gives new objects (`openView` decrypts the vault again), so the rows' memo, keyed by the accounts' identity, was rebuilt and read the kept answer, and the lookup ran again and opened a new 300 ms window; a View menu choice, a plugin's proposal answered or the side panel following a setting changed elsewhere moved a row | Main keys both on the accounts' ids and sites (`accounts`, a text of `aliasKey`s), not on their identity: the lines the list reads (`shown`) are taken only when the search, the page, the accounts' content change or an answer came in time; the lookup runs again only when the page or the accounts' content change | `rules-alias-list`: Main is drawn over a fresh copy of the vault at every paint, as `openView` gives it; a late answer, then three reloads of the same accounts: nothing moves, nothing asked again; the next search shows it. S1a (the lines read on any reload), S1b (asked again on any reload) |
| **S2** check-dist held the read to its chunk, not the format's checker: the checker's list of reserved names appended to the counted `boot` chunk passed (the review's T7) | That list (the one "localhost" a store build may hold) must be in the reader's chunk and in no other script, the worker included, in the store and the e2e build | `autofill1-check-dist`: the list appended to `boot` (prod), and moved from the reader to `sw.js` (e2e): refused. S2 |
| N1 the reader's rule looked at three pages (the offscreen document's own page could load it: T5) | every HTML page's scripts and what they import statically | `autofill1-check-dist`: the reader in `offscreen/index.html`: refused. N1 (three pages again) |
| N2 `import()` of the reader was not looked for (T4) | no script may load it by `import()`: the Fill and the "same sign-in" chunks import it statically | `autofill1-check-dist`: `import("./<reader>")` in `boot`: refused. N2 |
| N3 an account whose site was taken off kept its line until the next answer, and for good when that answer was late; nothing tested that the lookup runs again when the accounts change (the review's mutant R1 lived) | a line is keyed by the account's id and sites (`aliasKey`): one made for its old sites is not read; the lookup runs again on a change of ids or sites | `rules-alias-list`: `twitter.com` taken off with the next answer late: the line goes at once and stays gone; another account given `twitter.com`: asked again, its line in time, no other row moved; the model's key. R1, N3 |
| N4 a page remembered for one account in this opening kept the other rows' lines (the next opening asks nothing there) | `shown` gives none once an account is registered for the page | `rules-alias-list`: X remembered for `x.com` through "Choose": Twitter's line goes; `shown` with a registered account. N4 |
| N5 an empty answer drew the list again, on most pages | `ask` redraws only when the answer or the page's last one has lines | `rules-alias-list`: `ask` on a page of no group: no redraw; a page whose line went: redrawn. N5 |
| N6 `package-data.ts`'s line on what reads nothing said almost nothing | it names when the file is read and when not (no account with a site, no web page, before the first code on a page no account is registered for, without `scripting` on one an account is) | — |
| N7 §8.6 showed the "same sign-in" chunk alone | §8.11 lists what the path loads after the first code | — |

### 8.11 Sizes and checks of round 2

In a new worktree of `85e4e52` with round 1 applied, `85e4e52`'s own builds in a second one; every run through the
shared runner after the one-minute load was under 24; vitest with `--maxWorkers=2`, Playwright with one worker. The main
working tree was not touched.

Counted bytes, the popup's and the side panel's, the store build in its four ways (`logs-r2/variants.log`). The
maintainers' C30: 200 B stays the aim, and with both gates open each page must stay at least 300 B above the owner's
floor (popup ≤ 59,640 B, side panel ≤ 61,688 B).

| Gates | Popup (of 61,440) | Side panel (of 63,488) |
| --- | --- | --- |
| as shipped (both closed) | 58,223 → 58,419 (+196) | 60,464 → 60,661 (+197) |
| sync open | 58,783 → 58,994 (+211) | 61,019 → 61,230 (+211) |
| in-page suggestion open | 58,639 → 58,849 (+210) | 60,881 → 61,092 (+211) |
| **both open** | **59,213 → 59,418 (+205; 522 above the floor, 222 under C30's line)** | **61,449 → 61,655 (+206; 333 above the floor, 33 under C30's line)** |

Round 1 was +194 with both gates open: S1's keys (`accounts`, the memo of the lines read), `aliasKey` and its export, and
the module kept by Main (`ask`, `shown`) are the 11 to 12 B more; the timing, N4's and N5's tests are in the lazy module.

What the "same sign-in" path loads after the first code on a page no account is registered for, beyond what the popup
has loaded already (the review's N7; store build, gzip -9; `logs-r2/aliaspath.log`): the chunk itself (640 B), the site
rules' reader with the format's checker and the Fill card's text lookup (`fill-text-*.js`, 4,030 B), the shared names'
table (`site-domains-*.js`, 920 B), the lazy text helper (248 B) and the bundler's runtime (154 B): **5,992 B gz of
scripts**; the Fill card's text chunk of the language (en 1,331 B, zh_CN 1,599 B), which `fill-text` reads at once; and
the package's `rules/baseline.json`, **19,864 B** (3,742 B gzipped), read from the extension's own files and checked. All
after the first code; each once for the popup's or the panel's life.

| Check | Result |
| --- | --- |
| `python3 scripts/messages.py`; `npm run typecheck`; `bundle.mjs --check`; `import.mjs` | the two Fill catalogs as in round 1, a second run changes nothing; clean; up to date; 3 upstream files matching their pins |
| prod, dev and e2e builds with `check-dist`, and the store build four ways | all OK |
| The worker and the finder | `sw.js` and `inject/otp.js` byte for byte `85e4e52`'s in all three builds (in the dev build, as in round 1, `sw.js.map` changes: it carries `match.ts`'s text, whose header this patch extends) |
| The builds against `85e4e52`'s (`logs-r2/names.log`, `bootimports.log`) | store build: 141 → 143 files, 129 the same; new: the two chunks; changed: the Fill chunk, its two text chunks and `boot`; `AddMenu`, `EditDialog`, `Remember` and `late` only in the minifier's short names for what they import from `boot` (which exports one more binding, `aliasKey`, for the alias chunk); `popup`, `sidepanel` and the two pages only by names. The e2e build the same, with its bundle |
| `npm run format:check`, `npm run notices:check` | clean; up to date |
| Full unit run | 348 files: 5,661 passed, 4 expected fail, 1 skipped, none failed |
| e2e, one worker: every `autofill*.spec.ts` and `rules-*.spec.ts`, `add-popup`, `afmatch`, `sidepanel`, `visual-guard`, `perf`, `perf-idle` | 259 tests: 253 passed, 6 skipped (`autofill4b-measure`, on request only), none failed; `perf`'s read counts hold. The delay measured again: the side panel's line 5 ms after the list was drawn; the popup's already drawn when the test attached, 87 ms after the popup's start |
| Mutants (round 1's on round 2's code, and round 2's) | **33 of 33 killed**: round 1's 24 (A01 to A14, C01 to C05, E01 to E05 in real e2e builds) and round 2's 9 (R1, the review's mutant that lived; S1a, S1b; N3; N4; N5; S2, N1, N2 against check-dist); each by an assertion but A08 and R1, whose tests failed on their own waits ("never came: www.x.com's line", "asked again", "GitHub's line, asked again"); every file restored byte for byte, and the e2e build made again is the gates' |
| The patch | applied to a clean `85e4e52`, it gives the worktree's tree |

### 8.12 Round 3: the second review (merge once the window is fixed, no MUST) and the maintainers' two MUSTs

`REVIEW-AF3-4-r2.md` found S1, S2 and N1 to N7 fixed, one SHOULD (S-r2-1) and five NITs (r2-a to r2-e). The maintainers
made the window's start and S-r2-1 MUSTs for round 3, and asked for the NITs as long as C30's caps hold. Done on
`85e4e52` with round 2 applied (a new worktree).

| Finding | What changed | Test and mutant |
| --- | --- | --- |
| **MUST 1** the 300 ms window's start (found at the maintainers' intake): round 1 took it in Main's effect, before `aliasView()`; round 2 had moved it into `ask`, after the chunk and its static imports were loaded, so on a cold or busy open a row could move at the load's time plus 300 ms after the first code | Main takes `at = Date.now()` in its effect, before the chunk's import, and passes it to `ask(entries, host, at, redraw)`, which counts from it; `aliases.ts`'s comments, §8.1, §8.2 and H-1 say so | `rules-alias-list`: the chunk's load held by the test 300 ms, then a fast answer: nothing moves (and the next rebuild shows it); held 299 ms: shown; `ask` with `at` 300 ms before the call: no redraw, 299: redrawn. W1 (the start moved back into `ask`), W2 (Main's start taken once the chunk is in) |
| **MUST 2** (S-r2-1) `accounts` followed the list's order: a drag, or another device's order synced into an open side panel, read a late answer and asked again | `accounts` is the accounts' `aliasKey`s sorted, as one text | `rules-alias-list`: a late answer, then a drag by the list's own drag and drop, then an order synced in: nothing moves, nothing asked again. O1 (no sort) |
| r2-c `aliasKey` had no separator: crafted ids could share a key | `e.id + " " + e.domains` (no id holds a space) | `rules-alias-list`: the review's two crafted ids (`abcdefgh` with `twitter.com`, `abcdefghtwitter` with `.com`) have two keys, and the second gets no line. K1 |
| r2-a check-dist's `import()` rule knew `./<file>` only (T13 `../assets/<file>`, T14 `./<file>?x` passed) | any specifier that names the reader's file, whatever path before it and query or fragment after it | `autofill1-check-dist`: `import("../assets/<reader>")` and ``import(`./<reader>?x`)`` in `boot`, `import('/assets/<reader>#h')` in the View menu's chunk: refused. I1, I2 |
| r2-b the module's table outlived a lock in the side panel, and kept empty answers | an answer with no line is not kept (N5's redraw unchanged); the chunk follows the lock epoch every lock bumps in `chrome.storage.session` (the key spelled again in the chunk, as `fill-request.ts` does, so nothing more is imported from the counted code: no counted byte) and empties the table; an unlock asks again | `rules-alias-list`: an empty answer is not kept; a lock empties the table, another session change does not; `autofill-pre-source-rules`, which lists every module with a storage listener, has this one, which reads no value. P1, P2 |
| r2-d §8's opening sentence, §8.5 and §8.7 were round 1's | the opening gives round 3's numbers; §8.5 and §8.7 are the tests and mutants as they are now; §8.4, §8.6 and §8.8 are marked round 1's | — |
| r2-e (a reminder) S2's "the checker in the reader alone, not `sw.js`" and "`sw.js` reads no package file" change together with AF3-U2 | said in §8.9 | — |

Counted bytes, the popup's and the side panel's, the store build in its four ways against `85e4e52`
(`logs-r3/variants.log`). The maintainers' C30: 200 B stays the aim, and with both gates open each page stays at least
300 B above the owner's floor (popup ≤ 59,640 B, side panel ≤ 61,688 B). Measured after each change, both gates open:
round 2 59,418 / 61,655; with MUST 1 and 2, 59,423 / 61,659; with r2-c's separator, 59,428 / 61,665 (under the caps,
so it is in); the rest added no counted byte.

| Gates | Popup (of 61,440) | Side panel (of 63,488) |
| --- | --- | --- |
| as shipped (both closed) | 58,223 → 58,436 (+213) | 60,464 → 60,678 (+214) |
| sync open | 58,783 → 59,005 (+222) | 61,019 → 61,241 (+222) |
| in-page suggestion open | 58,639 → 58,863 (+224) | 60,881 → 61,103 (+222) |
| **both open** | **59,213 → 59,430 (+217; 510 above the floor, 210 under C30's line)** | **61,449 → 61,665 (+216; 323 above the floor, 23 under C30's line)** |

Round 2 was +205 / +206 with both gates open: Main's start of the window (`at`, passed to `ask`), the sort and the
key's space are the 10 to 12 B more (a few of them only the new hashed names the counted code lists for its lazy chunks,
which move its gzip by a byte or two from build to build). The lazy chunk: 702 B gz (round 2: 641); what the path loads
after the first code, beyond the popup's own: 6,051 B gz of scripts, the Fill text chunk of the language (en 1,331 B, zh_CN 1,599 B) and the
package's `rules/baseline.json`, 19,864 B (`logs-r3/aliaspath.log`).

| Check | Result |
| --- | --- |
| `python3 scripts/messages.py`; `npm run typecheck`; `bundle.mjs --check`; `import.mjs` | the two Fill catalogs as before, a second run changes nothing; clean; up to date; 3 upstream files matching their pins |
| prod, dev and e2e builds with `check-dist`, and the store build four ways | all OK |
| The worker, the finder, the content script and the bundle | `sw.js`, `inject/otp.js` and `inject/suggest.js` byte for byte `85e4e52`'s in all three builds and the four ways; `rules/baseline.json` too, but in the e2e build (its test group, by design); in the dev build `sw.js.map` changes, as in rounds 1 and 2 (it carries `match.ts`'s text) |
| The builds against `85e4e52`'s (`logs-r3/names.log`, `bootimports.log`) | as in round 2: two new chunks; content changed in Fill, its two text chunks, `boot`, and in `AddMenu`, `EditDialog`, `Remember` and `late` only the minifier's short names for what they import from `boot`; `popup`, `sidepanel` and the two pages only by names |
| `npm run format:check`, `npm run notices:check` | clean; up to date |
| Full unit run | 348 files: 5,666 passed, 4 expected fail, 1 skipped, none failed (a first run found two source rules this round's lock listener crossed: `autofill-pre-source-rules`, which lists every module with a storage listener, now lists it and pins its shape; `security-notice`'s rule against `.clear()` in the popup's code, which the chunk's `pages.clear()` matched: the table is replaced instead) |
| e2e, one worker: every `autofill*.spec.ts` and `rules-*.spec.ts`, `add-popup`, `afmatch`, `sidepanel`, `visual-guard`, `perf`, `perf-idle` | 259 tests: 253 passed, 6 skipped (`autofill4b-measure`, on request only), none failed; `perf`'s read counts hold. The delay measured again: the side panel's line 5 ms after the list was drawn; the popup's already drawn when the test attached, 91 ms after the popup's start |
| Mutants | 34 of 34 killed (§8.7): W1 and W2 by the held load and by `ask`'s own case, O1 by the new order, K1 by the crafted ids, I1 and I2 by the paths and the query, P1 by the empty answer, P2 by the lock; every file restored byte for byte |
| The patch | applied to a clean `85e4e52`, it gives the worktree's tree |

## 9. AF3-U1: the signed manifest

> **Round 2** (the review, `REVIEW-AF3-U1.md`, "merge after fixes", no MUST; the maintainers' C31 and C32): §9.9 lists
> its three SHOULDs and the NITs, each with its change, its test and its mutant; round 2's checks are §9.10. §9.1 to §9.5,
> §9.7 and §9.8 describe the code as it is now; §9.6 is round 1's checks.

**Nothing in the extension imports it yet, and the store build is byte for byte `1047c5d`'s** (§9.6): the client's checks
of a signed manifest and the record logic (`signed.ts`), the offline signer, the key steps, the updater's release gate
(closed in the store build), the pinned keys (none in the store build; two test keys in dev and e2e), the module-graph
guard and check-dist's rules for the gate. Fetching, storage, the switch and the worker's use of all this are AF3-U2's.
No text, permission, manifest key, page or script of any build changes.

### 9.1 What was built

| Part | Where | Licence |
| --- | --- | --- |
| The client's side of the plan's §5.2, pure (WebCrypto only; no network, storage or extension API; no run-time import, the format's checker passed in): the signed file and the manifest read closed (`parseSigned`, `parseManifest`, the manifest's one text `manifestText`), the key ids (`kidOf`) and the pinned keys (`importPinned`), steps 1 to 3 before a bundle is fetched (`checkManifest`), all four with the bundle (`checkSigned`), and the record's transitions as functions of state: `readRecord` (what is deleted at a read), `switchedOff`, `heldBundle` (the bundle to use now) | `extension/src/core/rules/signed.ts` (new) | MPL-2.0 |
| The offline signer: `sign` (a PKCS#8 key file, encrypted or not), `prepare` and `assemble` (a hardware key: the exact bytes to sign, then the signature from DER or raw), `kid` (a key's entry for the pinned list) | `rules/tools/sign.mjs` (new) | AGPL-3.0-or-later |
| The key steps: the two keys, sealing `next` apart, signing, signing again before 180 days, changing keys at a release, a lost or stolen key | `rules/SIGNING.md` (new); `rules/README.md` (two rows, one line) | CC-BY-4.0 |
| The manifest's format for other implementations (AF3-1a's A1-6 left it here) | `contract/rules/1/manifest.schema.json` (new) | CC0-1.0 |
| The release gate `RULES_UPDATE_IN_STORE_BUILD = false`, `rulesUpdateIn(flavour)`, each flavour's rules origin, and what stops a build with the gate open (`updaterProblems`) | `extension/scripts/rules-update.mjs` (+ `.d.mts`, new) | MPL-2.0 |
| The pinned keys: `STORE_RULES_KEYS` (empty), `TEST_RULES_KEYS` (dev and e2e), `rulesKeysOf(flavour)`, and the rule a release's list follows (`keyOrderProblem`) | `extension/scripts/rules-keys.mjs` (+ `.d.mts`, new) | MPL-2.0 |
| Two test key pairs, plainly marked, and the last release's store list (empty) | `extension/test/fixtures/rules-keys/test-only-current.pem`, `test-only-next.pem`, `released.json` (new) | MPL-2.0 |
| The graph guard, in all four passes of the build, given the extension's own `src/` by the build and comparing paths as the disk spells them, in any letter case | `extension/scripts/rules-guard.mjs` (+ `.d.mts`, new); `extension/scripts/build.mjs` | MPL-2.0 |
| check-dist: the gate's marks, the database's name in the worker alone, no test key in a store build | `extension/scripts/check-dist.mjs` | MPL-2.0 |
| Tests | `extension/test/unit/rules-signed.test.ts`, `rules-sign.test.ts`, `rules-update-gate.test.ts`, `rules-update-check-dist.test.ts` (new) | MPL-2.0 |
| A paragraph on the gate | `extension/README.md` | CC-BY-4.0 |
| The two test keys' files let in by their exact names (`*.pem` is otherwise ignored as signing material: the maintainers' C31) | `.gitignore` | CC0-1.0 |
| "The two test signing keys are published on purpose, not a leak" (C31) | `SECURITY.md` (Out of scope) | CC-BY-4.0 |

`REUSE.toml` is unchanged: every new path falls under an entry it has (`extension/**`, `rules/**`, `rules/**/*.md`,
`contract/rules/1/**`), which `rules-sign.test.ts` checks by REUSE's own last-match rule.

### 9.2 How a signed manifest is checked, and what the record does

- **The file** (`/v1/manifest.json`): exactly `{m, kid, sig}`, at most 4,096 characters. `m` printable ASCII; `kid` 32
  lower-case hex digits; `sig` the 64 bytes of r‖s in canonical base64url without padding.
- **The pinned keys** (`importPinned`): each `{kid, spki}`, the SPKI in its one form, a P-256 point uncompressed (91
  bytes, a fixed 27-byte prefix), the kid its own; so one key has one kid (round 2, S2).
- **Step 1**: the kid is one the build pins, and not retired on this client (its record's retired keys, and every pinned
  key before the record's); the signature verifies with that key over `sixkey-rules-manifest\n1\n` + `m`. Only then is
  `m` read: closed, schema 1 of `sixkey-rules-manifest`, and **its one text**: `m` must be exactly what `JSON.stringify`
  writes for its fields in the schema's order, so a field written twice, spaces, another order or `5.0` are refused.
- **Step 2**: `created ≤ now + 1 day`, `created < expires`, `expires − created ≤ 180 days`, `now < expires` (times
  `YYYY-MM-DDTHH:MM:SSZ`, calendar-checked).
- **Step 3**: an integer version with `baseline < version ≤ baseline + 1,000`, and above the record's version when the
  record is this key's (the floor). A key later in the pinned order is compared with the baseline only.
- **Step 4** (`checkSigned`): the bundle is at most 512 KiB, exactly `size` bytes, hashes to `sha256`, is ASCII, passes
  `validate(…, "live", …)` (the checker the caller passes, with its options: the e2e build will allow its reserved test
  hosts), and has the manifest's version, source and licence. Accepted: the new record is `{kid, version, retired:
  every key before this one (and those retired already), held: {text, expires}}`.
- **At every read** (`readRecord`, which `checkManifest` and `heldBundle` call first): with no key pinned at all, no
  record is used and none deleted (round 2, N3). Otherwise a record not of this shape, whose kid is no longer pinned, or
  whose kid is retired, is deleted (floor and all); a retired key no longer pinned, or after the record's own key in the
  pinned order (round 2, N10), is dropped from its list; a held bundle that has expired, or whose version the built-in
  bundle has reached, is deleted and its floor kept. `switchedOff(stored)` deletes the held bundle of any record of this
  shape and keeps its floor and retired keys as they are, reading no pinned list (the next read judges the rest).
  `heldBundle` gives the bundle to use (checked again as a live bundle of the record's version), or null. A refusal gives
  no record: the stored one is kept as it was. The updater calls these with the keys of a successful `importPinned`
  only (§9.8).

### 9.3 Decisions and deviations, with reasons

| # | Decision | Why |
| --- | --- | --- |
| U1-1 | `checkManifest` (steps 1 to 3) apart from `checkSigned` (all four) | The updater fetches a bundle only for a newer version (§5.3); the same code must decide that, before the bundle is fetched |
| U1-2 | `m` must be its one text (the fields in order, `JSON.stringify`'s form), instead of a scan for repeated keys | One rule refuses a key written twice, any reordering, spaces and other spellings of a number; the client needs no JSON-key scanner, and the only writer is the signer, which writes exactly that |
| U1-3 | The format's checker is passed in (`validate`, the host checks, options), as `format.ts` takes its host checks | `signed.ts` then imports nothing at run time, so `rules/tools/sign.mjs` loads it under Node's type stripping and runs the very same checks on what it signs; the options let the e2e build accept its reserved test hosts later |
| U1-4 | The bundle's bytes must be ASCII | A valid live bundle is ASCII anyway (hosts as the URL parser writes them, an ASCII selector grammar, ASCII paths, an https source), so nothing is lost and no text decoding question arises |
| U1-5 | The manifest's `source` and `license` must be the bundle's | The plan lists them in `m` without saying what they are for; equal is the only reading that adds a check and no ambiguity |
| U1-6 | Before its signature verifies, `m` is not parsed and none of its fields is read (only its length and its kind of characters are looked at); the kid and the retired keys are checked before the signature | An unsigned manifest's content never reaches a reason or a decision; the kid checks need nothing but the pinned list. (Round 1 said "nothing of `m` is read": the review's wording note) |
| U1-7 | The effective retired set includes every pinned key before the record's | "Accepting it retires every earlier key": a key earlier than the one last accepted is refused even if the stored list lost it |
| U1-8 | A held bundle the built-in bundle has caught up with is deleted at read (floor kept) | §5.2 says it is not used; baselines only rise, so it can never be used again |
| U1-9 | A record whose own kid is retired, or that is not of the record's shape, is deleted | Neither can come from these functions; deleting is what §5.2 says for a retired kid, and a malformed record must not stand for a floor |
| U1-10 | `importPinned` takes `{kid, spki}` entries, each SPKI in its one form (P-256, the point uncompressed: 91 bytes with the fixed prefix), checks each kid against its key; at most two keys. The signer writes every key in that form (from its x and y), and the key lists compare keys by their point (round 2, S2) | A mistyped kid then stops the build (`updaterProblems`) instead of silently refusing every bundle in the field. One key, one kid: with the compressed form allowed, one key could be listed as both current and next, an old key could pass for a new one, and a test key could pass the store build's checks (the review measured all three) |
| U1-11 | A release's key list may stay, take its first keys, move one step (`[old second, new]`) or be **two new keys** (the maintainers' C32); never one key twice, and never a key that an earlier release pinned and a later one dropped (`released.json`'s `ever`, which only grows: round 2, S3); nothing else | M3 NIT (a) is the planned move. §5.3's "a release with new keys" (`next` lost or stolen, or both) needs a list with neither old key: a key pinned beside one that may have retired it is never pinned again. Re-pinning the old `current` beside a new `next` (`[A, C]`) is refused (C32 keeps it so), as are reorderings. Round 1 compared with the last release only, so a dropped key could come back two releases later, when clients have forgotten they retired it; `ever` holds the whole history |
| U1-12 | Two test keys (current and next), not one | AF3-U2's e2e must test succession; their PEM files start with a TEST-ONLY paragraph, `rules-keys.mjs` lists their public halves, and a test holds the two together |
| U1-13 | `RULES_ORIGINS` in `rules-update.mjs`: the store build's `""` (Q1), dev and e2e `https://rules.fix.test` (§5.1) | check-dist needs the origin to look for it; a gate-open build stops without an https origin of its flavour (no path, port or user) |
| U1-14 | A gate-open build stops unless it pins **exactly two** keys (and, in the store build, no test key), checked by `signed.ts importPinned` through Vite's `runnerImport` | One key leaves no succession, the recovery §5.3 relies on; the build checks keys with the extension's own code, as `rules-package.mjs` checks the bundle with the reader |
| U1-15 | The guard is in all four passes (pages, worker, finder, content script), given the extension's own `src/` by the build (`resolve(root, "src")`), compares paths as the disk spells them (`realpathSync.native`) and, for a path not on the disk, without regard to letter case; its empty module is `export {}` | The plan names the worker, the settings page and the Fill chunk (all in the first two passes); the other two cost nothing. Round 1 compared ids as spelled: on macOS and Windows an import written `../core/rules/Signed` reached the build past both of its checks (the review's S1), and it found `src/` by a folder named `extension` (N8). An import of a name from the empty module fails the build too, so AF3-U2 reaches these modules only through the gate's own branch |
| U1-16 | check-dist looks for the gate's marks in every shipped text file, applies R5's rule (the database's name in `sw.js` alone) to every build now, and refuses the test keys in a store build whatever the gate, found by their kid, their SPKI in base64 and base64url, their point (x‖y, x, y, in hex and base64url) as `rules-keys.mjs` lists them, and, where the test fixtures are there, each line of their private PEM (round 2, N11); and the dev and e2e builds' rules origin in a store build even if the store build's origin were set to it (N2) | The marks could reach a page, a style or the manifest as easily as a script; R5 holds today trivially and must keep holding. A first version read the test keys from their PEM files; the full unit run showed that the tests which build the store build in a private copy of the extension (without its test fixtures) then failed check-dist, so the list in `scripts/` is read, and `rules-signed.test.ts` holds it to the files |
| U1-17 | With the gate open, check-dist requires nothing yet | Nothing imports the updater in AF3-U1; "all of them" (§4.6) is AF3-U2's to add with the code |
| U1-18 | The signer checks what it is about to sign with a throwaway P-256 key before the real key signs, then checks its own output with `checkSigned` before writing | A refusal costs no hardware signature, and the same implementation decides both times |
| U1-19 | Validity: `--days`, 1 to 180, by default 120 | 120 days lets a quarterly re-sign (every 90 days) keep 30 days of margin before clients fall back to their built-in rules, and a bundle found wrong but impossible to replace (the server lost) stays at most four months, not six |
| U1-20 | The signer's baseline is the committed `rules/build/baseline.json`'s version unless `--baseline` says another | It is what the newest release carries; the oldest release still in use can be checked with `--baseline` |
| U1-21 | `SIGNING.md` says that signing again means a new version | A consequence of M3's floor the plan does not state: a client refuses the version it already has, however freshly signed |
| U1-22 | The signer never overwrites a file, reads a passphrase on standard input (without echo at a terminal), and refuses SEC1 key files with the conversion to use | A published pair must not be clobbered by a second run; the passphrase never goes on a command line |
| U1-23 | The test keys' private halves are committed as PEM files, let in by their two exact names past `.gitignore`'s `*.pem`, which keeps signing material out; `SECURITY.md` says they are published on purpose (the maintainers' C31) | The signer's tests and AF3-U2's e2e sign with them, and the dev and e2e builds pin their public halves; two negations by name, with their reason beside them, keep the exception visible and any other `.pem` ignored, also in that folder (round 1 used a wildcard: the review's N7). A secret scanner will flag the files: the security policy answers the report before it is made |
| U1-24 | The store build's rules origin is refused when it is a reserved or local name, an IP address, or the dev and e2e builds' origin (round 2, N2) | Such a store build could never fetch anything, silently |
| U1-25 | `--baseline` is digits only (round 2, N5); `prepare` names the ways to sign over SHA-256 and prints the file's SHA-256 for a device that signs a digest (N6) | `""` was read as 0, `0x10` as 16; a device given the file where it expects a digest signs the wrong thing (safely refused by `assemble`, but a hardware signature spent) |

### 9.4 Tests

- `rules-signed.test.ts` (42 tests; keys made by WebCrypto in the test, signatures made as the signer makes them):
  the signed file closed (each field missing, an extra one, not an object, not JSON, over 4,096 characters; `m` not a
  string or not printable ASCII; the kid's forms; the signature's: the standard alphabet, padding, 63 and 65 and 72
  bytes, a last character with stray bits); the manifest closed, its one text (spaces, another order, a key twice with the
  same and another value, `5.0`, `5e0`, a string), each field's form (format, schema, version, five time forms and three
  impossible dates, sha256, size at 0, 512 KiB and one more, source, licence); the signature over exactly the prefix and
  `m` (over `m` alone, another schema line, no newline: refused), a changed `m`, a flipped bit, another pinned key's kid,
  an unpinned key, and `m` unread before its signature; **every time bound on both sides** (a day ahead and a second
  more; created equal to and after expires; 180 days and a second more, and 400 days; one millisecond before expiry and
  at it); **the version bounds on both sides** (the baseline and one more; baseline + 1,000 and one more), the floor
  (the same and an older version replayed; the floor and the baseline each holding whatever the other says); the bundle
  (512 KiB exactly accepted, one byte more refused, `size` one more and one less, a changed byte, not ASCII, not JSON, a
  live bundle with `aliases`, `appends` or `upstream` even empty, a baseline, a shared suffix, no source, version,
  source and licence not the manifest's, reserved hosts only with the caller's option); **the record**: a later key
  compared with the baseline only and retiring the earlier one (whose bundles are then refused at any version), a fresh
  client's first bundle from the later key, a key before the record's refused even when the stored list lost it, **a
  removed key's record and floor deleted at the next read** (and kept while it is pinned), a retired key no longer pinned
  forgotten, a malformed record (eleven shapes) deleted, a refusal leaving the stored record as it was; **expiry**: the
  bundle gone at the instant it expires and the floor kept; a release as new as the bundle: the same; **switched off**:
  the bundle gone, floor and retired keys kept, so a replay and a retired key are still refused; a held text no longer a
  live bundle of its version not used; the pinned keys (`importPinned`'s eleven refusals; the test keys' entries equal the
  public halves of their files, and the kid is the first 16 bytes of the SPKI's SHA-256); `signed.ts` imports types only
  and names no network, storage or extension API; the JSON Schema's fields, consts, bounds and patterns against the
  checker's on samples.
- `rules-sign.test.ts` (22 tests, the tool run as a maintainer runs it): the round trip (the bundle byte for byte, the
  extension accepting the output with the test keys pinned, `created` the clock's, 120 days by default, 180 accepted, six
  bad `--days` refused with nothing written); the `next` key's bundle retiring `current`; in its output, a changed `m`
  (two ways), a changed bundle byte, the other key's kid, an unpinned kid: refused by the extension; never overwriting; an
  encrypted key with its passphrase piped in, a wrong one, none; a SEC1 file, a P-384 key, a public key as the key:
  refused; `kid` giving `rules-keys.mjs`'s entries from a private key, a public PEM and a DER; **a key written twice in the
  raw text** (top level, in `hosts`, and as `"fill"` beside `"fill"`), **a live bundle with aliases, appends or
  upstream**, a baseline, a shared suffix, an empty source, not ASCII, not JSON, over 512 KiB, a version at the baseline
  or 1,001 above it (1,000 above: signed): refused before signing, nothing written; `prepare` (the body and exactly the
  prefixed bytes), `assemble` from a DER and a raw signature, accepted; another key's signature, 63 raw bytes, DER read as
  raw and raw as DER: refused, nothing written; **DER to r‖s** on real signatures until both a padded (33-byte) and a
  short integer occur, each converted value verified, and ten malformed encodings refused (not minimal, negative, zero,
  a length off, trailing bytes, a long form, a 33-byte value, another tag, one integer); fifteen command lines refused
  with the usage and exit 2; no network in its source; REUSE for each new kind of path.
- `rules-update-gate.test.ts` (25 tests): the gate pinned closed and the origins; one source (`build.mjs` and
  `check-dist.mjs` alone import the gate; no environment variable); the guard in all four passes and the keys checked
  before the first pass; nothing in `src/` imports the updater, and only `signed.ts` names its marks; the store list
  empty, the test keys for dev and e2e; **the store list held to `released.json` by the order rule**, and the rule on
  sixteen pairs of lists; `updaterProblems`: dev and e2e none, the store build's two today, two good keys none, a test
  key, one key, a wrong kid, a key twice, eight bad origins; the guard's hooks (ten imports taken, nine left alone, the
  paths it gates, the graph check, the gate open, a failing build); **real bundles**: the worker's kind of entry and a
  lazy chunk's `import()` built without the module with the gate closed and with it open, a name imported from the empty
  module failing the build, and **a forced import (a file outside `src/`, an absolute path from `src/`) failing the
  build**.
- `rules-update-check-dist.test.ts` (9 tests; a prod and an e2e build made once, copies altered): the pristine builds
  pass and say where the updater is; each of `sixkey-rules-manifest`, `sixkey-rules-live` and `rules.fix.test` in the
  worker, the Fill chunk and a style sheet of the store build: refused; the same in the e2e build: allowed, but the
  database's name in a page chunk refused in both builds; each test key's kid, SPKI and base64url SPKI in a script or the
  manifest of a store build: refused, and allowed in the e2e build.

**Added in round 2** (§9.9): `importPinned` refusing each test key's compressed form, alone and beside the key itself,
a changed prefix byte, one byte more, and a point off the curve in the right form; no key pinned: no record used or
deleted, `heldBundle` none, a bundle refused, the record back with the keys; a retired key after the record's own dropped
from its list and the succession through it; `switchedOff` reading no pinned list (`rules-signed`); `kid`, `prepare` and
`assemble` with a compressed public key giving the uncompressed entry and an accepted result; `prepare` naming the ways
to sign and printing the digest; seven `--baseline` spellings refused (`rules-sign`); `ever` (three returns refused,
the same move passing without it), the same key twice (three ways), compressed test keys recognised as those keys in the
order rule and refused in a store build's list, seven store origins refused and three accepted, the test hosts not
filtered by the store origin, the guard given `src/` (a copy whose folders have other names, a linked `src/`), import
spellings in four other letter cases, `gated` on fourteen paths, a forced import in another case (`rules-update-gate`); the
three gate-closed marks also in the manifest and a page's HTML, a test key's point in five spellings, each line of a test
key's private PEM (`rules-update-check-dist`).

### 9.5 Mutants

Hand-made, one at a time, each against the behaviour tests named for it only (vitest, two workers), every mutated file
restored byte for byte and its SHA-256 compared after each run and all of them after the last; the harness is not in the
tree. **53 mutants, 53 killed**, each by a failing test (an assertion, or a test bundle that failed or built when it should
not), and the no-change run Z0 passed (`logs/mutants/`).

- **The plan's M3 set** (`rules-signed`, `rules-sign`): a future `created` accepted (M3a); a long validity accepted (M3b);
  a version over the bound accepted (M3c); an unpinned key's record and floor kept (M3d); a retired key accepted (M3e).
- **The rest of §5.2 and the record** (same files): `created = expires` (S01) and `now = expires` (S02) accepted; the
  baseline's own version accepted (S03); the floor ignored (S04), its own version replayed (S05), a later key held to the
  earlier key's floor (S06); succession retiring nothing (S07); an expired bundle kept (S08), expiry deleting the floor
  too (S09); switched off, the bundle kept (S10), or the floor and retired keys deleted (S11); the signature not checked
  (S12); the prefix not signed (S13); `m`'s one text not required (S14); `m` not ASCII accepted (S15); the bundle's size
  (S16), hash (S17), version (S18) or source (S19) not compared; a pinned entry's kid not its key's (S20); an unpinned kid
  verified with the first key (S21); a bundle the built-in one caught up with kept (S22).
- **The signer** (`rules-sign`): a key written twice not looked for (G01); the format's live check skipped before signing
  (G02); its output not checked before it is written (G03); no throwaway run before the key signs (G04); DER integers
  not in their shortest form (G05) or bytes after the SEQUENCE (G06) accepted; `--days` over 180 taken (G07); a file
  overwritten (G08); `prepare`'s bytes without the prefix (G09).
- **The guard and the build** (`rules-update-gate`): the guard resolving nothing (R01); its graph check gone (R02);
  `rules-fetch.ts` and `rules-live.ts` not gated (R03); the worker's pass without the guard (R04); a gate-open build with
  problems going on (R05).
- **The keys and the gate's checks** (`rules-update-gate`): any new key list allowed (K01); the first key not the old
  second (K02); an old key back as the second (K03); a test key allowed in the store build (U01); one key enough (U02);
  any http origin (U03).
- **check-dist** (`rules-update-check-dist`, real builds): the gate-closed marks not looked for (C01); a page naming the
  database (C02); the test keys not looked for (C03), or not in base64url (C04); the rules origins not among the gate's
  marks (C05); the gate-closed rule applied to every build (C06).

After check-dist came to read the test keys from `rules-keys.mjs` (U1-16), C01 to C06 and Z0 were run again on that code:
all six killed, Z0 passed.

**Round 2**: the 53 above on round 2's code (S10 and S11 on the new `switchedOff`; R01, R03, R04, K01 to K03 on the
rewritten guard, build and order rule; C04 redefined, below) and 18 new: S1a (the guard's comparison without the `i`
flag), S1b (paths not as the disk spells them), S1c (the `src/` prefix compared in its case), N8 (`src/` found by a folder
named `extension` again), S2a (`importPinned` taking any SPKI WebCrypto imports), S2b (the signer keeping a public key's
own spelling), S2c (keys compared by their text, not their point), S3a (`ever` ignored), S3b (the same key twice
allowed), MY13 (the review's: the gate-closed scan skipping the manifest and the pages, which lived in round 1), N2a (any
store origin of the right form), N2b (the test hosts filtered by the store origin), N3 (no key pinned: every record
deleted), N10 (a retired key after the record's own kept), N11a (a test key's point not looked for), N11b (its PEM lines
not looked for), N5 (`--baseline` read by `Number`), N6 (`prepare` not printing the digest). **71 of 71 killed**, Z0
passed, every file restored byte for byte (`logs-r2/mutants/`). The first run of these found C04 alive: with the point's
base64url among the marks, the SPKI's own base64url mark had become redundant (the SPKI's 27-byte prefix is a whole number
of base64's 3-byte groups, so its base64url ends with the point's), so no test could tell it apart. The redundant mark was
dropped, C04 became "a test key's base64url spellings not looked for" and N11a "its point not looked for", and Z0 and
every check-dist mutant (C01 to C06, MY13, N11a, N11b) were run again on that code.

### 9.6 Checks

In a worktree of `1047c5d`, `1047c5d`'s own prod, e2e and dev builds made in it first, with check-dist, before any change
(so the dev build's source maps compare like with like); every run through the shared runner (`nice -n 19`, its lock,
its own process group) after the one-minute load was under 24; vitest with `--maxWorkers=2`, Playwright with one worker.
The main working tree was not touched. Logs: `logs/`.

| Check | Result |
| --- | --- |
| `python3 scripts/messages.py`, twice | no change in the 44 generated files, on either run (this patch adds no text) |
| `npm run typecheck`; `bundle.mjs --check`; `import.mjs` | clean; up to date; 3 upstream files matching their pins and shapes |
| **prod, e2e and dev builds with `check-dist`, against `1047c5d`'s** | all OK; **143, 156 and 276 files, the SHA-256 of every one identical** to `1047c5d`'s: byte for byte the same, `sw.js` and the counted popup and side panel bytes included (popup 58,436 of 61,440 B, side panel 60,678 of 63,488 B, `sw.js` 101,589 B gz, finder 7,144 B gz, all as at `1047c5d`) |
| G1: the store build with the sync, suggestion **and rules-update** gates open (`sed` on the three constants), keys and origin as committed | **refused before anything is built** (rc 1, no output folder): "no rules origin", "pins 0 signing keys … it needs two" |
| G3: the same with an origin and the test keys in the store list | refused: "the store build pins a test key", for each |
| G4: check-dist on the pristine store build with the store list holding the test keys | fails on exactly those two lines ("the store build's list pins the test signing key …") |
| G2: the store build with the sync and suggestion gates open, the rules-update gate closed, through check-dist | OK; its 149 files identical to `1047c5d`'s build of the same (the AF3-4 merge's list); popup 59,430 B, side panel 61,665 B, as there. The gate files restored byte for byte after each run (SHA-256) |
| `npm run format:check`, `npm run notices:check` | clean; up to date (nothing new ships) |
| The store package | refused as before (rc 1: the store ID, the cloud plugin's ID, the bundle's source), nothing built |
| The new tests | 4 files, 86 tests passed |
| Mutants | 53 of 53 killed, Z0 passed (§9.5) |
| Full unit run | 352 files: 5,752 passed, 4 expected fail, 1 skipped, none failed. A first run found 8 failures in 4 files (`m6-gate`, `devread-build`, `externally-connectable`, `m5-build-guard`), which build the store build in a private copy of the extension without its test fixtures: check-dist read the test keys from those fixtures then (U1-16). After the change, those files and this patch's check-dist tests passed, C01 to C06 were killed again, and every check above was run again |
| e2e, one worker: every `rules-*.spec.ts`, `autofill1`, `perf`, `perf-idle`, `visual-guard` | 65 passed, none failed or skipped, on the e2e build above (byte for byte `1047c5d`'s); `perf`'s read counts (its gates) hold |
| The patch | applied to a clean `1047c5d` in a temporary index, it gives the worktree's tree; `git apply --check` passes on the main tree. An export of that tree alone (nothing else from the worktree) passes the four new test files, `rules-tools` and `rules-contract` (6 files, 150 tests) and `format:check`: it carries everything they need. (The first patch did not: `.gitignore`'s `*.pem` had left the test keys' files out, U1-23) |

### 9.7 What is not proven

- **Chromium's WebCrypto**: every check ran on Node's WebCrypto (22.21.1). Chrome's MV3 worker implements the same
  standard (ECDSA P-256 verification over r‖s, SHA-256, SPKI import), but nothing here runs it there: AF3-U2's e2e will.
- **A real hardware key**: `prepare` and `assemble` were tested with Node's DER and r‖s signatures, and once by hand with
  OpenSSL 4.0.3 (`openssl dgst -sha256 -sign` on `to-sign.bin`, assembled as DER and accepted); no PIV or PKCS#11 device
  was used, and "PKCS#11's ECDSA mechanisms return r‖s" is from the standard, not a run.
- **The passphrase typed at a terminal** (raw mode, no echo): the tests pipe it; the terminal path is not exercised.
- **A store build with the rules gate open** cannot be made until the two keys and the origin exist, by design (G1 and G3
  in §9.6 show the refusal). Opening it changes no built file today: the dev and e2e builds, whose gate is open, are
  byte for byte `1047c5d`'s.
- **check-dist's test-key rule** finds the keys as text (the kid, the SPKI in base64 and base64url, the point x‖y, x and
  y in hex and base64url, the private PEM's lines). A build that carried them another way (a byte array) would pass it;
  AF3-U2 is to carry them as `rules-keys.mjs` lists them. With only the uncompressed SPKI pinnable (S2), the build-time
  check and the run-time one (Chrome's WebCrypto) read the same form; whether Chrome would accept the compressed form is
  no longer a question the code depends on, and was not checked.
- **The guard on a disk that ignores case**: measured on macOS's (APFS, case-insensitive), where the disk's spelling and
  the case-free comparison both apply; on Linux (case-sensitive) only the case-free comparison of a spelling that names
  no file is exercised, by the hooks' tests.
- **The client trusts its clock**: a client whose clock is far off refuses a valid bundle (or keeps one past its time) by
  as much; whatever the clock, a bundle's validity is at most 180 days.
- **U1-11's "two new keys"** recovery list is this patch's reading of §5.3's "a release with new keys", accepted by the
  maintainers (C32); the plan's M3 NIT (a) states only the one-step move. `ever` is held by a unit test against a file
  each release updates by hand: a release that forgets to add its key to `ever` weakens the next check (SIGNING.md's
  step 3 says so).
- **REUSE**: no `reuse` tool here (CI runs it); `rules-sign.test.ts` applies `REUSE.toml`'s last-match rule to each new
  kind of path.

### 9.8 What it leaves

- **AF3-U2**: `rules-fetch.ts` and `rules-live.ts` (the guard already gates them by name, anywhere under
  `extension/src/`), the worker's record in `sixkey-rules-live` read through `readRecord`, kept from `checkSigned`, used
  through `heldBundle` and `inEffect`, `checkManifest` before each bundle is fetched, `switchedOff` on the switch; the
  pinned keys carried into the worker as `rules-keys.mjs` lists them (`importPinned` once per worker life, and these
  functions called only with the keys of a successful `importPinned`: on a failure the updater touches no record; with
  none pinned `readRecord` uses and deletes nothing, N3); the define that carries the gate into the code, and imports of
  these modules only through that gate's branch (the guard's empty module exports nothing); check-dist's gate-open
  requirements (§4.6: every mark where it belongs, `sk-af-rule` in the Fill chunk, the CSP's rules path) and, gate
  closed, the switch's storage key, `sk-af-rule` and `sk-af-rules-status` added to the marks no store build may name
  (N9); and AF3-4's §8.9 note: "the format's checker in the reader chunk alone, never in `sw.js`" changes with it.
- **AF3-U2, from the review's N9 and notes**: turning the switch off while an acceptance is under way: the write-back
  re-reads the switch and the record in the same IndexedDB transaction, so a switch just turned off is never overwritten
  by a record with a bundle; off and on again keeps the floor (M3 NIT c), so the published version is refused (`not
  above N`) until the next one: the status line must say so, not promise an update at once; `checkManifest`'s commonest
  refusal, "no newer version" (`m.version: not above …`), is the normal answer of a daily check, not an error to log (a
  reason code is AF3-U2's to choose); the e2e build's test bundles are signed with `signed.ts` directly (`sign.mjs`
  checks without `allowReserved`, so it refuses the fixture hosts).
- **AF3-U3**: the store build's origin, the two real keys (`rules/SIGNING.md`), `released.json`'s `store` and `ever`
  updated at that release, the gate's flip, the privacy notes, the worker's budget (C14).

### 9.9 Round 2: the review (merge after fixes, no MUST)

`REVIEW-AF3-U1.md` found no MUST, three SHOULDs and eleven NITs, confirmed the store build byte for byte, and ran three
mutants of its own (one lived: MY13, below). The maintainers' calls: C31 (the test keys stay committed, by their exact
names, and the security policy says so) and C32 ("two new keys" stays; `[old current, new]`, the review's N4.1, is not
taken; `ever` added). Done on `1047c5d` with round 1 applied, in a worktree at round 1's path (so the dev build compares
like with like with round 1's base lists).

| Finding | What changed | Test and mutant |
| --- | --- | --- |
| **S1** the guard compared paths as spelled: on macOS and Windows `../core/rules/Signed` passed both its checks | `rules-guard.mjs`: every path is compared as the disk spells it (`realpathSync.native`), and under the given `src/` without regard to letter case (`GATED_IN_SRC` has the `i` flag), in `resolveId` and in `buildEnd` | `rules-update-gate`: imports in four other cases taken; real bundles with `../core/rules/Signed` and `../Core/Rules/signed.ts`, gate closed, built without the module; a forced import of `src/Core/Rules/Signed.ts` from outside `src/` fails the build; a `src/` given through a link. S1a (no `i` flag), S1b (no realpath), S1c (the prefix compared in its case) |
| **S2** a key had two spellings, so two kids: one key as current and next, an old key as a new one, a test key past the store build's checks | `signed.ts importPinned` takes only the uncompressed P-256 SPKI (91 bytes, the fixed prefix `P256_SPKI_PREFIX`); `sign.mjs` writes every key in that form from its x and y (`kid`, `sign`, `prepare`, `assemble` give one kid); `rules-keys.mjs` compares keys by their point (`pointOf`, `sameKey`) in the order rule, `updaterProblems` and check-dist's store-list check | `rules-signed`: each test key's compressed form refused, alone and beside itself, and four more malformed forms; `rules-update-gate`: the compressed test key recognised as that key in the order rule, and refused in a store build's list for both reasons; `rules-sign`: `kid --public <compressed PEM>` gives the uncompressed entry, `prepare`/`assemble` with it accepted. S2a, S2b, S2c |
| **S3** the order rule looked one release back: a dropped (perhaps stolen) key could return two releases later | `released.json` gains `ever` (every key a release pinned, only growing); `keyOrderProblem(previous, next, ever)` refuses a key of `ever` not in `previous`, and the same key twice; SIGNING.md's step 3 updates both | `rules-update-gate`: three returns refused, and passing without `ever`; `[K, K]` three ways; `released.json`'s `ever` holds its `store`. S3a, S3b |
| N1 the gate-closed marks were not tested in the manifest or a page | the three marks also put into `manifest.json` and `options/index.html` | `rules-update-check-dist`. The review's MY13 (the manifest and the pages skipped), which lived in round 1, killed |
| N2 the store origin could be a test, reserved or IP host, or the dev and e2e origin | `updaterProblems("prod")` refuses those (`storeOrigin`); check-dist's dev and e2e hosts (`testRulesHosts`) are no longer filtered by the store origin | `rules-update-gate`: seven origins refused, three accepted; the hosts unfiltered. N2a, N2b |
| N3 with no key pinned, `readRecord` and `switchedOff` deleted every record | `readRecord` with none pinned: no record, unchanged; `switchedOff(stored)` reads no pinned list (it drops the bundle of any record of the shape); the header and §9.8 say the updater calls these with a successful `importPinned`'s keys only | `rules-signed`: none pinned, nothing used or deleted, and the record back with the keys; `switchedOff` on an unpinned kid. N3 (and S10, S11 on the new `switchedOff`) |
| N4 U1-11 | C32: "two new keys" kept, `[old current, new]` not taken; SIGNING.md says that with two new keys clients of the old release stop updating once the server signs with them, until Chrome updates them (usually a day or two), keeping their unexpired bundle, then their built-in rules | — |
| N5 `--baseline` took `""`, `0x10`, `1e3` | digits only | `rules-sign`: seven spellings refused. N5 |
| N6 "the device hashes it" | SIGNING.md and `prepare`'s message: sign over the SHA-256 with a mechanism that hashes (`CKM_ECDSA_SHA256`, `openssl dgst -sha256 -sign`, `yubico-piv-tool` with `-H SHA256`), or give a digest-signing device the file's SHA-256, which `prepare` prints | `rules-sign`: the message names them and carries the digest. N6 |
| N7 the wildcard in `.gitignore`; a scanner's report | C31: the two exact names; `SECURITY.md` Out of scope: the two test keys are published on purpose, dev and test builds accept them, store builds refuse them | the export check of §9.10 (the tree carries both files) |
| N8 the guard found `src/` by a folder named `extension` | `build.mjs` passes `resolve(root, "src")` to every pass's guard (`rulesGuard(on, srcRoot)`; by default the `src/` beside the script) | `rules-update-gate`: a copy whose folders have other names guarded, another `src/` not; the build's four passes pass `RULES_SRC`. N8 |
| N9 §9.8's list for AF3-U2 | the switch's key and the two message names as gate-closed marks; the switch-off race; off and on waiting for the next version; "no newer version" as the normal answer; e2e bundles signed with `signed.ts` | — |
| N10 a retired key after the record's own blocked the succession | `readRecord` keeps only retired keys before the record's own (the list filtered, the record kept) | `rules-signed`: such a record read, and the later key's bundle accepted. N10 |
| N11 the test keys found by three spellings only | also their point (x‖y, x, y, in hex and base64url) and, where the fixtures are there, each line of their private PEM | `rules-update-check-dist`: five point spellings for each key, each PEM line. N11a, N11b |
| Wording (U1-6) | "`m` is not parsed and none of its fields read before its signature verifies (only its length and kind of characters)" in `signed.ts` and U1-6 | — |

### 9.10 Checks of round 2

In a worktree of `1047c5d` with round 1 applied and changed in place, at round 1's path; every run through the shared
runner after the one-minute load was under 24; vitest with `--maxWorkers=2`, Playwright with one worker. The main working
tree was not touched. Logs: `logs-r2/`.

| Check | Result |
| --- | --- |
| `python3 scripts/messages.py`, twice; `npm run typecheck`; `bundle.mjs --check`; `import.mjs` | no change in the 44 generated files, on either run; clean; up to date; 3 upstream files matching their pins |
| **prod, e2e and dev builds with `check-dist`, against `1047c5d`'s** | all OK; **143, 156 and 276 files, the SHA-256 of every one identical** to round 1's base lists of `1047c5d` (made in this same folder): byte for byte. Popup 58,436 B, side panel 60,678 B, `sw.js` 101,589 B gz, as at `1047c5d` |
| G2: the store build with the sync and suggestion gates open (rules gate closed), through check-dist | OK; its 149 files identical to round 1's list (`1047c5d`'s) |
| G1, G3, G4 as in round 1 | the same refusals |
| G5 (N2): check-dist with the rules gate open and the store origin set to the dev and e2e one, on a copy of the store build naming it | fails on it ("names the dev and e2e builds' rules origin `rules.fix.test` in a store build"); the gate files restored byte for byte after each run |
| `npm run format:check`, `npm run notices:check`; the store package | clean; up to date; refused as before, nothing built |
| The new tests | 4 files, 98 tests passed |
| Mutants | **71 of 71 killed** (round 1's 53 and 18 new), Z0 passed; C01 to C06, MY13, N11a, N11b and Z0 again after the last check-dist change (§9.5) |
| Full unit run | 352 files: 5,764 passed, 4 expected fail, 1 skipped, none failed |
| e2e, one worker: every `rules-*.spec.ts`, `autofill1`, `perf`, `perf-idle`, `visual-guard` | 65 passed, none failed or skipped; `perf`'s read counts hold |
| The patch | applied to a clean `1047c5d` in a temporary index, it gives the worktree's tree; `git apply --check` passes on the main tree; an export of that tree alone passes the four new test files, `rules-tools` and `rules-contract` and `format:check` |

## 10. AF3-U2: the updater and its switch

> **Round 2** (the review, `REVIEW-AF3-U2.md`, "merge after fixes", no MUST; the maintainers' C34): §10.10 lists its two
> SHOULDs and eight NITs, each with its change, its test and its mutant; round 2's checks are §10.11. §10.2 to §10.4,
> §10.8 and §10.9 describe the code as it is now; §10.5 to §10.7 are round 1's tests, mutants and checks, which §10.10 and
> §10.11 extend.

**In a build whose updater's release gate is open (the dev and e2e builds; the store build once the owner opens it,
AF3-U3), Sixkey can take signed site rules between releases**: Settings › Security › Autofill has "Get the latest site
rules", off by default; with it on, the worker reads the signed manifest once a day, checks it and the live bundle it
names with AF3-U1's checks and the format's whole checker, keeps the bundle in its own IndexedDB database, and the
popup's and the side panel's Fill paths ask the worker for the page's rule. **The store build, as shipped and with both
UI gates open, is byte for byte `9feef76`'s** (143 and 149 files, §10.7): with the gate closed, every line of the
updater is dead code the build removes, its modules are out of every module graph (AF3-U1's guard), and check-dist
refuses each of its marks. The keyboard shortcut still takes no rule (the maintainers' C27, §10.8).

### 10.1 Phase 0: the sizes measured, and the maintainers' decision

The plan estimated +2.5 to 3.5 KB gz for the worker (§R2.1). A prototype in a worktree of `9feef76`, measured before any
patch was written (builds through the shared runner; the store build with all three gates open made with the test origin
and test keys by measure-only edits of the gate files, never in a patch), gave instead:

| `sw.js`, B gz | e2e build (limit 106,496) | store build, three gates open (limit 106,496) |
| --- | --- | --- |
| `9feef76` | 104,555 | 103,166 (two UI gates) |
| **A** (the plan: fetch, `signed.ts`, the format's checker, the record, one host's rule) | 113,180 (+8,625) | 111,855 (+8,689) |
| B (the worker checks the signature and the bundle's frame; the reader checks the bundle whole at use) | 109,818 (+5,263) | 108,433 (+5,267) |
| C (the worker fetches and keeps; pages check the signature) | 105,954 (+1,399) | 104,556 (+1,390) |
| A and the shortcut taking rules | 113,862 (+682 on A) | 112,621 (+766 on A) |

Standalone, minified: the format's checker 3,854 B gz, `signed.ts` 3,783 to 3,864 B (its 53 reasons about 740 B of it),
the read 480 B. The Fill chunk with its reader stayed under its 12,288 B (A 10,874; B 10,935), the popup and the side
panel within C30 with all three gates open (A 59,429 / 61,665; B 59,431 / 61,668). The shortcut taking rules without the
updater, the gate closed: 101,589 → 106,005 B (491 B under the limit).

**The maintainers' C33**: approach A. B only postpones the checker's 3.4 KB to the day the shortcut takes rules (C27),
where it ends as large as A; A keeps one place that checks everything before anything is taken (the plan's §5.2, M3 and
AF3-U1's `checkSigned` with the format's checker as reviewed), pages get one host's rule (S9, C20), and B's concession
(a correctly signed bundle the format refuses would move the floor) does not arise. The worker's limit is raised by 9
KiB for the dev and e2e builds only (`RULES_UPDATER_GZ`); the store build's stays 106,496 B whatever its gate, so a
store build with the gate open fails on its worker's size until the owner agrees to the room (AF3-U3). The prototypes'
numbers (B, C) are kept above for comparison.

### 10.2 What was built

| Part | Where |
| --- | --- |
| The one read of the rules origin, `getCapped(url, max, fetch)`: GET, `credentials: "omit"`, `referrerPolicy: "no-referrer"`, `redirect: "error"`, `cache: "no-store"`, `Accept-Language: *`, 20 s for the whole read, a byte cap counted as the body arrives (4,096 B for the manifest, 512 KiB for a bundle), one attempt, null for anything else | `extension/src/platform/rules-fetch.ts` (new) |
| The updater, `createUpdater(deps)` and the worker's `updater()`: the database `sixkey-rules-live` (one object store: the switch `sk_rules_switch`, the record, the next due time, when the bundle was taken), the daily check, the Fill paths' answer, the switch and its status | `extension/src/platform/rules-live.ts` (new) |
| The worker: the daily check on `sk-daily`, a listener of its own for the two messages, the test builds' hook `__skRules`; each statement behind the define where it stands | `extension/src/background/sw.ts` |
| The two messages' table, with the gate open only (`RULES_SENDERS`, `rulesMessage`): `sk-af-rule` from the popup and the side panel, `sk-af-rules-status` from the settings page | `extension/src/platform/sender-policy.ts` |
| The Fill paths ask the worker while they read the package, 1 s at most; the three answers | `extension/src/platform/site-rule.ts` |
| The switch and its status line, a lazy chunk the settings page loads with the gate open; its own text | `extension/src/options/RulesUpdate.tsx` (new), `src/options/Misc.tsx`, `scripts/i18n/af3u2.py` (new), `scripts/messages.py` (the `RULES` catalog, its budget), `catalogs/rules-<lang>.json` (generated) |
| The build: the gate, the origin, the pinned keys and the built-in rules' version as defines (the last three only with the gate open); the CSP's one rules path more with the gate open; the switch's text chunks named | `extension/scripts/build.mjs`, `scripts/rules-update.mjs` (`rulesPathOf`) |
| The worker's limit by flavour (`swBudgetOf`): `SW_BUDGET_GZ`, and `RULES_UPDATER_GZ` for dev and e2e | `extension/scripts/sw-budget.mjs` (new) |
| check-dist: §4.6's updater row both ways; the CSP; the worker's fetch; the format's checker in the worker with the gate open; the URL rule; the worker's limit; the test hook as a dev marker | `extension/scripts/check-dist.mjs` |
| Docs | `docs/ARCHITECTURE.md` (the database), `extension/README.md`, `scripts/rules-update.mjs` and `rules-keys.mjs` headers |
| Tests | `test/unit/rules-live.test.ts`, `rules-update-fill.test.ts`, `rules-update-worker.test.ts`, `test/e2e/rules-update.spec.ts`, `test/helpers/rules-live-kit.ts`, `rules-server.ts` (new); cases in `rules-update-gate`, `rules-update-check-dist`, `autofill-pre-source-rules`, `autofill1-check-dist`, `cloudbk-check-dist`, `budget-split`, `m5-source-rules`; `sw-world.ts` (a `rules` option), `autofill-helpers.ts` (`rulesPort`), `panel-helpers.ts` (`cdp`) |

`REUSE.toml` is unchanged (every new path is under `extension/**`); no dependency, permission or manifest key is added.

### 10.3 How an update is taken and used

- **The switch** (`status(on)`, `sk-af-rules-status` from the settings page alone): off unless the user turns it on. On:
  the switch is written, a check runs at once, and the answer comes once it is over (the page shows the result). Off: in
  one transaction, the switch, and the record without its bundle (`switchedOff`: the floor and the retired keys stay, so
  off and on again is not a fresh install, M3 NIT c), and the date. While the switch is off the record is not used at
  all, whatever it holds (S8). The status line: "Site rules: built in, version N", or "updated on <the day this browser
  took them> (version M)"; after off and on again, with a floor above the built-in rules and no bundle in use, also
  "Waiting for a version newer than M" (AF3-U1's §9.8: no update promised at once). The page shows the worker's last
  real answer only (round 2, C34): turning it on shows "Checking for newer site rules…" while the check runs, the box
  disabled; a turn that gets no answer asks the status again and shows it (or, unanswered again, what was shown before
  the click) with "That didn't go through. Try again."; once drawn, the switch never goes away; a first read that fails
  twice draws it disabled with "This setting can't be read right now. Reload the page to try again."
- **The daily check** (`check()`, on `sk-daily`, every 6 hours): with the switch on, and the next check due (the last
  one + 24 hours + a random 0 to 6 hours, written before anything is read: one attempt a day, a failed one included; a
  due time further away than that, set while the clock was ahead, is due at once: round 2, N2),
  the manifest (`/v1/manifest.json`, 4,096 B at most); `checkManifest` (the pinned key and its signature, `m`'s form,
  the times, the version against the built-in rules' and the key's floor); only for a manifest it takes, the bundle it
  names (`/v1/bundle-<version>.json`, 512 KiB at most), and `checkSigned` with the format's whole checker (`validate`,
  the host checks; the e2e build's reserved test hosts allowed by the build's define). A bundle taken is written in a
  transaction that reads the switch again first, so a switch turned off while it was on its way is never overwritten
  (§9.8). How a check ended is a code (`off`, `later`, `keys`, `net`, `same`, `manifest`, `bundle`, `new`): `same`, "no
  newer version", is the usual answer of a day, not an error (§9.8); nothing is logged. Checks run one after another.
- **The Fill paths' answer** (`answer(host)`, `sk-af-rule` from the popup and the side panel): `null` while the switch
  is off, with no record, with a held bundle that expired, that the built-in rules have reached, or that is no longer a
  valid live bundle of its version (`heldBundle`); else `{v, rule}`: the bundle's version and its rule for the host, or
  `rule: null` for a host it does not name. The record as `readRecord` reads it now is written back when it differs
  (what it deletes at a read is deleted). The bundle is checked once per worker life and version.
- **In the Fill path** (`site-rule.ts ruleForPage`): the ask starts before the package's read, and waits 1 s at most.
  `{v, rule}`: that rule, final: a `null` rule is no rule, the package's is not taken (the live bundle replaces the
  built-in rules whole: R4-1, C24; the maintainers' C33). `null`, no answer in time, no answer at all, or an answer of
  another shape: the package's rule, as before. The appends always the package's (`appendsOn(baseline, host)`).
- **The database** is there in every gate-open build once a Fill path has asked or a daily alarm has fired: the switch
  is in it, so that first ask or alarm opens it, and creates it empty, even if the switch is never turned on (round 2,
  the review's N3).
- **The keys**: imported once per worker life from the build's define (`rules-keys.mjs`'s list, as written); if that
  fails or pins none, the updater reads, writes and answers nothing (AF3-U1's §9.8).
- **What the server learns**: the request's IP address and time, the User-Agent, `Origin: chrome-extension://<id>`,
  `Accept-Language: *`, the `sec-fetch-*` headers and, over https, the low-entropy client hints (the plan's S10; the
  privacy notes are AF3-U3's, at the flip). No cookie, referrer, account or site.

### 10.4 Decisions and deviations, with reasons

| # | Decision | Why |
| --- | --- | --- |
| U2-1 | Approach A (the maintainers' C33): the worker fetches, checks with `checkManifest`, then `checkSigned` and the format's whole checker, keeps the record, and answers one host's rule | §10.1. One place checks everything before anything is kept; the reviewed `checkSigned(…, validate)` used as it is |
| U2-2 | The worker's limit: +9 KiB (`RULES_UPDATER_GZ`) for the dev and e2e builds; the store build's 106,496 B whatever its gate, in a module that reads no gate (`scripts/sw-budget.mjs`) | The maintainers' C33 and C27: the store build's room is the owner's to give, at the flip (AF3-U3, the plan's C14); until then a store build with the gate open fails on its worker's size, which forces that decision. The e2e build measures 113,616 B in round 2 (2,096 B under its limit; 113,592 B in round 1) |
| U2-3 | The worker answers from the live bundle only; with none in use, `null`, and the Fill path reads its own package (it reads it anyway, for the appends). A deviation from §4.4's "answers from the live record or the baseline" | The worker then carries no package reader (C27's rule "`sw.js` reads no package file" holds), and no second copy of the built-in rules. Three answers, as C33 asks: a rule; none for this host (final: the package's rule is not taken, C24); none in use (`null`) |
| U2-4 | The switch is a key of the updater's own database (`sk_rules_switch`), read and written by the worker alone; Settings sets it through `sk-af-rules-status` | §9.8 asks the write-back to read the switch and the record in one IndexedDB transaction; no `chrome.storage` key, so no storage read of a page or of the worker's start changes (perf, W2B-04); pages never open the database (S9) |
| U2-5 | The built-in rules' version comes into the worker as a define, from the very text the build checks and writes | No package read in the worker (U2-3). A bare number cannot be found in a minified script, so a source test holds the define to the checked text, and the e2e test the behaviour (version 1 refused as "not newer", 2 taken) |
| U2-6 | The pinned keys and the origin are defines too, only with the gate open (`[]` and `""` otherwise, read by no code then); `rules-keys.mjs` (it reads `node:crypto`) is imported by no source | AF3-U1's §9.8. A source test holds both |
| U2-7 | The CSP gains `<origin>/v1/` in a build with the gate open, written by the build (the manifest files are unchanged) | "Exactly the rules path" (§4.6); the store build's CSP is untouched with the gate closed; check-dist holds the CSP to it both ways |
| U2-8 | AF3-5's NIT-2: `appendsOn` keeps taking the package's baseline only, now pinned by tests | A `try` of its own would change the store build's Fill chunk; the live answer is a rule, never a bundle, so it cannot reach `appendsOn` |
| U2-9 | The switch's text: a catalog of its own (`RULES`, `catalogs/rules-<lang>.json`), never in `_locales`, loaded by the switch's chunk alone, as the Sync section's | A store build with the gate closed carries none of it (check-dist looks for the words and the chunks) |
| U2-10 | The gate is the define used where it stands (`typeof __RULES_UPDATE__ === "boolean" && __RULES_UPDATE__`), in `Misc.tsx` inside a JSX conditional with the page's own last line on both sides | Found in phase 0: a module constant made the minifier keep `Ao=!1` and a child `Ao` in the settings page's chunk, so the store build changed; this form folds away whole (the build lists hold it) |
| U2-11 | The worker's listener is a named function registered at the top level behind the define (`if (…) chrome.runtime.onMessage.addListener(rulesListener);`), and the daily check is a line of the existing alarm listener | Every listener of the worker is registered at the top level (the access-level source rule); the store build's worker is unchanged |
| U2-12 | `getCapped` takes its fetch as an argument (no default) | The worker names `fetch` once more only (check-dist counts it: the sync transport, and with the gate open the updater) |
| U2-13 | One attempt; the next due time is written before the manifest is read | A server that fails is asked again the next day, not at every 6-hourly alarm |
| U2-14 | Checks run one after another (a queue); turning the switch on waits for its check | An alarm and a click cannot read and write the record at once; the status line then shows the result of that click |
| U2-15 | "updated on" is the day this browser took the bundle, not the bundle's `created` | What the user can relate to; the bundle's own date can be weeks older |
| U2-16 | check-dist's AF3-4 S2 rule, with the gate open: the format's checker in the reader and in `sw.js`, nowhere else; the e2e build's reserved test hosts accepted in both; the rule's probe allows white space (the worker is minified without removing it) | The maintainers' C33 item 7; the gate-closed rule is as it was |
| U2-17 | The fetch rule counts words without the bundler's `//#region` marks | The e2e worker carries `//#region src/platform/rules-fetch.ts`, a file name, not a call |
| U2-18 | The test builds' hook `__skRules` (a check started by a test, as `__skFill`), a dev marker in a prod build | The browser test drives each refusal without waiting for an alarm |
| U2-19 | In the browser test, `rules.fix.test` is the rules origin (a TLS server of the test's), not the test rule's page host; `live.fix.test` is a page host no built-in rule names | The e2e build's origin is `https://rules.fix.test` (AF3-U1); the host rule maps a name to one port |
| U2-20 | The toolbar popup's database opens are counted by loading it again through the DevTools protocol with the count installed first | Playwright's init scripts do not reach the toolbar popup (measured: not instrumented); the settings page, a tab, is counted from its first script |
| U2-21 | C24's "no fallback" (a live answer without the host's rule is final) holds when the worker answers. No answer within 1 s, or a worker that fails, falls back to the package's rules, as the plan's S9 has it; the worker is not warmed in advance (round 2, the review's N1) | S9's own rule: a page does not wait on the worker longer than its look takes. Checking even an 800 KB bundle took 12 to 22 ms in the review's measure, so a late answer comes from a worker's cold start |
| U2-22 | The switch shows the worker's last real answer only and never goes away once drawn: a turn with no answer asks again, then shows what was there before the click, with a line; "Checking…" while turning on waits; a first read tried twice, then the switch drawn disabled with a line to reload (round 2, the review's S1, the maintainers' C34) | Turning it off is how a user drops downloaded rules at once when a key is in doubt: the page must not show "off" while a bundle is in use, nor lose the switch |
| U2-23 | A due time further away than now + 24 h + 6 h counts as due (round 2, the review's N2) | A clock that was ahead when a check set it would otherwise stop the daily checks for as long, with nothing said |

### 10.5 Tests

- **Unit**, `rules-live.test.ts` (32 tests; a real IndexedDB, fake-indexeddb; the real `signed.ts` and format's checker;
  keys made in the test; the rules server a stub of fetch that records each request):
  - the read (`getCapped`): exactly GET, `credentials: "omit"`, `referrerPolicy: "no-referrer"`, `redirect: "error"`,
    `cache: "no-store"`, `Accept-Language: *` and a signal of 20 s (`AbortSignal.timeout(20000)`), nothing else; one
    attempt (a failing fetch called once); only a 200 read (204, 301, 304, 404, 500 null); the cap: exactly 4,096 B and
    512 KiB read, one byte more null and the read cancelled there; a body that stops half way ended by the signal;
  - the switch: off by default (no request, no answer, the built-in status); on: a check at once, the manifest then the
    bundle, the status with the version and the date; the three answers (the rule; `{v, rule: null}` for a host the
    bundle does not name, its `www.` variant too; `null` while nothing is in use); off: the bundle gone in the same
    transaction, the floor and the retired keys kept, the date gone; on again: the same version not taken, the status
    with the floor, a retired key's bundle refused, a newer one of the record's key taken; **S8**: a record holding a
    bundle beside a switch that is off is not used (answer, status, check);
  - the cadence: due at 24 hours plus `random × 6` hours (three draws), nothing read before it, the manifest alone at it
    (the same version: `same`); a failed read waits for the next due time too; a newer version taken and answered; two
    checks one after the other;
  - eleven refusals, each leaving the record as it was (only the due time moves): a key not pinned, a pinned key's id
    over another key's signature, the built-in rules' version (`same`), more than 1,000 above it, made more than a day
    ahead, valid more than 180 days, a bundle not the manifest's, a live bundle with alias groups or appends (M1), a
    reserved test host (the store build's checker), a selector the grammar refuses; the e2e build's checker takes its
    test hosts; keys that do not import (none, a wrong kid, not a list): nothing read, written or answered;
  - at a read: the bundle gone at the instant it expires, the floor kept; a release whose built-in rules reach the
    bundle's version: the built-in rules, the floor kept; **§9.8**: the switch turned off while the bundle is on its
    way: nothing written;
  - the source: the format's whole checker passed to `checkSigned` and `heldBundle`; the manifest checked before the
    bundle is fetched.
- **Unit**, `rules-update-fill.test.ts` (10 tests; `site-rule.ts` with the gate's define stubbed, the package's read and
  the worker's answer stubbed): the ask names the host as `hostOf` writes it and runs while the package is read; a live
  rule's hint and `minLeft` instead of the package's; **C24/C33**: `{v, rule: null}` gives no rule though the package
  has one (both test hosts); `null`: the package's rule; no answer within `ASK_MS` (1,000 ms, fake timers: 999 not yet)
  and a later answer changing nothing; a rejected message and six answers of another shape: the package's rule;
  **NIT-2**: the appends the package's whatever the worker says; the gate closed (false, or no define): nothing sent;
  the source (`appendsOn(baseline, host)` once; the ask before the read; no database named).
- **Unit**, `rules-update-worker.test.ts` (7 tests; the real worker, `sw-world.ts` with a `rules` option): gate closed:
  four listeners, the two messages answered by none, the daily alarm opens no updater database; gate open: a fifth
  listener, `sk-af-rule` from the popup and the side panel only and `sk-af-rules-status` from the settings page only,
  answered after the work, nothing at all from the other pages and five hostile senders (the database not even opened);
  Settings turns the switch on, a check at once, the Fill paths' answers (a rule, none for another host, `null` for a
  host that is no string, `null` once off); `sk-daily` runs the check when it is due; the hook in a test build only;
  `rulesMessage` refuses look-alikes, inherited types and other shapes, and the main table never takes the two.
- **Unit**, `rules-update-check-dist.test.ts` (25 tests: AF3-U1's 9 and 16 new; one more in round 2, §10.10; a prod and
  an e2e build made once, copies altered): gate closed, AF3-U2's marks (the switch's key, either message, an English and
  a Chinese line of the switch) in the worker, the Fill chunk, the manifest and a page; the switch's chunk and its text
  chunk by name; gate open: the manifest's format, the switch's key and the origin in a page chunk; each message where
  it does not belong (four places); each mark missing from where it must be (five); the switch's chunk loaded by the
  popup's chunk, its text changed, its text missing, its text loaded by the Fill chunk, the switch's chunk missing; the
  CSP without the rules path, with the whole origin, with another path; a third fetch in the worker; the checker's list
  out of the worker, in the boot chunk; reserved hosts refused by the e2e worker; the origin's URL in the Fill chunk;
  the worker's limits (`swBudgetOf`: prod 106,496 whatever the gate, e2e and dev 115,712; the module imports nothing;
  check-dist uses it); the store build's worker over 106,496 B refused, the e2e build's at 113,592 B passing, over
  115,712 B refused.
- **Unit**, other files: `rules-update-gate` (the updater reached from the worker alone, by `import()`, behind the
  define where it stands, three times; `rules-fetch` and `signed` imported by `rules-live` alone; the database, the
  switch's key, its one open in `rules-live.ts` alone, no rules origin in a source; the build's four values and the
  CSP's path with the gate open only); `autofill-pre-source-rules` (the two types in their own table, the two pages that
  send them, five listeners, the fifth's first act its own gate); `autofill1-check-dist` (the e2e worker's checker and
  reserved hosts, no package read); `cloudbk-check-dist` (the e2e worker's fetch count); `budget-split` (the `rules`
  catalog's budget, in both places); `m5-source-rules` (the updater's one `fetch`, passed to the read).
- **Chromium through the extension**, `rules-update.spec.ts` (2 tests; a TLS rules server at `rules.fix.test`, the test
  keys): before, the built-in rules (no box on `live.fix.test`, the test group on `rules2.fix.test`) and no request; the
  switch off, the status "built in, version 1" and the origin's host; on: the manifest then the bundle, each request GET
  with `Accept-Language: *`, no cookie, no referrer, `Origin: chrome-extension://<id>`; the status "updated on …
  (version 2)"; the Fill path: the live rule's box found and filled on `live.fix.test`, no box on `rules2.fix.test`
  (whole replacement); off: the built-in rules at once; on again: "Waiting for a version newer than 2", the manifest
  alone read; a newer one taken; **no page opened `sixkey-rules-live`**: the settings page counted from its first
  script, the toolbar popup loaded again with the count installed first and its look with the live rule done (§10.4
  U2-20). The second: no grant covers the origin (`permissions.contains` false); **a server without
  `Access-Control-Allow-Origin`** fails (`net`) though the request reached it; a redirect fails; six refusals (a key not
  pinned, a pinned kid over another key's signature, the built-in version, expired, a bundle not the manifest's, alias
  groups); then v2 by `current` taken, v3 by `next` taken, v4 by `current` refused (retired), v4 by `next` taken, and
  the live rule used.

### 10.6 Mutants

Hand-made, one at a time, each against the behaviour tests named for it only (vitest, two workers; or, for three of
them, the e2e build made again and `rules-update.spec.ts` run, one worker, without check-dist, which would refuse them
before any behaviour is seen), every mutated file restored byte for byte and its SHA-256 compared after each run and all
of them after the last; the harness is not in the tree (`logs/mutants/`). **42 of 42 killed**, each by a failing test;
the no-change runs Z0 (the four unit files) and Z0e (the browser spec) passed.

- **The read** (`rules-live.test.ts`): credentials sent (F01), a referrer (F02), redirects followed (F03), the cache
  (F04), no `Accept-Language: *` (F05), a minute instead of 20 s (F06), no byte cap (F07), any status under 400 read
  (F08), no time limit (F09), a failed read tried again (F10).
- **The updater** (`rules-live`, and `rules-update-worker` where named): **S8**, the record used while the switch is off
  (both files); a check while it is off (L02); no random part (L03); every 6 hours instead of 24 (L04); the due time not
  read (L05, both); a failed check tried again at the next alarm (L06); **§9.8**, the write-back not reading the switch
  again (L07); off keeping the bundle (L08) or deleting the floor and the retired keys (L09); **C24 in the worker**, a
  live bundle without the host's rule answered as none in use (L10, both); the format's checker not used (L11); reserved
  test hosts accepted in every build (L12); no pinned key and the updater going on (L13); a manifest not newer going on
  to the bundle (L14); the floor not in the status (L15); what `readRecord` deletes not written (L16).
- **The Fill path** (`rules-update-fill`): **the maintainers' C33 mutant**, a live answer without a rule taken as none
  in use, so the package's rule (N1); no time limit on the ask (N2, the test's own timeout); the answer's shape not
  checked (N3); the ask sent with the gate closed (N4).
- **The messages and the worker** (`rules-update-worker`): `sk-af-rule` from the settings page (P1); the sender not
  checked (P2); `sk-daily` not running the check (W1); the updater's listener in a build with the gate closed (W2).
- **In Chromium** (`rules-update.spec.ts`): **S9**, the Fill path opening `sixkey-rules-live` (two forms: a bare open,
  which also breaks the worker's database, killed when the settings page cannot draw the switch; and an open that makes
  the store as the worker does and closes it, S9b, killed by the popup's count of opens); N1 again (N1e: killed at "no
  rule on rules2.fix.test").
- **check-dist** (`rules-update-check-dist`, real builds): gate open, the marks' places not held (C1); the CSP without
  the rules path (C2); the store build's worker limit following the gate (C3, in `sw-budget.mjs`); gate closed, AF3-U2's
  marks not looked for (C4); gate open, the format's checker let anywhere (C5).

### 10.7 Checks

In a worktree of `9feef76`, `9feef76`'s own prod, e2e and dev builds made in it first, with check-dist, before any
change (their lists equal to the AF3-U1 merge's: 143, 156 and 276 files; the store build with both UI gates open, 149);
every run through the shared runner (`nice -n 19`, its lock, its own process group) after the one-minute load was under
24; vitest with `--maxWorkers=2`, Playwright with one worker. The main working tree was not touched. Logs: `logs/`
(`INDEX.md`).

| Check | Result |
| --- | --- |
| `python3 scripts/messages.py`, twice | no change in the 46 generated files on either run (the two new `catalogs/rules-<lang>.json` are this patch's) |
| `npm run typecheck`; `bundle.mjs --check`; `import.mjs` | clean; up to date; 3 upstream files matching their pins |
| **The store build (prod), with check-dist, against `9feef76`'s** | OK; **143 files, the SHA-256 of every one identical**: `sw.js` 101,589 B gz, popup 58,436 B, side panel 60,678 B, the Fill chunk with its reader 10,143 B, as at `9feef76` |
| **The store build with both UI gates open** (`sed`, put back), through check-dist | OK; **its 149 files identical to `9feef76`'s**; popup 59,430 B, side panel 61,665 B (C30: ≤ 59,640 and ≤ 61,688) |
| The store build with the rules gate open too | refused before anything is built (rc 1, no output folder): no rules origin, no signing key, as at AF3-U1; the gate files restored and compared |
| The e2e build, with check-dist | OK; 156 → 159 files (the switch's chunk and its two text chunks; 25 files changed, most by hashed names); **`sw.js` 113,592 B gz of 115,712** (+9,037 on `9feef76`'s 104,555; round 2's, the figure `sw-budget.mjs` gives: 113,616 B, +9,061, §10.11); the Fill chunk with its reader 10,922 B of 12,288 (+124); popup 59,662 B and side panel 61,903 B, as before; the switch's chunk 683 B gz, its text en 274 B and zh_CN 377 B of 2,048; the CSP `connect-src http://127.0.0.1:8787 https://rules.fix.test/v1/` |
| The dev build, with check-dist | OK; 276 → 282 files (the three chunks and their maps); `sw.js` 224,592 B gz (not held) |
| `npm run format:check`, `npm run notices:check` | clean; up to date (nothing new ships in a store build) |
| The store package | refused as before (rc 1: the store ID, the cloud plugin's ID, the bundle's source), nothing built |
| The new and changed tests | `rules-live` 32, `rules-update-fill` 10, `rules-update-worker` 7 tests; with the changed files, 10 files, 343 tests passed |
| Mutants | **42 of 42 killed**, Z0 and Z0e passed (§10.6) |
| Full unit run | 355 files: 5,830 passed, 4 expected fail, 1 skipped, none failed. A first run found three source rules the patch crossed: every worker listener at the top level (the updater's had been in an `if` block: now a named function behind the define, U2-11), and two check-dist tests that knew the e2e worker without the updater (its `allowReserved`, its fetch count): brought up to date |
| e2e, one worker: every `autofill*` and `rules-*` spec (with `rules-update`), `perf`, `perf-idle`, `visual-guard`, `sidepanel`, `add-popup`, `afmatch`; `plugins-w2b-r2`'s W2B-04 | 261 tests: 255 passed, 6 skipped (`autofill4b-measure`, on request only), none failed; `perf`'s read counts (its gates) hold; W2B-04 passed. `rules-update.spec.ts`: the popup's opens `[]`, the settings page's none of the updater's database |
| The patch | applied to a clean `9feef76` in a temporary index, it gives the worktree's tree; `git apply --check` passes on the main tree. An export of that tree alone (`git archive`, node_modules linked) passes the new and changed updater tests, `format:check`, the e2e build with check-dist and `rules-update.spec.ts`: 6 unit files, 127 tests passed; `format:check` clean; the e2e build with check-dist OK; `rules-update.spec.ts` 2 passed (the export was made before this cell was written: the final patch differs from that tree in this file alone) |

### 10.8 What is not proven

- **A real rules server, over the internet**: the browser test's server is local (TLS with a throw-away certificate,
  certificate errors ignored, the name mapped to the loopback address). CORS without a host permission, the refusal
  without `Access-Control-Allow-Origin`, `redirect: "error"` and the request's headers are measured in Chromium against
  it; a CDN's behaviour (compression, caching headers, HTTP/2 or 3) and the client hints sent over a real https
  connection are not.
- **Chrome's WebCrypto in the worker**: now exercised (the e2e worker verifies the test keys' signatures), on the
  bundled Chromium of the Playwright version in use only.
- **The alarm itself**: `sk-daily`'s listener calls the check (unit, with the worker's real listeners); in the browser a
  test starts the check through the e2e build's hook, so a real alarm firing the check after 6 hours is not observed.
- **A worker stopped mid-check**: nothing is written until the bundle is checked, and the due time is written before the
  read, so a stopped check is one lost attempt; not measured.
- **The toolbar popup's database opens** are counted after a reload with the count installed (U2-20), not at the popup's
  very first opening; the side panel's are not counted (it runs the same Fill code; its page is reached the same way).
- **The store build with the gate open** cannot be made until the origin and the two keys exist, and would then fail on
  its worker's size (by design: U2-2); the e2e build's three-gate twin was measured in phase 0 (A: 111,855 B).

### 10.9 What it leaves

- **AF3-U3** (the flip): the store build's rules origin and its two keys (`rules/SIGNING.md`), `released.json`, the
  gate; the store build's worker room (the owner's decision: `RULES_UPDATER_GZ` to the prod flavour in
  `scripts/sw-budget.mjs`, with the measured size; the maintainers' C33, C27, the plan's C14); the privacy notes (what
  the server learns, §10.3) and the store wording (the owner's, kept outside this tree); the CSP then gains the store
  origin's `/v1/` (the build writes it).
- **The keyboard shortcut** still takes no rule (C27). Measured in phase 0: with the updater in the worker (gate open),
  taking rules costs about +0.7 KB more (+682 B e2e, +766 B in the store build with three gates); without it (the gate
  closed), +4,416 B (101,589 → 106,005 B, 491 B under the limit). To be asked of the owner at AF3-6 or AF3-U3.
- **The status line's words** are the maintainers' C33 and C34; a line for a failed check (the last outcome) was not
  asked for and is not shown (the outcome codes exist).
- **"No newer version" is told by `signed.ts`'s reason text** (`m.version: not above …`, the review's N5): tests and the
  mutant L14 hold it; a machine reason code for `checkManifest`'s refusals is left to a later patch.

### 10.10 Round 2: the review (merge after fixes, no MUST)

`REVIEW-AF3-U2.md` found no MUST, two SHOULDs and eight NITs, confirmed the store build byte for byte, and ran five
mutants of its own aimed at the tests' gaps (all five lived; its three probe tests killed three). The maintainers' C34
took the SHOULDs with their words. Done on `9feef76` with round 1's final patch applied (a new worktree).

| Finding | What changed | Test and mutant |
| --- | --- | --- |
| **S1** the switch, when the worker failed or the channel closed, could show "off" while the bundle was in use, or vanish until a reload; no word while a turn on waited for its check | `RulesUpdate.tsx` (U2-22): what it shows is the worker's last real answer. A turn answered null or rejected asks the status again and shows it, or, unanswered again, what was shown before the click; either way "That didn't go through. Try again." (`ruFailed`), cleared by the next answered turn. While turning it on waits, "Checking for newer site rules…" (`ruChecking`) in the status line, the box disabled. The first read is tried twice; then the switch is drawn, disabled, with "This setting can't be read right now. Reload the page to try again." (`ruUnread`). The words are C34's, in `af3u2.py` and `catalogs/rules-<lang>.json` only | `rules-update-dom.test.ts` (new, 11 tests; Preact into the minimal document, the worker's answers scripted: answered, null, rejected, held, another shape). D1 (the status emptied: the switch gone), D2 (the click's guess kept), D3 (the state before the click put back without asking again), D4 (no "Checking…"), D5 (the first read not tried again), D6 (no line), D7 (the box enabled while a turn waits), D8 (a first read failing twice draws nothing) |
| **S2** C33's one transaction for off, and the write-back's second read, were held by no test (the review's MY3 and MY1 lived) | the code was right; the review's probes taken as tests of `rules-live.test.ts`: off's writes of the switch and the record are one `IDBTransaction`; a record written by another transaction just before an answer's write-back is kept; and (MY2) a release that reaches the record's version shows no floor | MY1, MY2, MY3 (the review's, on round 2's code) |
| N1 C24's "no fallback" does not hold when the worker does not answer | U2-21: stated; the plan's S9 fallback kept, no warming | — |
| N2 a due time set while the clock was ahead stopped the checks for as long | a due time further away than now + 24 h + 6 h is due (U2-23) | `rules-live`: the farthest a check sets still waited for, one millisecond more checked at once, a clock a year ahead put right. N2m |
| N3 every gate-open build makes the database, empty, though the switch was never on | stated in §10.3 and `docs/ARCHITECTURE.md` | — |
| N4 `askWorker` rejected when `sendMessage` threw at once | a `try` in the executor, the timer cleared; the comment says what it does | `rules-update-fill`: a message that throws at once: null, its timer cleared, the package's rule and appends. N4m |
| N5 "no newer version" is told by the reason's text | left as it is (tests and L14 hold it); §10.9 says a machine reason code is left to later | — |
| N6 the lead did not say the server sees the browser | `ruLead`, C34's words: "…That server sees your IP address, your browser's version and when you asked, never your accounts or sites." / "…对方能看到你的 IP 地址、浏览器版本和查询时间，看不到你的账户和网站。" | `catalogs/rules-<lang>.json` (generated); check-dist holds the text chunks to them |
| N7 another alarm opening the database untested (MY4); check-dist's four switch rules untested (MY5), against its comment | `rules-update-worker`: three other alarms open no updater database, `sk-daily` does; `rules-update-check-dist`: each of the four rules tampered with alone (the switch's chunk in the popup's page, its name gone from every settings script, its text past 2,048 B, one of its keys in the full catalog); the comment now says so | MY4, MY5, and MY5a to MY5d (each rule alone) |
| N8 a doubled sentence in §10.5; two figures for the updater's size | fixed; one figure, the final measure: 9,061 B gz (`sw-budget.mjs`, U2-2, §10.7, §10.11) | — |

### 10.11 Checks of round 2

In a new worktree of `9feef76` with round 1's final patch applied (its tree the same as round 1's), then changed; every
run through the shared runner after the one-minute load was under 24 (the runner's wrapper now refuses to run, and says
so, if the load stays at 24 or more for three hours: no step was skipped); vitest with `--maxWorkers=2`, Playwright with
one worker. The main working tree was not touched. Logs: `logs-r2/` (`INDEX.md`).

| Check | Result |
| --- | --- |
| `python3 scripts/messages.py`, twice; `npm run typecheck`; `bundle.mjs --check`; `import.mjs` | no change in the 46 generated files on either run (the switch's catalog has round 2's three keys and the new lead); clean; up to date; 3 upstream files matching their pins |
| **The store build (prod), with check-dist, against `9feef76`'s** | OK; **143 files, the SHA-256 of every one identical**; `sw.js` 101,589 B gz, popup 58,436 B, side panel 60,678 B |
| **The store build with both UI gates open**, through check-dist | OK; **its 149 files identical to `9feef76`'s**; popup 59,430 B, side panel 61,665 B (C30: ≤ 59,640 and ≤ 61,688) |
| The store build with the rules gate open too | refused before anything is built (rc 1, no output folder); the gate files restored and compared |
| The e2e build, with check-dist | OK; 159 files; **`sw.js` 113,616 B gz of 115,712** (+9,061 on `9feef76`'s 104,555: the updater's measured size, as `sw-budget.mjs` says; +24 on round 1, the due time's new rule); the Fill chunk with its reader 10,928 B of 12,288; popup 59,658 B and side panel 61,900 B (the e2e build's, from hashed names); the switch's text en 374 B and zh_CN 488 B of 2,048 |
| The dev build, with check-dist | OK; 282 files |
| `npm run format:check`, `npm run notices:check`; the store package | clean; up to date; refused as before, nothing built |
| The new and changed tests | `rules-update-dom` 11 tests (new); `rules-live` 36, `rules-update-fill` 11, `rules-update-worker` 8, `rules-update-check-dist` 26 tests; with the other touched files, 9 files, 162 tests passed |
| Mutants | **61 of 61 killed**, Z0 and Z0e passed (round 1's 42 on round 2's code, the review's MY1 to MY5 and MY5a to MY5d, D1 to D8, N2m, N4m) |
| Full unit run | 356 files: 5,848 passed, 4 expected fail, 1 skipped, none failed |
| e2e, one worker: every `autofill*` and `rules-*` spec, `perf`, `perf-idle`, `visual-guard`, `sidepanel`, `add-popup`, `afmatch`; `plugins-w2b-r2`'s W2B-04 | 261 tests: 255 passed, 6 skipped (`autofill4b-measure`, on request only), none failed; `perf`'s read counts hold; W2B-04 passed; the popup's opens `[]` |
| The patch | applied to a clean `9feef76` in a temporary index, it gives the worktree's tree; `git apply --check` passes on the main tree. An export of that tree alone (`git archive`, node_modules linked): 7 unit files of the updater, 145 tests passed; `format:check` clean; the e2e build with check-dist OK; `rules-update.spec.ts` 2 passed (the export was made before this cell was written: the final patch differs from that tree in this file alone) |
