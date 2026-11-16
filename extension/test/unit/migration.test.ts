import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { collectBatches, dedupeParams, parseMigrationUri, type MigrationBatch } from "../../src/core/totp/migration";
import { parseOtpauth } from "../../src/core/totp/otpauth";

// --- tiny protobuf writer, test-side only -------------------------------------------------
const varint = (n: bigint): number[] => {
  const out: number[] = [];
  let v = BigInt.asUintN(64, n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};
const key = (no: number, wire: number) => varint(BigInt((no << 3) | wire));
const vf = (no: number, n: number | bigint) => [...key(no, 0), ...varint(BigInt(n))];
const lf = (no: number, bytes: ArrayLike<number>) => [
  ...key(no, 2),
  ...varint(BigInt(bytes.length)),
  ...Array.from(bytes),
];
const str = (s: string) => Array.from(new TextEncoder().encode(s));

type E = {
  secret: number[];
  name?: string;
  issuer?: string;
  alg?: number;
  dig?: number;
  type?: number;
  counter?: number | bigint;
  extra?: number[];
};
const entry = (e: E) => [
  ...lf(1, e.secret),
  ...(e.name !== undefined ? lf(2, str(e.name)) : []),
  ...(e.issuer !== undefined ? lf(3, str(e.issuer)) : []),
  ...(e.alg !== undefined ? vf(4, e.alg) : []),
  ...(e.dig !== undefined ? vf(5, e.dig) : []),
  ...(e.type !== undefined ? vf(6, e.type) : []),
  ...(e.counter !== undefined ? vf(7, e.counter) : []),
  ...(e.extra ?? []),
];
const payload = (
  entries: E[],
  meta: { version?: number; size?: number; index?: number; id?: number } = {},
  tail: number[] = [],
) => [
  ...entries.flatMap((e) => lf(1, entry(e))),
  ...vf(2, meta.version ?? 1),
  ...vf(3, meta.size ?? 1),
  ...vf(4, meta.index ?? 0),
  ...vf(5, BigInt(meta.id ?? 0)),
  ...tail,
];
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const uri = (bytes: number[], enc: (s: string) => string = encodeURIComponent) =>
  `otpauth-migration://offline?data=${enc(b64(bytes))}`;
const HELLO = [...str("Hello!"), 0xde, 0xad, 0xbe, 0xef];

function parsed(u: string): MigrationBatch {
  const r = parseMigrationUri(u);
  if (!r.ok) throw new Error(r.error);
  return r.batch;
}

describe("known sample (dim13/otpauth README)", () => {
  const u = "otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZ29vZ2xlLmNvbRoHRXhhbXBsZTAC";
  it("decodes secret, issuer, label and defaults", () => {
    const b = parsed(u);
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]).toEqual({
      ok: true,
      value: {
        type: "totp",
        issuer: "Example",
        label: "alice@google.com",
        secret: "JBSWY3DPEHPK3PXP",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      },
    });
  });
});

describe("field mapping", () => {
  it("maps algorithm, digits and type enums", () => {
    const b = parsed(
      uri(
        payload([
          { secret: HELLO, name: "A", alg: 1, dig: 1, type: 2 },
          { secret: HELLO, name: "B", alg: 2, dig: 2, type: 2 },
          { secret: HELLO, name: "C", alg: 3, dig: 1, type: 2 },
        ]),
      ),
    );
    const v = b.entries.map((e) => (e.ok ? [e.value.algorithm, e.value.digits] : null));
    expect(v).toEqual([
      ["SHA1", 6],
      ["SHA256", 8],
      ["SHA512", 6],
    ]);
  });
  it("keeps HOTP with its counter", () => {
    const b = parsed(uri(payload([{ secret: HELLO, name: "H", type: 1, counter: 42 }])));
    expect(b.entries[0]).toMatchObject({ ok: true, value: { type: "hotp", counter: 42 } });
  });
  it("splits 'Issuer:account', prefers the issuer field, keeps unrelated prefixes", () => {
    const b = parsed(
      uri(
        payload([
          { secret: HELLO, name: "Example:alice" },
          { secret: HELLO, name: "Example:bob", issuer: "Example" },
          { secret: HELLO, name: "Other:carol", issuer: "Example" },
          { secret: HELLO, name: "dave" },
          { secret: HELLO, name: "腾讯:张三", issuer: "腾讯" },
        ]),
      ),
    );
    const got = b.entries.map((e) => (e.ok ? [e.value.issuer, e.value.label] : null));
    expect(got).toEqual([
      ["Example", "alice"],
      ["Example", "bob"],
      ["Example", "Other:carol"],
      ["", "dave"],
      ["腾讯", "张三"],
    ]);
  });
  it("produces a secret that matches the same account written as otpauth://", () => {
    const b = parsed(uri(payload([{ secret: HELLO, name: "Example:alice", issuer: "Example" }])));
    const viaUri = parseOtpauth("otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example");
    expect(b.entries[0]).toEqual({ ok: true, value: viaUri.ok ? viaUri.value : null });
  });
});

describe("entries that cannot be converted are reported, not dropped", () => {
  it("MD5, digits and type outside the supported set, empty secret", () => {
    const b = parsed(
      uri(
        payload([
          { secret: HELLO, name: "md5", alg: 4 },
          { secret: HELLO, name: "dig", dig: 3 },
          { secret: HELLO, name: "typ", type: 3 },
          { secret: [], name: "empty" },
          { secret: HELLO, name: "ok" },
        ]),
      ),
    );
    expect(b.entries.map((e) => (e.ok ? "ok" : e.error))).toEqual([
      "unsupported_algorithm",
      "unsupported_digits",
      "unsupported_type",
      "empty_secret",
      "ok",
    ]);
    expect(b.entries.map((e) => (e.ok ? e.value.label : e.label))).toEqual(["md5", "dig", "typ", "empty", "ok"]);
  });
  it("invalid UTF-8 in a name", () => {
    const bad = [...lf(1, HELLO), ...lf(2, [0xff, 0xfe])];
    const b = parsed(uri([...lf(1, bad)]));
    expect(b.entries[0]).toMatchObject({ ok: false, error: "invalid_text" });
  });
});

describe("encoding quirks", () => {
  const bytes = payload([{ secret: Array.from({ length: 20 }, (_, i) => 250 - i), name: "x?y>z", issuer: "i" }]);
  const expected = parsed(uri(bytes)).entries;
  it("percent-encoded standard base64", () => {
    expect(parsed(uri(bytes)).entries).toEqual(expected);
  });
  it("raw '+' that a form decoder turned into a space", () => {
    const raw = b64(bytes);
    expect(raw).toMatch(/[+/]/); // the sample really exercises + and /
    expect(parsed(`otpauth-migration://offline?data=${raw.replace(/\+/g, " ")}`).entries).toEqual(expected);
    expect(parsed(`otpauth-migration://offline?data=${raw}`).entries).toEqual(expected);
  });
  it("url-safe base64 and missing padding", () => {
    const safe = b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(parsed(`otpauth-migration://offline?data=${safe}`).entries).toEqual(expected);
  });
  it("extra query parameters after data", () => {
    expect(parsed(uri(bytes) + "&foo=1").entries).toEqual(expected);
  });
});

describe("batch metadata", () => {
  it("reads version, size, index and a negative batch id", () => {
    const b = parsed(uri(payload([{ secret: HELLO, name: "a" }], { version: 1, size: 3, index: 2, id: -1234567 })));
    expect(b).toMatchObject({ version: 1, batchSize: 3, batchIndex: 2, batchId: -1234567 });
  });
  it("skips unknown fields of every wire type", () => {
    const unknown = [
      ...vf(15, 99),
      ...lf(16, [1, 2, 3]),
      ...key(17, 1),
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ...key(18, 5),
      1,
      2,
      3,
      4,
    ];
    const b = parsed(uri(payload([{ secret: HELLO, name: "a", extra: unknown }], {}, unknown)));
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]!.ok).toBe(true);
  });
  it("collects a three-code export out of order and reports what is missing", () => {
    const mk = (i: number) => parsed(uri(payload([{ secret: HELLO, name: `n${i}` }], { size: 3, index: i, id: 77 })));
    const some = collectBatches([mk(2), mk(0), mk(0)]);
    expect(some).toHaveLength(1);
    expect(some[0]).toMatchObject({ batchId: 77, batchSize: 3, received: [0, 2], missing: [1], complete: false });
    const all = collectBatches([mk(2), mk(1), mk(0)]);
    expect(all[0]).toMatchObject({ complete: true, missing: [] });
    expect(all[0]!.entries.map((e) => (e.ok ? e.value.label : ""))).toEqual(["n0", "n1", "n2"]);
  });
  it("keeps different batch ids apart", () => {
    const a = parsed(uri(payload([{ secret: HELLO, name: "a" }], { size: 1, index: 0, id: 1 })));
    const b = parsed(uri(payload([{ secret: HELLO, name: "b" }], { size: 1, index: 0, id: 2 })));
    expect(
      collectBatches([a, b])
        .map((x) => x.batchId)
        .sort(),
    ).toEqual([1, 2]);
  });
});

describe("dedupe", () => {
  it("drops repeats by secret, issuer and label (case-insensitive on text)", () => {
    const mk = (issuer: string, label: string, secret = "JBSWY3DPEHPK3PXP") => ({
      type: "totp" as const,
      issuer,
      label,
      secret,
      algorithm: "SHA1" as const,
      digits: 6 as const,
      period: 30,
    });
    const out = dedupeParams([
      mk("GitHub", "a"),
      mk("github", "A"),
      mk("GitHub", "b"),
      mk("GitHub", "a", "GEZDGNBVGY3TQOJQ"),
    ]);
    expect(out.map((p) => p.label + p.secret.slice(0, 2))).toEqual(["aJB", "bJB", "aGE"]);
  });
});

describe("hostile input never throws", () => {
  it("rejects other schemes and bad data", () => {
    const bad = [
      "",
      "otpauth://totp/x?secret=AAAAAAAA",
      "otpauth-migration://offline",
      "otpauth-migration://offline?data=",
      "otpauth-migration://offline?data=%%%",
      "otpauth-migration://offline?data=A",
    ];
    for (const b of bad) expect(parseMigrationUri(b).ok).toBe(false);
  });
  it("every truncation of a valid payload yields a result", () => {
    const full = payload(
      [{ secret: HELLO, name: "Example:alice", issuer: "Example", alg: 2, dig: 2, type: 1, counter: 9 }],
      { size: 2, index: 1, id: -5 },
    );
    for (let n = 0; n <= full.length; n++) {
      const r = parseMigrationUri(uri(full.slice(0, n)));
      expect(typeof r.ok).toBe("boolean");
    }
  });
  it("random bytes never throw", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        const r = parseMigrationUri(uri(Array.from(bytes)));
        expect(typeof r.ok).toBe("boolean");
      }),
      { numRuns: 1000 },
    );
  });
  it("a varint that never ends is malformed", () => {
    const r = parseMigrationUri(uri(Array(20).fill(0xff)));
    expect(r).toEqual({ ok: false, error: "malformed" });
  });
  it("an absurd length prefix is malformed", () => {
    const r = parseMigrationUri(uri([0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f, 1, 2, 3]));
    expect(r).toEqual({ ok: false, error: "malformed" });
  });
  it("too many entries is refused", () => {
    const many = Array.from({ length: 2001 }, () => lf(1, entry({ secret: [1] }))).flat();
    expect(parseMigrationUri(uri(many))).toEqual({ ok: false, error: "too_large" });
  });
});
