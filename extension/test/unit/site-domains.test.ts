// PHASE0X-PLAN B2: which sites may be registered for an account (site-domains.ts), and the typed forms accepted.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostOf, isIpHost, matchTier, parseSite } from "../../src/core/match";
import { domainChoices, isShared, preferredChoice } from "../../src/core/site-domains";

describe("domainChoices", () => {
  it("the host first, then each parent, never a single label or a shared suffix", () => {
    expect(domainChoices("accounts.google.com")).toEqual(["accounts.google.com", "google.com"]);
    expect(domainChoices("signin.aws.amazon.com")).toEqual(["signin.aws.amazon.com", "aws.amazon.com", "amazon.com"]);
    expect(domainChoices("github.com")).toEqual(["github.com"]);
    expect(domainChoices("www.bbc.co.uk")).toEqual(["www.bbc.co.uk", "bbc.co.uk"]);
    expect(domainChoices("passport.baidu.com.cn")).toEqual(["passport.baidu.com.cn", "baidu.com.cn"]);
    expect(domainChoices("x.example.co.at")).toEqual(["x.example.co.at", "example.co.at"]); // the country rule, not the table
    expect(domainChoices("alice.github.io")).toEqual(["alice.github.io"]);
    expect(domainChoices("docs.alice.github.io")).toEqual(["docs.alice.github.io", "alice.github.io"]);
    expect(domainChoices("my-app.vercel.app")).toEqual(["my-app.vercel.app"]);
    expect(domainChoices("github.localhost")).toEqual(["github.localhost"]);
  });

  it("nothing above a shared suffix: a bucket's host, but never amazonaws.com", () => {
    expect(domainChoices("bucket.s3.amazonaws.com")).toEqual(["bucket.s3.amazonaws.com"]);
    expect(domainChoices("console.amazonaws.com")).toEqual(["console.amazonaws.com"]);
    expect(isShared("amazonaws.com")).toBe(true);
    expect(isShared("windows.net")).toBe(true);
  });

  it("nothing at all for single labels and for hosts that are themselves shared", () => {
    for (const h of [
      "localhost",
      "intranet",
      "com",
      "co.uk",
      "com.cn",
      "github.io",
      "vercel.app",
      "s3.amazonaws.com",
      "amazonaws.com",
    ])
      expect(domainChoices(h), h).toEqual([]);
  });

  it("an IP address offers only itself, and agrees with match.ts on what an IP address is", () => {
    expect(domainChoices("192.168.1.1")).toEqual(["192.168.1.1"]);
    expect(domainChoices("[::1]")).toEqual(["[::1]"]);
    // Four labels give three choices unless the host is an address; brackets give none unless it is one.
    for (const h of ["192.168.1.1", "10.0.0.1", "[::1]", "[2001:db8::1]", "1.2.3.example", "a.b.c.d", "w.x.y.z"]) {
      expect(domainChoices(h).length === 1, h).toBe(isIpHost(h));
    }
  });

  it("on a look-alike the choices spell out who owns it, and never offer the real site", () => {
    expect(domainChoices(hostOf("https://github.com.attacker.io/")!)).toEqual([
      "github.com.attacker.io",
      "com.attacker.io",
      "attacker.io",
    ]);
    expect(domainChoices(hostOf("https://google.evil-login.ru/")!)).toEqual(["google.evil-login.ru", "evil-login.ru"]);
    expect(domainChoices(hostOf("https://аpple.com/")!)).toEqual(["xn--pple-43d.com"]);
  });

  it("starts with the host itself, or its parent when the host only adds www.", () => {
    expect(preferredChoice(domainChoices("accounts.google.com"))).toBe("accounts.google.com");
    expect(preferredChoice(domainChoices("www.example.com"))).toBe("example.com");
    expect(preferredChoice(domainChoices("www.bbc.co.uk"))).toBe("bbc.co.uk");
    expect(preferredChoice(domainChoices("acme.example-saas.com"))).toBe("acme.example-saas.com"); // never the tenant's parent
    expect(preferredChoice([])).toBeUndefined();
  });

  it("each choice, once registered, makes the page registered", () => {
    for (const h of ["accounts.google.com", "www.bbc.co.uk", "alice.github.io", "192.168.1.1", "[::1]"]) {
      for (const d of domainChoices(h))
        expect(matchTier({ issuer: "", domains: [d] }, h), `${d} on ${h}`).toBe("registered");
    }
  });
});

describe("isShared", () => {
  it("the table and the country rule; real sites under them are not shared", () => {
    const src = readFileSync(join(__dirname, "../../src/core/site-domains.ts"), "utf8");
    const table = /new Set\(\s*`([\s\S]*?)`/.exec(src)![1]!.trim().split(/\s+/);
    expect(table.length).toBeGreaterThanOrEqual(80);
    expect(new Set(table).size).toBe(table.length);
    for (const s of table) expect(isShared(s), s).toBe(true);
    for (const s of [
      "co.uk",
      "org.uk",
      "com.au",
      "co.jp",
      "or.jp",
      "com.cn",
      "gov.cn",
      "com.hk",
      "com.tw",
      "idv.tw",
      "co.kr",
      "co.in",
      "com.br",
      "gob.mx",
      "co.za",
    ])
      expect(isShared(s), s).toBe(true);
    for (const s of ["google.com", "github.com", "aliyun.com", "bbc.co.uk", "web.de", "id.me", "x.com", "co.co.uk"])
      expect(isShared(s), s).toBe(false);
  });

  it("single labels and IP addresses", () => {
    expect(isShared("com")).toBe(true);
    expect(isShared("localhost")).toBe(true);
    expect(isShared("192.168.1.1")).toBe(false);
    expect(isShared("[::1]")).toBe(false);
  });
});

describe("parseSite: what may be typed in the editor's Sites field", () => {
  it("a host, a pasted address, or typed shorthand, stored in the URL parser's form", () => {
    expect(parseSite("github.com")).toBe("github.com");
    expect(parseSite("  GitHub.COM  ")).toBe("github.com");
    expect(parseSite("https://GitHub.com/login?next=/")).toBe("github.com");
    expect(parseSite("https://alice@github.com:8443/")).toBe("github.com");
    expect(parseSite("*.github.com")).toBe("github.com");
    expect(parseSite("github.com/login")).toBe("github.com");
    expect(parseSite("github.com:443")).toBe("github.com");
    expect(parseSite("github.com.")).toBe("github.com");
    expect(parseSite("Bücher.de")).toBe("xn--bcher-kva.de");
    expect(parseSite("192.168.1.1:5001")).toBe("192.168.1.1");
    expect(parseSite("[::1]:8080")).toBe("[::1]");
    expect(parseSite("com")).toBe("com"); // well-formed; isShared refuses it
  });

  it("refuses anything that is not a host name", () => {
    for (const s of [
      "",
      "   ",
      "git hub.com",
      "javascript:alert(1)",
      "github..com",
      ".github.com",
      "a_b c",
      "%67ithub.com",
      "xn--zz.com",
      "foo.123",
      "a".repeat(254),
      "::1",
      "http://",
    ])
      expect(parseSite(s), s).toBeNull();
  });
});
