// The builds of the backup in Chrome's sync storage's worker (CSB-3), and scripts/check-dist.mjs's rules on them: every
// build's worker has the backup (its debounce's and retries' alarms, its two records, the slots' writer) and sets
// storage.sync's access level among its first three calls (the maintainers' C7), and none has the Drive path's worker or
// the e2e build's fake Drive (unwired: C9); the worker's size is printed and held (the store build's budget,
// scripts/sw-budget.mjs, unchanged: C10); the manifest's permissions are its flavour's manifest's (no permission for
// the backup: storage.sync needs none). A store and an e2e build are made once into a temporary folder; each alteration of a
// copy is refused by check-dist with its own line. The settings page's parts of the backup (the card, first run's parts,
// the restore) are one lazy chunk with a catalog of their own, which the popup and the side panel can never load. Their
// own part (the pill, the footer's line and one click, the welcome's copy found) is a lazy chunk with a catalog of its
// own, which the settings page never loads, and nothing either can load names a message of the backup's.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs script with no type declarations
import { swAccessLevelOrder } from "../../scripts/sw-order.mjs";
import { SW_BUDGET_GZ, swBudgetOf } from "../../scripts/sw-budget.mjs";

const EXT = resolve(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "sixkey-csb-check-dist-"));
const built = { prod: join(work, "prod"), e2e: join(work, "e2e") };
type Flavour = keyof typeof built;
const flag = (f: Flavour) => (f === "prod" ? [] : [`--${f}`]);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV"));
const order = swAccessLevelOrder as (src: string) => { ok: boolean; reason: string; first: string[] };

function check(dir: string, flavour: Flavour): { ok: boolean; out: string } {
  const r = spawnSync(process.execPath, ["scripts/check-dist.mjs", ...flag(flavour), "--dist", dir], {
    cwd: EXT,
    encoding: "utf8",
    env,
  });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
let n = 0;
function mutant(flavour: Flavour, alter: (dir: string) => void) {
  const dir = join(work, `m${++n}`);
  cpSync(built[flavour], dir, { recursive: true });
  alter(dir);
  try {
    return check(dir, flavour);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const sw = (f: Flavour) => readFileSync(join(built[f], "sw.js"), "utf8");
const editSw = (d: string, fn: (t: string) => string) =>
  writeFileSync(join(d, "sw.js"), fn(readFileSync(join(d, "sw.js"), "utf8")));

beforeAll(() => {
  for (const f of ["prod", "e2e"] as const) {
    const r = spawnSync(process.execPath, ["scripts/build.mjs", ...flag(f), "--out", built[f]], {
      cwd: EXT,
      encoding: "utf8",
      env,
    });
    if (r.status !== 0) throw new Error(`build ${f} failed:\n${r.stdout}\n${r.stderr}`);
  }
}, 300_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("the pristine builds", () => {
  it("pass, and print the worker's size, held to its budget (the store build's unchanged: 106,496 B)", () => {
    expect(SW_BUDGET_GZ).toBe(106_496);
    for (const f of ["prod", "e2e"] as const) {
      const r = check(built[f], f);
      expect(r, f).toMatchObject({ ok: true });
      const m = /^service worker sw\.js: (\d+) B gz \(limit (\d+) B/m.exec(r.out);
      expect(m, f).not.toBeNull();
      expect(Number(m![2]), f).toBe(swBudgetOf(f));
      expect(Number(m![1]), f).toBeLessThanOrEqual(Number(m![2]));
    }
  });

  it("every worker has the backup in Chrome sync, and storage.sync's access level among its first three calls", () => {
    for (const f of ["prod", "e2e"] as const) {
      const t = sw(f);
      for (const word of ["sk-csb-soon", "sk-csb-retry", "sk_csb_cfg", "sk_csb_state", "sk-csb-merged", "sk-csb-drop"])
        expect(t, `${f}: ${word}`).toContain(word);
      const o = order(t);
      expect(o, f).toMatchObject({ ok: true });
      expect(o.first.slice(0, 3).sort(), f).toEqual([
        "chrome.storage.local.setAccessLevel",
        "chrome.storage.session.setAccessLevel",
        "chrome.storage.sync.setAccessLevel",
      ]);
    }
  });

  it("no worker has the Drive path's backup, its records or the fake Drive (unwired in CSB-3)", () => {
    for (const f of ["prod", "e2e"] as const)
      for (const word of ["sk-cloud-soon", "sk-cloud-retry", "sixkey-fake-drive", "sk_cloud_cfg", "sk_cloud_state"])
        expect(sw(f), `${f}: ${word}`).not.toContain(word);
  });

  it("the manifest asks for nothing new: its permissions are its flavour's manifest's, storage.sync needs none", () => {
    for (const f of ["prod", "e2e"] as const) {
      const m = JSON.parse(readFileSync(join(built[f], "manifest.json"), "utf8"));
      const own = JSON.parse(
        readFileSync(join(EXT, f === "prod" ? "manifest.base.json" : "manifest.e2e.json"), "utf8"),
      );
      expect(m.permissions, f).toEqual(own.permissions);
      expect(m.optional_permissions, f).toEqual(own.optional_permissions);
      expect(m.permissions, f).toContain("storage");
      expect(JSON.stringify(m), f).not.toMatch(/identity|sync/);
    }
  });
});

describe("check-dist refuses a worker that lost the backup in Chrome sync, or got the Drive path back", () => {
  const cases: [string, Flavour, (t: string) => string, RegExp][] = [
    [
      "no debounce's alarm",
      "e2e",
      (t) => t.replaceAll("sk-csb-soon", "sk-csb-gone"),
      /the e2e build's worker has no backup in Chrome sync/,
    ],
    [
      "storage.sync's access level never asked (the call reaches no area)",
      "prod",
      (t) => t.replace("r(e?.sync)", "r(e?.syncX)"),
      /service worker: the first three calls of the worker must be storage\.local\.setAccessLevel, storage\.session\.setAccessLevel and storage\.sync\.setAccessLevel/,
    ],
    [
      "storage.sync's access level asked after a listener",
      "e2e",
      (t) =>
        t.replace("r(e?.sync)", "r(e?.syncX)") +
        "\nchrome.runtime.onMessage.addListener(function(){});chrome.storage.sync.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});",
      /service worker: the first three calls of the worker must be/,
    ],
    [
      "the Drive path's retries' alarm and debounce back",
      "prod",
      (t) => `${t}\nconst a="sk-cloud-retry",b="sk-cloud-soon";`,
      /sw\.js: the removed Google Drive backup in the prod build \(sk-cloud-\)/,
    ],
    [
      "the fake Drive back in the e2e build's worker",
      "e2e",
      (t) => `${t}\nconst f="sixkey-fake-drive";`,
      /sw\.js: the removed Google Drive backup in the e2e build \(sixkey-fake-drive\)/,
    ],
  ];
  for (const [what, flavour, alter, msg] of cases)
    it(`${flavour}: ${what}`, () => {
      expect(sw(flavour)).not.toBe(alter(sw(flavour))); // the alteration does alter
      const r = mutant(flavour, (d) => editSw(d, alter));
      expect(r.ok, r.out).toBe(false);
      expect(r.out).toMatch(msg);
    });
});

// ---- the Google Drive backup, removed: no build reaches or names Google, nor carries that path's marks --------------

const editJson = (d: string, f: string, fn: (j: Record<string, unknown>) => void) => {
  const j = JSON.parse(readFileSync(join(d, f), "utf8"));
  fn(j);
  writeFileSync(join(d, f), JSON.stringify(j, null, 2));
};
const csp = (j: Record<string, unknown>) => j.content_security_policy as { extension_pages: string };
const GOOGLE_SRC =
  "https://www.googleapis.com/drive/v3/ https://www.googleapis.com/upload/drive/v3/ https://oauth2.googleapis.com/revoke";

describe("check-dist refuses the Google Drive backup's way out and its marks, in every build", () => {
  it("the pristine builds: no identity, no oauth2, the API origin alone in connect-src, no Google host anywhere", () => {
    for (const f of ["prod", "e2e"] as const) {
      const m = JSON.parse(readFileSync(join(built[f], "manifest.json"), "utf8"));
      expect([...m.permissions, ...m.optional_permissions], f).not.toContain("identity");
      expect("oauth2" in m, f).toBe(false);
      expect(csp(m).extension_pages, f).not.toMatch(/google/);
      const r = spawnSync("grep", ["-rlE", "googleapis\\.com|accounts\\.google\\.com|drive\\.google\\.com", built[f]], {
        encoding: "utf8",
      });
      expect(r.stdout, f).toBe("");
    }
  });
  const cases: [string, Flavour, (d: string) => void, RegExp][] = [
    [
      "connect-src with Google Drive's paths",
      "prod",
      (d) =>
        editJson(
          d,
          "manifest.json",
          (j) =>
            void (csp(j).extension_pages = csp(j).extension_pages.replace(
              "connect-src ",
              `connect-src ${GOOGLE_SRC} `,
            )),
        ),
      /unexpected extension_pages CSP/,
    ],
    [
      "identity offered",
      "prod",
      (d) =>
        editJson(
          d,
          "manifest.json",
          (j) => void (j.optional_permissions = [...(j.optional_permissions as string[]), "identity"]),
        ),
      /identity must never be in a build's optional_permissions: no build signs in to Google \(prod\)/,
    ],
    [
      "identity required",
      "e2e",
      (d) => editJson(d, "manifest.json", (j) => void (j.permissions = [...(j.permissions as string[]), "identity"])),
      /identity must never be in a build's permissions: no build signs in to Google \(e2e\)/,
    ],
    [
      "an oauth2 key",
      "prod",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.oauth2 = {
            client_id: "1234567-abcdefgh.apps.googleusercontent.com",
            scopes: ["https://www.googleapis.com/auth/drive.file"],
          };
        }),
      /manifest key not allowed: oauth2/,
    ],
    [
      "Drive's API in the worker",
      "prod",
      (d) => editSw(d, (t) => `${t}\nconst g="https://www.googleapis.com/drive/v3/";`),
      /sw\.js: the removed Google Drive backup in the prod build \(googleapis\.com\)/,
    ],
    [
      "Google's OAuth authorisation endpoint named in a page",
      "e2e",
      (d) =>
        writeFileSync(
          join(d, "options/index.html"),
          readFileSync(join(d, "options/index.html"), "utf8").replace(
            "</body>",
            "<!-- https://accounts.google.com/o/oauth2/v2/auth --></body>",
          ),
        ),
      /options\/index\.html: the removed Google Drive backup in the e2e build \(accounts\.google\.com\/o\/oauth2\)/,
    ],
    [
      "the card's link to a folder in Drive",
      "prod",
      (d) => editSw(d, (t) => `${t}\nconst l="https://drive.google.com/drive/folders/";`),
      /sw\.js: the removed Google Drive backup in the prod build \(drive\.google\.com\)/,
    ],
    [
      "Google's token record",
      "e2e",
      (d) => editSw(d, (t) => `${t}\nconst k="sk_cloud_token";`),
      /sw\.js: the removed Google Drive backup in the e2e build \(sk_cloud_token\)/,
    ],
    [
      "the Drive path's records",
      "prod",
      (d) => editSw(d, (t) => `${t}\nconst k=["sk_cloud_cfg","sk_cloud_state"];`),
      /sw\.js: the removed Google Drive backup in the prod build \(sk_cloud_cfg\)/,
    ],
    [
      "the developer cloud page's message",
      "e2e",
      (d) => editSw(d, (t) => `${t}\nconst m={type:"sk-devcloud"};`),
      /sw\.js: the removed Google Drive backup in the e2e build \(sk-devcloud\)/,
    ],
    [
      "the developer cloud page's folder",
      "prod",
      (d) => {
        mkdirSync(join(d, "devcloud"));
        writeFileSync(join(d, "devcloud/index.css"), "body{}\n");
      },
      /devcloud\/ \(the Google Drive backup's developer page\) is in the prod build/,
    ],
  ];
  for (const [what, flavour, alter, msg] of cases)
    it(`${flavour}: ${what}`, () => {
      const r = mutant(flavour, alter);
      expect(r.ok, r.out).toBe(false);
      expect(r.out).toMatch(msg);
    });
  it("endpoints and the path's names, not words: text naming Google or its Drive, and Google's sign-in page as a host (a site rule's), pass", () => {
    for (const f of ["prod", "e2e"] as const) {
      const r = mutant(f, (d) => {
        writeFileSync(
          join(d, "assets", "words-AbCd1234.js"),
          'export default {a:"Save the file to Google Drive",b:"把文件存进你的云端硬盘",c:"accounts.google.com"};\n',
        );
        writeFileSync(
          join(d, "options/index.html"),
          readFileSync(join(d, "options/index.html"), "utf8").replace("</body>", "<!-- accounts.google.com --></body>"),
        );
      });
      expect(r, f).toMatchObject({ ok: true });
    }
  });
});

// ---- the settings page's parts (the card, first run's parts, the restore, their text) --------------------------------

const assets = (f: Flavour) => readdirSync(join(built[f], "assets"));
/** The script a page's HTML loads first (its entry chunk). */
const entryOf = (d: string, page: string) =>
  join(d, "assets", /src="\.\.\/assets\/([^"]+\.js)"/.exec(readFileSync(join(d, page), "utf8"))![1]!);

describe("the backup in Chrome sync's pages and text: one lazy chunk and its catalog, the settings page's only", () => {
  it("every build ships them, and none ships the Google Drive pages' text any more", () => {
    for (const f of ["prod", "e2e"] as const) {
      const names = assets(f);
      expect(
        names.filter((n) => /^CsbPages-[\w-]+\.js$/.test(n)),
        f,
      ).toHaveLength(1);
      for (const loc of ["en", "zh_CN"])
        expect(
          names.filter((n) => n.startsWith(`csb-locale-${loc}-`)),
          `${f} ${loc}`,
        ).toHaveLength(1);
      expect(
        names.filter((n) => n.startsWith("cloud-locale-")),
        f,
      ).toEqual([]);
    }
  });
  const cases: [string, Flavour, (d: string) => void, RegExp][] = [
    [
      "the Google Drive pages' text shipped again, with its link into Drive",
      "prod",
      (d) =>
        writeFileSync(
          join(d, "assets", "cloud-locale-en-AbCd1234.js"),
          'export default {ckTitle:"Automatic backup to Google Drive",ckOpen:"drive.google.com/drive/folders/"};\n',
        ),
      /assets\/cloud-locale-en-AbCd1234\.js: the removed Google Drive backup in the prod build \(drive\.google\.com\)/,
    ],
    [
      "the popup can load the backup's pages",
      "e2e",
      (d) => {
        const pages = readdirSync(join(d, "assets")).find((n) => /^CsbPages-/.test(n))!;
        const entry = entryOf(d, "popup/index.html");
        writeFileSync(entry, `${readFileSync(entry, "utf8")}\nconst lazy=()=>import("./${pages}");`);
      },
      /popup\/index\.html can load CsbPages-[\w-]+\.js \(the Chrome-sync backup's pages are the settings page's\)/,
    ],
    [
      "one language's text missing",
      "prod",
      (d) => {
        const zh = readdirSync(join(d, "assets")).find((n) => n.startsWith("csb-locale-zh_CN-"))!;
        rmSync(join(d, "assets", zh));
      },
      /locale zh_CN: expected one Chrome-sync backup text chunk assets\/csb-locale-zh_CN-\*\.js, found 0/,
    ],
  ];
  for (const [what, flavour, alter, msg] of cases)
    it(`${flavour}: ${what}`, () => {
      const r = mutant(flavour, alter);
      expect(r.ok, r.out).toBe(false);
      expect(r.out).toMatch(msg);
    });
});

// ---- the popup's and the side panel's part (the pill, the footer's line and one click, the welcome's copy found) ------

/** Every file a page can load, statically or lazily, from its HTML (as check-dist walks it). */
function reach(d: string, page: string): Set<string> {
  const names = readdirSync(join(d, "assets")).filter((n) => n.endsWith(".js"));
  const seen = new Set<string>();
  const todo = [entryOf(d, page)];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(f, "utf8");
    for (const n of names) if (text.includes(n)) todo.push(join(d, "assets", n));
  }
  return new Set([...seen].map((f) => f.slice(join(d, "assets").length + 1)));
}

describe("the backup in Chrome sync in the popup and the side panel: their lazy chunk and text, and never a message of its own", () => {
  it("every build ships the pill's chunk and its text, which both pages reach lazily and the settings page never; none of their files names an sk-csb- message", () => {
    for (const f of ["prod", "e2e"] as const) {
      const names = assets(f);
      const pop = names.filter((n) => /^CsbPop-[\w-]+\.js$/.test(n));
      expect(pop, f).toHaveLength(1);
      const texts = ["en", "zh_CN"].map((loc) => names.filter((n) => n.startsWith(`csb-popup-locale-${loc}-`)));
      for (const t of texts) expect(t, f).toHaveLength(1);
      for (const page of ["popup/index.html", "sidepanel/index.html"]) {
        const r = reach(built[f], page);
        for (const n of [...pop, ...texts.flat()]) expect(r.has(n), `${f} ${page} ${n}`).toBe(true);
        for (const n of r) expect(readFileSync(join(built[f], "assets", n), "utf8"), n).not.toMatch(/["'`]sk-csb-/);
        // the one click's key, which the card takes (src/platform/cloud-go.ts)
        expect([...r].some((n) => readFileSync(join(built[f], "assets", n), "utf8").includes("sk_cloud_go"))).toBe(
          true,
        );
      }
      const settings = reach(built[f], "options/index.html");
      for (const n of [...pop, ...texts.flat()]) expect(settings.has(n), `${f} options ${n}`).toBe(false);
      const r = check(built[f], f);
      expect(r.out).toMatch(/^Chrome-sync backup popup text zh_CN: \d+ B gz \(limit 2048 B\)$/m);
    }
  });
  const cases: [string, Flavour, (d: string) => void, RegExp][] = [
    [
      "the pill's chunk sends the worker a message of the backup's",
      "prod",
      (d) => {
        const pop = readdirSync(join(d, "assets")).find((n) => /^CsbPop-/.test(n))!;
        const f = join(d, "assets", pop);
        writeFileSync(f, `${readFileSync(f, "utf8")}\nconst on=()=>chrome.runtime.sendMessage({type:"sk-csb-on"});`);
      },
      /popup\/index\.html can load CsbPop-[\w-]+\.js, which names a message of the Chrome-sync backup's \(the settings page's only\)[\s\S]*sidepanel\/index\.html can load CsbPop-[\w-]+\.js, which names a message/,
    ],
    [
      "the side panel's entry sends one",
      "e2e",
      (d) => {
        const entry = entryOf(d, "sidepanel/index.html");
        writeFileSync(
          entry,
          `${readFileSync(entry, "utf8")}\nconst now=()=>chrome.runtime.sendMessage({type:'sk-csb-now'});`,
        );
      },
      /sidepanel\/index\.html can load sidepanel-[\w-]+\.js, which names a message of the Chrome-sync backup's/,
    ],
    [
      "the settings page can load the popup's text",
      "prod",
      (d) => {
        const text = readdirSync(join(d, "assets")).find((n) => n.startsWith("csb-popup-locale-en-"))!;
        const entry = entryOf(d, "options/index.html");
        writeFileSync(entry, `${readFileSync(entry, "utf8")}\nconst t=()=>import("./${text}");`);
      },
      /options\/index\.html can load csb-popup-locale-en-[\w-]+\.js \(the Chrome-sync backup's popup part is the popup's and the side panel's\)/,
    ],
    [
      "the popup loads the pill's chunk statically",
      "e2e",
      (d) => {
        const pop = readdirSync(join(d, "assets")).find((n) => /^CsbPop-/.test(n))!;
        const entry = entryOf(d, "popup/index.html");
        writeFileSync(entry, `import "./${pop}";\n${readFileSync(entry, "utf8")}`);
      },
      /popup\/index\.html loads CsbPop-[\w-]+\.js statically; the Chrome-sync backup's popup part is lazy/,
    ],
    [
      "one language's popup text missing",
      "prod",
      (d) => {
        const zh = readdirSync(join(d, "assets")).find((n) => n.startsWith("csb-popup-locale-zh_CN-"))!;
        rmSync(join(d, "assets", zh));
      },
      /locale zh_CN: expected one Chrome-sync backup popup text chunk assets\/csb-popup-locale-zh_CN-\*\.js, found 0/,
    ],
    [
      "a second pill chunk",
      "e2e",
      (d) => {
        const pop = readdirSync(join(d, "assets")).find((n) => /^CsbPop-/.test(n))!;
        cpSync(join(d, "assets", pop), join(d, "assets", "CsbPop-AbCd1234.js"));
      },
      /expected one chunk of the Chrome-sync backup's pill and footer, assets\/CsbPop-\*\.js, found 2/,
    ],
    [
      "no pill chunk",
      "prod",
      (d) => {
        const pop = readdirSync(join(d, "assets")).find((n) => /^CsbPop-/.test(n))!;
        rmSync(join(d, "assets", pop));
      },
      /expected one chunk of the Chrome-sync backup's pill and footer, assets\/CsbPop-\*\.js, found 0/,
    ],
    [
      "the popup and the side panel cannot reach the pill's chunk",
      "prod",
      (d) => {
        const pop = readdirSync(join(d, "assets")).find((n) => /^CsbPop-/.test(n))!;
        for (const n of readdirSync(join(d, "assets")).filter((x) => x.endsWith(".js") && x !== pop)) {
          const f = join(d, "assets", n);
          const t = readFileSync(f, "utf8");
          if (t.includes(pop)) writeFileSync(f, t.replaceAll(pop, pop.replace("CsbPop-", "CsbPopGone-")));
        }
      },
      /popup\/index\.html cannot load CsbPop-[\w-]+\.js \(the Chrome-sync backup's popup part is the popup's and the side panel's\)[\s\S]*sidepanel\/index\.html cannot load CsbPop-/,
    ],
    [
      "the popup's text not the generated file",
      "e2e",
      (d) => {
        const en = readdirSync(join(d, "assets")).find((n) => n.startsWith("csb-popup-locale-en-"))!;
        const f = join(d, "assets", en);
        writeFileSync(f, readFileSync(f, "utf8").replace("message:`Backup stopped`", "message:`Backed up`"));
      },
      /csb-popup-locale-en-[\w-]+\.js differs from catalogs\/csb-popup-en\.json/,
    ],
    [
      "the popup's text over its budget",
      "prod",
      (d) => {
        const zh = readdirSync(join(d, "assets")).find((n) => n.startsWith("csb-popup-locale-zh_CN-"))!;
        const f = join(d, "assets", zh);
        writeFileSync(f, `${readFileSync(f, "utf8")}\n/*${randomBytes(2400).toString("base64")}*/`);
      },
      /Chrome-sync backup popup text zh_CN is \d+ B gz, over its limit of 2048 B/,
    ],
    [
      "a key of the full catalog in the popup's text",
      "prod",
      (d) => {
        const en = readdirSync(join(d, "assets")).find((n) => n.startsWith("csb-popup-locale-en-"))!;
        const f = join(d, "assets", en);
        writeFileSync(f, readFileSync(f, "utf8").replace("var e={", "var e={localOnly:{message:`local`},"));
      },
      /Chrome-sync backup popup text en: localOnly is also a key of the full catalog/,
    ],
  ];
  for (const [what, flavour, alter, msg] of cases)
    it(`${flavour}: ${what}`, () => {
      const r = mutant(flavour, alter);
      expect(r.ok, r.out).toBe(false);
      expect(r.out).toMatch(msg);
    });
});
