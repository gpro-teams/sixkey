// "Same sign-in" suggestions (src/core/rules/alias.ts; the plan's §3.4; docs/design/notes/AUTOFILL3-NOTES.md, AF3-1a), over
// real entries of Apple's list (apple/password-manager-resources, quirks/shared-credentials.json at e6a7cf40, written here
// in the bundle's form): one-way groups offer the `f` hosts' accounts on the `t` hosts only, shared groups every way, a
// member covers itself and its www. host only, and an account registered for the page is never among them.
import { describe, expect, it } from "vitest";
import { matchTier } from "../../src/core/match";
import { aliasRelated, atMember, offeredOn } from "../../src/core/rules/alias";
import type { AliasGroup } from "../../src/core/rules/format";

// {"from": ["twitter.com"], "to": ["x.com"], "fromDomainsAreObsoleted": true}, and so on, as Apple writes them
const APPLE: AliasGroup[] = [
  { f: ["twitter.com"], t: ["x.com"] },
  { s: ["chat.com", "chatgpt.com", "openai.com"] },
  { f: ["discordapp.com"], t: ["discord.com"] },
  { f: ["gamepedia.com", "wikia.com", "wikia.org", "wikicities.com"], t: ["fandom.com"] },
  { s: ["s.activision.com", "profile.callofduty.com"] },
  { s: ["proton.me", "protonvpn.com", "protonmail.ch", "protonmail.com"] },
  // Apple's three members that start with www. (the r2 recheck's R4-3)
  {
    f: [
      "www.seek.com.au",
      "www.seek.co.nz",
      "jobsdb.com",
      "hk.jobsdb.com",
      "sg.jobsdb.com",
      "th.jobsdb.com",
      "jobstreet.com",
      "myjobstreet.jobstreet.co.id",
      "myjobstreet.jobstreet.com.my",
      "myjobstreet.jobstreet.com.ph",
      "myjobstreet.jobstreet.com.sg",
    ],
    t: ["login.seek.com"],
  },
  { f: ["www.vistaprint.ca"], t: ["account.vistaprint.com"] },
];
let n = 0;
const acct = (...domains: string[]) => ({ id: `e${++n}`, issuer: "Account", domains });

describe("which members a page is offered", () => {
  it("a one-way group: the f hosts on a t host, never the other way (twitter.com → x.com)", () => {
    expect(offeredOn(APPLE, "x.com")).toEqual(["twitter.com"]);
    expect(offeredOn(APPLE, "twitter.com")).toEqual([]);
    expect(offeredOn(APPLE, "discord.com")).toEqual(["discordapp.com"]);
    expect(offeredOn(APPLE, "discordapp.com")).toEqual([]);
    expect(offeredOn(APPLE, "fandom.com")).toEqual(["gamepedia.com", "wikia.com", "wikia.org", "wikicities.com"]);
    expect(offeredOn(APPLE, "wikia.com")).toEqual([]);
  });
  it("a shared group: every other member, every way", () => {
    expect(offeredOn(APPLE, "chatgpt.com")).toEqual(["chat.com", "openai.com"]);
    expect(offeredOn(APPLE, "openai.com")).toEqual(["chat.com", "chatgpt.com"]);
    expect(offeredOn(APPLE, "profile.callofduty.com")).toEqual(["s.activision.com"]);
  });
  it("a member covers itself and its www. host, one leading www. taken off each side, and no other subdomain", () => {
    expect(offeredOn(APPLE, "www.x.com")).toEqual(["twitter.com"]);
    expect(offeredOn(APPLE, "www.openai.com")).toEqual(["chat.com", "chatgpt.com"]);
    for (const h of [
      "api.x.com",
      "community.fandom.com",
      "someone.fandom.com",
      "callofduty.com",
      "activision.com",
      "www.www.x.com",
      "x.com.evil.example",
      "notx.com",
      "xx.com",
    ])
      expect(offeredOn(APPLE, h), h).toEqual([]);
    expect(atMember("x.com", "x.com")).toBe(true);
    expect(atMember("www.x.com", "x.com")).toBe(true);
    expect(atMember("m.x.com", "x.com")).toBe(false);
    expect(atMember("x.com", "www.x.com")).toBe(true);
    expect(atMember("seek.com.au", "www.seek.com.au")).toBe(true);
    expect(atMember("www.www.x.com", "x.com")).toBe(false);
    expect(atMember("wwwx.com", "x.com")).toBe(false);
  });
  it("nothing for an IP address, no host, or no groups", () => {
    expect(offeredOn(APPLE, "1.2.3.4")).toEqual([]);
    expect(offeredOn(APPLE, "[::1]")).toEqual([]);
    expect(offeredOn(APPLE, null)).toEqual([]);
    expect(offeredOn([], "x.com")).toEqual([]);
  });
  it("each member once, in the groups' order, when two groups offer it", () => {
    const g: AliasGroup[] = [{ s: ["a.com", "b.com"] }, { f: ["b.com", "c.com"], t: ["a.com"] }];
    expect(offeredOn(g, "a.com")).toEqual(["b.com", "c.com"]);
  });
});

describe("which accounts are offered, with the site that makes them the same sign-in", () => {
  it("an account registered for twitter.com on x.com, and not the reverse", () => {
    const tw = acct("twitter.com");
    const x = acct("x.com");
    expect([...aliasRelated([tw, x], "x.com", APPLE)]).toEqual([[tw.id, "twitter.com"]]);
    expect([...aliasRelated([tw, x], "twitter.com", APPLE)]).toEqual([]);
    // www. on either side
    const wtw = acct("www.twitter.com");
    expect([...aliasRelated([wtw], "www.x.com", APPLE)]).toEqual([[wtw.id, "www.twitter.com"]]);
  });
  it("a shared group, both ways (chatgpt.com, openai.com)", () => {
    const o = acct("openai.com");
    const c = acct("chatgpt.com");
    expect([...aliasRelated([o, c], "chatgpt.com", APPLE)]).toEqual([[o.id, "openai.com"]]);
    expect([...aliasRelated([o, c], "openai.com", APPLE)]).toEqual([[c.id, "chatgpt.com"]]);
  });
  it("never an account already registered for the page (it is This site), so never the registered tier", () => {
    const both = acct("twitter.com", "x.com");
    const parent = acct("twitter.com", "www.x.com");
    expect(matchTier(both, "x.com")).toBe("registered");
    expect(aliasRelated([both], "x.com", APPLE).size).toBe(0);
    expect(matchTier(parent, "www.x.com")).toBe("registered");
    expect(aliasRelated([parent], "www.x.com", APPLE).size).toBe(0);
    // and what it returns is never "registered" for any account
    const all = [acct("twitter.com"), acct("openai.com"), acct("chat.com"), both, parent];
    for (const h of ["x.com", "www.x.com", "chatgpt.com", "openai.com"])
      for (const id of aliasRelated(all, h, APPLE).keys())
        expect(
          matchTier(
            all.find((e) => e.id === id)!,
            h,
          ),
          `${id} on ${h}`,
        ).not.toBe("registered");
  });
  it("an account's site must be at an offered member: a subdomain or a parent of it does not count", () => {
    for (const d of ["api.twitter.com", "mobile.twitter.com", "callofduty.com"]) {
      const a = acct(d);
      expect(aliasRelated([a], "x.com", APPLE).size, d).toBe(0);
      expect(aliasRelated([a], "s.activision.com", APPLE).size, d).toBe(0);
    }
    const cod = acct("profile.callofduty.com");
    expect([...aliasRelated([cod], "s.activision.com", APPLE)]).toEqual([[cod.id, "profile.callofduty.com"]]);
  });
  it("Apple's www. members: an account remembered on www.seek.com.au (stored as seek.com.au) is offered on login.seek.com", () => {
    const seek = acct("seek.com.au"); // site-domains.ts preferredChoice stores this for www.seek.com.au
    const nz = acct("www.seek.co.nz");
    const vista = acct("vistaprint.ca");
    expect([...aliasRelated([seek, nz, vista], "login.seek.com", APPLE)]).toEqual([
      [seek.id, "seek.com.au"],
      [nz.id, "www.seek.co.nz"],
    ]);
    expect([...aliasRelated([vista], "account.vistaprint.com", APPLE)]).toEqual([[vista.id, "vistaprint.ca"]]);
    // one way still: nothing for them on the seek or vistaprint hosts themselves
    expect(offeredOn(APPLE, "www.seek.com.au")).toEqual([]);
    expect(offeredOn(APPLE, "seek.com.au")).toEqual([]);
    // and a subdomain of a member is no member: login.seek.com is not seek.com
    expect(offeredOn(APPLE, "seek.com")).toEqual([]);
  });
  it("only usable registered sites count (a stored 'com', a wildcard, an address are ignored), the first one names it", () => {
    const junk = acct("com", "*.twitter.com", "https://twitter.com", "TWITTER.COM");
    // TWITTER.COM is canonicalised to twitter.com by usableDomain, as match.ts does for every stored site
    expect([...aliasRelated([junk], "x.com", APPLE)]).toEqual([[junk.id, "twitter.com"]]);
    const two = acct("www.twitter.com", "twitter.com");
    expect(aliasRelated([two], "x.com", APPLE).get(two.id)).toBe("www.twitter.com");
    const none = { id: "nodomains", issuer: "Twitter", domains: undefined };
    expect(aliasRelated([none], "x.com", APPLE).size).toBe(0);
  });
  it("nothing on an IP address, on no host, or without groups", () => {
    const a = acct("twitter.com");
    expect(aliasRelated([a], null, APPLE).size).toBe(0);
    expect(aliasRelated([a], "1.2.3.4", APPLE).size).toBe(0);
    expect(aliasRelated([a], "x.com", []).size).toBe(0);
  });
});
