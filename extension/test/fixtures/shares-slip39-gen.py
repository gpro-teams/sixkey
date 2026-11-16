# Generates the recovery code shares' test fixtures (docs/design/notes/SHAMIR-NOTES.md §2); run with python3 -I, from a
# directory of its own, with the reference package in another:
#   python3 -I shares-slip39-gen.py <dir holding the shamir_mnemonic package> <vectors.json> <out dir>
# writes into <out dir>:
#   shares-slip39.json  SLIP-39's official vectors (trezor/python-shamir-mnemonic vectors.json), decoded to raw member
#                       shares with the reference's own decoder; only vectors that decode (sharing-level outcomes) are
#                       kept. Derived from MIT-licensed vectors: REUSE.toml marks this file MIT.
#   shares-cross.json   the split cross-check: Sixkey's own chosen secrets and random streams through the reference's
#                       _split_secret (RANDOM_BYTES replaced by the stream), and what it gave: Sixkey's (the extension's
#                       licence), as this script is.
import hashlib, itertools, json, sys

sys.path.insert(0, sys.argv[1])
import shamir_mnemonic.shamir as sh  # noqa: E402
from shamir_mnemonic.utils import MnemonicError  # noqa: E402
from shamir_mnemonic import combine_mnemonics  # noqa: E402

import os  # noqa: E402

vectors_path, out_dir = sys.argv[2], sys.argv[3]
raw = open(vectors_path, "rb").read()
vectors = json.loads(raw)

official = []
for desc, mnemonics, secret, _xprv in vectors:
    try:
        groups = sh.decode_mnemonics(mnemonics)
    except MnemonicError:
        continue  # a word-level failure (checksum, padding, length, mixed parameters): not the sharing's
    except ValueError:
        continue
    first = next(iter(next(iter(groups.values())).shares))
    entry = {
        "description": desc,
        "identifier": first.identifier,
        "extendable": first.extendable,
        "iterationExponent": first.iteration_exponent,
        "groupThreshold": first.group_threshold,
        "groupCount": first.group_count,
        "groups": [
            {
                "index": gi,
                "memberThreshold": g.member_threshold(),
                "shares": sorted([{"x": s.index, "y": s.value.hex()} for s in g.shares], key=lambda d: d["x"]),
            }
            for gi, g in sorted(groups.items())
        ],
    }
    try:
        ems = sh.recover_ems(groups)
        entry["ems"] = ems.ciphertext.hex()
        got = combine_mnemonics(mnemonics, b"TREZOR")
        assert got.hex() == secret, desc
        entry["masterSecret"] = secret
    except MnemonicError as e:
        assert secret == "", desc
        msg = str(e)
        entry["error"] = (
            "digest" if "digest" in msg else "duplicate" if "unique" in msg else "count" if "number" in msg else msg
        )
    official.append(entry)


def stream(seed):
    """A fixed byte stream: SHA-256(seed || counter), concatenated."""
    out = bytearray()
    for i in itertools.count():
        out += hashlib.sha256(seed + i.to_bytes(4, "big")).digest()
        if len(out) > 4096:
            return bytes(out)


cross = []
for t, n in [(2, 2), (2, 3), (3, 5), (4, 7), (5, 16), (16, 16), (1, 3)]:
    seed = f"sixkey-shares-cross|{t}|{n}".encode()
    secret = hashlib.sha256(seed + b"|secret").digest()[:16]
    buf = stream(seed)
    pos = [0]
    used = []

    def rb(k):
        b = buf[pos[0] : pos[0] + k]
        pos[0] += k
        used.append(b.hex())
        return b

    sh.RANDOM_BYTES = rb
    shares = sh._split_secret(t, n, secret)
    for sub in itertools.combinations(shares, t):
        assert sh._recover_secret(t, list(sub)) == secret
    cross.append(
        {
            "threshold": t,
            "count": n,
            "secret": secret.hex(),
            "random": used,
            "shares": [{"x": s.x, "y": s.data.hex()} for s in shares],
        }
    )

json.dump(
    {
        "source": {
            "what": "Derived from SLIP-39's official test vectors, decoded by its reference implementation, for the share arithmetic only",
            "repository": "https://github.com/trezor/python-shamir-mnemonic",
            "commit": "1ff7b9a9d675ab69945c84a50848d704ce1c78b7",
            "pypiVersion": "0.3.0",
            "vectorsSha256": hashlib.sha256(raw).hexdigest(),
            "licence": "MIT (Copyright 2018 Andrew R. Kozlik; Copyright 2019 SatoshiLabs)",
            "passphrase": "TREZOR",
            "generator": "extension/test/fixtures/shares-slip39-gen.py",
        },
        "official": official,
    },
    open(os.path.join(out_dir, "shares-slip39.json"), "w"),
    indent=1,
)
json.dump(
    {
        "source": {
            "what": "Sixkey's own secrets and random streams through the reference's _split_secret, and its output",
            "repository": "https://github.com/trezor/python-shamir-mnemonic",
            "commit": "1ff7b9a9d675ab69945c84a50848d704ce1c78b7",
            "generator": "extension/test/fixtures/shares-slip39-gen.py",
        },
        "cross": cross,
    },
    open(os.path.join(out_dir, "shares-cross.json"), "w"),
    indent=1,
)
print(len(official), "official sets,", len(cross), "cross-check splits")
