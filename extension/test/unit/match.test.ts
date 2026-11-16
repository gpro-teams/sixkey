import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalHost, firmGuess, hostOf, matchesSite, matchTier, normalizeName } from "../../src/core/match";
import { LIMITS } from "../../src/core/vault/validate";

describe("hostOf", () => {
  it("only web pages have a host", () => {
    expect(hostOf("https://github.com/login")).toBe("github.com");
    expect(hostOf("http://Example.COM:8080/x")).toBe("example.com");
    for (const u of [
      "chrome://newtab",
      "about:blank",
      "file:///x",
      "chrome-extension://abc/p.html",
      "",
      undefined,
      "not a url",
    ])
      expect(hostOf(u)).toBeNull();
  });
});

describe("matchesSite", () => {
  const e = (issuer: string, domains?: string[]) => ({ issuer, ...(domains ? { domains } : {}) });
  it("domain rule matches the host and its subdomains, not look-alikes", () => {
    expect(matchesSite(e("X", ["github.com"]), "github.com")).toBe(true);
    expect(matchesSite(e("X", ["github.com"]), "gist.github.com")).toBe(true);
    expect(matchesSite(e("X", ["github.com"]), "notgithub.com")).toBe(false);
    expect(matchesSite(e("X", ["github.com"]), "github.com.evil.example")).toBe(false);
  });
  it("issuer name matches a whole host label", () => {
    expect(matchesSite(e("GitHub"), "github.com")).toBe(true);
    expect(matchesSite(e("AWS"), "console.aws.amazon.com")).toBe(true);
    expect(matchesSite(e("Google"), "accounts.google.com")).toBe(true);
  });
  it("short or generic issuers do not match everything", () => {
    expect(matchesSite(e("A"), "apple.com")).toBe(false);
    expect(matchesSite(e("ab"), "abc.com")).toBe(false);
    expect(matchesSite(e(""), "example.com")).toBe(false);
  });
  it("long issuers may match inside a longer host name; short ones need an exact label", () => {
    expect(matchesSite(e("Cloudflare"), "dash.cloudflare.com")).toBe(true);
    expect(matchesSite(e("Git"), "github.com")).toBe(false);
  });
  it("no host, no match", () => {
    expect(matchesSite(e("GitHub", ["github.com"]), null)).toBe(false);
  });
});

// PHASE0X-PLAN B2: two tiers. Only a registered domain makes an account "This site"; a name guess is only "related".
describe("matchTier", () => {
  const e = (issuer: string, domains?: string[]) => ({ issuer, ...(domains ? { domains } : {}) });
  const tier = (issuer: string, domains: string[] | undefined, url: string) =>
    matchTier(e(issuer, domains), hostOf(url));

  // ux-study §2.10 / E5: the look-alikes the old rule labelled "This site". (The study's summary counts five; §2.10 and
  // bench/match-check.mjs name these four.) More of the usual tricks follow them.
  const LOOKALIKES: [issuer: string, real: string, url: string][] = [
    ["Google", "google.com", "https://google.evil-login.ru/"],
    ["Google", "google.com", "https://secure-google-verify.com/"],
    ["PayPal", "paypal.com", "https://paypal-account-check.xyz/"],
    ["GitHub", "github.com", "https://github.com.attacker.io/login"],
    ["GitHub", "github.com", "https://github.com-login.ru/"],
    ["GitHub", "github.com", "https://notgithub.com/"],
    ["GitHub", "github.com", "https://github.co/"],
    ["Google", "accounts.google.com", "https://accounts.google.com.evil.io/"],
    ["Google", "google.com", "https://accounts-google.com/"],
    ["GitHub", "github.com", "https://github.com@evil.io/"], // user info: the host is evil.io
    ["GitHub", "github.com", "https://evil.io\\@github.com/"], // a backslash ends the host
    ["GitHub", "github.com", "https://evil.io#@github.com"],
    ["GitHub", "github.com", "https://evil.io?.github.com"],
    ["GitHub", "github.com", "https://github.com%2eevil.io/"], // decodes to github.com.evil.io
    ["Apple", "apple.com", "https://\u0430pple.com/"], // Cyrillic а: xn--pple-43d.com
    ["Google", "google.com", "https://g\u043e\u043egle.com/"], // Cyrillic о
  ];

  it("a look-alike host is never registered, with or without the real site's domain", () => {
    for (const [issuer, real, url] of LOOKALIKES) {
      expect(tier(issuer, undefined, url), url).not.toBe("registered");
      expect(tier(issuer, [real], url), url).not.toBe("registered");
      expect(tier("X", [real, `www.${real}`], url), url).toBeNull();
    }
  });

  it("an account with a registered domain is not guessed elsewhere, so a look-alike does not even list it as related", () => {
    for (const [issuer, real, url] of LOOKALIKES) expect(tier(issuer, [real], url), url).toBeNull();
    // the old guess, kept for accounts without a site: the first four are "related", never "This site"
    for (const [issuer, , url] of LOOKALIKES.slice(0, 4)) expect(tier(issuer, undefined, url), url).toBe("related");
  });

  it("the registered domain and its subdomains are registered; the name guess alone is only related", () => {
    expect(tier("GitHub", ["github.com"], "https://github.com/login")).toBe("registered");
    expect(tier("Anything", ["github.com"], "https://gist.github.com/")).toBe("registered");
    expect(tier("Google", ["google.com"], "https://accounts.google.com/")).toBe("registered");
    expect(tier("Google", ["accounts.google.com"], "https://accounts.google.com/")).toBe("registered");
    expect(tier("Google", ["accounts.google.com"], "https://google.com/")).toBeNull(); // a parent is not covered by its child
    expect(tier("GitHub", undefined, "https://github.com/")).toBe("related");
    expect(tier("Google", undefined, "https://accounts.google.com/")).toBe("related");
    expect(tier("Nothing", undefined, "https://github.com/")).toBeNull();
    expect(matchTier(e("GitHub", ["github.com"]), null)).toBeNull();
  });

  it("Chinese names keep their letters and match once their domain is registered", () => {
    expect(normalizeName("阿里云")).toBe("阿里云");
    expect(normalizeName("阿里云").length).toBeGreaterThan(0);
    expect(tier("阿里云", undefined, "https://signin.aliyun.com/")).toBeNull(); // nothing to guess from an ASCII host
    expect(tier("阿里云", ["aliyun.com"], "https://signin.aliyun.com/")).toBe("registered");
    expect(matchesSite(e("阿里云", ["aliyun.com"]), "signin.aliyun.com")).toBe(true);
    // a name's ASCII part still guesses; accents and full-width letters fold
    expect(tier("Google 谷歌", undefined, "https://accounts.google.com/")).toBe("related");
    expect(tier("阿里云 Aliyun", undefined, "https://signin.aliyun.com/")).toBe("related");
    expect(tier("Société Générale", undefined, "https://particuliers.societegenerale.fr/")).toBe("related");
    expect(tier("\uff27\uff49\uff54\uff28\uff55\uff42", undefined, "https://github.com/")).toBe("related"); // ＧｉｔＨｕｂ
    expect(normalizeName("Société Générale")).toBe("societegenerale");
  });

  it("the guess: a whole label but not the top level, a long name inside the host, never punycode or IP hosts", () => {
    expect(tier("Shop", undefined, "https://example.shop/")).toBeNull();
    expect(tier("Booking.com", undefined, "https://account.booking.com/")).toBe("related");
    expect(tier("Mail.ru", undefined, "https://e.mail.ru/")).toBe("related");
    expect(tier("Apple", undefined, "https://\u0430pple.com/")).toBeNull(); // xn--pple-43d.com: no name in it
    expect(tier("192", undefined, "http://192.168.1.1/")).toBeNull();
    expect(tier("GitHub", undefined, "http://github.localhost:8080/")).toBe("related");
  });

  it("international names compare as punycode on both sides; nothing is decoded", () => {
    expect(hostOf("https://b\u00fccher.de/")).toBe("xn--bcher-kva.de");
    expect(tier("X", ["xn--bcher-kva.de"], "https://b\u00fccher.de/")).toBe("registered");
    expect(tier("X", ["b\u00fccher.de"], "https://www.b\u00fccher.de/")).toBe("registered"); // stored in Unicode: compared as punycode
    expect(hostOf("https://\u0430pple.com/")).toMatch(/^xn--/);
    expect(tier("X", ["apple.com"], "https://\u0430pple.com/")).toBeNull();
  });

  it("ports and trailing dots do not matter; IP addresses only ever match exactly", () => {
    expect(tier("X", ["nas.example.net"], "https://nas.example.net:5001/")).toBe("registered");
    expect(hostOf("https://GITHUB.COM.:443/x")).toBe("github.com");
    expect(tier("X", ["GitHub.com."], "https://github.com./")).toBe("registered");
    expect(tier("X", ["192.168.1.1"], "http://192.168.1.1:5001/")).toBe("registered");
    expect(tier("X", ["192.168.1.1"], "http://3232235777/")).toBe("registered"); // the same address, written as a number
    expect(tier("X", ["168.1.1"], "http://192.168.1.1/")).toBeNull();
    expect(tier("X", ["1.1"], "http://1.1.1.1/")).toBeNull();
    expect(tier("X", ["1.1.1"], "http://1.1.1.1/")).toBeNull();
    expect(tier("X", ["[::1]"], "http://[::1]:8080/")).toBe("registered");
    expect(tier("X", ["[0:0:0:0:0:0:0:1]"], "http://[::1]/")).toBe("registered");
  });

  it("stored domains that are not a usable host name are ignored, never widened; the guess then still applies", () => {
    for (const junk of [
      "com",
      "localhost",
      "*.github.com",
      "https://github.com",
      "github.com/login",
      "github.com:443",
      "",
      " ",
      "git hub.com",
      "%67ithub.com",
      "github..com",
      ".github.com",
      "xn--zz.com",
      "a".repeat(254),
    ]) {
      expect(tier("X", [junk], "https://github.com/"), junk).toBeNull();
      expect(tier("X", [junk], "https://gist.github.com/"), junk).toBeNull();
      expect(tier("GitHub", [junk], "https://github.com/"), junk).toBe("related");
    }
    expect(tier("X", ["localhost"], "http://localhost:3000/")).toBeNull();
    expect(
      canonicalHost("a".repeat(63) + "." + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(61)),
    ).not.toBeNull(); // 253
    expect(
      canonicalHost("a".repeat(63) + "." + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(62)),
    ).toBeNull(); // 254
    expect(LIMITS.domain).toBe(253); // so every host canonicalHost accepts fits the vault's limit for a domain
  });

  it("property: registered exactly when the host's last labels are the domain's labels", () => {
    const label = fc.stringMatching(/^[ab]{1,2}$/); // a tiny alphabet, so hosts and domains often overlap
    fc.assert(
      fc.property(
        fc.array(label, { minLength: 1, maxLength: 4 }),
        fc.array(label, { minLength: 2, maxLength: 3 }),
        (hostLabels, domainLabels) => {
          const host = hostLabels.join(".");
          const oracle =
            hostLabels.length >= domainLabels.length &&
            hostLabels.slice(-domainLabels.length).join(".") === domainLabels.join(".");
          expect(matchTier({ issuer: "", domains: [domainLabels.join(".")] }, host) === "registered").toBe(oracle);
          // glued on without a dot, or with more labels after it, it never counts
          expect(matchTier({ issuer: "", domains: [domainLabels.join(".")] }, `x${domainLabels.join(".")}`)).toBeNull();
          expect(
            matchTier({ issuer: "", domains: [domainLabels.join(".")] }, `${domainLabels.join(".")}.zz`),
          ).toBeNull();
        },
      ),
      { numRuns: 500 },
    );
  });
});

// AFMATCH (docs/design/notes/AFMATCH-NOTES.md): a name of 2 letters or digits is guessed too, as a whole label only. The
// owner's case: accounts imported from Google Authenticator have no sites, and "ws" was too short for any guess on ws.g.pro.
describe("the name guess for a name of 2", () => {
  const tier = (issuer: string, domains: string[] | undefined, url: string) =>
    matchTier({ issuer, ...(domains ? { domains } : {}) }, hostOf(url));

  it("a whole label other than the top level: related, never registered", () => {
    expect(tier("ws", undefined, "https://ws.g.pro/admin/")).toBe("related");
    expect(tier("WS", undefined, "https://login.ws.example.com/")).toBe("related");
    expect(tier("W.S.", undefined, "https://ws.g.pro/")).toBe("related"); // folded to "ws"
    expect(tier("ws 后台", undefined, "https://ws.g.pro/")).toBe("related"); // only the ASCII part compares
    expect(tier("51", undefined, "https://www.51.example/")).toBe("related");
    expect(tier("ws", undefined, "https://ws.pro/")).toBe("related");
  });

  it("not the top-level label", () => {
    expect(tier("ws", undefined, "https://example.ws/")).toBeNull();
    expect(tier("io", undefined, "https://github.io/")).toBeNull();
    expect(tier("CN", undefined, "https://www.example.cn/")).toBeNull();
  });

  it("never run together: inside a label, or across labels, it is not a guess", () => {
    for (const url of [
      "https://aws.amazon.com/",
      "https://news.example.com/",
      "https://wsx.example.com/",
      "https://w.s.example.com/", // run together: "wsexamplecom"
      "https://example.wsx/",
    ])
      expect(tier("ws", undefined, url), url).toBeNull();
    // the names of 3 and 4 keep the rule they had: a whole label, never inside one
    expect(tier("Git", undefined, "https://github.com/")).toBeNull();
    expect(tier("Hub", undefined, "https://hub.docker.com/")).toBe("related");
  });

  it("never a punycode label, never an IP host", () => {
    expect(hostOf("https://wsü.example.com/")).toMatch(/^xn--ws-/);
    expect(tier("ws", undefined, "https://wsü.example.com/")).toBeNull();
    expect(tier("10", undefined, "http://10.0.0.1/")).toBeNull();
    expect(tier("12", undefined, "http://12.34.56.78:8080/")).toBeNull();
  });

  it("one letter is never enough", () => {
    expect(tier("x", undefined, "https://x.example.com/")).toBeNull();
    expect(tier("Q", undefined, "https://q.q.example/")).toBeNull();
    expect(tier("q 云", undefined, "https://q.example.com/")).toBeNull();
  });

  it("an account with a usable registered domain is not guessed; an unusable one does not stop the guess", () => {
    expect(tier("ws", ["ws.g.pro"], "https://ws.g.pro/")).toBe("registered");
    expect(tier("ws", ["ws.g.pro"], "https://ws.example.com/")).toBeNull();
    expect(tier("ws", ["github.com"], "https://ws.g.pro/")).toBeNull();
    expect(tier("ws", ["com"], "https://ws.g.pro/")).toBe("related");
  });

  it('too weak to tick "Show first on <host>" for a new account (firmGuess): only a guess of 3 or more does', () => {
    expect(firmGuess("ws", "ws.g.pro")).toBe(false); // related, by a name of 2 only
    expect(firmGuess("W.S.", "ws.g.pro")).toBe(false);
    expect(firmGuess("ws 后台", "ws.g.pro")).toBe(false); // the guess is on the ASCII part, and so is its length
    expect(firmGuess("Hub", "hub.docker.com")).toBe(true); // 3, as before
    expect(firmGuess("GitHub", "github.com")).toBe(true);
    expect(firmGuess("Booking.com", "account.booking.com")).toBe(true); // run together
    expect(firmGuess("Zoom", "ws.g.pro")).toBe(false); // no guess at all
    expect(firmGuess("GitHub", "192.168.1.1")).toBe(false);
    expect(firmGuess("GitHub", null)).toBe(false);
  });
});
