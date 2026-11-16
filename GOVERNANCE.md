# Governance and commitments

Sixkey is a product of the g.pro family, published and maintained by VIEW TECH LTD, a company registered in London,
United Kingdom. The commitments below apply from the first public release.

## Who decides

VIEW TECH LTD maintains Sixkey: it reviews and merges changes, decides the design, and holds the release and store
accounts. Design decisions are recorded in the design documents (`docs/`). Decisions about licences, accounts, money
and legal matters are the maintainer's; their outcomes are stated in the documents they affect ([LICENSE.md](LICENSE.md),
[SECURITY.md](SECURITY.md), [TRADEMARKS.md](TRADEMARKS.md), this file, [ROADMAP.md](ROADMAP.md)).

Today one person holds the release process, and there is no second publisher: the store publisher account, once it is
created, will have one holder. That is a single point of failure, and it is stated here rather than hidden. What limits its consequences: the code is open source
under licences that let anyone continue it, and the packaging is deterministic (`extension/scripts/package.mjs`), so a
store version can be compared with the source.

## What the paid offering is, and what it will never be

Sixkey is open source in every part: the extension, the sync server, the API contract and its test vectors, and the
documents. The model is the one of SimpleLogin or Supabase: the only thing that will be sold is a **hosted sync
service**, that is running the server, keeping it available, backing it up, delivering its sign-in email, handling
abuse and support.

The project commits that:

1. **Local features are never gated.** Everything the extension can do on one computer (codes, import, export,
   backups, recovery, the security settings) stays free and works without an account, with or without the hosted
   service.
2. **No open core.** The hosted service runs the same server code as this repository, from tagged public releases.
   There is no feature that exists only in private cloud code, and the server has no private modules: billing, abuse
   handling and operations run outside the server process or are published with it. Limits that differ between plans
   are configuration values, not code.
3. **Your data stays yours.** Sync is end-to-end encrypted: the service stores ciphertext it cannot read. You can always
   export your accounts and leave, and turning sync off never removes your local data.
4. **No tracking in the extension**, now or in a paid plan.

Self-hosting is meant to stay free. The project publishes what is needed to run a server yourself once it exists
([docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)); it does not offer to set up or operate hosting for users.

## If ownership changes

If the extension, its store listing, its signing keys or the hosted service are ever transferred to another person or
company, the project commits that:

1. the transfer will be **announced publicly in advance**, in this repository and in the extension's store listing;
2. a new owner may **not add data collection** or new permissions without asking every user again, through Chrome's
   own permission prompt or a new install;
3. the code stays under its open-source licences, so anyone can continue the project as a fork under another name;
   and the packaging is deterministic (`extension/scripts/package.mjs`) so that a store version can be compared with
   the source (the tooling for that comparison is planned).

## Changing this document

Changes to the commitments above are announced in the release notes and take effect only for later releases.
