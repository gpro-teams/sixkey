# Security policy

Sixkey holds two-factor secrets, so security reports get priority over everything else. Thank you for taking the time
to report a problem responsibly. Sixkey is published and maintained by VIEW TECH LTD.

## How to report a vulnerability

Please **do not** open a public issue, discussion or pull request for a security problem.

Report it privately, by either of these:

- **GitHub private vulnerability reporting**: the "Report a vulnerability" button on this repository's Security tab.
  The report is visible only to you and the maintainers.
- **Email**: [security@g.pro](mailto:security@g.pro).

No encryption key is published yet. If your report contains sensitive details, such as a working exploit, please use
GitHub private vulnerability reporting.

Please include what you can of:

- the component and version (extension build and commit, server commit, or the contract file);
- what an attacker can do, and what they need first (for example: a copy of a browser profile, control of the sync
  server, a page the user visits);
- steps to reproduce, or a proof of concept;
- whether you have told anyone else.

You do not need a complete analysis: a short, clear report is enough to start.

## What happens next

| Step                                                     | Target                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| We acknowledge your report                               | within **5 business days**                                                                      |
| We assess it and tell you whether we confirm it, and why | as soon as we can; we keep you informed while we work on it                                     |
| We fix it, or publish an advisory with mitigations       | within **90 days** of your report; if we need longer, we tell you why and agree a date with you |

We ask that you keep the problem private until a fix or an advisory is out, or until the 90 days have passed, whichever
comes first. Advisories and CVE identifiers are issued through GitHub Security Advisories.

## Scope

In scope:

- the browser extension in `extension/`: the local vault, its encryption and storage, the popup and settings pages,
  the service worker, the build checks in `scripts/check-dist.mjs`;
- the sync protocol and its cryptography (`docs/SYNC-DESIGN.md`, `api/openapi.yaml`, `contract/`);
- the sync server in `api/server/`, including when you run it locally for testing;
- the documents, where a claim in `docs/security/local-vault.md` or `docs/PRIVACY.md` is not true of the code.

Out of scope:

- attacks that need malware already running as the user, or control of the browser profile's debugging port while
  Sixkey is unlocked: these are documented limits (`docs/security/local-vault.md`, "What is protected, and from
  whom"), though a way to make them worse is in scope;
- a vault from an early version that never got a master password: it is documented as unprotected against anyone who
  can read the profile;
- social engineering of users, denial of service by volume, and reports from automated scanners without a working
  attack;
- third-party services and browsers, unless Sixkey uses them wrongly;
- the two site-rules signing keys in `extension/test/fixtures/rules-keys/`: they are test keys, published on purpose.
  Development and test builds accept what they sign, and store builds refuse them, so they are not a leaked secret.

Known, accepted residual risks are listed in `docs/security/local-vault.md` ("Limits you should know about", "Known
gaps") and in `docs/SYNC-DESIGN.md` §1.2 and §1.3. A report that one of them is worse than described is welcome. One of
them concerns the lock: with sync on, a locked page also opens with the master password the sync server's keys use now,
and, while a key change is unconfirmed or the server is on an older key state, with a former one after the user confirms
"adopt anyway" (`docs/security/local-vault.md`, "With sync on: what opens a locked page").

## Supported versions

Sixkey is pre-release. Only the latest commit on the default branch is supported. Once releases exist, the latest
release will be supported and this section will say for how long older ones are.

## Safe harbour

If you act in good faith and within this policy, VIEW TECH LTD will not take legal action against you, or ask anyone
else to, for your research. Acting within this policy means that you:

- test only against your own accounts, your own browser profiles and a server you run yourself;
- do not access, change or delete other people's data, and stop as soon as you come across any;
- do not degrade a service for others, and do not use social engineering;
- report the problem to us privately and give us reasonable time to fix it before you disclose it.

This applies only to Sixkey and to systems VIEW TECH LTD controls. We cannot authorise testing of anyone else's systems
(for example a browser, GitHub or a hosting provider), and this policy does not override the law. If you are unsure
whether something is covered, ask us first at [security@g.pro](mailto:security@g.pro).

## No bug bounty

Sixkey does not pay for vulnerability reports. Reports are welcome as feedback, and we credit you in the advisory if you
wish; we ask before naming you.
