// Pages that look like an account's site without being it (core/lookalike.ts; the owner's request of 2026-11-18).
import { describe, expect, it } from "vitest";
import { lookalikeOf } from "../../src/core/lookalike";

const gh = { issuer: "GitHub", domains: ["github.com"] };
const cs = { issuer: "CSLink", domains: ["cslink.vip"] };

describe("a page that looks like an account's site", () => {
  it.each([
    ["githuh.com", "a letter changed"],
    ["gitthub.com", "a letter added"],
    ["githb.com", "a letter dropped"],
    ["gihtub.com", "two letters swapped"],
    ["g1thub.com", "a look-alike character"],
    ["github-login.com", "one part of a hyphenated name"],
    ["secure-github.net", "one part of a hyphenated name"],
    ["github.com.evil.ru", "the name on another domain"],
    ["login.github.evil.com", "the name as a label of another domain"],
    ["github.io", "the name under another suffix"],
    ["githuh.co.uk", "a country's suffix"],
  ])("%s: %s", (host) => {
    expect(lookalikeOf(gh, host)).toBe("github.com");
  });
  it.each([
    ["github.com", "the site"],
    ["gist.github.com", "a subdomain of the site"],
    ["githubusercontent.com", "the name run into a longer one, unhyphenated"],
    ["gitlab.com", "another name, two letters away"],
    ["example.com", "nothing like it"],
    ["127.0.0.1", "an address"],
  ])("%s: %s, not", (host) => {
    expect(lookalikeOf(gh, host)).toBeNull();
  });
  it("the owner's sites: a subdomain of the remembered site is the site; a near miss is not", () => {
    expect(lookalikeOf(cs, "admin.cslink.vip")).toBeNull();
    expect(lookalikeOf(cs, "admin.csIink.vip")).toBe("cslink.vip");
    expect(lookalikeOf(cs, "cs1ink.vip")).toBe("cslink.vip");
  });
  it("an account with no remembered site: only near misses of its name, never a page that has the name itself", () => {
    const bare = { issuer: "Sharelife" };
    expect(lookalikeOf(bare, "admin.sharelife.com")).toBeNull();
    expect(lookalikeOf(bare, "sharelife-login.com")).toBeNull(); // could be its site: only the name to go by
    expect(lookalikeOf(bare, "sharelfe.com")).toBe("Sharelife");
    expect(lookalikeOf({ issuer: "AWS" }, "aws.amazon.com")).toBeNull(); // under 4 letters: never compared
    expect(lookalikeOf({ issuer: "Box" }, "b0x.com")).toBeNull();
  });
});
