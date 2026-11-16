import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  parseOtpauth,
  parseOtpauthList,
  serializeOtpauth,
  type OtpParams,
  type OtpauthError,
} from "../../src/core/totp/otpauth";
import { encodeBase32 } from "../../src/core/totp/base32";

const S = "JBSWY3DPEHPK3PXP"; // 80 bits

function ok(uri: string) {
  const r = parseOtpauth(uri);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}: ${uri}`);
  return r;
}
function err(uri: string): OtpauthError {
  const r = parseOtpauth(uri);
  if (r.ok) throw new Error(`expected error: ${uri}`);
  return r.error;
}

describe("otpauth: labels and issuers", () => {
  const cases: [string, string, string, string][] = [
    ["prefix and matching param", `otpauth://totp/GitHub:alice?secret=${S}&issuer=GitHub`, "GitHub", "alice"],
    ["prefix only", `otpauth://totp/GitHub:alice?secret=${S}`, "GitHub", "alice"],
    ["param only", `otpauth://totp/alice?secret=${S}&issuer=GitHub`, "GitHub", "alice"],
    ["neither", `otpauth://totp/alice?secret=${S}`, "", "alice"],
    [
      "percent-encoded space and @",
      `otpauth://totp/Example%20Co:alice%40example.com?secret=${S}`,
      "Example Co",
      "alice@example.com",
    ],
    ["encoded colon", `otpauth://totp/Example%3Aalice?secret=${S}`, "Example", "alice"],
    ["space after colon", `otpauth://totp/Example:%20alice?secret=${S}`, "Example", "alice"],
    ["encoded space after encoded colon", `otpauth://totp/Example%3A%20alice?secret=${S}`, "Example", "alice"],
    ["CJK", `otpauth://totp/%E8%85%BE%E8%AE%AF:%E5%BC%A0%E4%B8%89?secret=${S}`, "腾讯", "张三"],
    [
      "plus in label is literal",
      `otpauth://totp/Example:alice+tag@example.com?secret=${S}`,
      "Example",
      "alice+tag@example.com",
    ],
    ["plus in issuer param is a space", `otpauth://totp/alice?secret=${S}&issuer=Example+Co`, "Example Co", "alice"],
    ["%20 in issuer param", `otpauth://totp/alice?secret=${S}&issuer=Example%20Co`, "Example Co", "alice"],
    [
      "issuer case differs from prefix, param wins without conflict",
      `otpauth://totp/github:alice?secret=${S}&issuer=GitHub`,
      "GitHub",
      "alice",
    ],
    ["unencoded space in label", `otpauth://totp/Example Co:alice?secret=${S}`, "Example Co", "alice"],
    ["empty label, issuer param", `otpauth://totp/?secret=${S}&issuer=Solo`, "Solo", ""],
    ["issuer containing a colon", `otpauth://totp/A%3AB:alice?secret=${S}&issuer=A%3AB`, "A:B", "alice"],
    ["label with extra colon after issuer", `otpauth://totp/X:a%3Ab?secret=${S}&issuer=X`, "X", "a:b"],
    ["fragment is ignored", `otpauth://totp/x?secret=${S}#frag`, "", "x"],
  ];
  for (const [name, uri, issuer, label] of cases) {
    it(name, () => {
      const { value } = ok(uri);
      expect(value.issuer).toBe(issuer);
      expect(value.label).toBe(label);
    });
  }

  it("issuer conflict: param wins, full label kept, warning raised", () => {
    const r = ok(`otpauth://totp/Foo:alice?secret=${S}&issuer=Bar`);
    expect(r.value.issuer).toBe("Bar");
    expect(r.value.label).toBe("Foo:alice");
    expect(r.warnings).toContain("issuer_mismatch");
  });
  it("matching issuer raises no warning", () => {
    expect(ok(`otpauth://totp/GitHub:alice?secret=${S}&issuer=GitHub`).warnings).toEqual([]);
  });
});

describe("otpauth: parameters", () => {
  it("defaults to SHA1 / 6 digits / 30 s TOTP", () => {
    expect(ok(`otpauth://totp/x?secret=${S}`).value).toMatchObject({
      type: "totp",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
  });
  it("scheme and type are case-insensitive", () => {
    expect(ok(`OTPAUTH://TOTP/x?secret=${S}`).value.type).toBe("totp");
  });
  it("surrounding whitespace is trimmed", () => {
    expect(ok(`  \n otpauth://totp/x?secret=${S}  \t`).value.label).toBe("x");
  });
  for (const [raw, expected] of [
    ["sha256", "SHA256"],
    ["SHA-256", "SHA256"],
    ["SHA512", "SHA512"],
    ["Sha1", "SHA1"],
    ["SHA-512", "SHA512"],
  ] as const) {
    it(`algorithm ${raw}`, () => {
      expect(ok(`otpauth://totp/x?secret=${S}&algorithm=${raw}`).value.algorithm).toBe(expected);
    });
  }
  it("empty algorithm falls back to default", () => {
    expect(ok(`otpauth://totp/x?secret=${S}&algorithm=`).value.algorithm).toBe("SHA1");
  });
  it("digits 8", () => {
    expect(ok(`otpauth://totp/x?secret=${S}&digits=8`).value.digits).toBe(8);
  });
  it("period 60 and 86400", () => {
    expect(ok(`otpauth://totp/x?secret=${S}&period=60`).value.period).toBe(60);
    expect(ok(`otpauth://totp/x?secret=${S}&period=86400`).value.period).toBe(86400);
  });
  it("unknown parameters are ignored", () => {
    const r = ok(`otpauth://totp/x?secret=${S}&image=https%3A%2F%2Fexample.com%2Fa.png&foo=bar&lock=true`);
    expect(r.value.label).toBe("x");
  });
  it("first duplicate parameter wins", () => {
    expect(ok(`otpauth://totp/x?secret=${S}&secret=AAAAAAAA`).value.secret).toBe(S);
  });
  it("hotp keeps its counter, including 0", () => {
    expect(ok(`otpauth://hotp/x?secret=${S}&counter=5`).value).toMatchObject({ type: "hotp", counter: 5 });
    expect(ok(`otpauth://hotp/x?secret=${S}&counter=0`).value.counter).toBe(0);
  });
});

describe("otpauth: secrets", () => {
  it("lowercase is normalised", () => {
    expect(ok(`otpauth://totp/x?secret=${S.toLowerCase()}`).value.secret).toBe(S);
  });
  it("spaces (%20) are stripped", () => {
    expect(ok(`otpauth://totp/x?secret=JBSW%20Y3DP%20EHPK%203PXP`).value.secret).toBe(S);
  });
  it("'+' as a space separator is stripped", () => {
    expect(ok(`otpauth://totp/x?secret=JBSW+Y3DP+EHPK+3PXP`).value.secret).toBe(S);
  });
  it("hyphens and '=' padding are stripped", () => {
    expect(ok(`otpauth://totp/x?secret=JBSW-Y3DP-EHPK-3PXP====`).value.secret).toBe(S);
  });
  it("short secrets are accepted with a warning", () => {
    const r = ok(`otpauth://totp/x?secret=JBSWY3DP`);
    expect(r.warnings).toContain("short_secret");
  });
  it("length that is not a multiple of 8 still decodes", () => {
    expect(ok(`otpauth://totp/x?secret=JBSWY3DPEHPK3PX`).warnings).toContain("short_secret");
  });
  it("80-bit secrets are not flagged", () => {
    expect(ok(`otpauth://totp/x?secret=${S}`).warnings).toEqual([]);
  });
});

describe("otpauth: errors", () => {
  const cases: [string, string, OtpauthError][] = [
    ["empty string", "", "not_otpauth"],
    ["plain text", "hello", "not_otpauth"],
    ["https url", "https://example.com", "not_otpauth"],
    ["single slash", "otpauth:/totp/x", "malformed"],
    ["steam type", `otpauth://steam/x?secret=${S}`, "unsupported_type"],
    ["no secret", "otpauth://totp/x", "missing_secret"],
    ["empty secret", "otpauth://totp/x?secret=", "missing_secret"],
    ["blank secret", "otpauth://totp/x?secret=%20%20", "missing_secret"],
    ["digit 0/1/8/9 in secret", "otpauth://totp/x?secret=JBSWY3D0", "invalid_secret"],
    ["symbol in secret", "otpauth://totp/x?secret=JBSW!Y3DP", "invalid_secret"],
    ["secret with no whole byte", "otpauth://totp/x?secret=A", "invalid_secret"],
    ["MD5", `otpauth://totp/x?secret=${S}&algorithm=MD5`, "unsupported_algorithm"],
    ["SHA3", `otpauth://totp/x?secret=${S}&algorithm=SHA3`, "unsupported_algorithm"],
    ["7 digits", `otpauth://totp/x?secret=${S}&digits=7`, "unsupported_digits"],
    ["10 digits", `otpauth://totp/x?secret=${S}&digits=10`, "unsupported_digits"],
    ["digits not a number", `otpauth://totp/x?secret=${S}&digits=abc`, "unsupported_digits"],
    ["period 0", `otpauth://totp/x?secret=${S}&period=0`, "invalid_period"],
    ["negative period", `otpauth://totp/x?secret=${S}&period=-5`, "invalid_period"],
    ["fractional period", `otpauth://totp/x?secret=${S}&period=1.5`, "invalid_period"],
    ["period not a number", `otpauth://totp/x?secret=${S}&period=abc`, "invalid_period"],
    ["period too large", `otpauth://totp/x?secret=${S}&period=100000`, "invalid_period"],
    ["hotp without counter", `otpauth://hotp/x?secret=${S}`, "missing_counter"],
    ["hotp counter not a number", `otpauth://hotp/x?secret=${S}&counter=abc`, "missing_counter"],
    ["hotp negative counter", `otpauth://hotp/x?secret=${S}&counter=-1`, "missing_counter"],
    ["broken percent-encoding in label", `otpauth://totp/%E0%A4%A?secret=${S}`, "malformed"],
    ["migration uri", "otpauth-migration://offline?data=abc", "migration_uri"],
  ];
  for (const [name, uri, code] of cases) {
    it(`${name} -> ${code}`, () => {
      expect(err(uri)).toBe(code);
    });
  }
});

describe("otpauth: pasting several at once", () => {
  const a = `otpauth://totp/A:one?secret=${S}&issuer=A`;
  const b = `otpauth://totp/B:two?secret=${S}&issuer=B`;
  it("one per line, with blank lines and CRLF", () => {
    const items = parseOtpauthList(`${a}\r\n\r\n${b}\r\n`);
    expect(items.map((i) => i.result.ok)).toEqual([true, true]);
  });
  it("space-separated and run-together", () => {
    expect(parseOtpauthList(`${a} ${b}`)).toHaveLength(2);
    expect(parseOtpauthList(`${a}${b}`)).toHaveLength(2);
  });
  it("reports each line separately, bad ones included", () => {
    const items = parseOtpauthList(`${a}\nnot a uri\notpauth://totp/x\n${b}\notpauth-migration://offline?data=x`);
    expect(items.map((i) => (i.result.ok ? "ok" : i.result.error))).toEqual([
      "ok",
      "not_otpauth",
      "missing_secret",
      "ok",
      "migration_uri",
    ]);
  });
  it("empty input gives nothing", () => {
    expect(parseOtpauthList("  \n \n")).toEqual([]);
  });
});

describe("otpauth: serialisation", () => {
  const base: OtpParams = {
    type: "totp",
    issuer: "GitHub",
    label: "alice@example.com",
    secret: S,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  };
  it("matches the expected string", () => {
    expect(serializeOtpauth(base)).toBe(
      `otpauth://totp/GitHub:alice%40example.com?secret=${S}&issuer=GitHub&algorithm=SHA1&digits=6&period=30`,
    );
  });
  it("omits issuer when empty", () => {
    expect(serializeOtpauth({ ...base, issuer: "" })).toBe(
      `otpauth://totp/alice%40example.com?secret=${S}&algorithm=SHA1&digits=6&period=30`,
    );
  });
  it("hotp writes counter, not period", () => {
    expect(serializeOtpauth({ ...base, type: "hotp", counter: 7 })).toContain("counter=7");
    expect(serializeOtpauth({ ...base, type: "hotp", counter: 7 })).not.toContain("period");
  });
  it("round-trips arbitrary parameters", () => {
    const text = fc.string({ unit: "grapheme", maxLength: 24 }).filter((s) => s === s.trim());
    const params = fc.record({
      type: fc.constantFrom("totp" as const, "hotp" as const),
      issuer: text,
      label: text,
      bytes: fc.uint8Array({ minLength: 1, maxLength: 64 }),
      algorithm: fc.constantFrom("SHA1" as const, "SHA256" as const, "SHA512" as const),
      digits: fc.constantFrom(6 as const, 8 as const),
      period: fc.integer({ min: 1, max: 86400 }),
      counter: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    });
    fc.assert(
      fc.property(params, (p) => {
        const input: OtpParams = {
          type: p.type,
          issuer: p.issuer,
          label: p.label,
          secret: encodeBase32(p.bytes),
          algorithm: p.algorithm,
          digits: p.digits,
          period: p.type === "totp" ? p.period : 30,
          ...(p.type === "hotp" ? { counter: p.counter } : {}),
        };
        const r = parseOtpauth(serializeOtpauth(input));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toEqual(input);
      }),
      { numRuns: 500 },
    );
  });
});
