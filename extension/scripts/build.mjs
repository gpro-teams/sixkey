// Two Vite passes: (1) HTML pages, (2) the service worker as one self-contained ES file.
// Then write dist/manifest.json (base + dev overlay when --dev, + e2e overlay when --e2e, + test overlay when --test; an
// overlay's null removes the base's key).
// Each flavour has its own output directory, so a dev or e2e build never sits where the store package is made from:
// prod dist/, dev dist-dev/, e2e dist-e2e/ (scripts/package.mjs zips dist/ only after check-dist passed it).
//   --out <dir>   write the build there instead (the check-dist tests build into a temporary directory)
//   --id-draft    the prod build as the first store upload's ID draft (scripts/package.mjs --id-draft; the review's N-1):
//                 into dist-id-draft/, named "Sixkey (ID draft, do not publish)"; otherwise the store build
//   --test        the prod build for testing by hand (npm run build:test): into dist-test/, named "Sixkey (test)", with
//                 manifest.test.json's key (a fixed ID of its own, neither the dev build's nor the store's) and the
//                 install-source check off; otherwise the store build. Loaded unpacked only: scripts/package.mjs never
//                 zips it, and check-dist (prod) refuses it.
import { build } from "vite";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ID_DRAFT_NAME } from "./store-gates.mjs";
import { STORE_ID } from "./store-id.mjs";
import { cspOf } from "./csp.mjs";
import { suggestUiIn } from "./suggest-ui.mjs";
import { suggestGuard } from "./suggest-guard.mjs";
import { RULES_ORIGINS, rulesPathOf, rulesUpdateIn, updaterProblems } from "./rules-update.mjs";
import { rulesKeysOf } from "./rules-keys.mjs";
import { rulesGuard } from "./rules-guard.mjs";
import {
  CatalogKeysError,
  POPUP_CATALOG_PREFIX,
  POPUP_PAGES,
  popupKeys,
  readCatalogs,
  subsetCatalog,
  VIEW_CATALOG_FILE,
  VIEW_ENTRIES,
  viewKeys,
} from "./catalog-keys.mjs";
import { extensionNoticesText } from "./notices.mjs";
import {
  checkedBaseline,
  e2eBaselineText,
  extensionLicenceText,
  PACKAGED_BASELINE,
  PACKAGED_LICENCE,
  RULES_DIR,
  rulesLicenceText,
} from "./rules-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dev = process.argv.includes("--dev");
const e2e = process.argv.includes("--e2e"); // test-only build: clipboard permissions granted up front so Playwright can exercise them
// One flavour per build. Both together never meant anything (the e2e build won): refused.
if (dev && e2e) {
  console.error("build: --dev and --e2e are two flavours of the build; pass one of them");
  process.exit(2);
}
// The ID draft is a prod build: never a dev or e2e one.
const idDraft = process.argv.includes("--id-draft");
if (idDraft && (dev || e2e)) {
  console.error("build: --id-draft is the prod build's ID draft; it takes neither --dev nor --e2e");
  process.exit(2);
}
// The test build is a prod build too, and neither of the other kinds of prod build: never a dev, e2e or ID draft one.
const testBuild = process.argv.includes("--test");
if (testBuild && (dev || e2e || idDraft)) {
  console.error("build: --test is the prod build for testing by hand; it takes neither --dev, --e2e nor --id-draft");
  process.exit(2);
}
const outArg = process.argv.indexOf("--out");
if (outArg !== -1 && !process.argv[outArg + 1]) {
  console.error("build: --out needs a directory");
  process.exit(2);
}
const dist =
  outArg !== -1
    ? isAbsolute(process.argv[outArg + 1])
      ? process.argv[outArg + 1]
      : resolve(process.cwd(), process.argv[outArg + 1])
    : resolve(root, e2e ? "dist-e2e" : dev ? "dist-dev" : idDraft ? "dist-id-draft" : testBuild ? "dist-test" : "dist");

// The install-source check (H4, src/platform/install-source.ts): on in the prod build only. Dev and e2e builds are
// always loaded unpacked, so it would always fire there; the e2e suite asserts it against the prod build instead.
const prod = !dev && !e2e;
// The test build is the prod flavour in every respect (the same release gates, defines, API origin, CSP, permissions
// and module-graph guards: `prod` and `flavour` are the store build's) but three: its manifest name, its manifest key
// (manifest.test.json), and the install-source check, which is off. The check asks chrome.management.getSelf() how
// this copy was installed and shows "Not installed from the Chrome Web Store" in the popup and on the settings page
// when it was not installed the normal way (src/core/install-source.ts). A test build is always loaded unpacked
// (installType "development"), so the check would always show that notice, which a user of the store build never
// sees: the test build would then look different from the store build exactly where it should not.
const installCheck = prod && !testBuild;
// The test build's overlay (manifest.test.json) holds its name ("Sixkey (test)", a literal like the ID draft's, which
// check-dist --test holds it to) and its key, and nothing else: whatever else it said would make the test build differ
// from the store build, so the build stops, before anything is built. The key is a public key alone (its private half
// was not kept: an unpacked copy needs none), whose ID check-dist pins (TEST_EXTENSION_ID): the copies on two computers
// share that ID, and with it their data in Chrome sync, and the build sits in one profile beside the dev build without
// being the store's item.
let testOverlay = null;
if (testBuild) {
  try {
    testOverlay = JSON.parse(readFileSync(resolve(root, "manifest.test.json"), "utf8"));
  } catch (e) {
    console.error(`build: manifest.test.json cannot be read: ${e.message}`);
    process.exit(1);
  }
  if (
    JSON.stringify(Object.keys(testOverlay ?? {}).sort()) !== '["key","name"]' ||
    typeof testOverlay.name !== "string" ||
    typeof testOverlay.key !== "string"
  ) {
    console.error("build: manifest.test.json must hold the test build's name and key, and nothing else");
    process.exit(1);
  }
}
const flavour = e2e ? "e2e" : dev ? "dev" : "prod";
// The in-page suggestion of TOTP autofill (scripts/suggest-ui.mjs, its release gate): dev and e2e builds always, the store
// build only once the gate is opened.
const suggestUi = suggestUiIn(flavour);
// The site rules' updater (TOTP autofill Stage 3; scripts/rules-update.mjs, its release gate): dev and e2e builds always,
// the store build only once the gate is opened. With the gate closed, its modules are kept out of every pass's module
// graph (scripts/rules-guard.mjs); with it open, the build stops unless the flavour has a rules origin and exactly two
// pinned signing keys, checked by the extension's own code, and no test key in a store build (updaterProblems).
const rulesUpdate = rulesUpdateIn(flavour);
// the guard compares module paths with the extension's own src/ (scripts/rules-guard.mjs), whatever the folders above it
const RULES_SRC = resolve(root, "src");
if (rulesUpdate) {
  const problems = await updaterProblems(flavour);
  if (problems.length) {
    console.error(`build: the site rules' updater's gate is open, but:\n - ${problems.join("\n - ")}`);
    process.exit(1);
  }
}
// __I18N_GUARD__ (src/ui/i18n.ts): dev and e2e builds report a key that has no text on screen; prod builds have no such code.
// __SYNC_DEV__ (src/background/sw.ts): dev and e2e builds, with the end-to-end tests' hooks and the removal of what the
// server sync's client left in a profile (src/platform/server-sync-leftovers.ts). (Its name is that sync's: its other
// users went with its client. So did __API_ORIGIN__ and __SERVER_SYNC__, the API origin and the worker's sync, which only
// the dev and e2e builds had: OWNER-DECISIONS/25, DV-0b. The graph guard below and check-dist hold every flavour to
// none of that client.)
// The site rules' baseline bundle (TOTP autofill Stage 3, AF3-3a; scripts/rules-package.mjs): every flavour carries the
// repository's rules/build/baseline.json as rules/baseline.json, checked here, before anything is built, by the reader the
// extension uses (src/core/rules/baseline.ts) and held to bundle.mjs's form; a build without a bundle it accepts stops.
// The licence texts written beside it are read here too, so a missing one stops the build before anything is written.
// The e2e build's bundle also holds its own test rules, on the fixture hosts its tests serve (AF3-3b; rules-package.mjs
// e2eBaselineText: test/fixtures/rules/), checked the same way with reserved names allowed, as that build's reader allows
// them (__SK_RULES_TEST_HOSTS__ below); every other build carries the committed bundle as it is.
let baseline, licences;
try {
  baseline = await checkedBaseline();
  if (e2e)
    baseline = await checkedBaseline(await e2eBaselineText(baseline.text), "the e2e build's bundle", {
      allowReserved: true,
    });
  licences = { extension: extensionLicenceText(), rules: rulesLicenceText() };
} catch (e) {
  console.error(`build: ${e.message}`);
  process.exit(1);
}
const define = {
  // (the test build keeps the store build's: with its check off, nothing compares it or shows it)
  __STORE_ID__: JSON.stringify(prod ? STORE_ID : ""),
  __INSTALL_CHECK__: JSON.stringify(installCheck), // off in the test build too (installCheck above)
  __I18N_GUARD__: JSON.stringify(!prod),
  __SYNC_DEV__: JSON.stringify(!prod),
  // AUTOFILL2 patch 4 (src/platform/sender-policy.ts, src/platform/content-channel.ts, src/background/sw.ts): the content
  // script's `open` and the answer to its `cand`, from the release gate above; false compiles both out (check-dist)
  __SUGGEST_UI__: JSON.stringify(suggestUi),
  // src/background/sw.ts: the e2e build's backup in Chrome sync waits 5 s after a change instead of 30 s, for its browser
  // tests (CSB-3); nothing else of it differs, and it is turned on the one way every build has, the settings page's
  // message
  __CSB_E2E__: JSON.stringify(e2e),
  // src/platform/package-data.ts: the e2e build's reader accepts its test rules' reserved host names (AF3-3b); no other
  // build's does, and check-dist holds every other build's bundle to none
  __SK_RULES_TEST_HOSTS__: JSON.stringify(e2e),
  // The site rules' updater (AF3-U2; src/platform/rules-live.ts, its switch src/options/RulesUpdate.tsx, the Fill paths'
  // ask src/platform/site-rule.ts, its messages src/platform/sender-policy.ts, src/background/sw.ts): the release gate
  // above, and, with it open, the flavour's rules origin, the keys it pins as scripts/rules-keys.mjs lists them (checked
  // above by updaterProblems), and the built-in bundle's version (the bundle this build carries, checked above); with the
  // gate closed, nothing reads these three (the code that would is not in the build: scripts/rules-guard.mjs, check-dist)
  __RULES_UPDATE__: JSON.stringify(rulesUpdate),
  __SK_RULES_ORIGIN__: JSON.stringify(rulesUpdate ? RULES_ORIGINS[flavour] : ""),
  __SK_RULES_KEYS__: JSON.stringify(rulesUpdate ? rulesKeysOf(flavour) : []),
  __SK_RULES_BASELINE__: JSON.stringify(rulesUpdate ? JSON.parse(baseline.text).version : 0),
};

// No build contains the settings page's Sync section (src/options/sync/, its catalogs catalogs/sync-<lang>.json and
// catalogs/sync-manage-<lang>.json), the developer sync page (src/devsync/), or the rest of the server sync's client
// (DV-0b): its engine (src/core/sync/: the enrolment the section drove among it), the service's sync flows, the worker's
// sync, the bridge for pages, the transport, the API origin and its host permission, and the pairing code of its
// approval join (the toolbar badge's module, platform/badge.ts, is not refused: a later patch draws its own badge
// there; check-dist refuses the sync badge's text). Nothing a user of any build can reach turns sync on, and no build
// reaches its API (OWNER-DECISIONS/25). This plugin fails the build if any entry's module graph (static imports and import()) holds one
// of these modules, in every flavour, should one come back from the history. check-dist checks the built files again, by
// other means.
const SYNC_SECTION_FORBIDDEN = [
  /[\\/]src[\\/]devsync[\\/]/,
  /[\\/]src[\\/]core[\\/]sync[\\/]/,
  /[\\/]src[\\/]core[\\/]service[\\/]sync-flows\.ts$/,
  /[\\/]src[\\/]core[\\/]crypto[\\/]pairing-code\.ts$/,
  /[\\/]src[\\/]platform[\\/](?:sync-worker|sync-engine|bridge-page|bridge-worker|fetch-transport|api-permission|api-origin)\.ts$/,
  /[\\/]src[\\/]options[\\/]sync[\\/]/,
  /[\\/]src[\\/]options[\\/]SyncHost\.tsx$/,
  /[\\/]catalogs[\\/]sync-(?:manage-)?[A-Za-z_]+\.json$/, // both of the section's catalogs
];
function syncSectionGuard() {
  return {
    name: "sixkey-sync-section-guard",
    buildEnd(err) {
      if (err) return;
      const bad = [...this.getModuleIds()]
        .map((id) => id.replace(/\?.*$/, ""))
        .filter((id) => SYNC_SECTION_FORBIDDEN.some((re) => re.test(id)));
      if (bad.length)
        this.error(
          `no build may contain the Sync section, the developer sync page or the server sync's client: ${bad.map((f) => f.slice(root.length + 1)).join(", ")}`,
        );
    },
  };
}

// Every path the guards below compare is spelt as the disk spells it (realpathSync.native: its own letter case, links
// followed), so an import written in another case on a case-insensitive disk, or through a link, is still seen.
const slashed = (p) => p.split("\\").join("/");
const onDisk = (p) => {
  try {
    return slashed(realpathSync.native(p));
  } catch {
    return slashed(p); // not a file (a virtual module): as it is
  }
};
// The site rules (../rules/; TOTP autofill Stage 3, AF3-3a; scripts/rules-package.mjs) are data the extension reads from
// its package (rules/baseline.json, src/platform/package-data.ts), never code: AGPL data inlined into the MPL code is what
// the plan's §4.4 keeps out ("no JavaScript data module"). Every flavour's build fails if any entry's module graph holds
// a file under the repository's rules/ folder, however it is imported (a JSON module, a named import, ?raw, ?url), naming
// the file and the modules that import it; paths compared as the disk spells them, as above. A file such a build emits as
// an asset of its own is refused too (generateBundle: `new URL("../rules/…", import.meta.url)` in a page reaches no
// module graph, and the page build copies the file into assets/), naming it. A library build (the worker, the finder, the
// content script) writes such a file into the script as a data: URL instead, which check-dist refuses
// (`data:application/json`), as it refuses the bundle's host lists in any shipped text file and a copy of the bundle
// anywhere but rules/ (rules-package.mjs dataProbes).
const RULES_ROOT = `${onDisk(RULES_DIR)}/`;
function rulesDataGuard() {
  let viteRoot = root;
  return {
    name: "sixkey-rules-data-guard",
    configResolved(config) {
      viteRoot = config.root;
    },
    generateBundle(_, bundle) {
      const bad = [];
      for (const out of Object.values(bundle))
        for (const name of out.type === "asset" ? (out.originalFileNames ?? []) : []) {
          const file = onDisk(resolve(viteRoot, name));
          if (file.startsWith(RULES_ROOT)) bad.push(`rules/${file.slice(RULES_ROOT.length)} (as ${out.fileName})`);
        }
      if (bad.length)
        this.error(
          `the site rules' data in the build (it is read from the package, never emitted as an asset): ${bad.join("; ")}`,
        );
    },
    buildEnd(err) {
      if (err) return;
      const ours = `${onDisk(root)}/`;
      const plain = (id) => id.replace(/^\0/, "");
      const bad = [];
      for (const id of this.getModuleIds()) {
        const file = onDisk(plain(id).replace(/\?.*$/, ""));
        if (!file.startsWith(RULES_ROOT)) continue;
        const info = this.getModuleInfo(id);
        const by = [...(info?.importers ?? []), ...(info?.dynamicImporters ?? [])].map((i) => {
          const f = onDisk(plain(i).replace(/\?.*$/, ""));
          return f.startsWith(ours) ? f.slice(ours.length) : f;
        });
        bad.push(
          `rules/${file.slice(RULES_ROOT.length)}${plain(id).match(/\?.*$/)?.[0] ?? ""} (imported by ${by.join(", ") || "an entry"})`,
        );
      }
      if (bad.length)
        this.error(
          `the site rules' data in the build (it is read from the package, never imported): ${bad.join("; ")}`,
        );
    },
  };
}

// Every flavour is a production-mode build, whatever the environment says: Vite follows NODE_ENV, and a build made with
// NODE_ENV=development or =test (a developer's shell, a test runner) would use the JSX runtime's debug build, which
// writes the builder's absolute file paths into the pages. dev builds differ only in what is listed above (no
// minification, source maps, the developer-build defines). check-dist refuses a development-mode build.
process.env.NODE_ENV = "production";
const shared = {
  configFile: false,
  mode: "production",
  logLevel: "warn",
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
};
const buildCommon = { target: "chrome120", sourcemap: dev, minify: !dev, modulePreload: { polyfill: false } };

// Each language's catalog is its own lazily loaded chunk with a fixed name (see src/ui/i18n.ts loadCatalog), so
// check-dist can find them and count each against its budget: the popup's are assets/popup-locale-<lang>-<hash>.js (the
// larger one the popup can load is counted in its budget), the settings page's parts (catalogs/settings-<part>-<lang>.json,
// made by scripts/messages.py; src/options/parts.tsx loads each before its part is drawn) are
// assets/settings-locale-<part>-<lang>-<hash>.js. No page loads the full catalogs (_locales, which Chrome reads): a chunk
// of one would be assets/locale-<lang>-<hash>.js, which check-dist refuses, and the plugins below fail the build first.
// The popup's View menu (src/popup/main/View.tsx) has a catalog of its own, catalogs/view-<lang>.json (scripts/messages.py
// VIEW), loaded with the menu on its first use: assets/view-locale-<lang>-<hash>.js, which check-dist counts apart from
// the popup's catalogs and refuses in any page's static graph.
// The recovery code shares' catalog (catalogs/shares-<lang>.json, scripts/messages.py SHARES; src/ui/share-text.ts),
// loaded with the shares' lazy chunks by the popup, the side panel and the settings page: assets/shares-locale-<lang>-
// <hash>.js, which check-dist counts apart from every page's catalogs and refuses in any page's static graph
// (docs/design/notes/SHAMIR-NOTES.md §6).
// The device unlock's catalog (catalogs/device-<lang>.json, scripts/messages.py DEVICE; src/ui/device-text.ts), loaded with
// the device unlock's lazy chunks by the popup, the side panel and the settings page, likewise: assets/device-locale-
// <lang>-<hash>.js (docs/design/notes/PRF-NOTES.md).
// The PIN record's catalog (scripts/messages.py RESTART; docs/design/notes/PIN-RESTART-NOTES.md §8): the settings page's
// (catalogs/restart-<lang>.json, src/ui/restart-text.ts) is assets/restart-locale-<lang>-<hash>.js; check-dist holds the
// settings page to it and keeps it from the popup's and the side panel's.
// The autofill switch's catalog (scripts/messages.py PLUGINS): the settings page's (catalogs/plugins-<lang>.json,
// src/ui/plugins/text.ts) is assets/plugins-locale-<lang>-<hash>.js; check-dist holds the settings page to it and keeps
// it from the popup's and the side panel's.
const LOCALE_MODULE = /[\\/]_locales[\\/]([A-Za-z_]+)[\\/]messages\.json(?:\?.*)?$/;
const AUTOFILL_LOCALE_MODULE = /[\\/]catalogs[\\/]autofill-([A-Za-z_]+)\.json(?:\?.*)?$/;
const SHARES_LOCALE_MODULE = /[\\/]catalogs[\\/]shares-([A-Za-z_]+)\.json(?:\?.*)?$/;
const DEVICE_LOCALE_MODULE = /[\\/]catalogs[\\/]device-([A-Za-z_]+)\.json(?:\?.*)?$/;
const RESTART_LOCALE_MODULE = /[\\/]catalogs[\\/]restart-([A-Za-z_]+)\.json(?:\?.*)?$/;
// The backup in Chrome's sync storage's (catalogs/csb-<lang>.json, src/ui/csb-text.ts): assets/csb-locale-<lang>-<hash>.js,
// the settings page's only (check-dist); and the popup's and the side panel's (catalogs/csb-popup-<lang>.json,
// src/ui/csb-popup-text.ts): assets/csb-popup-locale-<lang>-<hash>.js, theirs only.
const CSB_LOCALE_MODULE = /[\\/]catalogs[\\/]csb-([A-Za-z_]+)\.json(?:\?.*)?$/;
const CSB_POPUP_LOCALE_MODULE = /[\\/]catalogs[\\/]csb-popup-([A-Za-z_]+)\.json(?:\?.*)?$/;
const PLUGINS_LOCALE_MODULE = /[\\/]catalogs[\\/]plugins-([A-Za-z_]+)\.json(?:\?.*)?$/;
const SETTINGS_LOCALE_MODULE = /[\\/]catalogs[\\/]settings-([a-z]+)-([A-Za-z_]+)\.json(?:\?.*)?$/;
// The site rules' updater's text (AF3-U2; catalogs/rules-<lang>.json, src/options/RulesUpdate.tsx): assets/rules-update-
// locale-<lang>-<hash>.js, in a build whose updater's gate is open only (check-dist).
const RULES_LOCALE_MODULE = /[\\/]catalogs[\\/]rules-([A-Za-z_]+)\.json(?:\?.*)?$/;
const POPUP_CATALOG_ID = "\0" + POPUP_CATALOG_PREFIX;
const popupLangOf = (id) => (id?.startsWith(POPUP_CATALOG_ID) ? id.slice(POPUP_CATALOG_ID.length) : undefined);
const chunkFileNames = (chunk) => {
  const popupLang = popupLangOf(chunk.facadeModuleId);
  if (popupLang) return `assets/popup-locale-${popupLang}-[hash].js`;
  const fillLang = AUTOFILL_LOCALE_MODULE.exec(chunk.facadeModuleId ?? "")?.[1];
  if (fillLang) return `assets/autofill-locale-${fillLang}-[hash].js`;
  const sharesLang = SHARES_LOCALE_MODULE.exec(chunk.facadeModuleId ?? "")?.[1];
  if (sharesLang) return `assets/shares-locale-${sharesLang}-[hash].js`;
  const deviceLang = DEVICE_LOCALE_MODULE.exec(chunk.facadeModuleId ?? "")?.[1];
  if (deviceLang) return `assets/device-locale-${deviceLang}-[hash].js`;
  const restartLang = RESTART_LOCALE_MODULE.exec(chunk.facadeModuleId ?? "")?.[1];
  if (restartLang) return `assets/restart-locale-${restartLang}-[hash].js`;
  const csbLang = CSB_LOCALE_MODULE.exec(chunk.facadeModuleId ?? "")?.[1];
  if (csbLang) return `assets/csb-locale-${csbLang}-[hash].js`;
  const csbPopupLang = CSB_POPUP_LOCALE_MODULE.exec(chunk.facadeModuleId ?? "")?.[1];
  if (csbPopupLang) return `assets/csb-popup-locale-${csbPopupLang}-[hash].js`;
  const pluginsLang = PLUGINS_LOCALE_MODULE.exec(chunk.facadeModuleId ?? "")?.[1];
  if (pluginsLang) return `assets/plugins-locale-${pluginsLang}-[hash].js`;
  const viewLang = VIEW_CATALOG_FILE.exec(chunk.facadeModuleId ?? "")?.[1];
  if (viewLang) return `assets/view-locale-${viewLang}-[hash].js`;
  const settings = SETTINGS_LOCALE_MODULE.exec(chunk.facadeModuleId ?? "");
  if (settings) return `assets/settings-locale-${settings[1]}-${settings[2]}-[hash].js`;
  const rulesLang = RULES_LOCALE_MODULE.exec(chunk.facadeModuleId ?? "")?.[1];
  if (rulesLang) return `assets/rules-update-locale-${rulesLang}-[hash].js`;
  const lang = LOCALE_MODULE.exec(chunk.facadeModuleId ?? "")?.[1];
  return lang ? `assets/locale-${lang}-[hash].js` : "assets/[name]-[hash].js"; // the last is Vite's default
};

// The popup's catalogs, virtual:popup-catalog/<lang> (src/popup/boot.tsx): the full catalog cut down to the keys popup
// code can use, which scripts/catalog-keys.mjs works out from the syntax tree of every module the popup page, and the
// side panel's page that draws the same screens, can load (lazy ones too; POPUP_PAGES). Worked out again on every build
// from the sources and the _locales this build ships, never cached. Then the plugin checks what the bundler really did,
// by means that share no code with the collector:
//   - every source module in the bundler's graph of the two pages (static imports and import(), from popup/index.html
//     and sidepanel/index.html) is one the collector read, and no full catalog (_locales/*.json) is in it;
//   - every quoted key in the code of each chunk either page can load (its entry, the chunks it imports, and those it
//     loads later) is in the popup catalog;
//   - the pages can load a catalog for every language, all with the same keys.
// Any failure stops the build. check-dist checks the result again in dist/ and counts it.
function popupCatalog() {
  // the popup and the side panel, which draws the popup's screens and loads the same catalog (catalog-keys.mjs POPUP_PAGES)
  const pages = POPUP_PAGES.map((page) => resolve(root, page));
  const catalogs = readCatalogs(root);
  const allKeys = new Set(Object.keys(catalogs.en));
  let found;
  try {
    found = popupKeys(root, catalogs, { suggestUi }); // a release gate closed: what only it lets in is not the popup's
  } catch (e) {
    if (e instanceof CatalogKeysError) {
      console.error(`build: the popup's message keys cannot be worked out.\n${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  // the View menu's keys (stopped out of the popup's walk): its module is read (below) and its chunk may name them
  const view = viewKeys(root, catalogs, { suggestUi });
  const keep = new Set(found.keys);
  // every key the menu can show has its text in the popup's catalog or the menu's own (a lacking one would show as its name)
  for (const lang of Object.keys(catalogs)) {
    const file = resolve(root, "catalogs", `view-${lang}.json`);
    let own;
    try {
      own = new Set(Object.keys(JSON.parse(readFileSync(file, "utf8"))));
    } catch {
      console.error(`build: ${file} cannot be read; run python3 scripts/messages.py`);
      process.exit(1);
    }
    const lacking = view.keys.filter((k) => !keep.has(k) && !own.has(k));
    if (lacking.length) {
      console.error(
        `build: the View menu (src/popup/main/View.tsx) can show keys that neither the popup's catalog nor catalogs/view-${lang}.json has: ${lacking.join(", ")}. List them in a fragment's VIEW (scripts/messages.py).`,
      );
      process.exit(1);
    }
  }
  const viewMayName = new Set([...found.keys, ...view.keys]);
  const subsets = Object.fromEntries(
    Object.entries(catalogs).map(([lang, cat]) => [lang, subsetCatalog(cat, found.keys, lang)]),
  );
  const read = new Set([...found.modules, ...view.modules].map((m) => resolve(root, m)));
  const viewEntries = VIEW_ENTRIES.map((m) => resolve(root, m));
  const strip = (id) => id.replace(/\?.*$/, "");
  return {
    name: "sixkey-popup-catalog",
    resolveId(id) {
      return id.startsWith(POPUP_CATALOG_PREFIX) ? "\0" + id : undefined;
    },
    load(id) {
      const lang = popupLangOf(id);
      if (lang === undefined) return undefined;
      if (!Object.hasOwn(subsets, lang)) this.error(`${POPUP_CATALOG_PREFIX}${lang}: no such language in _locales`);
      return `export default ${JSON.stringify(subsets[lang])};\n`;
    },
    buildEnd(err) {
      if (err) return;
      const graph = new Set();
      const todo = [...pages];
      while (todo.length) {
        const id = todo.pop();
        if (graph.has(id)) continue;
        graph.add(id);
        const info = this.getModuleInfo(id);
        if (!info) this.error(`popup graph: no module info for ${id}`);
        todo.push(...info.importedIds, ...info.dynamicallyImportedIds);
      }
      const unread = [];
      for (const id of graph) {
        const file = strip(id);
        if (LOCALE_MODULE.test(file))
          this.error(
            `the popup can load the full catalog ${file.slice(root.length + 1)}; it must only import virtual:popup-catalog/<lang>`,
          );
        if (file.startsWith(resolve(root, "src") + "/") && /\.(?:[mc]?[jt]sx?)$/.test(file) && !read.has(file))
          unread.push(file.slice(root.length + 1));
      }
      if (unread.length)
        this.error(`the popup's graph has modules the key collector did not read: ${unread.join(", ")}`);
    },
    generateBundle(_, bundle) {
      const entries = pages.map((page) => {
        const entry = Object.values(bundle).find((c) => c.type === "chunk" && c.isEntry && c.facadeModuleId === page);
        if (!entry) this.error(`no entry chunk for ${page.slice(root.length + 1)}`);
        return entry;
      });
      const reach = new Set();
      const todo = entries.map((e) => e.fileName);
      while (todo.length) {
        const f = todo.pop();
        if (reach.has(f)) continue;
        reach.add(f);
        const c = bundle[f];
        if (c?.type === "chunk") todo.push(...c.imports, ...c.dynamicImports);
      }
      const langs = new Set();
      const viewLangs = new Set();
      const missing = new Map();
      // what each page loads up front (entry, static imports): the View menu's code and text are never in it
      for (const e of entries) {
        const statics = new Set();
        const up = [e.fileName];
        while (up.length) {
          const f = up.pop();
          if (statics.has(f)) continue;
          statics.add(f);
          const c = bundle[f];
          if (c?.type === "chunk") up.push(...c.imports);
        }
        for (const f of statics) {
          const c = bundle[f];
          if (
            c?.type === "chunk" &&
            (VIEW_CATALOG_FILE.test(c.facadeModuleId ?? "") || c.moduleIds.some((m) => viewEntries.includes(strip(m))))
          )
            this.error(`${e.fileName} imports ${f} up front; the View menu loads only when it is opened`);
        }
      }
      for (const f of reach) {
        const c = bundle[f];
        if (c?.type !== "chunk") continue;
        const lang = popupLangOf(c.facadeModuleId);
        if (lang !== undefined) {
          langs.add(lang);
          continue;
        }
        const viewLang = VIEW_CATALOG_FILE.exec(c.facadeModuleId ?? "")?.[1];
        if (viewLang !== undefined) {
          viewLangs.add(viewLang);
          continue;
        }
        if (LOCALE_MODULE.test(c.facadeModuleId ?? "")) this.error(`the popup can load the full catalog chunk ${f}`);
        const isView = c.moduleIds.some((m) => viewEntries.includes(strip(m)));
        for (const [, , k] of c.code.matchAll(/(["'`])([A-Za-z0-9_]+)\1/g))
          if (allKeys.has(k) && !(isView ? viewMayName : keep).has(k))
            (missing.get(k) ?? missing.set(k, new Set()).get(k)).add(f);
      }
      if (missing.size)
        this.error(
          `popup code mentions message keys its catalog lacks: ${[...missing].map(([k, fs]) => `${k} (${[...fs].join(", ")})`).join("; ")}`,
        );
      const want = Object.keys(catalogs);
      if (want.some((l) => !langs.has(l)))
        this.error(`the popup cannot load a catalog for ${want.filter((l) => !langs.has(l)).join(", ")}`);
      if (want.some((l) => !viewLangs.has(l)))
        this.error(`the View menu cannot load a catalog for ${want.filter((l) => !viewLangs.has(l)).join(", ")}`);
      console.log(
        `popup catalog: ${found.keys.length} of ${allKeys.size} keys (${found.traced.length} traced from t(), ${found.families.length} famil${found.families.length === 1 ? "y" : "ies"}), from ${found.modules.length} modules`,
      );
    },
  };
}

// The settings page's text (src/options/parts.tsx): its parts' catalogs, never the full catalogs. Which key is in which
// part is data (scripts/messages.py, the fragments' PARTS), held to the code by test/unit/budget-split.test.ts with the
// key collector; this plugin checks what the bundler really did, by means that share no code with it:
//   - no full catalog (_locales/*.json) is in the settings page's module graph (static imports and import());
//   - every settings catalog (catalogs/settings-<part>-<lang>.json) is a chunk of its own that the page reaches by import()
//     only, never by a static import (each is loaded when its part is drawn), for every part and language;
//   - every quoted key of the full catalogs in the code of each chunk the page can load is in one of those catalogs.
// Any failure stops the build. check-dist checks the result again in dist/ and counts each catalog against its budget.
function settingsCatalogs() {
  const optionsHtml = resolve(root, "src/options/index.html");
  const allKeys = new Set(Object.keys(readCatalogs(root).en));
  const dir = resolve(root, "catalogs");
  const files = readdirSync(dir).filter((n) => /^settings-[a-z]+-[A-Za-z_]+\.json$/.test(n));
  const placed = new Set(files.flatMap((n) => Object.keys(JSON.parse(readFileSync(resolve(dir, n), "utf8")))));
  const strip = (id) => id.replace(/\?.*$/, "");
  return {
    name: "sixkey-settings-catalogs",
    buildEnd(err) {
      if (err) return;
      const graph = new Set();
      const todo = [optionsHtml];
      while (todo.length) {
        const id = todo.pop();
        if (graph.has(id)) continue;
        graph.add(id);
        const info = this.getModuleInfo(id);
        if (!info) this.error(`settings page graph: no module info for ${id}`);
        todo.push(...info.importedIds, ...info.dynamicallyImportedIds);
      }
      for (const id of graph)
        if (LOCALE_MODULE.test(strip(id)))
          this.error(
            `the settings page can load the full catalog ${strip(id).slice(root.length + 1)}; it loads its parts (src/options/parts.tsx)`,
          );
    },
    generateBundle(_, bundle) {
      const entry = Object.values(bundle).find(
        (c) => c.type === "chunk" && c.isEntry && c.facadeModuleId === optionsHtml,
      );
      if (!entry) this.error("no settings page entry chunk");
      const reach = new Set();
      const statics = new Set();
      const todo = [entry.fileName];
      while (todo.length) {
        const f = todo.pop();
        if (reach.has(f)) continue;
        reach.add(f);
        const c = bundle[f];
        if (c?.type !== "chunk") continue;
        for (const i of c.imports) statics.add(i);
        todo.push(...c.imports, ...c.dynamicImports);
      }
      const seen = new Set();
      const missing = new Map();
      for (const f of reach) {
        const c = bundle[f];
        if (c?.type !== "chunk") continue;
        const m = SETTINGS_LOCALE_MODULE.exec(c.facadeModuleId ?? "");
        if (m) {
          seen.add(`settings-${m[1]}-${m[2]}.json`);
          if (statics.has(f))
            this.error(`the settings catalog chunk ${f} is imported statically; it must load with its part`);
          continue;
        }
        for (const [, , k] of c.code.matchAll(/(["'`])([A-Za-z0-9_]+)\1/g))
          if (allKeys.has(k) && !placed.has(k)) (missing.get(k) ?? missing.set(k, new Set()).get(k)).add(f);
      }
      const unseen = files.filter((n) => !seen.has(n));
      if (unseen.length) this.error(`the settings page cannot load the catalogs ${unseen.join(", ")}`);
      if (missing.size)
        this.error(
          `settings page code mentions message keys no settings catalog has: ${[...missing].map(([k, fs]) => `${k} (${[...fs].join(", ")})`).join("; ")}`,
        );
      console.log(`settings catalogs: ${placed.size} keys in ${files.length / 2} parts`);
    },
  };
}

await build({
  ...shared,
  define,
  plugins: [
    popupCatalog(),
    settingsCatalogs(),
    syncSectionGuard(),
    rulesDataGuard(),
    rulesGuard(rulesUpdate, RULES_SRC),
  ],
  root: resolve(root, "src"),
  base: "./",
  publicDir: resolve(root, "public"),
  build: {
    ...buildCommon,
    outDir: dist,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(root, "src/popup/index.html"),
        // the side panel: the popup's screens in a page of its own (docs/design/notes/SIDEPANEL-NOTES.md); the code the
        // two share is one chunk, and check-dist holds each page to its own budget
        sidepanel: resolve(root, "src/sidepanel/index.html"),
        options: resolve(root, "src/options/index.html"),
        offscreen: resolve(root, "src/offscreen/index.html"),
      },
      output: { chunkFileNames },
    },
  },
});

await build({
  ...shared,
  define,
  plugins: [syncSectionGuard(), rulesDataGuard(), rulesGuard(rulesUpdate, RULES_SRC)],
  root,
  publicDir: false,
  build: {
    ...buildCommon,
    outDir: dist,
    emptyOutDir: false,
    copyPublicDir: false,
    lib: { entry: resolve(root, "src/background/sw.ts"), formats: ["es"], fileName: () => "sw.js" },
    rollupOptions: { output: { codeSplitting: false } },
  },
});

// The code box finder and filler (src/inject/otp.ts; TOTP-AUTOFILL §4): the one script Sixkey runs in a web page, and only
// on the user's action. A classic script of its own (no imports, no chunks: the browser injects the file as it is), built
// last so that nothing else can import it; it leaves one global, __skOtp, in the isolated world it is injected into.
// check-dist holds the file to its budget and its rules. `__SK_ENGINE__` names the build of the finder (a hash of its source):
// a second install into a page keeps the first copy only if it is the same build (src/inject/otp.ts, "one finder per page").
await build({
  ...shared,
  define: {
    __SK_ENGINE__: JSON.stringify(
      createHash("sha256")
        .update(readFileSync(resolve(root, "src/inject/otp.ts")))
        .digest("hex")
        .slice(0, 16),
    ),
  },
  plugins: [rulesDataGuard(), rulesGuard(rulesUpdate, RULES_SRC)],
  root,
  publicDir: false,
  build: {
    ...buildCommon,
    outDir: dist,
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: resolve(root, "src/inject/otp.ts"),
      formats: ["iife"],
      name: "__skOtp",
      fileName: () => "inject/otp.js",
    },
    rollupOptions: { output: { codeSplitting: false } },
  },
});

// The content script of TOTP autofill Stage 2 (src/inject/suggest.ts; docs/design/notes/AUTOFILL2-NOTES.md §9): registered by
// the worker for the sites the user turned on, and run after inject/otp.js in the same isolated world. A classic script with
// no exports, so it leaves no global of its own; check-dist holds it to its budget, its forbidden list and its one message.
await build({
  ...shared,
  // the in-page suggestion's release gate (scripts/suggest-ui.mjs; AUTOFILL2 patch 4b): with it closed the file is patch 3's,
  // and its modules are not in the graph at all (scripts/suggest-guard.mjs); `__SUGGEST_DBG__`, the e2e build's record of
  // the suggestion's decisions for its tests, in that build only (check-dist)
  define: { ...define, __SUGGEST_DBG__: JSON.stringify(e2e && suggestUi) },
  plugins: [rulesDataGuard(), suggestGuard(suggestUi), rulesGuard(rulesUpdate, RULES_SRC)],
  root,
  publicDir: false,
  build: {
    ...buildCommon,
    outDir: dist,
    emptyOutDir: false,
    copyPublicDir: false,
    // (no `lib`: a library build of an IIFE needs a global name, and this file must leave none)
    rollupOptions: {
      input: resolve(root, "src/inject/suggest.ts"),
      output: { format: "iife", entryFileNames: "inject/suggest.js", codeSplitting: false },
    },
  },
});

const read = (f) => JSON.parse(readFileSync(resolve(root, f), "utf8"));
// The overlays are merged shallowly, so manifest.e2e.json restates its host permission key in full (its automated tests
// cannot answer Chrome's prompt: the key is the required one, and the overlay removes the optional key with null).
// Whatever the files say, the one key this flavour uses must hold TOTP autofill's per-site grants and nothing else, and
// the CSP must let nothing connect: the build stops otherwise. In prod and dev the key is exactly the optional
// https://*/* (one site at a time, asked in a click: src/platform/autofill-sites.ts); in e2e two fixture hosts granted
// up front (scripts/check-dist.mjs has their list). (The dev and e2e builds' host permission and CSP source for the
// server sync's API origin went with its client: OWNER-DECISIONS/25, DV-0b.)
const manifest = {
  ...read("manifest.base.json"),
  ...(dev ? read("manifest.dev.json") : {}),
  ...(e2e ? read("manifest.e2e.json") : {}),
};
for (const [k, v] of Object.entries(manifest)) if (v === null) delete manifest[k];
// the ID draft says what it is wherever the store or Chrome shows its name (check-dist holds each kind of prod build to
// its own name)
if (idDraft) manifest.name = `Sixkey (${ID_DRAFT_NAME})`;
// the test build's name and key (its overlay, read and checked before anything was built: testOverlay above)
if (testOverlay) Object.assign(manifest, testOverlay);
const [hostKey, otherKey] = e2e
  ? ["host_permissions", "optional_host_permissions"]
  : ["optional_host_permissions", "host_permissions"];
const hosts = JSON.stringify(manifest[hostKey]);
if (!e2e && hosts !== JSON.stringify(["https://*/*"])) {
  console.error(`build: the ${flavour} manifest's ${hostKey} are ${hosts}, not autofill's sites`);
  process.exit(1);
}
if (otherKey in manifest) {
  console.error(`build: the ${flavour} manifest must not have ${otherKey}`);
  process.exit(1);
}
// The CSP's connect-src names nothing ('none'; no build reaches Google: the backup in Chrome's sync storage makes no
// request, Chrome syncs it); check-dist holds every build to the same.
if (manifest.content_security_policy?.extension_pages !== cspOf()) {
  console.error(`build: the ${flavour} manifest's CSP does not allow exactly nothing to connect to`);
  process.exit(1);
}
// With the site rules' updater's gate open (AF3-U2), the CSP's connect-src also names the rules origin's one path, which the
// worker's updater reads (scripts/rules-update.mjs rulesPathOf), and nothing else; with it closed, the CSP is the files'.
if (rulesUpdate)
  manifest.content_security_policy = {
    ...manifest.content_security_policy,
    extension_pages: cspOf([rulesPathOf(RULES_ORIGINS[flavour])]),
  };
writeFileSync(resolve(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
cpSync(resolve(root, "_locales"), resolve(dist, "_locales"), { recursive: true });
// Every build carries the extension's licence and the third-party notices at its root (LICENSE.md): the licence text
// from the repository's LICENSES/, after one line naming the rules' licences (the plan's §4.1), and the notices generated
// from the installed packages and the bundle's upstream data (scripts/notices.mjs). check-dist requires both.
writeFileSync(resolve(dist, "LICENSE.txt"), licences.extension);
writeFileSync(resolve(dist, "THIRD-PARTY-NOTICES.txt"), extensionNoticesText());
// The site rules (checked above): the bundle, byte for byte, and its licence file; nothing else under rules/
mkdirSync(resolve(dist, "rules"), { recursive: true });
writeFileSync(resolve(dist, PACKAGED_BASELINE), baseline.text);
writeFileSync(resolve(dist, PACKAGED_LICENCE), licences.rules);
console.log(
  `built ${flavour}${testBuild ? " (the test build)" : ""} -> ${outArg !== -1 ? dist : e2e ? "dist-e2e/" : dev ? "dist-dev/" : idDraft ? "dist-id-draft/" : testBuild ? "dist-test/" : "dist/"}`,
);
