# Signing live bundles of the site rules

A Sixkey build whose updater is let in (`extension/scripts/rules-update.mjs`, its release gate; closed in the store
build) can take site rules between releases: once a day at most it reads a signed manifest and the live bundle it names,
and keeps them only if the signature is by a key the build pins and every check below holds. This file is the steps
around that signature: making the two keys, signing, signing again before a bundle expires, changing keys at a release,
and what to do when a key is lost or stolen. The extension's checks are `extension/src/core/rules/signed.ts`; the signer
is `tools/sign.mjs`; the manifest's format is `contract/rules/1/manifest.schema.json`.

## What is signed, and what a client checks

The server holds two files under `/v1/`: `bundle-<version>.json`, a live bundle (`contract/rules/1/live.schema.json`:
site rules only, and all of them; never alias groups, "code after the password" hosts or upstream data, which ship only
with releases), and `manifest.json`:

```
{"m": "<the manifest>", "kid": "<key id>", "sig": "<signature>"}
```

- `m` is the manifest, `{"format":"sixkey-rules-manifest","schema":1,"version":…,"created":…,"expires":…,"sha256":…,
"size":…,"source":…,"license":…}`, written exactly in that order with no spaces (one text for one manifest), printable
  ASCII; times are UTC, `YYYY-MM-DDTHH:MM:SSZ`.
- `sig` is ECDSA on P-256 with SHA-256 over the bytes `sixkey-rules-manifest\n1\n` followed by `m`, written as r and s
  (64 bytes) in base64url without padding.
- `kid` is the hex of the first 16 bytes of the SHA-256 of the key's SubjectPublicKeyInfo (DER).

A client accepts them only if: the kid is pinned by its build and not retired on that client; the signature verifies;
`created` is at most a day after its clock and before `expires`; `expires` is after its clock and at most 180 days after
`created`; the version is above the bundle built into its release, by at most 1,000, and above the last version it
accepted from the same key (its floor); and the bundle is exactly `size` bytes, hashes to `sha256`, passes the format's
checks as a live bundle and has the manifest's version, source and licence. It keeps the bundle until it expires.

So every bundle published is a new version: a client that has version 7 refuses version 7 again, even signed anew.

## The two keys

Two P-256 keys, made offline, in an order: **`current`** signs every bundle; **`next`** signs nothing until it takes over
from `current`. A client that accepts a bundle signed by `next` retires `current` for good: it compares that bundle with
its built-in rules only (not with `current`'s floor), and refuses whatever `current` signs from then on. That is what
makes a lost or stolen `current` recoverable, and why `next` is kept apart and used for nothing else.

Make each key on a machine with no network, as a PKCS#8 file under a passphrase (the signer takes no other kind of file):

```
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -aes-256-cbc -out current.pem
openssl pkey -in current.pem -pubout -out current.pub.pem
```

and the same for `next`, with another passphrase. Or make it on a hardware key that can sign with ECDSA P-256 (a PIV
token, say), where the private half never leaves the device, and export only its public key as PEM.

The key id and the entry a build pins:

```
node rules/tools/sign.mjs kid --public current.pub.pem
```

prints `{"kid": "…", "spki": "…"}` (the same kid as the first 32 hex digits of
`openssl pkey -pubin -in current.pub.pem -outform DER | openssl dgst -sha256`). The store list is
`STORE_RULES_KEYS` in `extension/scripts/rules-keys.mjs`: `[current, next]`, in that order. A store build with the gate
open refuses to build without exactly two keys, each a P-256 key whose kid is its own, neither a test key.

**Sealing `next` apart**: its file (or its device) is kept offline, in another place than `current`, its passphrase not
with it, and it is not on the machine that signs. It is taken out only for the steps under "When a key is lost or
stolen" and for a planned change of keys. Keep a sealed backup of `current` too: losing it is recoverable, but costs a
release.

## Signing a bundle

1. Write the live bundle: every site rule it should hold (it replaces the built-in rules whole), its `version` above the
   newest release's built-in bundle (`rules/build/baseline.json`) and above every version published before, and a
   `source` naming the repository at its tag (`rules-v<version>`).
2. With a key file:

   ```
   node rules/tools/sign.mjs sign --bundle live.json --key current.pem --passphrase-stdin --out out/
   ```

   (the passphrase is asked for without echo, or read from a pipe). With a hardware key:

   ```
   node rules/tools/sign.mjs prepare --bundle live.json --public current.pub.pem --out prep/
   ```

   then sign `prep/to-sign.bin` with ECDSA P-256 over its SHA-256. Use a way of signing that hashes the file itself
   with SHA-256 (PKCS#11's `CKM_ECDSA_SHA256`, `openssl dgst -sha256 -sign`, `yubico-piv-tool` with `-H SHA256`); a
   device or mechanism that signs a digest it is given (PKCS#11's plain `CKM_ECDSA`, a PIV card's raw sign) must be
   given the file's SHA-256, which `prepare` prints, not the file. Then

   ```
   node rules/tools/sign.mjs assemble --bundle live.json --public current.pub.pem \
     --body prep/manifest-body.txt --sig sig.der --sig-format der --out out/
   ```

   (`--sig-format der` for a DER signature, as OpenSSL and most tools write it; `raw` for r and s as 64 bytes, as
   PKCS#11's ECDSA mechanisms return them).

   The signer refuses, before signing: a bundle with a JSON key written twice, anything the extension's checker refuses
   in a live bundle, a bundle over 512 KiB or not ASCII, a version not above the built-in bundle's or more than 1,000
   above it, a validity over 180 days. After signing, it checks its output with the extension's own code before it
   writes `out/manifest.json` and `out/bundle-<version>.json`, and it never overwrites a file.

3. Publish `bundle-<version>.json` first, then `manifest.json`, both under `/v1/`. Tag the commit `rules-v<version>`.

`--days` sets the validity: 1 to 180, by default 120. `--baseline <version>` checks against another built-in bundle than
the committed one, such as the oldest release still in use (a client accepts a version at most 1,000 above its own).

## Signing again at least every 180 days

A client stops using a bundle when its manifest expires, and falls back to the rules built into its release: nothing
warns anyone. So a new version is signed and published before the last one expires, whether or not the rules changed
(bump `version`, update `source`, sign, publish). With the default validity of 120 days, signing every 90 days leaves 30
days of margin.

## Changing the keys, at a release only

The pinned list moves forward one step at a time, and only in a release: the new list's first key is the old list's
second. To change keys as planned:

1. Make a new key, `new`, and seal it apart: it will be the next `next`.
2. Release R+1 pins `[next, new]`, and from then on bundles are signed with `next` (now the current key). Clients on R+1
   drop `current`'s record and its floor; clients still on R accept `next`'s bundles too (it is pinned there), which
   retires `current` on them. Never sign with the old `current` again.
3. After the release, update `extension/test/fixtures/rules-keys/released.json`: `store` becomes the list it pins, and
   `ever` gains its new key (`ever` holds every key any release has pinned, and only grows). A test holds the store list
   to both: the next change must again be one step forward, or two new keys, and a key that has left the list never
   comes back (a client forgets a retired key once no release pins it).

## When a key is lost or stolen

- **`current` lost**: sign the next bundle with `next` at once (step 2 above, without waiting for a release): every
  client that fetches it retires `current`. Then a release pins `[next, new]`.
- **`current` stolen**: the same, as soon as the rules server is in your hands again (a thief who can deliver a forged
  bundle usually controls the server or its name first; take them back). The `next`-signed bundle is compared with each
  client's built-in rules only, so it is accepted whatever version the thief used, and it retires the stolen key. Until a
  client fetches it, a forged bundle can act on it for at most 180 days, within the limits below. Then a release pins
  `[next, new]`.
- **`next` lost or stolen**: `current` keeps working, but nothing can take over from it, and a thief with `next` can
  retire `current` on every client that fetches the thief's bundle. A release pins two new keys (neither of the old ones:
  a key pinned beside one that may have retired it is never pinned again); clients on it drop the old keys' records.
- **Both lost or stolen**: a release with two new keys, as above.

With two new keys, the old release and the new one share no key, and the server has one manifest. Until it is signed
with the new keys, clients of the new release get nothing new; from then on, clients still on the old release stop
taking updates until Chrome updates them to the new release (usually within a day or two). Meanwhile they keep using the
bundle they hold until it expires (180 days at most), then their built-in rules. Switch the server to the new keys once
the new release is out. A user can clear a bundle at once by turning the updates off.

Whatever a forged or wrong bundle says, it can only act on a page of a site the user registered for an account: make
Sixkey pick another visible ordinary input box (never one the page marks as a password, card, phone, search or other
box Sixkey refuses), pin how a group of boxes is filled, show the "sent code" note, wait up to 20 seconds for the next
code, or make Sixkey ask the user to choose. It cannot change which sites share a sign-in or want the code after the
password, suggest a site, add a site to an account, fill a page of another site, or read anything.

## Test keys

`extension/test/fixtures/rules-keys/test-only-current.pem` and `test-only-next.pem` are published with the tests, so
anyone can sign with them. The dev and e2e builds pin them (`TEST_RULES_KEYS`); `extension/scripts/check-dist.mjs`
refuses them, and the dev and e2e rules origin, in a store build.
