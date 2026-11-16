// The plugin platform's pure rules, kept in src/core/plugins with the grant store (from the removed plugin SDK's
// specification): JCS and the
// worked contributionsHash; plain text, protected terms, the shortcut grammar and the PNG limits (§2.3, §5.1, §7.2,
// §7.3); the descriptor read tolerantly (§4.3) and negotiated (§5.3); the allow-list of harmless changes (§4.2 item 2);
// the catalog, the trust levels, their ceilings and slots, and a plugin's state (§8, §6.2, §7.1, §9.6).
import { describe, expect, it } from "vitest";
import { jcs, sha256Hex } from "../../src/core/plugins/jcs";
import {
  contributionsHash,
  isStoredDescriptor,
  localised,
  negotiate,
  onlyHarmless,
  readDescriptor,
  type Descriptor,
} from "../../src/core/plugins/descriptor";
import { displayText, isPlainText, isShortcut, pngDrawable, usesProtectedTerm } from "../../src/core/plugins/text";
import {
  ceilingOf,
  heldNow,
  parseCatalog,
  shownName,
  slotAllowed,
  stateOf,
  trustOf,
  type Catalog,
} from "../../src/core/plugins/policy";
import type { GrantEntry } from "../../src/core/plugins/grants";
import { BLOCKED, descriptor, LISTED, OFFICIAL, PID, png } from "../helpers/plugins";

const read = (d: unknown) => {
  const r = readDescriptor(d);
  if (!r.ok) throw new Error(`not read: ${JSON.stringify(r)}`);
  return r;
};

describe("JCS (RFC 8785) and the contributionsHash (§4.2 item 3)", () => {
  it("sorts members by UTF-16 code units, keeps arrays in order, writes primitives as ECMAScript does", () => {
    expect(jcs({ b: 1, a: [3, "x", null, true], "€": 0, "\u0080": 1, A: false })).toBe(
      '{"A":false,"a":[3,"x",null,true],"b":1,"\u0080":1,"€":0}',
    );
    expect(jcs({ s: 'q"\\\n\u0001é' })).toBe('{"s":"q\\"\\\\\\n\\u0001é"}');
    expect(jcs({ n: 1e21, m: -0.5, o: 0 })).toBe('{"m":-0.5,"n":1e+21,"o":0}');
    expect(jcs({ a: undefined, b: 2 })).toBe('{"b":2}'); // as JSON and chrome.storage leave it out
  });
  it("refuses what JSON cannot hold the same way twice", () => {
    expect(() => jcs({ x: NaN })).toThrow(TypeError);
    expect(() => jcs([undefined])).toThrow(TypeError);
    expect(() => jcs({ x: "\ud800" })).toThrow(TypeError);
    expect(() => jcs({ x: () => 1 })).toThrow(TypeError);
    expect(() => jcs(new Date(0))).toThrow(TypeError);
    expect(jcs("😀")).toBe('"😀"'); // a pair is fine
  });
  it("reproduces the SDK's worked example (§12.4's import plugin)", async () => {
    const d = read({
      id: "defghijklmnopabcdefghijklmnopabc",
      name: "FooAuth Importer",
      version: "1.0.0",
      publisher: { name: "Example Developer" },
      sdkVersion: 1,
      capabilities: [{ name: "ui.slots", reason: "Adds Import from FooAuth to Sixkey's Add menu." }],
      contributions: [
        { id: "import", slot: "add.sources", title: "Import from FooAuth", icon: { builtin: "upload" }, extra: 1 },
      ],
      defaultLocale: "en",
    }).descriptor;
    expect(await contributionsHash(d)).toBe("ea60a1ad468aa3ddd0da8b9da149a088caf1d566d5535a15fcbc754a316a017e");
    expect(
      await sha256Hex(
        '{"contributions":[{"icon":{"builtin":"upload"},"id":"import","slot":"add.sources","title":"Import from FooAuth"}],"titles":{}}',
      ),
    ).toBe("ea60a1ad468aa3ddd0da8b9da149a088caf1d566d5535a15fcbc754a316a017e");
  });
  it("the hash covers the contributions (sorted by id) and their titles, and nothing else", async () => {
    const base = read(descriptor()).descriptor;
    const h = await contributionsHash(base);
    expect(await contributionsHash({ ...base, name: "Other", version: "9" })).toBe(h);
    const more = read(
      descriptor(PID, {
        contributions: [
          { id: "zzz", slot: "settings.page", title: "Z", icon: { builtin: "list" } },
          { id: "generate", slot: "popup.menu", title: "Generate password", icon: { builtin: "dice" } },
        ],
      }),
    ).descriptor;
    const swapped = { ...more, contributions: [...more.contributions].reverse() };
    expect(await contributionsHash(more)).toBe(await contributionsHash(swapped)); // order does not count
    expect(await contributionsHash(more)).not.toBe(h);
    const retitled = { ...base, contributions: [{ ...base.contributions[0]!, title: "Generate a password" }] };
    expect(await contributionsHash(retitled)).not.toBe(h);
    const zh = { ...base, locales: { zh_CN: { titles: { generate: "生成一个密码" } } } };
    expect(await contributionsHash(zh)).not.toBe(h);
    // titles of a contribution that did not survive are not in it, and an empty locale is left out
    const ghost = {
      ...base,
      locales: {
        zh_CN: { name: "密码生成器", titles: { generate: "生成密码", gone: "Ghost" } },
        fr: { titles: { gone: "x" } },
      },
    };
    expect(await contributionsHash(ghost)).toBe(h);
    const otherIcon = { ...base, contributions: [{ ...base.contributions[0]!, icon: { builtin: "key" as const } }] };
    expect(await contributionsHash(otherIcon)).not.toBe(h);
  });
});

describe("plain text and what Sixkey draws of a plugin's words (§2.3, §7.3)", () => {
  it("plain text refuses controls, bidirectional marks and default-ignorables, astral ones too", () => {
    expect(isPlainText("Generate password", 1, 32)).toBe(true);
    for (const bad of [
      "a\u200eb",
      "a\u200fb",
      "a\u200bb",
      "a\u202eb",
      "a\u2066b",
      "a\u061cb",
      "a\u00adb",
      "a\ufeffb",
      "a\ufe0fb",
      "a\u0007b",
      "a\u0085b",
      "a\u{e0041}b",
      "a\u{1d173}b",
      "a\u{e0100}b",
      "a\u3164b",
    ])
      expect(isPlainText(bad, 1, 32), JSON.stringify(bad)).toBe(false);
    expect(isPlainText("", 1, 32)).toBe(false);
    expect(isPlainText("x".repeat(33), 1, 32)).toBe(false);
    expect(isPlainText("😀".repeat(32), 1, 32)).toBe(true); // code points, as JSON Schema counts
  });
  it("drawn text: NFKC, the refused characters taken out, spaces collapsed, cut to its limit", () => {
    expect(displayText("Ｇｅｎｅｒａｔｅ\u200e  pass\u200bword", 32)).toBe("Generate password");
    expect(displayText("\u202eevil", 32)).toBe("evil");
    expect(displayText("x".repeat(40), 32)).toHaveLength(32);
  });
  it("protected terms: whole words of the comparison form, phrases, CJK", () => {
    for (const ok of [
      "Pinterest",
      "Spinner",
      "Generate password",
      "Unlocking tips",
      "Recovery tools",
      "Key ring",
      "Passcodes",
    ])
      expect(usesProtectedTerm(ok), ok).toBe(false);
    for (const bad of [
      "Ѕіхkеу", // Cyrillic lookalikes
      "Sixkey",
      "SIXKEY helper",
      "Six key".replace(" ", ""),
      "Unlock",
      "unlock vault",
      "PIN",
      "P1N",
      "P|N",
      "unIock", // a capital I for the l
      "SlXKEY", // an l for the i
      // however it is spaced or punctuated (F12)
      "Six Key",
      "Six-Key",
      "S1x Key",
      "Un lock",
      "P I N",
      "Master-Pass word",
      "recovery.key",
      "P1N码",
      "PIN 码",
      "恢 复 密 钥",
      "Enter your pin",
      "Passcode",
      "Master password",
      "master-password",
      "MasterPassword",
      "Recovery code",
      "recovery key",
      "Ｕｎｌｏｃｋ", // full width: NFKC
      "𝐔𝐧𝐥𝐨𝐜𝐤", // mathematical bold: NFKC
      "Uпlосk", // Cyrillic п, о, с
      "主密码",
      "解锁 Sixkey",
      "输入恢复密钥",
      "恢复码",
      "PIN码",
      "pin码",
      "解鎖",
    ])
      expect(usesProtectedTerm(bad), bad).toBe(true);
  });
  it("keys: Chrome's shortcut grammar or the macOS symbols; anything else is never drawn", () => {
    for (const ok of ["Alt+Shift+P", "Ctrl+Shift+F12", "Command+Period", "MediaPlayPause", "⌥⇧P", "⌘,"])
      expect(isShortcut(ok), ok).toBe(true);
    for (const bad of [
      "Type PIN in next window",
      "",
      "Alt+",
      "Alt+Shift+Ctrl+Command+P",
      "alt+shift+p",
      "Alt+Shift+PP",
      "⌥⇧⌃⌘⌥P",
    ])
      expect(isShortcut(bad), bad).toBe(false);
  });
  it("icons: a PNG of at most 64 × 64, 8 bits, not interlaced, 8 KiB, through its data URL only", () => {
    expect(pngDrawable(png(64, 64))).toBe(true);
    expect(pngDrawable(png(16, 16))).toBe(true);
    expect(pngDrawable(png(64, 65))).toBe(false);
    expect(pngDrawable(png(65, 64))).toBe(false);
    expect(pngDrawable(png(0, 16))).toBe(false);
    expect(pngDrawable(png(16, 16, { depth: 16 }))).toBe(false);
    expect(pngDrawable(png(16, 16, { interlace: 1 }))).toBe(false);
    expect(pngDrawable(png(16, 16, { pad: 8200 }))).toBe(false);
    expect(pngDrawable(png(16, 16, { chunk: "IDAT" }))).toBe(false);
    expect(pngDrawable(png(16, 16).replace("image/png", "image/svg+xml"))).toBe(false);
    expect(pngDrawable("https://example.org/x.png")).toBe(false);
    expect(pngDrawable(`data:image/png;base64,${btoa("GIF89a")}`)).toBe(false);
  });
});

describe("the descriptor, read tolerantly (§4.3) and negotiated (§5.3)", () => {
  it("a valid descriptor reads as itself, its unknown fields left out", () => {
    const r = read(
      descriptor(PID, { futureField: { x: 1 }, publisher: { name: "E", url: "https://e.example", logo: "x" } }),
    );
    expect(r.unavailable).toEqual([]);
    expect(r.sdk).toBe(1);
    expect(r.descriptor).not.toHaveProperty("futureField");
    expect(r.descriptor.publisher).toEqual({ name: "E", url: "https://e.example" });
    expect(isStoredDescriptor(r.descriptor)).toBe(true);
    expect(isStoredDescriptor({ ...r.descriptor, futureField: 1 })).toBe(false); // a stored one is exactly normalised
  });
  it("a version-2 hello with sdkMin 1 negotiates version 1; no common version is `version`", () => {
    expect(negotiate(descriptor(PID, { sdkVersion: 2, sdkMin: 1 }))).toBe(1);
    expect(negotiate(descriptor(PID, { sdkVersion: 2 }))).toBe(null);
    expect(negotiate(descriptor(PID, { sdkVersion: 3, sdkMin: 2 }))).toBe(null);
    expect(readDescriptor(descriptor(PID, { sdkVersion: 2 }))).toEqual({
      ok: false,
      error: "version",
      supported: { min: 1, max: 1 },
    });
    expect(read(descriptor(PID, { sdkVersion: 2, sdkMin: 1, newThing: [1] })).sdk).toBe(1);
    for (const bad of [{ sdkVersion: 0 }, { sdkVersion: 1.5 }, { sdkVersion: "1" }, { sdkVersion: 1, sdkMin: 2 }])
      expect(readDescriptor(descriptor(PID, bad)), JSON.stringify(bad)).toEqual({ ok: false, error: "invalid" });
  });
  it("only the top level fails the whole descriptor", () => {
    const bad: Record<string, unknown>[] = [
      { id: "ABC" },
      { name: "" },
      { name: "x".repeat(41) },
      { name: "a\u202eb" },
      { description: "x".repeat(201) },
      { version: "1.0.0-beta" },
      { publisher: { url: "https://x" } },
      { publisher: { name: "P", url: "http://insecure.example" } },
      { worker: "sw.js" },
      { capabilities: "ui.slots" },
      { capabilities: new Array(17).fill({ name: "ui.slots", reason: "r" }) },
      { contributions: [1] },
      { defaultLocale: "en-US" },
      { locales: [] },
      { capabilities: [{ name: "codes.forPage", reason: "r" }] }, // no worker
    ];
    for (const b of bad)
      expect(readDescriptor(descriptor(PID, b)), JSON.stringify(b)).toEqual({ ok: false, error: "invalid" });
    for (const k of [
      "id",
      "name",
      "version",
      "publisher",
      "sdkVersion",
      "capabilities",
      "contributions",
      "defaultLocale",
    ]) {
      const d = descriptor();
      delete d[k];
      expect(readDescriptor(d), k).toEqual({ ok: false, error: k === "sdkVersion" ? "invalid" : "invalid" });
    }
  });
  it("an item this Sixkey cannot use is dropped and listed in `unavailable`, and only that item", () => {
    const r = read(
      descriptor(PID, {
        capabilities: [
          { name: "ui.slots", reason: "ok" },
          { name: "ui.slots", reason: "again" }, // repeated
          { name: "codes.read", reason: "P3: not offered yet (wave 2b offers P2, so this example is P3's)" },
          { name: "future.thing", reason: "unknown" },
          { name: "env.read", reason: "" }, // fails the schema
        ],
        contributions: [
          { id: "a", slot: "popup.menu", title: "A", icon: { builtin: "dice" } },
          { id: "b", slot: "popup.menu", title: "B", icon: { builtin: "rocket" } }, // unknown builtin
          { id: "c", slot: "popup.menu", title: "C", icon: { svg: "<svg/>" } }, // unknown kind
          { id: "d", slot: "popup.menu", title: "D", icon: { builtin: "dice" }, when: { vault: "sometimes" } },
          { id: "e", slot: "popup.menu", title: "E", icon: { builtin: "dice" }, with: ["account"] }, // no account here
          { id: "f", slot: "future.slot", title: "F", icon: { builtin: "dice" } }, // unknown slot
          { id: "g", slot: "account.primary", title: "G", icon: { builtin: "dice" } }, // the built-in autofill's: not offered
          { id: "a", slot: "settings.page", title: "A2", icon: { builtin: "list" } }, // repeated id
          { id: "h", slot: "settings.page", title: "H", icon: { builtin: "list" }, when: { vault: "any", note: 1 } },
          { id: "i", slot: "popup.menu", title: "I", icon: { builtin: "dice", size: 2 } }, // icon with extra fields
        ],
        locales: {
          zh_CN: { name: "名" },
          "en-GB": { name: "bad tag" },
          fr: { name: "" },
          es_419: { titles: { a: "A" } },
        },
      }),
    );
    expect(r.descriptor.capabilities.map((c) => c.name)).toEqual(["ui.slots"]);
    expect(r.descriptor.contributions.map((c) => c.id)).toEqual(["a", "h"]);
    expect(r.descriptor.contributions[1]!.when).toEqual({ vault: "any" });
    expect(Object.keys(r.descriptor.locales!)).toEqual(["zh_CN", "es_419"]);
    expect(r.unavailable.sort()).toEqual(
      [
        "capability:ui.slots",
        "capability:codes.read",
        "capability:future.thing",
        "capability:env.read",
        "contribution:b",
        "contribution:c",
        "contribution:d",
        "contribution:e",
        "contribution:f",
        "contribution:g",
        "contribution:a",
        "contribution:i",
        "locale:en-GB",
        "locale:fr",
      ].sort(),
    );
  });
  it("only version, the descriptions and the publisher's URL change without asking (§4.2 item 2)", () => {
    const a = read(descriptor()).descriptor;
    const same = (over: Record<string, unknown>) => onlyHarmless(a, read(descriptor(PID, over)).descriptor);
    expect(same({ version: "1.1" })).toBe(true);
    expect(same({ description: "New words" })).toBe(true);
    expect(same({ publisher: { name: "Example Developer", url: "https://new.example" } })).toBe(true);
    expect(
      same({ locales: { zh_CN: { name: "密码生成器", titles: { generate: "生成密码" }, description: "新" } } }),
    ).toBe(true);
    expect(same({ unknownField: 1 })).toBe(true); // tolerated, so it changes nothing
    expect(same({ name: "Password Generator 2" })).toBe(false);
    expect(same({ publisher: { name: "Someone Else" } })).toBe(false);
    expect(same({ worker: "/sw.js" })).toBe(false);
    expect(same({ sdkMin: 1 })).toBe(false);
    expect(same({ defaultLocale: "zh_CN" })).toBe(false);
    expect(same({ locales: { zh_CN: { name: "密码", titles: { generate: "生成密码" } } } })).toBe(false);
    expect(
      same({
        locales: { zh_CN: { name: "密码生成器", titles: { generate: "生成密码" }, reasons: { "ui.slots": "x" } } },
      }),
    ).toBe(false);
    expect(same({ capabilities: [{ name: "ui.slots", reason: "Adds Generate password to Sixkey's menu." }] })).toBe(
      false,
    );
    expect(same({ contributions: [] })).toBe(false);
    // with `management`, a third-party plugin's version is a change to approve
    expect(onlyHarmless(a, read(descriptor(PID, { version: "1.1" })).descriptor, false)).toBe(false);
  });
});

describe("the catalog, the trust levels and what each may do (§8, §6.2, §7.1)", () => {
  const catalog: Catalog = parseCatalog({
    v: 1,
    plugins: [
      {
        id: OFFICIAL,
        trust: "official",
        name: "Sixkey Autofill",
        publisher: "Sixkey",
        ceiling: ["ui.slots", "env.read", "codes.forPage"],
      },
      {
        id: LISTED,
        trust: "listed",
        name: "Reviewed Tool",
        publisher: "Example",
        store: `https://chromewebstore.google.com/detail/${LISTED}`,
        ceiling: ["ui.slots", "env.read", "accounts.add", "codes.read"],
        contributionsHash: "0".repeat(64),
        minVersion: "2.0",
      },
      { id: BLOCKED, trust: "blocked", name: "Bad", publisher: "Bad", reason: "It stole codes." },
    ],
  });
  it("the catalog file's schema", () => {
    for (const bad of [
      { v: 2, plugins: [] },
      { v: 1, plugins: [{ id: PID, trust: "listed", name: "X", publisher: "Y" }] }, // listed needs its pins
      { v: 1, plugins: [{ id: PID, trust: "blocked", name: "X", publisher: "Y" }] }, // blocked needs a reason
      { v: 1, plugins: [{ id: PID, trust: "official", name: "X", publisher: "Y" }] }, // official needs a ceiling
      { v: 1, plugins: [{ id: PID, trust: "unlisted", name: "X", publisher: "Y" }] },
      { v: 1, plugins: [{ id: PID, trust: "official", name: "X", publisher: "Y", ceiling: [], extra: 1 }] },
      {
        v: 1,
        plugins: [
          { id: PID, trust: "official", name: "X", publisher: "Y", ceiling: [] },
          { id: PID, trust: "official", name: "X", publisher: "Y", ceiling: [] },
        ],
      },
    ])
      expect(() => parseCatalog(bad), JSON.stringify(bad)).toThrow(TypeError);
  });
  it("the trust level is computed: catalog, then management's install type (a developer copy is unlisted)", () => {
    expect(trustOf(catalog, PID, null)).toEqual({ trust: "unlisted", devCopy: false });
    expect(trustOf(catalog, LISTED, null).trust).toBe("listed");
    expect(trustOf(catalog, OFFICIAL, null).trust).toBe("official");
    expect(trustOf(catalog, BLOCKED, null).trust).toBe("blocked");
    const dev = { installType: "development", version: "1", name: "x", enabled: true };
    expect(trustOf(catalog, LISTED, dev)).toMatchObject({ trust: "unlisted", devCopy: true });
    expect(trustOf(catalog, OFFICIAL, { ...dev, installType: "sideload" })).toMatchObject({
      trust: "unlisted",
      devCopy: true,
    });
    expect(trustOf(catalog, LISTED, { ...dev, installType: "normal" }).trust).toBe("listed");
  });
  it("ceilings: unlisted P0 only; listed never codes, badges or sites in version 1; official its catalog's", () => {
    expect([...ceilingOf("unlisted")]).toEqual(["ui.slots", "env.read"]);
    expect([...ceilingOf("unlisted", catalog.plugins[1])]).toEqual(["ui.slots", "env.read"]); // a developer copy
    expect([...ceilingOf("listed", catalog.plugins[1])]).toEqual(["ui.slots", "env.read", "accounts.add"]);
    expect([...ceilingOf("official", catalog.plugins[0])]).toEqual(["ui.slots", "env.read", "codes.forPage"]);
    expect([...ceilingOf("blocked")]).toEqual([]);
  });
  it("slots: popup.menu and settings.page for all, add.sources and account.actions for official and listed only (W2a)", () => {
    expect(slotAllowed("popup.menu", "unlisted")).toBe(true);
    expect(slotAllowed("settings.page", "unlisted")).toBe(true);
    expect(slotAllowed("add.sources", "unlisted")).toBe(false);
    expect(slotAllowed("add.sources", "listed")).toBe(true);
    expect(slotAllowed("add.sources", "official")).toBe(true);
    // the account menu (wave 2a): P1's slot, so never an unlisted plugin's (no developer mode)
    expect(slotAllowed("account.actions", "unlisted")).toBe(false);
    expect(slotAllowed("account.actions", "listed")).toBe(true);
    expect(slotAllowed("account.actions", "official")).toBe(true);
    for (const s of ["account.primary", "action.menu"] as const) expect(slotAllowed(s, "official"), s).toBe(false);
    for (const s of ["popup.menu", "account.actions"] as const) expect(slotAllowed(s, "blocked"), s).toBe(false);
  });
  it("a plugin's state: stored, paused, pinned, minVersion, a version change under management, blocked", () => {
    const d = read(descriptor(LISTED, { version: "2.1" })).descriptor as Descriptor;
    const e: GrantEntry = {
      pluginId: LISTED,
      state: "approved",
      descriptor: d,
      granted: ["ui.slots"],
      approvedAt: 10,
      trashed: [],
    };
    const o = { install: null, pauses: [], storedHash: "0".repeat(64) };
    expect(stateOf(catalog, LISTED, e, o).state).toBe("approved");
    expect(stateOf(catalog, LISTED, undefined, o).state).toBe("unknown");
    expect(stateOf(catalog, LISTED, e, { ...o, storedHash: "1".repeat(64) })).toMatchObject({
      why: "changed-since-review",
    });
    expect(stateOf(catalog, LISTED, e, { ...o, pauses: [{ pluginId: LISTED, since: 11 }] })).toMatchObject({
      why: "paused",
    });
    expect(stateOf(catalog, LISTED, e, { ...o, pauses: [{ pluginId: LISTED, since: 9 }] }).state).toBe("approved");
    const old = { ...e, descriptor: { ...d, version: "1.9" } };
    expect(stateOf(catalog, LISTED, old, o)).toMatchObject({ why: "update" });
    // minVersion is held to the version the plugin has now, not the approved one (F5): its hello's, else Chrome's
    expect(stateOf(catalog, LISTED, old, { ...o, version: "2.0" }).state).toBe("approved");
    expect(stateOf(catalog, LISTED, e, { ...o, version: "1.0" })).toMatchObject({ why: "update" });
    const install = { installType: "normal", version: "2.2", name: "Reviewed Tool", enabled: true };
    expect(stateOf(catalog, LISTED, old, { ...o, install, version: "1.0" }).state).toBe("approved"); // Chrome's wins
    // with management: a P0 plugin's new version pauses nothing (OD-2); one that holds more is a change to approve
    expect(stateOf(catalog, LISTED, e, { ...o, install }).state).toBe("approved");
    expect(stateOf(catalog, LISTED, { ...e, granted: ["ui.slots", "accounts.add"] }, { ...o, install })).toMatchObject({
      why: "version-changed",
    });
    expect(
      stateOf(
        catalog,
        LISTED,
        { ...e, granted: ["ui.slots", "accounts.add"] },
        { ...o, install: { ...install, version: "2.1" } },
      ).state,
    ).toBe("approved");
    expect(stateOf(catalog, LISTED, { ...e, state: "disabled", reason: "user" }, o).state).toBe("disabled");
    expect(stateOf(catalog, BLOCKED, { ...e, pluginId: BLOCKED }, o)).toEqual({
      state: "blocked",
      reason: "It stole codes.",
    });
    expect(
      heldNow({ ...e, granted: ["ui.slots", "codes.read", "accounts.add"] }, "listed", catalog.plugins[1]),
    ).toEqual(["ui.slots", "accounts.add"]);
    expect(heldNow({ ...e, granted: ["ui.slots", "accounts.add"] }, "unlisted")).toEqual(["ui.slots"]);
  });
  it("the name shown: the catalog's for official and listed, Chrome's with management, else the plugin's, marked", () => {
    const d = read(descriptor(PID)).descriptor;
    expect(shownName(catalog, d, "en", null)).toEqual({ name: "Password Generator", given: true });
    expect(shownName(catalog, d, "zh_CN", null)).toEqual({ name: "密码生成器", given: true });
    expect(shownName(catalog, { ...d, id: LISTED }, "en", null)).toEqual({ name: "Reviewed Tool", given: false });
    expect(
      shownName(catalog, d, "en", { installType: "normal", version: "1", name: "Chrome's name", enabled: true }),
    ).toEqual({
      name: "Chrome's name",
      given: false,
    });
  });
});

describe("a plugin's own words, looked up as its own (W1a review F1, F2)", () => {
  const ctor = (locales: Record<string, unknown>) => {
    const r = readDescriptor(
      descriptor(PID, {
        contributions: [{ id: "constructor", slot: "popup.menu", title: "Go", icon: { builtin: "dice" } }],
        locales,
      }),
    );
    if (!r.ok) throw new Error("fixture");
    return r.descriptor;
  };
  it("a contribution called constructor, an empty table, another language: always a string, its own or the default", () => {
    for (const d of [ctor({ en: { titles: {} }, zh_CN: { titles: {} } }), ctor({ zh_CN: { titles: {} } })])
      for (const lang of ["en", "zh_CN", "fr"]) {
        const t = localised(d, lang);
        expect(t.title(d.contributions[0]!), lang).toBe("Go");
        expect(typeof t.reason("ui.slots")).toBe("string");
        expect(typeof t.name).toBe("string");
      }
    const own = ctor({ zh_CN: { titles: { constructor: "走" } } });
    expect(localised(own, "zh_CN").title(own.contributions[0]!)).toBe("走");
    expect(localised(own, "en").title(own.contributions[0]!)).toBe("Go");
    // a locale tag or table key that is not one of the schema's never parses (no __proto__, no toString)
    for (const bad of [{ __proto__x: {} }, { toString: { titles: {} } }, { en: { titles: { __proto__: "x" } } }])
      expect(readDescriptor(descriptor(PID, { locales: bad })).ok).toBe(true); // dropped, the rest works
  });
  it("every third-party name, the plugin's own or Chrome's, is held to the protected terms: refused, it is the ID", () => {
    const empty = parseCatalog({ v: 1, plugins: [] });
    const catalog = parseCatalog({
      v: 1,
      plugins: [
        { id: OFFICIAL, trust: "official", name: "Sixkey Autofill", publisher: "Sixkey", ceiling: ["ui.slots"] },
        {
          id: LISTED,
          trust: "listed",
          name: "Reviewed Tool",
          publisher: "Example",
          store: `https://chromewebstore.google.com/detail/${LISTED}`,
          ceiling: ["ui.slots"],
          contributionsHash: "0".repeat(64),
        },
      ],
    });
    const install = (name: string) => ({ installType: "normal", version: "1.0.0", name, enabled: true });
    const d = read(descriptor(PID)).descriptor as Descriptor;
    expect(shownName(empty, d, "en", null)).toEqual({ name: d.name, given: true });
    expect(shownName(empty, d, "en", install("Password Tools"))).toEqual({ name: "Password Tools", given: false });
    expect(shownName(empty, d, "en", install("Sixkey Unlock"))).toEqual({ name: PID, given: false }); // Chrome's
    expect(shownName(empty, { ...d, name: "Ѕіхkеу helper" }, "en", null)).toEqual({ name: PID, given: false });
    expect(shownName(empty, { ...d, name: "\u200b" }, "en", null)).toEqual({ name: PID, given: false }); // no text
    // a developer copy of a listed plugin is unlisted: its Chrome name is checked too
    const dev = { installType: "development", version: "2.1", name: "Unlock helper", enabled: true };
    expect(shownName(catalog, { ...d, id: LISTED }, "en", dev)).toEqual({ name: LISTED, given: false });
    // the catalog's names are reviewed: an official or listed plugin keeps its own
    expect(shownName(catalog, { ...d, id: OFFICIAL }, "en", null)).toEqual({ name: "Sixkey Autofill", given: false });
  });
});

describe("the string checked is the string drawn (W1a review r2 N1, N7)", () => {
  // the Hangul fillers are letters that show nothing: drawn, "Six\u3164key" reads "Sixkey"
  const FILLERS = ["\u3164", "\u115f", "\u1160", "\uffa0"];
  it("a name or title with an invisible filler letter is compared as it is drawn", () => {
    const empty = parseCatalog({ v: 1, plugins: [] });
    const d = read(descriptor(PID)).descriptor as Descriptor;
    for (const f of FILLERS) {
      const raw = `Six${f}key Unl${f}ock`;
      expect(displayText(raw, 40), JSON.stringify(f)).toBe("Sixkey Unlock");
      expect(usesProtectedTerm(raw), JSON.stringify(f)).toBe(true);
      expect(usesProtectedTerm(`P${f}IN`), JSON.stringify(f)).toBe(true);
      expect(usesProtectedTerm(`解${f}锁`), JSON.stringify(f)).toBe(true);
      const chrome = { installType: "normal", version: "1.0.0", name: raw, enabled: true };
      expect(shownName(empty, d, "en", chrome)).toEqual({ name: PID, given: false });
      // a harmless name keeps its text, as drawn
      const fine = { ...chrome, name: `Tab${f} Tools` };
      expect(shownName(empty, d, "en", fine)).toEqual({ name: "Tab Tools", given: false });
    }
  });
  it("CJK: a visible separator ends the term, plain spaces, dashes and underscores do not", () => {
    for (const ok of ["了解 · 锁定", "了解｜锁定", "了解/锁定", "了解、锁定", "主题 · 密码生成器"])
      expect(usesProtectedTerm(ok), ok).toBe(false);
    for (const bad of ["解 锁", "解-锁", "解_锁", "P1N 码", "PIN码", "恢 复 密 钥", "主 密 码", "解锁 Sixkey"])
      expect(usesProtectedTerm(bad), bad).toBe(true);
  });
  it("common names that must pass still pass", () => {
    const ok = [
      "Pinterest Saver",
      "Spinner",
      "Unlocking tips",
      "Password Generator",
      "1Password helper",
      "KeePass bridge",
      "Key Manager",
      "Six Degrees",
      "Master Plan",
      "Recovery Tool",
      "Code Snippets",
      "Lock Screen Clock",
      "Pass the Parcel",
      "Opinion Poll",
      "Six Kittens",
      "Sixty Keys",
      "密码生成器",
      "截图工具",
      "一键截图",
      "主题切换",
    ];
    expect(ok.filter((s) => usesProtectedTerm(s))).toEqual([]);
  });
});
