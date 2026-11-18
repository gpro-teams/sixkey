// Which leaf of the settings page is shown (src/options/route.ts, SHORT-SETTINGS-NOTES.md): the hash maps to a
// leaf of a group; every hash the rest of the extension opens still lands where it did; and the rules in the source that make
// the page show one section at a time, move the focus only on a switch, and never hide the install notice for good. The
// browser's own part (Back and Forward, focus, scrolling) is short-settings.spec.ts's. The Sync section is gone from every
// build (OWNER-DECISIONS/25): #sync names no leaf, and nothing opens it.
import fc from "fast-check";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LEAF, GROUPS, groupOf, LEAVES, leafOfHash, nextPicked, panelOfHash } from "../../src/options/route";

const EXT = resolve(__dirname, "../..");
const SRC = join(EXT, "src");
function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const files = sources().map((p) => ({ path: relative(SRC, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const src = (p: string) => files.find((f) => f.path === p)!.text;

/** Hashes that are not about leaves: the wizard, the reset, the install notice (App.tsx, InstallNotice.tsx). */
const NOT_LEAVES = ["#setup", "#setup-restore", "#setup-csb", "#reset", "#install"];

describe("the groups and their leaves", () => {
  it("four groups in the rail's order, the first leaf being what the group's own link opens; no build has Sync", () => {
    // (Plugins went with the plugin platform, and Sync with the server sync: #plugins and #sync name no leaf, below)
    expect(GROUPS.map((g) => g.id)).toEqual(["accounts", "security", "appearance", "advanced"]);
    expect(LEAVES).toEqual([
      "add",
      "groups", // the owner's report of 2026-11-18: accounts moved into a group many at a time
      "backup",
      "trash",
      "security",
      "security-keys",
      "security-log",
      "autofill", // AUTOFILL2 patch 2: the sites for autofill, a leaf of the Security group
      "appearance",
      "advanced",
    ]);
    expect(groupOf("plugins")).toBeUndefined(); // the plugin platform's leaf, removed
    expect(groupOf("sync")).toBeUndefined(); // the Sync section's, removed
    expect(groupOf("autofill")!.id).toBe("security");
    expect(groupOf("security-keys")!.id).toBe("security");
    expect(groupOf("trash")!.id).toBe("accounts");
    expect(groupOf("clipboard")).toBeUndefined(); // a panel inside the Appearance leaf, not a leaf
    expect(DEFAULT_LEAF).toBe("security");
  });

  it("a leaf is in one group only", () => {
    const all = GROUPS.flatMap((g) => g.leaves);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("leafOfHash", () => {
  it("a leaf's own hash names it", () => {
    for (const l of LEAVES) expect(leafOfHash(`#${l}`, LEAVES), l).toBe(l);
  });

  it("a group's hash names its first leaf; the names that moved into a leaf name that leaf", () => {
    expect(leafOfHash("#accounts", LEAVES)).toBe("add");
    expect(leafOfHash("#clipboard", LEAVES)).toBe("appearance");
    expect(leafOfHash("#guide", LEAVES)).toBeNull(); // the removed Guide panel's name: the default leaf shows
    expect(leafOfHash("#plugins", LEAVES)).toBeNull(); // the removed Settings › Plugins: the default leaf shows
    expect(leafOfHash("#plugins/add=" + "a".repeat(32), LEAVES)).toBeNull();
    expect(leafOfHash("#sync", LEAVES)).toBeNull(); // the removed Settings › 同步: the default leaf shows
    expect(leafOfHash("#sync/join", LEAVES)).toBeNull();
  });

  it("a hash names a leaf by its first word: the popup's and the notice's", () => {
    const table: [string, string | null][] = [
      ["#add-paste", "add"],
      ["#add-upload", "add"],
      ["#add-manual", "add"],
      ["#add-google", "add"],
      ["#add-scanned", "add"],
      ["#security-log", "security-log"],
      ["#security-keys", "security-keys"],
      ["#security-else", "security"],
      ["#sync/anything/else", null],
      ["#backup", "backup"],
      ["#backup-x", "backup"],
      ["#advanced", "advanced"],
      ["#clipboard-x", "appearance"],
    ];
    for (const [hash, id] of table) expect(leafOfHash(hash, LEAVES), hash).toBe(id);
  });

  it("the wizard's, the reset's and the install notice's hashes, none, and anything else name none", () => {
    for (const h of [
      ...NOT_LEAVES,
      "",
      "#",
      "#unknown",
      "#Security",
      "#security2",
      "#secur",
      "security",
      "xsecurity",
      "x#security",
      "#-add",
      "# add",
    ])
      expect(leafOfHash(h, LEAVES), h).toBeNull();
  });

  it("a leaf not among those given is not named", () => {
    const some = LEAVES.filter((l) => l !== "backup");
    expect(leafOfHash("#backup", some)).toBeNull();
    expect(leafOfHash("#accounts", some)).toBe("add");
    expect(leafOfHash("#advanced", some)).toBe("advanced");
  });

  it("whatever the hash, the answer is one of the leaves or null", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = leafOfHash(s, LEAVES);
        return r === null || LEAVES.includes(r);
      }),
    );
    fc.assert(
      fc.property(fc.constantFrom(...LEAVES), fc.constantFrom("", "-", "/"), fc.string(), (id, sep, rest) => {
        const r = leafOfHash(`#${id}${sep}${sep ? rest : ""}`, LEAVES);
        return r !== null && groupOf(r)?.id === groupOf(id)!.id;
      }),
    );
  });
});

describe("panelOfHash: the panel a hash points at inside its leaf", () => {
  it("#clipboard (and what follows it); nothing else", () => {
    expect(panelOfHash("#clipboard")).toBe("clipboard");
    expect(panelOfHash("#clipboard-x")).toBe("clipboard");
    for (const h of ["", "#", "#appearance", "#advanced", "#clipboards", "clipboard", "#xclipboard", "#guide"])
      expect(panelOfHash(h), h).toBeNull();
  });
});

describe("nextPicked (after the hash changed): the page shows what the address says", () => {
  it("a hash naming a leaf picks it; no hash, and any hash that names none, picks none: the default shows", () => {
    expect(nextPicked("#backup", LEAVES)).toBe("backup");
    expect(nextPicked("#add-scanned", LEAVES)).toBe("add");
    for (const h of ["", "#", ...NOT_LEAVES]) expect(nextPicked(h, LEAVES), h).toBeNull();
  });
});

describe("every hash the extension opens lands on a leaf or is one the page handles itself", () => {
  const known = (hash: string) => leafOfHash(hash, LEAVES) !== null || NOT_LEAVES.includes(hash);

  it("the popup's, the side panel's and the background's openOptions()", () => {
    const seen: string[] = [];
    for (const f of files.filter((x) => /^(popup|sidepanel|background|ui)\//.test(x.path)))
      for (const m of code(f.text).matchAll(/openOptions\(\s*[`"'](#[^`"'$)]*)/g)) {
        if (m[1] === "#") continue; // from a variable: the two below
        seen.push(m[1]!);
        expect(known(m[1]!), `${f.path}: ${m[1]}`).toBe(true);
      }
    expect(seen).toEqual(
      expect.arrayContaining([
        "#backup",
        "#security",
        "#security-log",
        "#install",
        "#setup",
        "#setup-restore",
        "#setup-csb", // the welcome's restore from Chrome Sync (popup/screens/CsbFound.tsx)
        "#reset",
      ]),
    );
    expect(seen).not.toContain("#sync"); // the popup lock screen's way to the Sync section went with it
    const menu = code(src("popup/main/AddMenu.tsx"));
    expect(menu).toMatch(/openOptions\(`#add-\$\{id\}`\)/);
    expect(code(src("ui/errors.ts"))).toMatch(/"backup" \| "advanced" \| null/);
    expect(code(src("popup/screens/Status.tsx"))).toMatch(/openOptions\(`#\$\{section\}`\)/);
    for (const section of ["backup", "advanced"]) expect(leafOfHash(`#${section}`, LEAVES)).toBe(section);
  });

  it("the settings page's own links and hash writes", () => {
    for (const f of files.filter((x) => x.path.startsWith("options/"))) {
      const c = code(f.text);
      for (const m of c.matchAll(/href="(#[^"]*)"/g))
        if (m[1] !== "#") expect(known(m[1]!), `${f.path}: ${m[1]}`).toBe(true);
      for (const m of c.matchAll(/location\.hash = "(#[^"]*)"/g)) expect(known(m[1]!), `${f.path}: ${m[1]}`).toBe(true);
    }
  });

  it("the rail's 'set a master password' link names a leaf", () => {
    expect(leafOfHash("#security-keys", LEAVES)).toBe("security-keys");
  });
});

describe("what is static in the source (the behaviour is the e2e specs')", () => {
  const app = code(src("options/App.tsx"));

  it("the page listens to hashchange once and not to popstate: Back and Forward are not handled twice", () => {
    expect(app.match(/addEventListener\("hashchange"/g)).toHaveLength(1);
    expect(app).not.toMatch(/popstate/);
  });

  it("the rail has no sync group, and the page no way to the Sync section", () => {
    expect(app).not.toMatch(/\bsync(?:Label|Rail|Host)\b|SYNC_UI|#sync/);
    expect(app).toMatch(/\["appearance", "lookTitle", "sun"\],\n {2}\["advanced", "advancedTitle", "sliders"\],/);
  });

  it("the few scrollIntoView calls are inside their own leaf or at the page's top", () => {
    const calls = files
      .filter((f) => f.path.startsWith("options/") && /scrollIntoView/.test(code(f.text)))
      .map((f) => f.path)
      .sort();
    expect(calls).toEqual([
      "options/App.tsx", // a hash that points at a panel inside a leaf (#clipboard): the panel
      "options/Backup.tsx", // the error line, in Backup
      "options/FirstRun.tsx", // SetupReady, at the top of Add accounts
      "options/Security.tsx", // the refusal at the top of Password & recovery, brought into view when it comes
    ]);
  });

  it("the page's panels are focusable headings (the focus goes there on a switch)", () => {
    expect(code(src("options/shared.tsx"))).toMatch(/<h2 tabIndex=\{-1\}>\{p\.title\}<\/h2>/);
  });
});

describe("the install notice", () => {
  const notice = code(src("options/InstallNotice.tsx"));

  it("is never hidden for good: it stores nothing and has no dismissal", () => {
    expect(notice).not.toMatch(/localStorage|sessionStorage|chrome\.storage|dismiss|hidden|display/i);
  });
});
