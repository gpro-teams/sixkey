// scripts/check-dist.mjs against real builds (SYNC-DESIGN §7): a prod and an e2e build are made once into a temporary
// directory; each pristine one must pass, and each copy altered to break one rule must fail with that rule's message.
// These are the check's own mutants, kept as regression tests: a rule that stops failing them is a rule that stopped
// working.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const EXT = resolve(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "sixkey-check-dist-"));
const built = { prod: join(work, "prod"), e2e: join(work, "e2e"), dev: join(work, "dev") };
type Flavour = keyof typeof built;
const flag = (f: Flavour) => (f === "prod" ? [] : [`--${f}`]);
// The scripts run as from a developer's shell, without the test runner's NODE_ENV=test (the build pins its own mode).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV"));

function build(flavour: Flavour) {
  const r = spawnSync(process.execPath, ["scripts/build.mjs", ...flag(flavour), "--out", built[flavour]], {
    cwd: EXT,
    encoding: "utf8",
    env,
  });
  if (r.status !== 0) throw new Error(`build ${flavour} failed:\n${r.stdout}\n${r.stderr}`);
}
function check(dir: string, flavour: Flavour): { ok: boolean; out: string } {
  const r = spawnSync(process.execPath, ["scripts/check-dist.mjs", ...flag(flavour), "--dist", dir], {
    cwd: EXT,
    encoding: "utf8",
    env,
  });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
let n = 0;
/** A copy of a build with `alter` applied; checked; the copy removed. */
function mutant(flavour: Flavour, alter: (dir: string) => void): { ok: boolean; out: string } {
  const dir = join(work, `m${++n}`);
  cpSync(built[flavour], dir, { recursive: true });
  alter(dir);
  try {
    return check(dir, flavour);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const editJson = (dir: string, f: string, fn: (j: Record<string, unknown>) => void) => {
  const p = join(dir, f);
  const j = JSON.parse(readFileSync(p, "utf8"));
  fn(j);
  writeFileSync(p, JSON.stringify(j, null, 2));
};
const editText = (dir: string, f: string, fn: (t: string) => string) =>
  writeFileSync(join(dir, f), fn(readFileSync(join(dir, f), "utf8")));
const popupChunk = (dir: string) =>
  `assets/${readdirSync(join(dir, "assets")).find((x) => /^popup-(?!locale)[\w-]+\.js$/.test(x))!}`;
const csp = (j: Record<string, unknown>) => j.content_security_policy as { extension_pages: string };

beforeAll(() => {
  build("prod");
  build("e2e");
  build("dev");
}, 240_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("check-dist: the pristine builds pass", () => {
  it("prod, e2e and dev", () => {
    const p = check(built.prod, "prod");
    expect(p.out).toContain("check-dist (prod) OK");
    expect(p.ok).toBe(true);
    const e = check(built.e2e, "e2e");
    expect(e.out).toContain("check-dist (e2e) OK");
    expect(e.ok).toBe(true);
    const d = check(built.dev, "dev");
    expect(d.out).toContain("check-dist (dev) OK");
    expect(d.ok).toBe(true);
    // and each fails the others' rules: the flavours are not interchangeable
    expect(check(built.e2e, "prod").ok).toBe(false);
    expect(check(built.prod, "e2e").ok).toBe(false);
    expect(check(built.dev, "prod").ok).toBe(false);
    expect(check(built.prod, "dev").ok).toBe(false);
  });
});

describe("check-dist: the service worker's first calls (storage access level, TOTP-AUTOFILL §4.2)", () => {
  const SET = /\.setAccessLevel\(/;
  const cases: [string, (t: string) => string][] = [
    ["a listener added before the calls", (t) => `chrome.runtime.onMessage.addListener(function(){});\n${t}`],
    ["a storage read before the calls", (t) => `chrome.storage.local.get("k");\n${t}`],
    [
      "the calls made but never reached (renamed method)",
      (t) => t.replace(new RegExp(SET.source, "g"), ".setAccessLevelX("),
    ],
  ];
  for (const flavour of ["prod", "e2e", "dev"] as const)
    for (const [what, alter] of cases)
      it(`${flavour}: ${what}`, () => {
        const r = mutant(flavour, (d) => editText(d, "sw.js", alter));
        expect(r.ok).toBe(false);
        expect(r.out).toMatch(/service worker: the first three calls of the worker must be/);
      });
});

describe("check-dist: the manifest", () => {
  const cases: [string, (d: string) => void, RegExp][] = [
    [
      "a second optional origin",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          (j.optional_host_permissions as string[]).push("https://evil.example/*");
        }),
      /optional_host_permissions must be exactly/,
    ],
    [
      "no optional host permission",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          delete j.optional_host_permissions;
        }),
      /manifest key missing: optional_host_permissions/,
    ],
    [
      "all hosts, optionally",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.optional_host_permissions = ["<all_urls>"];
        }),
      /optional_host_permissions must be exactly/,
    ],
    [
      // the store build names autofill's sites alone, not the server sync's API origin (no build does since DV-0b)
      "the API origin back in the store build's optional hosts",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.optional_host_permissions = ["https://api.sixkey.app/*", "https://*/*"];
        }),
      /optional_host_permissions must be exactly \["https:\/\/\*\/\*"\]/,
    ],
    [
      "a required host permission besides the optional one",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.host_permissions = ["https://api.sixkey.app/*"];
        }),
      /the prod build must not have host_permissions/,
    ],
    [
      "the sites' pattern required instead of optional (granted at install, without the user's click)",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.host_permissions = j.optional_host_permissions;
          delete j.optional_host_permissions;
        }),
      /manifest key not allowed: host_permissions/,
    ],
    [
      "an empty required list",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.host_permissions = [];
        }),
      /the prod build must not have host_permissions: \[\]/,
    ],
    [
      "connect-src widened",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          csp(j).extension_pages = csp(j).extension_pages.replace(
            "connect-src 'none'",
            "connect-src https://evil.example",
          );
        }),
      /unexpected extension_pages CSP/,
    ],
    [
      // the store build connects nowhere: its connect-src is 'none' (its site rules' updater's gate closed)
      "the API origin back in the store build's connect-src",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          csp(j).extension_pages = csp(j).extension_pages.replace(
            "connect-src 'none'",
            "connect-src https://api.sixkey.app",
          );
        }),
      /unexpected extension_pages CSP/,
    ],
    [
      "script-src weakened",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          csp(j).extension_pages = csp(j).extension_pages.replace(
            "script-src 'self'",
            "script-src 'self' 'wasm-unsafe-eval'",
          );
        }),
      /unexpected extension_pages CSP/,
    ],
    [
      "a sandbox CSP",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          (j.content_security_policy as Record<string, string>).sandbox = "sandbox allow-scripts";
        }),
      /content_security_policy must hold extension_pages only/,
    ],
    [
      "content scripts",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.content_scripts = [{ matches: ["<all_urls>"], js: ["sw.js"] }];
        }),
      /manifest key not allowed: content_scripts/,
    ],
    [
      // no build has externally_connectable since the plugin platform was removed, in any shape
      "externally connectable to web pages",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.externally_connectable = { matches: ["https://*.example/*"] };
        }),
      /manifest key not allowed: externally_connectable/,
    ],
    [
      "externally connectable to an extension",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.externally_connectable = { ids: ["abcdefghijklmnopabcdefghijklmnop"] };
        }),
      /externally_connectable must not be in a build's manifest \(prod\)/,
    ],
    [
      "externally connectable to every extension",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.externally_connectable = { ids: ["*"] };
        }),
      /manifest key not allowed: externally_connectable/,
    ],
    [
      "the reserved ID alone, as the store build had it while the plugin platform was there",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.externally_connectable = { ids: ["a".repeat(32)] };
        }),
      /manifest key not allowed: externally_connectable/,
    ],
    [
      "`management` asked for again (only the removed plugin platform used it)",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          (j.optional_permissions as string[]).push("management");
        }),
      /optional permission not allowed: management/,
    ],
    [
      "an optional permission no feature needs",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          (j.optional_permissions as string[]).push("tabs");
        }),
      /optional permission not allowed: tabs/,
    ],
    [
      "web-accessible resources",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.web_accessible_resources = [{ resources: ["*"], matches: ["<all_urls>"] }];
        }),
      /manifest key not allowed: web_accessible_resources/,
    ],
    [
      "a permission more",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          (j.permissions as string[]).push("tabs");
        }),
      /permissions must be exactly/,
    ],
    [
      "a permission less",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.permissions = (j.permissions as string[]).filter((p) => p !== "alarms");
        }),
      /permissions must be exactly/,
    ],
    [
      "an optional permission not on its own allow-list",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          (j.optional_permissions as string[]).push("nativeMessaging");
        }),
      /optional permission not allowed: nativeMessaging/,
    ],
    [
      // (a version below the server sync's minimum client version failed here too, until its client went: DV-0b)
      "a version that is not a Chrome version",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.version = "0.1.0-beta";
        }),
      /manifest version is not a Chrome version: 0\.1\.0-beta/,
    ],
    [
      "a classic background page",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.background = { service_worker: "sw.js" };
        }),
      /background must be exactly/,
    ],
    // the keyboard shortcuts (QUICK-UNLOCK §5.12 item 2): exactly the two, none global
    [
      "a third command",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          (j.commands as Record<string, unknown>).copy = {
            suggested_key: { default: "Alt+Shift+C" },
            description: "x",
          };
        }),
      /commands must be exactly/,
    ],
    [
      "a global lock shortcut",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          (j.commands as Record<string, Record<string, unknown>>).lock!.global = true;
        }),
      /commands must be exactly/,
    ],
    [
      "the lock command bound to another key",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          (j.commands as Record<string, Record<string, unknown>>).lock!.suggested_key = { default: "Ctrl+Shift+L" };
        }),
      /commands must be exactly/,
    ],
    [
      "no lock command",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          delete (j.commands as Record<string, unknown>).lock;
        }),
      /commands must be exactly/,
    ],
  ];
  for (const [what, alter, msg] of cases) {
    it(what, () => {
      const r = mutant("prod", alter);
      expect(r.ok, r.out).toBe(false);
      expect(r.out).toMatch(msg);
    });
  }
});

// No build has externally_connectable since the plugin platform was removed: the pristine builds have none, and one put
// back in any of them fails (the prod build's cases above; here the e2e and developer builds, which once had the test
// plugins' IDs).
describe("check-dist: no externally_connectable in any build", () => {
  it("the pristine builds have none", () => {
    for (const f of ["prod", "e2e", "dev"] as const) {
      const text = readFileSync(join(built[f], "manifest.json"), "utf8");
      expect("externally_connectable" in JSON.parse(text), f).toBe(false);
      expect(text, f).not.toContain("externally_connectable");
    }
  });
  for (const f of ["e2e", "dev"] as const)
    it(`${f}: one put back fails`, () => {
      const r = mutant(f, (d) =>
        editJson(d, "manifest.json", (j) => {
          j.externally_connectable = { ids: ["abcdefghijklmnopabcdefghijklmnop"] };
        }),
      );
      expect(r.ok, r.out).toBe(false);
      expect(r.out).toMatch(/manifest key not allowed: externally_connectable/);
      expect(r.out).toContain(`externally_connectable must not be in a build's manifest (${f})`);
    });
});

describe("check-dist: the network in shipped scripts", () => {
  const cases: [string, (d: string) => void, RegExp][] = [
    [
      "fetch in a page's chunk",
      (d) => editText(d, popupChunk(d), (t) => `${t}\nfetch("https://api.sixkey.app/v1/keys");`),
      /popup-[\w-]+\.js: `fetch` appears 1 times/,
    ],
    // the store build's worker has no site rules' updater (its release gate closed) and no sync transport (no build has
    // since DV-0b): no fetch at all
    [
      "a fetch in the store build's worker",
      (d) => editText(d, "sw.js", (t) => `${t}\nglobalThis.x=()=>fetch("/");`),
      /sw\.js: `fetch` appears 1 times; only sw\.js may use it, 0 times \(no network in this build/,
    ],
    [
      "a WebSocket",
      (d) => editText(d, popupChunk(d), (t) => `${t}\nnew WebSocket("wss://api.sixkey.app");`),
      /network primitive in shipped code/,
    ],
    [
      "sendBeacon",
      (d) => editText(d, "sw.js", (t) => `${t}\nnavigator.sendBeacon("/x");`),
      /network primitive in shipped code/,
    ],
    [
      "importScripts",
      (d) => editText(d, "sw.js", (t) => `${t}\nimportScripts("x.js");`),
      /network primitive in shipped code/,
    ],
    [
      "a URL of another host",
      (d) => editText(d, popupChunk(d), (t) => `${t}\nconst u="https://evil.example/collect";`),
      /URL in shipped code that is not one it may hold: https:\/\/evil\.example\/collect/,
    ],
    [
      "a URL that only starts like the API origin",
      (d) => editText(d, "sw.js", (t) => `${t}\nconst u="https://api.sixkey.app.evil.example/";`),
      /not one it may hold: https:\/\/api\.sixkey\.app\.evil\.example\//,
    ],
    [
      "a ws URL of the API host",
      (d) => editText(d, "sw.js", (t) => `${t}\nconst u="wss://api.sixkey.app/";`),
      /not one it may hold: wss:\/\/api\.sixkey\.app\//,
    ],
    // nor the server sync's API origin, nor its host, in any shipped file (in no build since DV-0b)
    [
      "the API origin in the store build's worker",
      (d) => editText(d, "sw.js", (t) => `${t}\nconst o="https://api.sixkey.app";`),
      /sw\.js: names the server sync's API \(api\.sixkey\.app\), whose client no build has/,
    ],
    [
      "the API host alone in a page's chunk",
      (d) => editText(d, popupChunk(d), (t) => `${t}\nconst h="api.sixkey.app";`),
      /popup-[\w-]+\.js: names the server sync's API \(api\.sixkey\.app\)/,
    ],
    [
      "the API host in the manifest",
      (d) =>
        editText(d, "manifest.json", (t) =>
          t.replace('"description"', '"homepage_url": "https://api.sixkey.app/", "description"'),
        ),
      /manifest\.json: names the server sync's API \(api\.sixkey\.app\)/,
    ],
    [
      "a remote script in a page",
      (d) =>
        editText(d, "popup/index.html", (t) =>
          t.replace("</head>", '<script src="https://evil.example/x.js"></script></head>'),
        ),
      /remote resource/,
    ],
    [
      "an inline script in a page",
      (d) => editText(d, "options/index.html", (t) => t.replace("</head>", "<script>alert(1)</script></head>")),
      /inline <script>/,
    ],
    [
      "a page without its own connect-src 'none'",
      (d) =>
        editText(d, "popup/index.html", (t) =>
          t.replace(`<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`, ""),
        ),
      /popup\/index\.html: no page-level connect-src 'none'/,
    ],
    [
      "a listener for other extensions' messages",
      (d) => editText(d, popupChunk(d), (t) => `${t}\nchrome.runtime.onMessageExternal.addListener(()=>{});`),
      /popup-[\w-]+\.js: a listener for other extensions' messages or ports/,
    ],
    [
      "a listener for other extensions' connections, in the worker",
      (d) => editText(d, "sw.js", (t) => `${t}\nchrome.runtime.onConnectExternal.addListener(()=>{});`),
      /sw\.js: a listener for other extensions' messages or ports/,
    ],
    [
      "a development-mode build (the JSX runtime's debug keys)",
      (d) =>
        editText(
          d,
          popupChunk(d),
          (t) => `${t}\nx("div",{},void 0,!1,{fileName:"src/popup/App.tsx",lineNumber:3,columnNumber:1});`,
        ),
      /popup-[\w-]+\.js: a development-mode build/,
    ],
    [
      "a path of the build machine",
      (d) => editText(d, "sw.js", (t) => `${t}\nconst p=${JSON.stringify(join(EXT, "src/x.ts"))};`),
      /sw\.js: a path of the build machine/,
    ],
    [
      "an absolute file path",
      (d) => editText(d, popupChunk(d), (t) => `${t}\nconst p="/home/someone/sixkey/src/x.ts";`),
      /popup-[\w-]+\.js: an absolute file path/,
    ],
    [
      "a page whose own policy comes after a script",
      (d) =>
        editText(d, "options/index.html", (t) =>
          t
            .replace(`<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`, "")
            .replace("</head>", `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'"></head>`),
        ),
      /options\/index\.html: no page-level connect-src 'none'/,
    ],
  ];
  for (const [what, alter, msg] of cases) {
    it(what, () => {
      const r = mutant("prod", alter);
      expect(r.ok, r.out).toBe(false);
      expect(r.out).toMatch(msg);
    });
  }
  // the e2e build, whose worker has the site rules' updater (its gate open) and, since DV-0b, no sync transport: its one
  // fetch is the updater's, and no API origin is in it (the server sync's local one, 127.0.0.1:8787, was until then)
  const e2eWorker: [string, (d: string) => void, RegExp][] = [
    [
      "a second fetch in the worker (the site rules' updater's is its one)",
      (d) => editText(d, "sw.js", (t) => `${t}\nglobalThis.x=()=>fetch("/");`),
      /sw\.js: `fetch` appears 2 times; only sw\.js may use it, 1 times \(the site rules' updater\)/,
    ],
    [
      "no fetch in the worker",
      (d) => editText(d, "sw.js", (t) => t.replace(/\bfetch\b/g, "fetsh")),
      /sw\.js: `fetch` appears 0 times/,
    ],
    [
      "the server sync's local API origin back in the worker",
      (d) => editText(d, "sw.js", (t) => `${t}\nconst o="http://127.0.0.1:8787";`),
      /sw\.js: names the server sync's API \(127\.0\.0\.1:8787\), whose client no build has/,
    ],
    [
      "another loopback origin in the worker",
      (d) => editText(d, "sw.js", (t) => `${t}\nconst o="http://127.0.0.1:8788";`),
      /not one it may hold: http:\/\/127\.0\.0\.1:8788/,
    ],
  ];
  for (const [what, alter, msg] of e2eWorker) {
    it(`e2e: ${what}`, () => {
      const r = mutant("e2e", alter);
      expect(r.ok, r.out).toBe(false);
      expect(r.out).toMatch(msg);
    });
  }
});

describe("check-dist: nothing in a prod build turns sync on (SYNC-DESIGN §9 M5/M6)", () => {
  const cases: [string, (d: string) => void, RegExp][] = [
    [
      "the developer sync page",
      (d) => {
        mkdirSync(join(d, "devsync"));
        writeFileSync(join(d, "devsync/index.html"), "<!doctype html><title>x</title>");
      },
      /devsync\/ \(the developer sync page\) is in the prod build/,
    ],
    [
      "the developer page's marker in a chunk",
      (d) => editText(d, popupChunk(d), (t) => `${t}\nconst m="sixkey-dev-sync";`),
      /popup-[\w-]+\.js: the developer sync page's marker in the prod build/,
    ],
    [
      "enrolment code (its domain tag)",
      (d) => editText(d, "sw.js", (t) => `${t}\nconst k="sixkey-enroll|2|";`),
      /enrolment code in the prod build \(sixkey-enroll\|2\|\)/,
    ],
    [
      // the server sync's toolbar badge: its title's text, which the worker read with chrome.i18n (_locales is shipped)
      "the sync badge's title back in _locales",
      (d) =>
        editJson(d, "_locales/en/messages.json", (j) => {
          j.syncBadgeTitle = { message: "Sixkey · devices waiting for approval: $1" };
        }),
      /_locales\/en\/messages\.json: the server sync's toolbar badge \(syncBadgeTitle\) in the prod build/,
    ],
    [
      // the removal of what the server sync's client left (src/platform/server-sync-leftovers.ts): dev and e2e builds only
      "the server sync's records' removal in the store build's worker",
      (d) =>
        editText(
          d,
          "sw.js",
          (t) => `${t}\nconst k=["sk_sync_cfg","sk_prejoin"],db="sixkey-identity",a="sk-sync-periodic";`,
        ),
      /sw\.js: names the server sync's records \(sk_sync_\) in the prod build, whose worker never removes them/,
    ],
    [
      "the loopback dev origin in a chunk",
      (d) => editText(d, popupChunk(d), (t) => `${t}\nconst o="127.0.0.1";`),
      /dev marker in a prod build: 127\.0\.0\.1/,
    ],
    [
      "a dev name in the manifest",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.name = "Sixkey (dev)";
        }),
      /dev marker in manifest: \(dev\)/,
    ],
  ];
  for (const [what, alter, msg] of cases) {
    it(what, () => {
      const r = mutant("prod", alter);
      expect(r.ok, r.out).toBe(false);
      expect(r.out).toMatch(msg);
    });
  }
});

describe("check-dist --e2e: the test build's own hosts, and no developer page", () => {
  it("the server sync's API origin in an e2e build fails; an e2e build with the developer page fails", () => {
    const a = mutant("e2e", (d) =>
      editJson(d, "manifest.json", (j) => {
        j.host_permissions = ["https://api.sixkey.app/*"];
      }),
    );
    expect(a.ok).toBe(false);
    // (AUTOFILL2 patch 2) the two fixture hosts the e2e build grants up front, and nothing else (the API origin was first,
    // until DV-0b)
    expect(a.out).toMatch(/host_permissions must be exactly \["https:\/\/grantedtls\.fix\.test\/\*","http:\/\/granted/);
    expect(a.out).toMatch(/manifest\.json: names the server sync's API \(api\.sixkey\.app\)/);
    // the e2e build's permission is required (its tests cannot answer Chrome's prompt), and only required
    const o = mutant("e2e", (d) =>
      editJson(d, "manifest.json", (j) => {
        j.optional_host_permissions = j.host_permissions;
        delete j.host_permissions;
      }),
    );
    expect(o.ok).toBe(false);
    expect(o.out).toMatch(/manifest key missing: host_permissions/);
    expect(o.out).toMatch(/the e2e build must not have optional_host_permissions/);
    const b = mutant("e2e", (d) => {
      mkdirSync(join(d, "devsync"));
      writeFileSync(join(d, "devsync/index.html"), "<!doctype html><title>x</title>");
    });
    expect(b.ok).toBe(false);
    expect(b.out).toMatch(/devsync\/ \(the developer sync page\) is in the e2e build/);
    const c = mutant("e2e", (d) =>
      editJson(d, "manifest.json", (j) => {
        j.permissions = (j.permissions as string[]).filter((p) => p !== "clipboardRead");
      }),
    );
    expect(c.ok).toBe(false);
    expect(c.out).toMatch(/permissions must be exactly/);
    // the e2e build is checked for a development-mode build as prod is
    const dm = mutant("e2e", (d) => editText(d, popupChunk(d), (t) => `${t}\nx({fileName:"a.tsx",lineNumber:1});`));
    expect(dm.ok).toBe(false);
    expect(dm.out).toMatch(/a development-mode build/);
    // the e2e build is minified like prod: its scripts are read as text too
    const e = mutant("e2e", (d) =>
      editText(
        d,
        popupChunk(d),
        (t) => `${t}\nfetch("http://127.0.0.1:8787/v1/keys");const u="https://evil.example/";`,
      ),
    );
    expect(e.ok).toBe(false);
    expect(e.out).toMatch(/`fetch` appears 1 times/);
    expect(e.out).toMatch(/not one it may hold: https:\/\/evil\.example\//);
  });
});

describe("check-dist --dev: the dev build's hosts, optional as in prod", () => {
  it("a dev build with the permission required, or with the server sync's API origin, fails", () => {
    const a = mutant("dev", (d) =>
      editJson(d, "manifest.json", (j) => {
        j.host_permissions = j.optional_host_permissions;
        delete j.optional_host_permissions;
      }),
    );
    expect(a.ok).toBe(false);
    expect(a.out).toMatch(/the dev build must not have host_permissions/);
    const b = mutant("dev", (d) =>
      editJson(d, "manifest.json", (j) => {
        j.optional_host_permissions = ["https://api.sixkey.app/*"];
      }),
    );
    expect(b.ok).toBe(false);
    // (AUTOFILL2 patch 2) https sites, one at a time, and nothing else (the dev origin was first, until DV-0b)
    expect(b.out).toMatch(/optional_host_permissions must be exactly \["https:\/\/\*\/\*"\]/);
  });
});

describe("check-dist: each page's policy in its pinned place, and what a page may hold", () => {
  const META = `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`;
  const failsWith = (r: { ok: boolean; out: string }, msg: RegExp) => {
    expect(r.ok, r.out).toBe(false);
    expect(r.out).toMatch(msg);
  };
  // text that looks like the policy, where the browser would not apply it (or only after a script ran)
  const hidden: [string, (t: string, d: string) => string][] = [
    [
      "inside <noscript> (raw text in a scripting-enabled <head>)",
      (t) => t.replace(META, `<noscript>${META}</noscript>`),
    ],
    ["inside <template> (inert)", (t) => t.replace(META, `<template>${META}</template>`)],
    [
      "inside <title> (text, not an element)",
      (t) => t.replace(META, "").replace(/<title>([^<]*)<\/title>/, `<title>$1${META}</title>`),
    ],
    [
      "after a --!> comment end, with a script of the build's own before it",
      (t, d) => t.replace(META, `<!-- x --!><script src="../${popupChunk(d)}"></script><!-- -->${META}`),
    ],
    [
      "after a classic script (theme-boot.js)",
      (t) => t.replace(META, "").replace(/(<script\s+src="\.\.\/theme-boot\.js"\s*><\/script>)/, `$1${META}`),
    ],
    ["after an uppercase <SCRIPT>", (t) => t.replace(META, `<SCRIPT src="../theme-boot.js"></SCRIPT>${META}`)],
    [
      "after another <meta> (the viewport)",
      (t) => t.replace(`${META}\n`, "").replace(/(<meta name="viewport"[^>]*>)/, `$1${META}`),
    ],
  ];
  for (const [what, alter] of hidden) {
    it(`the policy ${what} is no policy`, () => {
      failsWith(
        mutant("prod", (d) => editText(d, "popup/index.html", (t) => alter(t, d))),
        /popup\/index\.html: no page-level connect-src 'none'/,
      );
    });
  }
  it("<noscript>, <template> and a --!> comment end are refused in a page wherever they are", () => {
    for (const tag of ["<noscript>x</noscript>", "<template><b>x</b></template>", "<!-- x --!>"]) {
      failsWith(
        mutant("prod", (d) => editText(d, "options/index.html", (t) => t.replace("</body>", `${tag}</body>`))),
        /options\/index\.html: <noscript>, <template> or a "--!>" comment end in a page/,
      );
    }
  });
  it("a page shipped as .htm is a page: it needs its own policy too", () => {
    failsWith(
      mutant("prod", (d) => {
        mkdirSync(join(d, "extra"));
        writeFileSync(
          join(d, "extra/page.htm"),
          '<!doctype html><html><head><meta charset="utf-8"><script type="module" src="../theme-boot.js"></script></head></html>',
        );
      }),
      /extra\/page\.htm: no page-level connect-src 'none'/,
    );
  });
  it("a path of the repository outside extension/ is a path of the build machine", () => {
    failsWith(
      mutant("prod", (d) =>
        editText(
          d,
          "sw.js",
          (t) => `${t}\nconst p=${JSON.stringify(join(resolve(EXT, ".."), "contract/vectors/x.json"))};`,
        ),
      ),
      /sw\.js: a path of the build machine/,
    );
  });
  it("the e2e build is held to no machine paths as well", () => {
    failsWith(
      mutant("e2e", (d) => editText(d, "sw.js", (t) => `${t}\nconst p=${JSON.stringify(join(EXT, "src/x.ts"))};`)),
      /a path of the build machine/,
    );
  });
  it("a meta refresh however its attribute is quoted", () => {
    for (const m of [
      '<meta http-equiv=refresh content="0;url=https://evil.example/">',
      "<meta http-equiv='refresh' content=\"0;url=https://evil.example/\">",
    ]) {
      failsWith(
        mutant("prod", (d) => editText(d, "options/index.html", (t) => t.replace("</head>", `${m}</head>`))),
        /a meta refresh/,
      );
    }
  });
  it("a remote stylesheet or preload through href", () => {
    for (const tag of [
      '<link rel="stylesheet" href="https://evil.example/x.css">',
      '<link rel="modulepreload" href="//evil.example/x.js">',
    ]) {
      failsWith(
        mutant("prod", (d) => editText(d, "popup/index.html", (t) => t.replace("</head>", `${tag}</head>`))),
        /remote resource/,
      );
    }
  });
  it("no listener of another extension's messages or ports anywhere, the worker included; native messaging is not one", () => {
    failsWith(
      mutant("prod", (d) => editText(d, "sw.js", (t) => `${t}\nchrome.runtime.onMessageExternal.addListener(()=>{});`)),
      /sw\.js: a listener for other extensions' messages or ports/,
    );
    // (a program on this computer, through native messaging, is another way, which this rule does not look at)
    const native = mutant("prod", (d) => editText(d, "sw.js", (t) => `${t}\nvoid chrome.runtime.connectNative;`));
    expect(native.out).not.toMatch(/a listener for other extensions/);
  });
  it("management's calls: getSelf alone, which needs no permission", () => {
    for (const call of ["get", "getPermissionWarningsById", "getAll", "setEnabled", "uninstall", "launchApp"])
      failsWith(
        mutant("prod", (d) => editText(d, popupChunk(d), (t) => `${t}\nchrome.management.${call}("x");`)),
        new RegExp(`chrome\\.management\\.${call} \\(only getSelf\\)`),
      );
  });
  it("no define of the removed plugin platform in a shipped file", () => {
    for (const name of ["__PLUGIN_CATALOG__", "__PLUGIN_OWN_IDS__", "__PLUGIN_TEST_ANSWERS__"])
      failsWith(
        mutant("prod", (d) => editText(d, popupChunk(d), (t) => `${t}\nvoid (typeof ${name});`)),
        /a define of the removed plugin platform \(__PLUGIN_…\)/,
      );
  });
  it("no port opened by the worker; the grant store and the autofill switch's text in no page's static graph", () => {
    failsWith(
      mutant("prod", (d) => editText(d, "sw.js", (t) => `${t}\nchrome.runtime.connect("x");`)),
      /sw\.js: runtime\.connect in the worker/,
    );
    failsWith(
      mutant("prod", (d) => editText(d, popupChunk(d), (t) => `${t}\nconst k="sk_plugins_overlay";`)),
      /popup\/index\.html loads the plugin platform statically/,
    );
    failsWith(
      mutant("prod", (d) => {
        const text = readdirSync(join(d, "assets")).find((x) => /^plugins-locale-en-/.test(x))!;
        editText(d, "popup/index.html", (t) =>
          t.replace("</head>", `<link rel="modulepreload" href="../assets/${text}"></head>`),
        );
      }),
      /popup\/index\.html loads plugins-locale-en-[\w-]+\.js statically/,
    );
  });
  it("a dev build is checked for listeners of other extensions too", () => {
    failsWith(
      mutant("dev", (d) => editText(d, "sw.js", (t) => `${t}\nchrome.runtime.onMessageExternal.addListener(()=>{});`)),
      /a listener for other extensions' messages/,
    );
  });
  it("a dev build is checked for the removed Google Drive backup's endpoints and marks too, its kept comments included", () => {
    // (the dev build keeps every JSDoc comment and is not minified: what it names is still held to the marks)
    failsWith(
      mutant("dev", (d) => editText(d, "sw.js", (t) => `${t}\n/** https://www.googleapis.com/drive/v3/files */`)),
      /sw\.js: the removed Google Drive backup in the dev build \(googleapis\.com\)/,
    );
    failsWith(
      mutant("dev", (d) => editText(d, popupChunk(d), (t) => `${t}\nconst m={type:"sk-cloud-now"};`)),
      /popup-[\w-]+\.js: the removed Google Drive backup in the dev build \(sk-cloud-\)/,
    );
  });
});
