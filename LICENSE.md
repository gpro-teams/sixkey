# Licences

Sixkey is open source. It is made of parts with different purposes, so each part has the licence that suits it. The
exact mapping of every path to its licence is [`REUSE.toml`](REUSE.toml); the licence texts are in
[`LICENSES/`](LICENSES/). `reuse lint` ([REUSE](https://reuse.software/)) checks that every file is covered.

Copyright 2026 VIEW TECH LTD and Sixkey contributors. Each contributor keeps the copyright of their contribution and
licenses it under the licence of the files it changes (see "Contributions" below).

| Part                                                                                                   | Paths                                                        | Licence                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser extension                                                                                      | `extension/`, and the dev-only WebAuthn probe in `tools/`    | [Mozilla Public License 2.0](LICENSES/MPL-2.0.txt) (`MPL-2.0`)                                                                              |
| Sync server                                                                                            | `api/server/`                                                | [GNU Affero General Public License v3.0 or later](LICENSES/AGPL-3.0-or-later.txt) (`AGPL-3.0-or-later`)                                     |
| Site rules for TOTP autofill: the rules, their test pages, the tools, the upstream pins and exclusions | `rules/`                                                     | [GNU Affero General Public License v3.0 or later](LICENSES/AGPL-3.0-or-later.txt) (`AGPL-3.0-or-later`); see [`rules/NOTICE`](rules/NOTICE) |
| The site rules' bundle, generated from the rules and Apple's data                                      | `rules/build/`                                               | `AGPL-3.0-or-later AND MIT`, with both copyright lines                                                                                      |
| Apple's password-manager-resources files, kept verbatim (shared sign-in groups)                        | `rules/upstream/apple/`                                      | [MIT](LICENSES/MIT.txt) (`MIT`), Copyright 2020 - 2026 Apple Inc.                                                                           |
| Contract code: vector generator, consistency checker, Python reference implementation                  | `contract/tools/`, `contract/py/`                            | [Apache License 2.0](LICENSES/Apache-2.0.txt) (`Apache-2.0`)                                                                                |
| Contract data: API description, known-answer test vectors, the site rules' JSON Schemas                | `api/openapi.yaml`, `contract/vectors/`, `contract/rules/1/` | [CC0 1.0](LICENSES/CC0-1.0.txt) (`CC0-1.0`, a public domain dedication)                                                                     |
| Documents                                                                                              | `docs/`, and every `*.md` file                               | [Creative Commons Attribution 4.0](LICENSES/CC-BY-4.0.txt) (`CC-BY-4.0`)                                                                    |
| Repository configuration, lock files                                                                   | `.github/`, the dot files, `ruff.toml`, `package-lock.json`  | `CC0-1.0`                                                                                                                                   |
| Third-party notices (generated)                                                                        | `THIRD-PARTY-NOTICES.md`                                     | `CC0-1.0` for the compilation; each notice and licence text it quotes keeps its own terms                                                   |
| Code of conduct                                                                                        | `CODE_OF_CONDUCT.md`                                         | `CC-BY-4.0`, the Contributor Covenant's own licence                                                                                         |
| Developer Certificate of Origin                                                                        | `DCO.txt`                                                    | the Linux Foundation's terms: verbatim copies only ([`LICENSES/LicenseRef-DCO.txt`](LICENSES/LicenseRef-DCO.txt))                           |
| A test fixture from SLIP-39's vectors (the recovery key shares' arithmetic)                            | `extension/test/fixtures/shares-slip39.json`                 | [MIT](LICENSES/MIT.txt) (`MIT`), Copyright 2018 Andrew R. Kozlik, 2019 SatoshiLabs; never shipped                                           |

The planned native helper for YubiKey support (a design, not written yet:
[docs/design/proposals/YUBIKEY-DESIGN.md](docs/design/proposals/YUBIKEY-DESIGN.md)) will be `Apache-2.0`.

## Why these licences

- **The extension (MPL-2.0).** Its cores (TOTP, the import parsers, the vault envelope) can be reused in other software,
  including closed software, while changes to Sixkey's own files in a distributed copy stay open. MPL-2.0 is file-level
  copyleft and includes a patent grant.
- **The server (AGPL-3.0-or-later).** Anyone who runs a modified copy of the server as a service must offer its source
  to the users of that service. That is what makes "the hosted service runs the public code" checkable. The server
  will not contain private modules: billing, abuse handling and operations either run outside the server process or
  are published with it ([GOVERNANCE.md](GOVERNANCE.md)).
- **The site rules (AGPL-3.0-or-later).** The rules for finding a site's code box are open data that stays open: whoever
  passes on the rules or a changed bundle, in a build or as a download, passes on the rules' source too. A program that
  only reads a bundle, Sixkey's extension included, keeps its own licence ([`rules/NOTICE`](rules/NOTICE)); the format's
  JSON Schemas are contract data, so anyone can implement it.
- **The contract (Apache-2.0 and CC0-1.0).** Anyone should be able to write a client or a server for the protocol, or
  test one against the vectors, without a licence review.
- **The documents (CC-BY-4.0).** They may be copied and adapted with attribution.

The model is the one of open-source projects with a hosted offering, such as SimpleLogin or Supabase: everything is
open source, and what is sold is the operation of a hosted service. Local features are never part of that offering
([GOVERNANCE.md](GOVERNANCE.md)).

## Contributions

Contributions are accepted under the licence of the files they change ("inbound = outbound"), with a
[Developer Certificate of Origin](DCO.txt) sign-off on every commit. There is no contributor licence agreement. See
[CONTRIBUTING.md](CONTRIBUTING.md#sign-off-developer-certificate-of-origin).

## Third-party components

Third-party components keep their own licences. What ships inside the extension, and the notices each part requires,
are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md); every build of the extension carries the same notices
as `THIRD-PARTY-NOTICES.txt`, and the extension's licence as `LICENSE.txt` (its first line names the site rules'
licences and the third-party parts' own). Every build also carries the site rules' bundle, `rules/baseline.json` (the repository's
`rules/build/baseline.json`), with its licence and notices beside it as `rules/LICENSE.txt`.

The name "Sixkey" and the Sixkey icon are not covered by these licences: see [TRADEMARKS.md](TRADEMARKS.md).
