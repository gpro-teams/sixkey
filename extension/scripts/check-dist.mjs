// Fails the build when a built extension breaks a hard rule from the original plan (docs/history/PLAN-zh.md §8 / §9)
// and SYNC-DESIGN §7.
//   node scripts/check-dist.mjs          the prod build in dist/ (npm run build; npm run check)
//   node scripts/check-dist.mjs --e2e    the e2e build in dist-e2e/ (npm run build:e2e)
//   node scripts/check-dist.mjs --dev    a dev build in dist-dev/ (npm run build:dev)
//   node scripts/check-dist.mjs --id-draft  the prod build's ID draft in dist-id-draft/ (scripts/package.mjs --id-draft):
//                                        every prod rule, and its own name
//   node scripts/check-dist.mjs --test   the prod build for testing by hand in dist-test/ (npm run build:test): every
//                                        prod rule, and its own name, its own key (TEST_EXTENSION_ID) and no
//                                        install-source check; a test build never passes the prod check, nor the
//                                        store build this one
//   --dist <dir>                         check that directory instead (the tests check altered copies of a build)
// Every expected value below is written out here on purpose, not imported from the build's own configuration
// (scripts/csp.mjs, the manifests): this script is the second opinion on what the build produced.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { swAccessLevelOrder, swActionFirst } from "./sw-order.mjs";
import { STORE_ID } from "./store-id.mjs";
import { SUGGEST_UI_IN_STORE_BUILD, suggestUiIn } from "./suggest-ui.mjs";
import { RULES_ORIGINS, RULES_UPDATE_IN_STORE_BUILD, rulesUpdateIn, testRulesHosts } from "./rules-update.mjs";
import { pointOf, sameKey, STORE_RULES_KEYS, TEST_RULES_KEYS } from "./rules-keys.mjs";
import { RULES_UPDATER_GZ, swBudgetOf } from "./sw-budget.mjs";
import { pluginPageProblems, PLUGIN_TEXT_KINDS } from "./plugin-pages.mjs";
import { selectorsOf } from "./css-selectors.mjs";
import { DATA_NOTES } from "./notices-data.mjs";
import {
  BASELINE_SOURCE,
  checkedBaseline,
  dataProbes,
  e2eBaselineText,
  extensionLicenceText,
  LICENCE_LINE,
  normalised,
  PACKAGED_BASELINE,
  PACKAGED_LICENCE,
  RULES_DIR,
  rulesLicenceText,
} from "./rules-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flavour = args.includes("--e2e") ? "e2e" : args.includes("--dev") ? "dev" : "prod";
const prod = flavour === "prod";
// the ID draft (scripts/build.mjs --id-draft): a prod build, held to every prod rule, with its own name and catalog
const idDraft = args.includes("--id-draft");
if (idDraft && !prod) {
  console.error("check-dist: --id-draft is the prod build's ID draft; it takes neither --dev nor --e2e");
  process.exit(2);
}
// the test build (scripts/build.mjs --test): a prod build, held to every prod rule, with its own name and key, and the
// install-source check off; neither a dev, e2e nor ID draft build
const testBuild = args.includes("--test");
if (testBuild && (!prod || idDraft)) {
  console.error(
    "check-dist: --test is the prod build for testing by hand; it takes neither --dev, --e2e nor --id-draft",
  );
  process.exit(2);
}
const distArg = args.indexOf("--dist");
if (distArg !== -1 && !args[distArg + 1]) {
  console.error("check-dist: --dist needs a directory");
  process.exit(2);
}
const dist =
  distArg !== -1
    ? isAbsolute(args[distArg + 1])
      ? args[distArg + 1]
      : resolve(process.cwd(), args[distArg + 1])
    : resolve(
        root,
        flavour === "e2e"
          ? "dist-e2e"
          : flavour === "dev"
            ? "dist-dev"
            : idDraft
              ? "dist-id-draft"
              : testBuild
                ? "dist-test"
                : "dist",
      );
const BUDGET_GZ = 60 * 1024; // popup JS+CSS, gzipped. PLAN target is 200KB; this keeps regressions visible.
// The side panel (sidepanel/index.html; docs/design/notes/SIDEPANEL-NOTES.md), counted the same way: it draws the popup's
// screens, so it loads what the popup loads plus its own entry, stylesheet and the chunk it shares with the settings page.
// Its budget is the popup's plus 2 KB for that code of its own (1,471 B gzipped when it was introduced, the release gate
// open: the panel 61,291 B, the popup 59,820 B), so the panel's own code cannot grow unseen while the popup has room.
// Enforced in the build that ships, like the popup's.
const PANEL_BUDGET_GZ = BUDGET_GZ + 2 * 1024;
// The settings page's text, in parts (catalogs/settings-<part>-<lang>.json, scripts/messages.py, which holds the same
// numbers; docs/design/notes/BUDGET-NOTES.md): each part's catalog, gzipped, the larger language counted, so the growth of
// each part's text stays visible on its own. Each was set at its measured size plus at least 1.5 KB. Until the budget
// relief the page loaded its whole text as one catalog, held to FULL_CATALOG_GZ (the maintainer's setting: 10.1 KB when
// it was introduced, then 12 KB). It still holds, on the same measure: what the page loads together, each view's parts as
// one gzip stream (SETTINGS_VIEWS), and no part's budget is above it. The popup's budget counts only its own catalog.
const FULL_CATALOG_GZ = 12 * 1024;
const SETTINGS_CATALOG_GZ = {
  core: 5120,
  security: 5120,
  accounts: 3072,
  backup: 3072,
  misc: 3072,
  general: 3072,
  firstrun: 3072,
  unlock: 3072,
};
// The popup's View menu (src/popup/main/View.tsx; docs/design/notes/QUICKVIEW-NOTES.md) has its text in a catalog of its own,
// catalogs/view-<lang>.json (scripts/messages.py VIEW), gzipped, the larger language counted: it is loaded when the menu is
// first opened, by the popup and the side panel, so it is held apart from the budgets above (which count what a page
// loads up front) and to its own, set at its measured size plus at least 1.5 KB like the settings parts'.
const VIEW_CATALOG_GZ = 2048;
// What the settings page loads together: the core, then src/options/parts.tsx partsFor's parts (with no vault, the
// wizard's; with one, the sections and the lock's), and every part at once, the most one page can hold. Each is held, its
// chunks concatenated in this order (one gzip stream, per language), to FULL_CATALOG_GZ. scripts/messages.py holds the
// same lists (AGGREGATES; test/unit/budget-split.test.ts checks them against each other and against partsFor).
const SETTINGS_VIEWS = {
  "with no vault": ["core", "firstrun"],
  "with a vault": ["core", "security", "accounts", "backup", "misc", "general", "unlock"],
  "every part": ["core", "security", "accounts", "backup", "misc", "general", "firstrun", "unlock"],
};
// TOTP autofill, Stage 1 (TOTP-AUTOFILL §4.1, §6.4; docs/design/notes/AUTOFILL1-NOTES.md):
//   - the finder, inject/otp.js, gzipped (the design's target; 4,4 KB when it was introduced, 6,087 B at the end of Stage 2,
//     7,144 B with Stage 3's hint: the token kinds, the boost conditions and the every-box checks, AF3-2);
//   - the Fill button's text, catalogs/autofill-<lang>.json (scripts/messages.py), gzipped, the larger language: a lazy chunk
//     of its own (assets/autofill-locale-<lang>-*.js), never in the popup's counted bundle, never loaded by the settings page.
const ENGINE_BUDGET_GZ = 8 * 1024;
//   - the content script of TOTP autofill Stage 2, inject/suggest.js, gzipped (AUTOFILL2-PLAN §4.6: patch 4 adds the in-page
//     suggestion to it; patch 3's is detection only);
const SUGGEST_BUDGET_GZ = 6 * 1024;
const AUTOFILL_CATALOG_GZ = 4 * 1024;
// The Fill button's lazy chunk (assets/Fill-*.js), gzipped: loaded with the first account for the page, at every open of
// the popup or the side panel that has one, so its growth is held in view though no counted budget covers it. Since
// TOTP autofill Stage 3 (AF3-3b) it holds the site rules' reader and the format's checker: 9,710 B at AF3-3b. Since
// AF3-4 the reader is a chunk of its own, which the Fill chunk loads with it: the two are held to this together.
const FILL_CHUNK_GZ = 12 * 1024;
// The "same sign-in" chunk (assets/aliases-*.js, TOTP autofill Stage 3, AF3-4), gzipped: loaded after the first code on a
// page no account is registered for, so held in view too; the reader it loads is the Fill chunk's (above).
const ALIAS_CHUNK_GZ = 2 * 1024;
// Recovery code shares (docs/design/notes/SHAMIR-NOTES.md §6, §7): the share entry (assets/ShareEntry-*.js, the popup's,
// the side panel's and the settings page's), the settings page's wizard (assets/ShareWizard-*.js) and their text,
// catalogs/shares-<lang>.json (scripts/messages.py SHARES), gzipped, the larger language: lazy chunks only, never in any
// page's static graph (so in no page's counted bundle), the text with keys of no other catalog. Its budget is its
// measured size plus at least 1.5 KB, rounded up to 512 B, as the settings parts' (messages.py BUDGETS["shares"]).
const SHARES_CATALOG_GZ = 3072;
// What a vault's page holds with the shares' text in (its view's parts and the shares' catalog, as one gzip stream): the
// shares' catalog is outside FULL_CATALOG_GZ (lazy, as the popup's), and this holds the page with it to FULL_CATALOG_GZ +
// SHARES_CATALOG_GZ, the owner's decision of 2026-10-23 (SHAMIR-NOTES.md §6; messages.py SHARES_PAGE_LIMIT).
const SHARES_PAGE_GZ = 15 * 1024;
// The device unlock (Touch ID / Windows Hello, QUICK-UNLOCK Stage 2; docs/design/notes/PRF-NOTES.md): the lock screen's
// button (assets/DeviceUnlock-*.js: the popup's, the side panel's and the settings page's unlock bar), the settings page's
// box (assets/DeviceBox-*.js) and their text, catalogs/device-<lang>.json (scripts/messages.py DEVICE), gzipped, the larger
// language: lazy chunks only, never in a page's static graph, as the shares' are. Its budget is the maintainers' allowance
// of 2026-10-23: 1,500 B, 1,600 B since OWNER-DECISIONS/17's texts (messages.py BUDGETS["device"]; 1,487 B zh_CN when it
// was introduced). A vault's page with every lazy catalog in (the shares' and this one) is held to SHARES_PAGE_GZ too. WebAuthn itself (navigator.credentials) is in
// no page's static graph.
const DEVICE_CATALOG_GZ = 1600;
// The PIN's record (OWNER-DECISIONS/20 and its 2026-10-30 notes; docs/design/notes/PIN-RESTART-NOTES.md §8, §18): the lock
// screens' steps (the record's unlock and writes and the master password's note, with the crypto:
// assets/pin-restart-steps-*.js, loaded on first use by the popup's, the side panel's and the settings page's lock
// screens), the settings page's PIN box's lazy part (assets/PinRestartBox-*.js), and its text, catalogs/restart-<lang>.json
// (scripts/messages.py RESTART), gzipped, the larger language: lazy chunks only, never in a page's static graph. Its budget
// is its measured size plus at least 1.5 KB, rounded up to 512 B (messages.py BUDGETS); it is one of the lazy catalogs a
// vault's page holds with the autofill switch's (the check below holds that page to SHARES_PAGE_GZ), and the settings
// page's only.
const RESTART_CATALOG_GZ = 2048;
// The backup in Chrome's sync storage's text (scripts/messages.py CSB, src/ui/csb-text.ts): catalogs/csb-<lang>.json,
// gzipped, the larger language, lazy chunks only and the settings page's only, held to a budget of its own (messages.py
// BUDGETS["csb"]: its measured size plus at least 1.5 KB, rounded up to 512 B), and a vault's page with it in (and first
// run with it in) to SHARES_PAGE_GZ.
const CSB_CATALOG_GZ = 4096;
// Its popup's and side panel's (scripts/messages.py CSB_POPUP, src/ui/csb-popup-text.ts): the pill's, the footer's and
// the welcome's text, loaded with their lazy chunks, their own budget (messages.py BUDGETS["csb-popup"]), never the
// settings page's.
const CSB_POPUP_CATALOG_GZ = 2048;
// The site rules' updater's switch (TOTP autofill Stage 3, AF3-U2; scripts/messages.py RULES, src/options/RulesUpdate.tsx):
// its text, catalogs/rules-<lang>.json, gzipped, in a build whose updater's gate is open only, its own budget (messages.py
// BUDGETS["rules"]).
const RULES_CATALOG_GZ = 2048;
/** The wrap's AAD prefix (src/core/crypto/pin-restart-wrap.ts RESTART_TAG): only the record's lazy chunks carry it. */
const RESTART_TAG = "sixkey-pin-restart|1|";
// The autofill switch's text (Settings › Security › Autofill: the switch and its recent requests; the plugin platform's
// catalog until the platform was removed): catalogs/plugins-<lang>.json
// (scripts/messages.py PLUGINS), gzipped, the larger language: lazy chunks only, never in a page's static graph, keys of
// no other catalog; the budget it had (messages.py BUDGETS["plugins"]). What a vault's page holds with it and the shares'
// text in is held to SHARES_PAGE_GZ (messages.py PLUGINS_VIEW).
const PLUGINS_CATALOG_GZ = 3072;
// The defines of the removed plugin platform (__PLUGIN_CATALOG__, __PLUGIN_OWN_IDS__, __PLUGIN_TEST_ANSWERS__): no build
// defines them any more, so a shipped file that still names one would read a global at run time. None may.
const REMOVED_DEFINE = "__PLUGIN_";
// Chrome's management API, which no build holds the permission for: getSelf alone (the install-source check,
// src/platform/install-source.ts), which needs none. Nothing that reads, turns off, removes or launches another extension.
const MANAGEMENT_CALLS = new Set(["getSelf"]);
// What the finder's file may not contain, so it can do nothing but find boxes and type a code into them. Read as text of the
// built file (minified in prod and e2e builds): the chrome API (it has no use for any), the network, storage, messages,
// the clipboard, dynamic code, and anything that submits a form or presses a key. src/inject/otp.ts says why each is absent;
// test/unit/autofill1-source-rules.test.ts holds the source to the same list.
const ENGINE_FORBIDDEN = [
  /\bchrome\b/,
  /\bconsole\b/,
  /\bbrowser\b/,
  /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/,
  /\b(?:localStorage|sessionStorage|indexedDB|caches|cookie)\b/,
  /\b(?:postMessage|BroadcastChannel|MessageChannel|sendMessage|connect)\b/,
  /\b(?:eval|Function|setInterval)\b\s*\(/,
  /\bnew\s+Function\b/,
  /\.(?:submit|requestSubmit|click|writeText|readText|execCommand)\s*\(/,
  /\b(?:clipboard|KeyboardEvent|MouseEvent|PointerEvent)\b/,
  /(?:^|[\n;])\s*(?:import|export)\b/,
];
// What the content script may not contain (AUTOFILL2-PLAN §4.6, as built in patch 3: it notices a code box and sends one
// message, and draws nothing): storage, the network, the clipboard, dynamic code and timers that repeat, every other
// channel, any action on the page, any write to the page (an element, an attribute, a style, HTML, an event), and the
// console. Its only chrome API is runtime.sendMessage, checked apart below.
const SUGGEST_FORBIDDEN = [
  /\b(?:storage|localStorage|sessionStorage|indexedDB|caches|cookie)\b/,
  /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/,
  /\b(?:clipboard|execCommand)\b/,
  /\b(?:eval|Function|setInterval|setTimeout)\b\s*\(/,
  /\bnew\s+Function\b/,
  /\b(?:postMessage|BroadcastChannel|MessageChannel|connect)\b/,
  /\.(?:click|submit|requestSubmit|focus|blur)\s*\(|\bdispatchEvent\b/,
  /\b(?:innerHTML|outerHTML|insertAdjacentHTML|textContent|innerText|outerText)\b/,
  /\b(?:createElement|appendChild|insertBefore|replaceChild|attachShadow|setAttribute|removeAttribute|toggleAttribute|classList|dataset|style)\b/,
  /\b(?:console|alert|confirm|prompt)\b/,
  /\b(?:preventDefault|stopPropagation|stopImmediatePropagation)\b/,
  /(?:^|[\n;])\s*(?:import|export)\b/,
];
// The content script with the in-page suggestion's release gate open (AUTOFILL2 patch 4b, the patch 4 plan's §7 and S-6): it
// draws its suggestion, so it may make its own elements (in a closed shadow root it attaches to its own host), its
// stylesheets, its observers and its frames, and stop its own events; everything else of SUGGEST_FORBIDDEN still holds. No
// attribute is set (only IDL properties), no `style`, no `textContent`, no timer (its clock is timestamps and frames), no
// focus or click of anything, no storage or network. Its chrome APIs are runtime.sendMessage, twice (its two messages, exact)
// and i18n.getMessage; its one font is the generic `system-ui,sans-serif`. (Its one global, the e2e build's record of its
// decisions, `__skSugLog` in its own world, is held to that build below, in every flavour.)
const SUGGEST_FORBIDDEN_ON = [
  /\b(?:storage|localStorage|sessionStorage|indexedDB|caches|cookie)\b/,
  /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/,
  /\b(?:clipboard|execCommand)\b/,
  /\b(?:eval|Function|setInterval|setTimeout)\b\s*\(/,
  /\bnew\s+Function\b/,
  /\b(?:postMessage|BroadcastChannel|MessageChannel|connect)\b/,
  /\.(?:click|submit|requestSubmit|focus|blur)\s*\(|\bdispatchEvent\b/,
  /\b(?:innerHTML|outerHTML|insertAdjacentHTML|textContent|innerText|outerText)\b/,
  /\b(?:appendChild|insertBefore|replaceChild|setAttribute|removeAttribute|toggleAttribute|classList|dataset|style)\b/,
  /\b(?:console|alert|confirm|prompt)\b/,
  /(?:^|[\n;])\s*(?:import|export)\b/,
];
function checkSuggestion(text) {
  const rel = "inject/suggest.js";
  for (const re of SUGGEST_FORBIDDEN_ON) {
    const hit = re.exec(text)?.[0];
    if (hit !== undefined)
      fail(`${rel}: the content script may not contain ${re} (found ${JSON.stringify(hit.trim())})`);
  }
  const apis = [...new Set([...text.matchAll(/\bchrome\.[\w.]+/g)].map((x) => x[0]))].sort();
  if (apis.join() !== "chrome.i18n.getMessage,chrome.runtime.sendMessage")
    fail(`${rel}: its chrome APIs must be runtime.sendMessage and i18n.getMessage: ${JSON.stringify(apis)}`);
  // (the minifier may write a string with any quote)
  const sends = [...text.matchAll(/chrome\.runtime\.sendMessage\(([^)]*)\)/g)].map((x) =>
    x[1].replace(/\s/g, "").replace(/[`']/g, '"'),
  );
  if (sends.sort().join() !== `{type:"sk-af-cand"},{type:"sk-af-open"}`)
    fail(
      `${rel}: its two messages must be exactly {type: "sk-af-cand"} and {type: "sk-af-open"}: ${JSON.stringify(sends)}`,
    );
  // (a declaration's value ends at its `!important`, written in place or interpolated: `${...}`)
  const fonts = [...text.matchAll(/font(?:-family)?:([^;}!"`$]*)/g)].map((x) => x[1].trim());
  if (!fonts.length || fonts.some((f) => !/(?:^|\s)system-ui,sans-serif$/.test(f)))
    fail(
      `${rel}: its one font must be the generic system-ui,sans-serif (a page's @font-face may name any other): ${JSON.stringify(fonts)}`,
    );
}

// The site rules' baseline bundle, rules/baseline.json (TOTP autofill Stage 3, AF3-3a; scripts/rules-package.mjs),
// gzipped: today's is 3,716 B (131 alias groups, no site rule yet). The plan's §4.6 estimate, with room for the
// corpus to grow; the extension's reader refuses more than its own byte limit, which this holds the copy to as well.
const RULES_BUDGET_GZ = 64 * 1024;
// The site rules' reader's option for reserved host names, as the minifier folds the build's define into the call
// (src/platform/package-data.ts): on in the e2e build's Fill chunk, which reads that build's test rules, off elsewhere.
const RESERVED_ON = /\ballowReserved\s*:\s*!0\b/;
const RESERVED_OFF = /\ballowReserved\s*:\s*!1\b/;
// The release gate of TOTP autofill's in-page suggestion (scripts/suggest-ui.mjs): whether this flavour carries it.
// Imported rather than restated, as STORE_ID is: a second copy here would be a second switch to forget when it is flipped.
const SUGGEST_UI = suggestUiIn(flavour);
// The release gate of the site rules' updater (scripts/rules-update.mjs), imported for the same reason.
const RULES_UPDATE = rulesUpdateIn(flavour);
// The server sync's API (SYNC-DESIGN §5.2, §7): its public host and the local server the dev and e2e builds talked to.
// That sync's client is gone from the extension (OWNER-DECISIONS/25, DV-0b): no build names either in any shipped file,
// its manifest included (below), and no build reaches any API. The only request a build may make to a server is the site
// rules' updater's, with that gate open (RULES_PATH below).
const GONE_API = ["api.sixkey.app", "127.0.0.1:8787"];
// Exactly these permissions; the e2e build grants the optional clipboard pair up front so Playwright can use it.
// `sidePanel` (no install warning; Chrome 114+, open() 116+) came with the side panel mode (docs/design/notes/
// SIDEPANEL-NOTES.md; ux-study §2.1 and Q2, the owner's decision of 2026-10-16): the one permission added since Phase 0.x
// and SYNC-DESIGN §7's "no new permission", which SYNC-DESIGN §9.1's cross-reference limits to the sync milestones. It is
// required, not optional: the worker opens the panel in the click itself, and an optional permission's prompt would need a
// user action of its own. Any other change to this list still fails (test/unit/sidepanel-check-dist.test.ts).
//
// `scripting` (no install warning) came with TOTP autofill, Stage 1 (docs/design/notes/AUTOFILL1-NOTES.md; TOTP-AUTOFILL §2,
// §12.4): the Fill button and the `fill` shortcut inject src/inject/otp.js into the tab the user is on, with activeTab and
// only on the user's action. Since wave 1b of the plugin platform (MOD-PLATFORM §7.2 Option I item 3; PLUGINS-W1B-NOTES.md)
// it is OPTIONAL in every build: the first Fill click asks for it (Chrome grants it without a dialog), turning a site on
// asks for it with the site, and turning autofill off in Settings gives it back. It is never a host permission: the
// manifest has no host access at install and no `content_scripts` (MANIFEST_KEYS below).
const PERMISSIONS = [
  "storage",
  "unlimitedStorage",
  "activeTab",
  "alarms",
  "idle",
  "offscreen",
  "sidePanel",
  ...(flavour === "e2e" ? ["clipboardRead", "clipboardWrite"] : []),
];
// Optional permissions the user may grant later: its own allow-list, kept apart from the rules above (a later feature
// that needs one, such as the YubiKey design's native messaging, adds it here deliberately).
// `scripting`: autofill's, optional since wave 1b (above); every build must offer it, or autofill could never run.
// `nativeMessaging`: the link with Sixkey for Mac (platform/mac-link.ts), asked only in the click that turns it on.
// Never `identity` (no build signs in to Google or anything else; the identity rule below says so by name), and never
// `management` since the plugin platform was removed (it was asked for plugins only; MANAGEMENT_CALLS above).
const OPTIONAL_ALLOWED = ["clipboardRead", "clipboardWrite", "scripting", "nativeMessaging"];
// The Google Drive backup through a separate plugin is gone (unwired in every build since CSB-3, its code removed since):
// no build, the developer build included, names Google's API and OAuth endpoints or Drive (what that path called: Drive's
// v3 API and its uploads, the token, its revocation and the scopes, all under googleapis.com; the sign-in window's
// authorisation endpoint; Drive itself), or carries a mark of that path (its fake Drive, its developer page and that
// page's message, its messages and alarms, all "sk-cloud-…", its records and its token). Sixkey makes no request to
// Google: the backup in Chrome's sync storage is carried by Chrome. Each is looked for in every shipped text file. These
// are endpoints and the path's own names, not words: a line of text naming Google or its Drive, or a site rule for
// Google's sign-in page (accounts.google.com, where its 2-step codes are typed), is not one. The manifest's exact CSP and
// permissions, below, hold the rest: no Google origin, no `identity`, no `oauth2` key.
const DRIVE_MARKS = [
  "googleapis.com",
  "accounts.google.com/o/oauth2",
  "drive.google.com",
  "sixkey-fake-drive",
  "sixkey-dev-cloud",
  "sk-devcloud",
  "devcloud/",
  "sk-cloud-",
  "sk_cloud_cfg",
  "sk_cloud_state",
  "sk_cloud_token",
];
// The host permissions, exactly, in exactly one key; the other key must not exist. (The server sync's API origin was one,
// in the dev and e2e builds, until its client went: OWNER-DECISIONS/25, DV-0b.)
//   - TOTP autofill's per-site grants (AUTOFILL2-PLAN §3.1, §3.6; docs/design/notes/AUTOFILL2-NOTES.md §7): prod and dev
//     declare https://*/* as OPTIONAL, which grants nothing at install and warns of nothing; Sixkey asks for one site at
//     a time, exactly https://<host>/*, in the click that turns that site on (src/platform/autofill-sites.ts). Nothing
//     broader may be declared: no http, no <all_urls>, no *://*/*, and nothing required.
//   - The e2e build cannot answer that prompt either, so it grants two fixture hosts of its own up front, and only those:
//     the Stage 1 fixture hosts (app.fix.test, auth.fix.test, tls.fix.test, evil.test, ...) stay ungranted, as the
//     Stage 1 specs need (a frame activeTab cannot reach must stay out of reach).
const HOST_KEY = flavour === "e2e" ? "host_permissions" : "optional_host_permissions";
const SITES_PATTERN = "https://*/*";
const E2E_GRANTED = ["https://grantedtls.fix.test/*", "http://granted.fix.test/*"];
const HOSTS = flavour === "e2e" ? E2E_GRANTED : [SITES_PATTERN];
// The manifest's top-level keys, exactly. Anything else (content_scripts, externally_connectable, the other host
// permission key, web_accessible_resources, sandbox, ...) fails. externally_connectable went with the plugin platform:
// with no listener of another extension's messages or ports in any build (the rule below), no other extension and no
// web page can reach Sixkey.
const MANIFEST_KEYS = [
  "manifest_version",
  "name",
  "description",
  "version",
  "default_locale",
  "minimum_chrome_version",
  "icons",
  "action",
  "commands",
  "options_page",
  "background",
  HOST_KEY,
  "permissions",
  "content_security_policy",
  "optional_permissions",
  // a fixed ID: the dev build's and the test build's (below); never the store build's, nor an ID draft's
  ...(flavour === "dev" || testBuild ? ["key"] : []),
];
// The dev build's fixed extension ID (QUICK-UNLOCK §0A.1 item 5, §8 "Release-order constraints"; docs/design/notes/
// PRF-NOTES.md): manifest.dev.json carries the public key whose SHA-256 gives this ID (only the public half; the private
// key was not kept: an unpacked copy needs none), so a developer's passkeys, which are bound to chrome-extension://<id>,
// survive reinstalls and moved folders. The dev build only: the store's ID is the store's (OWNER-DECISIONS/11), and the
// e2e build's does not matter to the virtual authenticator.
const DEV_EXTENSION_ID = "pgnlbjikdnniepfeijffpefifnojjege";
// The test build's fixed extension ID (scripts/build.mjs --test): manifest.test.json carries the public key whose SHA-256
// gives it (only the public half; the private key was never kept). The owner's copies on two computers have the same ID,
// so Chrome sync, which keys an extension's data by its ID, carries the backup in Chrome sync between them. It is
// neither the dev build's (both can sit in one profile) nor the store's (STORE_ID: a test build never takes the place
// of the store's item).
const TEST_EXTENSION_ID = "copndbnmkakfiohikpecmdaoldodaojc";
/** An extension's ID from its manifest key: SHA-256 of the key's bytes, the first 32 hex digits written with a to p. */
const idOfKey = (key) =>
  [
    ...createHash("sha256")
      .update(Buffer.from(String(key), "base64"))
      .digest("hex")
      .slice(0, 32),
  ]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");
// The keyboard shortcuts (a manifest key that needs no permission), exactly: Alt+Shift+K opens the popup, Alt+Shift+L
// locks Sixkey from the service worker (QUICK-UNLOCK §5.12 item 2), and Alt+Shift+F fills the code of the one account
// registered for the tab's site (TOTP-AUTOFILL §2.4; src/background/fill-command.ts). None may be "global" (a shortcut that works while
// Chrome is not in front), and no other command may appear without this list changing on purpose. Compared with the
// keys in any order.
const COMMANDS = {
  _execute_action: { suggested_key: { default: "Alt+Shift+K" } },
  lock: { suggested_key: { default: "Alt+Shift+L" }, description: "__MSG_cmdLock__" },
  fill: { suggested_key: { default: "Alt+Shift+F" }, description: "__MSG_cmdFill__" },
};
// The policy that makes "connect nowhere" a property the browser enforces, not just a habit of the code. It applies to
// the extension's pages and to its service worker. With the site rules' updater's gate open (AF3-U2), connect-src names
// the rules origin's one path the worker reads (/v1/: the manifest and the bundles), and nothing more of it (each page
// narrows it to nothing with its own policy, below); with the gate closed, as in the store build, connect-src 'none'.
// (The server sync's API origin was the other source, in the dev and e2e builds, until its client went: DV-0b.)
const RULES_PATH = RULES_UPDATE ? `${RULES_ORIGINS[flavour]}/v1/` : null;
const CONNECT = RULES_PATH ? [RULES_PATH] : [];
const EXPECTED_CSP = `script-src 'self'; object-src 'self'; default-src 'self'; connect-src ${CONNECT.length ? CONNECT.join(" ") : "'none'"}; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
const DEV_MARKERS = ["localhost", "127.0.0.1", "auth.g.pro", "(dev)", "__skFill", "__skRules"];
// The site rules' format (src/core/rules/format.ts RESERVED_TLDS; in the Fill chunk since TOTP autofill Stage 3, AF3-3b)
// names "localhost" in its list of the reserved names a rule's host may not be under. That list, exactly as the minifier
// writes it (on one line in a page's chunk; one name a line in the worker, which the site rules' updater's checks put it
// in: AF3-U2), is the one place a prod script may hold the word: it is taken out of the text before the dev markers are
// looked for, and any other "localhost", in the same chunk too, is still one.
const RESERVED_NAMES_LIST = /\[\s*([`'"])test\1\s*,\s*\1example\1\s*,\s*\1invalid\1\s*,\s*\1localhost\1\s*\]/g;
// The developer sync page (src/devsync/, gone from every build: OWNER-DECISIONS/25). Its marker was in its HTML and its
// script.
const DEV_SYNC_MARKER = "sixkey-dev-sync";
// No build carries the Sync section or the developer sync page, nor the enrolment code they drove, so nothing a user of
// any build can reach turns sync on. These string literals are that enrolment's own domain tags and key label (its
// enroll-labels.ts, which went with the rest of the server sync's client, DV-0b): names no other code uses (the device
// groups' join has labels of its own), which survive minification. No source holds them now
// (test/unit/m5-source-rules.test.ts); scripts/build.mjs checks the bundler's module graph as well.
const ENROLMENT_FINGERPRINTS = ["sixkey-enroll|2|", "sixkey-enroll-commit|2|", "sixkey/v2/enroll-key"];
// The names of what the server sync's client left in a profile (src/platform/server-sync-leftovers.ts): its records in
// chrome.storage.local, its identity's database and its alarms. Only the dev and e2e builds' worker names them, to
// remove them once; the store and test builds compile that out (the define __SYNC_DEV__), so none of their files holds
// one.
const SERVER_SYNC_RECORDS = ["sk_sync_", "sk_prejoin", "sixkey-identity", "sk-sync-"];
// The server sync's toolbar badge: its title's text key (the worker read it with chrome.i18n; its badge text was a count),
// in no shipped file of any build, _locales included. The badge's module (platform/badge.ts) may draw another badge.
const SYNC_BADGE_KEYS = ["syncBadgeTitle"];
// http(s) URLs a shipped script may contain (besides the site rules' origin in the worker, with the updater's gate open):
// namespace names (not fetched), the hostname normaliser's template http://${host}/ (src/core/site-domains.ts: parsed
// with new URL, never fetched), and the one permission pattern of an autofill site, https://${host}/*
// (src/core/autofill-sites.ts sitePattern: asked of chrome.permissions, never fetched; the CSP's connect-src allows
// none of these).
const URL_ALLOWED = [
  /^http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xhtml|1999\/xlink|1998\/Math\/MathML)$/,
  /^http:\/\/\$\{[A-Za-z_$][\w$]*\}\/$/,
  /^https:\/\/\$\{[A-Za-z_$][\w$]*\}\/\*$/,
];
// The extension's licence and the third-party notices (LICENSE.md): plain text at the root of every build, by exactly
// these names, and the site rules' licence beside their bundle (rules/LICENSE.txt, AF3-3a); a .txt anywhere else is a
// kind of file a build does not ship. The notices must keep what the shipped data requires (THIRD-PARTY-NOTICES.md,
// "Data with terms of its own"): the OpenSubtitles notice of @zxcvbn-ts/language-en, the EFF word list's attribution,
// the fonts' licence text; and the notice of every upstream source the rules' bundle takes data from (below).
const NOTICE_FILES = ["LICENSE.txt", "THIRD-PARTY-NOTICES.txt", PACKAGED_LICENCE];
const NOTICE_MARKERS = [
  "Any redistribution of this package must retain this notice.",
  "Creative Commons Attribution 3.0 United States (CC BY 3.0 US)",
  "SIL OPEN FONT LICENSE Version 1.1",
];

const errors = [];
const fail = (m) => errors.push(m);
const read = (p) => readFileSync(resolve(dist, p), "utf8");

if (!existsSync(dist)) {
  console.error(`${dist} missing; run the ${flavour} build first`);
  process.exit(1);
}

const manifestText = read("manifest.json");
const m = JSON.parse(manifestText);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (x) => (Array.isArray(x) ? [...x].sort() : x);
/** JSON with every object's keys in order, so two values compare equal whatever order their keys were written in. */
const canonical = (x) =>
  JSON.stringify(x, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );

// manifest
if (m.manifest_version !== 3) fail("manifest_version must be 3");
for (const k of Object.keys(m)) if (!MANIFEST_KEYS.includes(k)) fail(`manifest key not allowed: ${k}`);
for (const k of MANIFEST_KEYS) if (!(k in m)) fail(`manifest key missing: ${k}`);
// The name: a store package's is the catalog's, an ID draft's says what it is (the review's N-1), and neither is the other
// (a draft can never pass as the store package, nor the store package as a draft). Dev and e2e builds have their own.
// A test build's says what it is too ("Sixkey (test)"), and is neither of the other two, nor they it.
const PROD_NAME = idDraft ? "Sixkey (ID draft, do not publish)" : testBuild ? "Sixkey (test)" : "__MSG_appName__";
if (prod && m.name !== PROD_NAME)
  fail(
    `the ${idDraft ? "ID draft's" : testBuild ? "test build's" : "store build's"} manifest name is ${JSON.stringify(m.name)}`,
  );
if (flavour === "dev" && "key" in m && idOfKey(m.key) !== DEV_EXTENSION_ID)
  fail(`the dev build's manifest key gives the ID ${idOfKey(m.key)}, not ${DEV_EXTENSION_ID}`);
if (testBuild && "key" in m && idOfKey(m.key) !== TEST_EXTENSION_ID)
  fail(`the test build's manifest key gives the ID ${idOfKey(m.key)}, not ${TEST_EXTENSION_ID}`);
if (!same(sorted(m.permissions), sorted(PERMISSIONS)))
  fail(`permissions must be exactly ${PERMISSIONS.join(", ")}: ${JSON.stringify(m.permissions)}`);
for (const p of m.optional_permissions ?? [])
  if (!OPTIONAL_ALLOWED.includes(p)) fail(`optional permission not allowed: ${p}`);
if (!same(m[HOST_KEY], HOSTS))
  fail(`${HOST_KEY} must be exactly ${JSON.stringify(HOSTS)}: ${JSON.stringify(m[HOST_KEY])}`);
for (const k of ["host_permissions", "optional_host_permissions"])
  if (k !== HOST_KEY && k in m) fail(`the ${flavour} build must not have ${k}: ${JSON.stringify(m[k])}`);
// externally_connectable is not a key a build may have (MANIFEST_KEYS), said by name: without it, Chrome would let every
// extension message Sixkey, so no build may also listen (the rule on onMessageExternal and onConnectExternal below).
if ("externally_connectable" in m) fail(`externally_connectable must not be in a build's manifest (${flavour})`);
if (canonical(m.commands) !== canonical(COMMANDS))
  fail(`commands must be exactly ${JSON.stringify(COMMANDS)}: ${JSON.stringify(m.commands)}`);
if (!same(m.background, { service_worker: "sw.js", type: "module" }))
  fail(`background must be exactly the module service worker sw.js: ${JSON.stringify(m.background)}`);
const csp = m.content_security_policy?.extension_pages ?? "";
if (csp !== EXPECTED_CSP) fail(`unexpected extension_pages CSP: ${csp}`);
if (!same(Object.keys(m.content_security_policy ?? {}), ["extension_pages"]))
  fail("content_security_policy must hold extension_pages only");
const scriptSrc = /(?:^|;)\s*script-src([^;]*)/.exec(csp)?.[1] ?? "";
if (/wasm-unsafe-eval|unsafe-eval|unsafe-inline/.test(scriptSrc)) fail("CSP weakens script-src");
if (prod) for (const d of DEV_MARKERS) if (manifestText.includes(d)) fail(`dev marker in manifest: ${d}`);
// Chrome 140 or later (OWNER-DECISIONS/14 OQ1 (a), folded into wave 1b): the first version where storage.local can be
// closed to content scripts (storage-access.ts, STORAGEGATE), which autofill needs. STORAGEGATE stays as a second layer.
if (!(Number(m.minimum_chrome_version) >= 140)) fail("minimum_chrome_version must be >= 140");
if (!(m.optional_permissions ?? []).includes("scripting")) fail("scripting must be an optional permission (autofill)");
for (const k of ["permissions", "optional_permissions"])
  if ((m[k] ?? []).includes("identity"))
    fail(`identity must never be in a build's ${k}: no build signs in to Google (${flavour})`);
if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(m.version ?? "")) fail(`manifest version is not a Chrome version: ${m.version}`);

// referenced files exist
const refs = [
  m.background?.service_worker,
  m.action?.default_popup,
  m.options_page,
  ...Object.values(m.icons ?? {}),
  ...Object.values(m.action?.default_icon ?? {}),
].filter(Boolean);
for (const f of refs) if (!existsSync(resolve(dist, f))) fail(`manifest references missing file: ${f}`);
// and the side panel's page, which the worker names rather than the manifest (src/platform/action-mode.ts PANEL_PATH)
if (!existsSync(resolve(dist, "sidepanel/index.html")))
  fail("sidepanel/index.html missing: the worker opens it as the side panel's page");

// locales: every __MSG_x__ resolves in the default locale
const msgsOf = (loc) => JSON.parse(read(`_locales/${loc}/messages.json`));
const msgs = msgsOf(m.default_locale);
for (const [, key] of manifestText.matchAll(/__MSG_(\w+)__/g)) if (!msgs[key]) fail(`missing message: ${key}`);
for (const loc of readdirSync(resolve(dist, "_locales"))) {
  const other = JSON.parse(read(`_locales/${loc}/messages.json`));
  for (const key of Object.keys(msgs)) if (!other[key]) fail(`locale ${loc} missing key ${key}`);
}
// (and every key a shipped script passes to chrome.i18n.getMessage has text in every locale: below, with the scripts)

// service worker: single file, no static or dynamic imports
const sw = read(m.background.service_worker);
if (/\bimport\s*\(/.test(sw)) fail("service worker contains dynamic import()");
if (/^\s*import\s/m.test(sw) || /^\s*export\s+\*?\s*from/m.test(sw))
  fail("service worker has static imports; it must be one self-contained file");
// and in the BUILT file its first three calls are the storage access level of local, session and sync (the backup in
// Chrome's sync storage: CSB-3, the maintainers' C7), ahead of every listener and every storage access (TOTP-AUTOFILL
// §4.2; scripts/sw-order.mjs runs the top level over a stand-in)
{
  const order = swAccessLevelOrder(sw);
  if (!order.ok) fail(`service worker: ${order.reason}`);
  // then what the toolbar icon opens, the popup or the side panel, set before anything else of the worker's
  const action = swActionFirst(sw);
  if (order.ok && !action.ok) fail(`service worker: ${action.reason}`);
}

// Every shipped file, by kind. A build holds only these kinds; anything else fails, so no script, page or style can hide
// under another extension (an .mjs module runs in a page as well as a .js one). Text kinds are read and checked below;
// binary ones (icons, fonts) only by their names.
const TEXT_KINDS = /\.(?:js|mjs|cjs|css|html|htm|json)$/i;
const BINARY_KINDS = flavour === "dev" ? /\.(?:png|woff2|map)$/i : /\.(?:png|woff2)$/i; // a dev build has source maps
const shipped = [];
(function walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const rel = p
      .slice(dist.length + 1)
      .split("\\")
      .join("/");
    if (statSync(p).isDirectory()) walk(p);
    else if (TEXT_KINDS.test(n) || NOTICE_FILES.includes(rel)) shipped.push({ rel, text: readFileSync(p, "utf8") });
    else if (!BINARY_KINDS.test(n)) fail(`${rel}: a kind of file a build does not ship`);
  }
})(dist);
// licence and notices: the licence is the line naming the rules' licences and then exactly the repository's MPL-2.0
// text; the notices name every runtime dependency of package.json at its pinned version, keep every marker above, give
// every data file with an attribution in notices-data.mjs that attribution and its licence's URI, and carry the licence
// text of every upstream source of the rules' bundle as rules/upstream/SOURCES.json pins it
{
  const licence = shipped.find((f) => f.rel === "LICENSE.txt");
  if (!licence) fail("LICENSE.txt (the extension's licence) missing from the build");
  else if (
    !licence.text.startsWith(`${LICENCE_LINE}\n\n`) ||
    !licence.text
      .slice(LICENCE_LINE.length + 2)
      .trimStart()
      .startsWith("Mozilla Public License Version 2.0") ||
    licence.text !== extensionLicenceText()
  )
    fail("LICENSE.txt is not the rules' line and then the repository's LICENSES/MPL-2.0.txt");
  const notices = shipped.find((f) => f.rel === "THIRD-PARTY-NOTICES.txt");
  if (!notices) fail("THIRD-PARTY-NOTICES.txt (the third-party notices) missing from the build");
  else {
    const deps = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).dependencies ?? {};
    for (const [name, version] of Object.entries(deps))
      if (!notices.text.includes(`\n  ${name} ${version}: `))
        fail(`THIRD-PARTY-NOTICES.txt does not list ${name} ${version}`);
    for (const k of NOTICE_MARKERS) if (!notices.text.includes(k)) fail(`THIRD-PARTY-NOTICES.txt lacks: ${k}`);
    const flat = (t) => t.replace(/\s+/g, " ").trim();
    for (const [name, notes] of Object.entries(DATA_NOTES))
      for (const d of notes.filter((x) => x.attribution)) {
        if (!d.licenceUrl || !notices.text.includes(d.licenceUrl))
          fail(`THIRD-PARTY-NOTICES.txt lacks the licence URI of ${name} ${d.file}: ${d.licenceUrl}`);
        if (!flat(notices.text).includes(flat(d.attribution)))
          fail(`THIRD-PARTY-NOTICES.txt lacks the attribution of ${name} ${d.file}`);
      }
    const bundle = shipped.find((f) => f.rel === PACKAGED_BASELINE);
    let upstream = [];
    try {
      const u = JSON.parse(bundle?.text ?? "{}")?.upstream;
      if (Array.isArray(u)) upstream = u;
    } catch {
      // not JSON: the site rules' own check below says so
    }
    if (upstream.length) {
      const pins = JSON.parse(readFileSync(resolve(RULES_DIR, "upstream/SOURCES.json"), "utf8")).files;
      for (const u of upstream) {
        const source = pins.find((p) => p.id === u.id)?.source;
        const licenceFile = pins.find((p) => p.source === source && p.use === "licence");
        if (!licenceFile)
          fail(`${PACKAGED_BASELINE}: upstream ${u.id} has no pinned licence (rules/upstream/SOURCES.json)`);
        else if (
          !flat(notices.text).includes(flat(readFileSync(resolve(RULES_DIR, "upstream", licenceFile.vendored), "utf8")))
        )
          fail(
            `THIRD-PARTY-NOTICES.txt lacks the notice of the rules' upstream data ${u.id} (${licenceFile.vendored})`,
          );
      }
    }
  }
}
const scripts = shipped.filter((f) => /\.(?:js|mjs|cjs)$/i.test(f.rel));
/** The local scripts a page's HTML names, as absolute paths. */
function htmlScripts(page) {
  const html = resolve(dist, page);
  if (!existsSync(html)) return [];
  return [...readFileSync(html, "utf8").matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.js)"/g)]
    .map((x) => x[1])
    .filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u))
    .map((u) => resolve(dirname(html), u));
}
/**
 * `from` (absolute paths of scripts) and every script they import statically, file by file: what loads with them. An
 * import() is not followed (what it loads comes later, on use).
 */
function staticImports(from) {
  const seen = new Set();
  const todo = [...from];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    const text = readFileSync(f, "utf8");
    for (const [, u] of text.matchAll(
      /\b(?:import|export)\s*(?:[\w$*{][^"';]*?\s*from\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g,
    ))
      todo.push(resolve(dirname(f), u));
  }
  return seen;
}
// Chrome's own use of _locales besides the manifest: the service worker's words (chrome.i18n.getMessage: the fill
// shortcut's toolbar title, src/background/fill-command.ts)
for (const f of scripts)
  for (const [, key] of f.text.matchAll(/\bgetMessage\(\s*["'`]([A-Za-z0-9_]+)["'`]/g))
    for (const loc of readdirSync(resolve(dist, "_locales")))
      if (!msgsOf(loc)[key]) fail(`${f.rel}: chrome.i18n.getMessage("${key}") has no text in _locales/${loc}`);
const pages = shipped.filter((f) => /\.html?$/i.test(f.rel));
const swRel = m.background?.service_worker;

// html pages: no inline script, no inline handlers, no remote resources, no self-navigation. An attribute value is read
// quoted or not; one with a scheme, or protocol-relative (//host/...), is remote.
for (const { rel, text: h } of pages) {
  for (const [, attrs, body] of h.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=/i.test(attrs) || body.trim()) fail(`${rel}: inline <script>`);
  }
  if (/\son[a-z]+\s*=/i.test(h)) fail(`${rel}: inline event handler`);
  for (const [, , dq, sq, bare] of h.matchAll(
    /\b(src|href|srcset|action|formaction|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
  )) {
    const v = (dq ?? sq ?? bare ?? "").trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith("//") || v.startsWith("\\\\"))
      fail(`${rel}: remote resource: ${v}`);
  }
  if (/http-equiv\s*=\s*["']?\s*refresh/i.test(h)) fail(`${rel}: a meta refresh (the page would navigate itself)`);
}

// Every page carries its own connect-src 'none' ahead of everything else: a second policy, which the browser enforces
// together with the manifest's, so no page reaches any host: the worker is the one context the manifest's connect-src
// lets reach anything (the site rules' updater's one path, with that gate open). The policy's place is pinned,
// not searched for: the document starts with the doctype, <html>, <head>, <meta charset="utf-8"> and then exactly this
// <meta>, with only whitespace between them. Text that only looks like the policy is no policy: inside <noscript> (raw
// text while scripts run), <template> (inert) or <title> (text), or after a "--!>" comment end, it would pass a search
// and not be in force; none of those may appear in a page at all.
const PAGE_CSP = `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`;
const PAGE_START = /^\s*<!doctype html>\s*<html(?:\s[^>]*)?>\s*<head>\s*<meta charset="utf-8">\s*/i;
for (const { rel, text: h } of pages) {
  const start = PAGE_START.exec(h);
  if (!start || !h.startsWith(PAGE_CSP, start[0].length))
    fail(`${rel}: no page-level connect-src 'none' right after <meta charset="utf-8"> at the start of <head>`);
  if (/<noscript\b|<template\b|--!>/i.test(h)) fail(`${rel}: <noscript>, <template> or a "--!>" comment end in a page`);
}

// theme (PHASE0X-PLAN C4): the popup, the side panel and the settings page declare both colour schemes, so the browser's canvas
// matches the system before any stylesheet applies, and set the chosen theme before anything is drawn. That is
// theme-boot.js, copied from public/: a plain classic script (not a module, not deferred or async, so it runs as the
// parser reaches it), after the meta it rewrites and ahead of every stylesheet and module script.
if (!existsSync(resolve(dist, "theme-boot.js"))) fail("theme-boot.js missing from the build");
for (const page of ["popup/index.html", "sidepanel/index.html", "options/index.html"]) {
  if (!existsSync(resolve(dist, page))) continue; // a missing page has failed above
  const h = read(page);
  const meta = h.search(/<meta\s+name="color-scheme"\s+content="light dark"\s*\/?>/);
  const boot = h.search(/<script\s+src="\.\.\/theme-boot\.js"\s*><\/script>/);
  const later = [/<link\b[^>]*\brel="stylesheet"/, /<script\b[^>]*\btype="module"/]
    .map((re) => h.search(re))
    .filter((i) => i !== -1);
  if (meta === -1) fail(`${page}: missing <meta name="color-scheme" content="light dark">`);
  if (boot === -1) fail(`${page}: theme-boot.js is not loaded as a plain <script src>`);
  else if (meta > boot || later.some((i) => i < boot))
    fail(`${page}: theme-boot.js must come after the color-scheme meta and before every stylesheet and module script`);
}

// stylesheets: nothing may be fetched from the network (fonts are bundled)
for (const f of shipped.filter((x) => x.rel.endsWith(".css"))) {
  if (/@import/i.test(f.text)) fail(`${f.rel}: @import in CSS`);
  if (/url\(\s*["']?(https?:)?\/\//i.test(f.text)) fail(`${f.rel}: remote url() in CSS`);
}

// scripts: the network (SYNC-DESIGN §4.9, §7). The CSP already blocks every host but the site rules' updater's one path
// (with that gate open); these tripwires keep the code itself to that one way out, so a dependency that starts using
// another before it ships fails here:
//   - no XMLHttpRequest, WebSocket, EventSource, sendBeacon, WebTransport, RTCPeerConnection or importScripts anywhere;
//   - `fetch` in the service worker only for the site rules' updater (below), never for anything else: the server sync's
//     transport (src/platform/fetch-transport.ts), the dev and e2e builds' other fetch, went with its client (DV-0b);
//     besides, the read of the extension's own package file (TOTP autofill Stage 3, AF3-3b; src/platform/package-data.ts:
//     fetch(chrome.runtime.getURL(...)) of the site rules' path, no network), once, in the Fill paths' lazy chunk, and
//     nowhere else: not in the worker, whose shortcut takes no rule yet (the maintainers' C27); and with the site rules'
//     updater's gate open (AF3-U2; src/platform/rules-live.ts), its one read of the rules origin, in the worker. Counted
//     on the text without the bundler's region marks (`//#region src/platform/rules-fetch.ts` names a file, not a call);
//   - every http(s) or ws(s) URL in a script is the site rules' origin in the worker (with the updater's gate open), or one
//     of the few names in URL_ALLOWED.
// The last two read the scripts as text, which holds only for minified ones: a dev build keeps every comment (they name
// URLs and the word fetch), so it skips them. The prod and e2e builds, minified from the same sources, are checked.
const packageReaders = [];
for (const f of scripts) {
  if (/\b(XMLHttpRequest|WebSocket|EventSource|sendBeacon|WebTransport|RTCPeerConnection|importScripts)\b/.test(f.text))
    fail(`${f.rel}: network primitive in shipped code`);
  // Other extensions and web pages could message this one only through these listeners. The plugin platform, their one
  // user, was removed, and so was the manifest's externally_connectable: without it Chrome lets every extension try, so
  // no shipped file may listen, the worker included. (Native messaging, runtime.connectNative to a program on this
  // computer, is not one of them: this rule does not look at it.)
  if (/\bon(?:MessageExternal|ConnectExternal)\b/.test(f.text))
    fail(`${f.rel}: a listener for other extensions' messages or ports (onMessageExternal, onConnectExternal)`);
  // no define of the removed plugin platform (REMOVED_DEFINE above)
  if (f.text.includes(REMOVED_DEFINE)) fail(`${f.rel}: a define of the removed plugin platform (${REMOVED_DEFINE}…)`);
  // Chrome's management API: only the calls MANAGEMENT_CALLS names (never getAll, nothing that reads or changes another
  // extension)
  for (const [, call] of f.text.matchAll(/\bmanagement\??\.([A-Za-z_$][\w$]*)/g))
    if (!MANAGEMENT_CALLS.has(call))
      fail(`${f.rel}: chrome.management.${call} (only ${[...MANAGEMENT_CALLS].join(", ")})`);
  // The side panel opens from the worker's click handler, which grants activeTab for the clicked tab; the side panel
  // API's own "open on action click" behaviour does not, and "this site" and the page scan would stop working in the
  // panel (ux-study E2; src/platform/action-mode.ts). No shipped file, comments included, names it.
  if (/\b(?:openPanelOnActionClick|setPanelBehavior)\b/.test(f.text))
    fail(`${f.rel}: the side panel's open-on-click behaviour (it loses activeTab); the worker opens the panel itself`);
  if (flavour === "dev") continue;
  // the package file's read (AF3-3b): one fetch of chrome.runtime.getURL(...), in a script that names the site rules' path
  const own = f.text.match(/\bfetch\(chrome\.runtime\.getURL\(/g)?.length ?? 0;
  const ownRead = own === 1 && new RegExp(`["'\`]${PACKAGED_BASELINE}["'\`]`).test(f.text);
  if (own > 0 && !ownRead)
    fail(
      `${f.rel}: a fetch of a package file that is not the one read of ${PACKAGED_BASELINE} (src/platform/package-data.ts)`,
    );
  if (ownRead) packageReaders.push(f.rel);
  const fetches = f.text.replace(/^\/\/#(?:end)?region\b.*$/gm, "").match(/\bfetch\b/g)?.length ?? 0;
  const allowed = (f.rel === swRel && RULES_UPDATE ? 1 : 0) + (ownRead ? 1 : 0);
  if (fetches !== allowed)
    fail(
      `${f.rel}: \`fetch\` appears ${fetches} times; only ${swRel} may use it, ${allowed} times (${f.rel === swRel && RULES_UPDATE ? "the site rules' updater" : "no network in this build"}${ownRead ? ", and the site rules' read" : ""})`,
    );
  for (const [u] of f.text.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`<>\\)]*/gi)) {
    // the site rules' updater's origin, in the worker, with its gate open (AF3-U2): the origin and its /v1/ files
    if (RULES_PATH && f.rel === swRel && (u === RULES_ORIGINS[flavour] || u.startsWith(RULES_PATH))) continue;
    if (!URL_ALLOWED.some((re) => re.test(u))) fail(`${f.rel}: URL in shipped code that is not one it may hold: ${u}`);
  }
}
// the package file's read in one lazy chunk of the popup's and the side panel's (AF3-3b): since AF3-4 the chunk the bundler
// splits off for the two that read it, the Fill chunk (assets/Fill-*.js, the Fill paths' rule) and the "same sign-in"
// chunk (assets/aliases-*.js, its alias groups), each of which imports it statically; nothing else loads it, statically or
// by import(). So it is in no page's own scripts (every HTML page's: nothing counted, nothing the offscreen document or
// the settings page loads with it), nor in the worker (C27). The format's checker goes with it: its list of reserved names
// (the one "localhost" a store build may hold, below) is in that chunk and in no other script (AF3-4's review, S2), but for
// the worker of a build whose site rules' updater's gate is open, which checks a downloaded bundle with it (AF3-U2: the
// maintainers' C33; the worker still reads no package file). And the reserved host names the e2e build's test rules use,
// accepted in that build only (__SK_RULES_TEST_HOSTS__, folded by the minifier into `allowReserved`): in its reader, and
// with the updater, in its worker (which checks the e2e build's test bundles); every other build's refuse them there
if (flavour !== "dev") {
  const lazyOf = (re) => scripts.filter((f) => re.test(f.rel)).map((f) => resolve(dist, f.rel));
  const users = [...lazyOf(/^assets\/Fill-[\w-]+\.js$/), ...lazyOf(/^assets\/aliases-[\w-]+\.js$/)];
  const at = packageReaders.length === 1 ? resolve(dist, packageReaders[0]) : null;
  // every HTML page's own scripts and what they import statically (the review's N1)
  const loadedWithPages = pages.flatMap((p) => [...staticImports(htmlScripts(p.rel))]);
  const importers = scripts
    .map((f) => resolve(dist, f.rel))
    .filter((f) => f !== at && at !== null && staticImports([f]).has(at));
  // and import() of it, from anywhere (the review's N2): the two that use it import it statically. Any specifier that names
  // its file counts, whatever path comes before the name (`./`, `../assets/`, `/assets/`) and whatever query or fragment
  // after it (round 2's r2-a)
  const dynamic =
    at === null
      ? []
      : scripts
          .filter((f) =>
            new RegExp(
              `\\bimport\\(\\s*["'\`](?:[^"'\`]*/)?${basename(at).replace(/[.-]/g, "\\$&")}(?:[?#][^"'\`]*)?["'\`]\\s*\\)`,
            ).test(f.text),
          )
          .map((f) => f.rel);
  if (
    at === null ||
    packageReaders[0] === swRel ||
    loadedWithPages.includes(at) ||
    users.length !== 2 ||
    !users.every((u) => u === at || importers.includes(u)) ||
    importers.some((f) => !users.includes(f)) ||
    dynamic.length > 0
  )
    fail(
      `the site rules' read (src/platform/package-data.ts) must be in one lazy chunk, loaded with the Fill chunk and the "same sign-in" chunk alone; found in: ${packageReaders.join(", ") || "nothing"}${at ? `, loaded with: ${importers.map((f) => f.slice(dist.length + 1)).join(", ") || "nothing"}${dynamic.length ? `, by import() in: ${dynamic.join(", ")}` : ""}${loadedWithPages.includes(at) ? ", and with a page's own scripts" : ""}` : ""}`,
    );
  // where the checker must be: the reader, and with the updater the worker (the two, sorted as `scripts` lists them)
  const checkers = scripts
    .filter((f) => f.rel === packageReaders[0] || (RULES_UPDATE && f.rel === swRel))
    .map((f) => f.rel);
  const checker = scripts.filter((f) => new RegExp(RESERVED_NAMES_LIST.source).test(f.text)).map((f) => f.rel);
  if (packageReaders.length !== 1 || checker.join(" ") !== checkers.join(" "))
    fail(
      `the format's checker (its list of reserved names, src/core/rules/format.ts) must be in the site rules' reader${RULES_UPDATE ? ` and in ${swRel} (the updater's)` : " alone"}; found in: ${checker.join(", ") || "nothing"}`,
    );
  const reserved = scripts.filter((f) => RESERVED_ON.test(f.text)).map((f) => f.rel);
  if (
    flavour === "e2e"
      ? reserved.join(" ") !== checkers.join(" ")
      : reserved.length > 0 || checkers.some((c) => !RESERVED_OFF.test(scripts.find((f) => f.rel === c)?.text ?? ""))
  )
    fail(
      `reserved host names in the site rules' checks: ${flavour === "e2e" ? `the e2e build's reader must accept them (its test rules)${RULES_UPDATE ? ", and its worker (the updater's)" : ""}; accepted in: ${reserved.join(", ") || "nothing"}` : `a ${flavour} build's reader must refuse them (allowReserved:!1)${RULES_UPDATE ? ", and its worker (the updater's)" : ""}; accepted in: ${reserved.join(", ") || "nothing"}`}`,
    );
}
for (const f of scripts)
  if (f.text.includes("__SK_RULES_TEST_HOSTS__"))
    fail(`${f.rel}: __SK_RULES_TEST_HOSTS__ left in the build (the define is missing)`);

// Built in production mode, wherever it was built: a build made with NODE_ENV=development or =test (a developer's
// shell, a test runner) uses the JSX runtime's debug build, whose calls carry fileName and lineNumber keys holding the
// builder's absolute file paths. scripts/build.mjs pins the mode; this checks the result (the dev build is unminified
// and keeps comments, so it is not read this way).
if (flavour !== "dev") {
  const machine = [root, resolve(root, "..")];
  for (const f of scripts)
    if (/[{,]\s*(?:fileName|lineNumber|columnNumber)\s*:/.test(f.text))
      fail(`${f.rel}: a development-mode build (fileName/lineNumber keys)`);
  for (const f of shipped) {
    if (machine.some((p) => f.text.includes(p))) fail(`${f.rel}: a path of the build machine`);
    else if (/["'`](?:\/(?:Users|home|root|private\/var|var\/folders)\/|[A-Za-z]:\\\\(?:Users|home)\\\\)/.test(f.text))
      fail(`${f.rel}: an absolute file path`);
  }
}
// The server sync's API (GONE_API above): in no shipped file of any build, the manifest and a dev build's comments
// included, not even its host name, so a scan of the package finds no address of it.
for (const f of shipped)
  for (const a of GONE_API)
    if (f.text.includes(a)) fail(`${f.rel}: names the server sync's API (${a}), whose client no build has (DV-0b)`);
// The in-page suggestion's release gate (scripts/suggest-ui.mjs; AUTOFILL2 patch 4), both ways. With the gate closed,
// no shipped script names any mark of what the gate lets in, so the store build is patches 1 to 3 (nothing a page sends
// opens a Sixkey surface, no request v2 is read or written, the surface's page-R rules and their text are not there):
// the content script's second message, request v2's document pattern, the worker's records, the Fill strip's line for a
// page's request, the gate's two popup keys (in the code and in the popup's catalog chunks; _locales, the full catalogs
// for every build, is not a script), and the surface's input delay. With the gate open, each is where it belongs.
// test/unit/autofill1-check-dist.test.ts tampers with every mark, both ways.
{
  const marks = {
    "sk-af-open": [swRel], // the click's message (sender-policy.ts, content-channel.ts)
    // request v2's document (fill-request.ts DOC_RE). A generic text: unrelated code that comes to hold it would fail the
    // store build here, which is the safe way to fail (the review's N-3); name such code here if that is ever right
    "[0-9A-F]{32}": [swRel],
    sk_sug_shown: [swRel], // the worker's records (page-open.ts)
    "fill-page-go": [/^assets\/Fill-/], // the Fill strip's line (Fill.tsx PageGo)
    pinLength: [/^assets\/popup-locale-/, /^assets\/late-/], // the lock screen's line (Locked.tsx, page-lock.ts)
    afSugGo: [/^assets\/popup-locale-/, /^assets\/Fill-/],
    // the surface's input delay (popup/page-delay.ts): its object's property, which minifying keeps, in the popup's and the
    // side panel's boot chunk, where App starts it (the review's N-2: a leak would otherwise show only as the popup's size)
    lastPress: [/^assets\/boot-/],
  };
  for (const [mark, where] of Object.entries(marks)) {
    const hits = scripts.filter((f) => f.text.includes(mark)).map((f) => f.rel);
    if (!SUGGEST_UI)
      for (const rel of hits)
        fail(
          `${rel}: names \`${mark}\` in a build whose release gate keeps the in-page suggestion out (scripts/suggest-ui.mjs)`,
        );
    else
      for (const w of where)
        if (!hits.some((rel) => (typeof w === "string" ? rel === w : w.test(rel))))
          fail(
            `no shipped script ${typeof w === "string" ? w : `like ${w}`} names \`${mark}\` in a build whose release gate lets the in-page suggestion in (scripts/suggest-ui.mjs)`,
          );
  }
  console.log(
    `in-page suggestion: ${SUGGEST_UI ? "in" : "out"} (release gate SUGGEST_UI_IN_STORE_BUILD = ${SUGGEST_UI_IN_STORE_BUILD})`,
  );
}

// The site rules' updater's release gate (scripts/rules-update.mjs; TOTP autofill Stage 3, AF3-U1; the plan's S7), as the
// in-page suggestion's. With the gate closed, no shipped file names the signed manifest's format (src/core/rules/signed.ts),
// the database the updater keeps its record in (AF3-U2's), or any flavour's rules origin: a store build holds none of the
// updater (scripts/rules-guard.mjs keeps its modules out of every module graph; this is the second look, at the files).
// In every build, the database's name is in the worker's script alone, never in a page's: pages never open it (the plan's
// S9, R5). A store build, whatever the gate, holds no test signing key (scripts/rules-keys.mjs TEST_RULES_KEYS, whose
// private halves are published with the tests; a test holds that list to their files) in any file: not its kid, its SPKI
// in base64 or base64url, its point (x‖y, and x and y apart, in hex and base64url: a JWK's fields), nor, where the test
// fixtures are there, a line of its private key's PEM (the AF3-U1 review's N11); nor the dev and e2e builds' rules origin
// (even when the store build's origin was set to it: the review's N2); and the store list pins no test key, in whatever
// spelling of its SPKI (rules-keys.mjs sameKey). The list is read from scripts/, so a source tree without its tests checks
// the same.
// AF3-U2 (the updater, src/platform/rules-live.ts; its switch, src/options/RulesUpdate.tsx) adds, gate closed, to what no
// shipped file may name: the switch's key in the database, the two messages (`sk-af-rule`, which `sk-af-rules-status`
// starts with), any text of the switch's catalog (catalogs/rules-<lang>.json), and the switch's chunk and its text chunks
// by name. Gate open, each mark is where it belongs and nowhere else: the database, the manifest's format, the switch's
// key and the rules origin (as a URL) in the worker's script alone; `sk-af-rule` in the worker and the Fill chunk
// (src/platform/site-rule.ts: the Fill paths ask the worker); `sk-af-rules-status` in the worker and the switch's chunk;
// the switch's chunk loaded by import() from the settings page's own scripts and by nothing else, never with a page; its
// text, one chunk per language (assets/rules-update-locale-<lang>-*.js), exactly the generated file, within its budget
// (RULES_CATALOG_GZ), disjoint from the full catalog, loaded by the switch's chunk alone. The CSP's one rules path, the
// worker's one more fetch and the format's checker in the worker are held above.
// test/unit/rules-update-check-dist.test.ts tampers with each, both ways (the switch's four rules each alone: round 2).
{
  const MANIFEST_MARK = "sixkey-rules-manifest";
  const DATABASE = "sixkey-rules-live";
  const SWITCH_KEY = "sk_rules_switch";
  const RULE_MESSAGE = "sk-af-rule";
  const STATUS_MESSAGE = "sk-af-rules-status";
  const hostOf = (o) => new URL(o).host;
  const origins = [...new Set(Object.values(RULES_ORIGINS).filter(Boolean).map(hostOf))];
  const assetNames = existsSync(resolve(dist, "assets")) ? readdirSync(resolve(dist, "assets")) : [];
  const SWITCH_CHUNK = /^RulesUpdate-[\w-]+\.js$/;
  const TEXT_CHUNK = /^rules-update-locale-[A-Za-z_]+-[\w-]+\.js$/;
  // the switch's words as the catalog has them (up to a first "$"), the longer ones: a store build holds none of them
  const words = ["en", "zh_CN"].flatMap((loc) => {
    const file = resolve(root, "catalogs", `rules-${loc}.json`);
    return existsSync(file)
      ? Object.values(JSON.parse(readFileSync(file, "utf8")))
          .map((e) =>
            String(e?.message ?? "")
              .split("$")[0]
              .trim(),
          )
          .filter((w) => w.length >= 6)
      : [];
  });
  if (!RULES_UPDATE) {
    for (const f of shipped)
      for (const mark of [MANIFEST_MARK, DATABASE, SWITCH_KEY, RULE_MESSAGE, ...origins, ...words])
        if (f.text.includes(mark))
          fail(
            `${f.rel}: names \`${mark}\` in a build whose release gate keeps the site rules' updater out (scripts/rules-update.mjs)`,
          );
    for (const n of assetNames)
      if (SWITCH_CHUNK.test(n) || TEXT_CHUNK.test(n))
        fail(`assets/${n}: the site rules' updater's switch in a build whose release gate keeps the updater out`);
  } else {
    const origin = RULES_ORIGINS[flavour];
    const quoted = (w) => new RegExp(`["'\`]${w}["'\`]`);
    const marks = [
      [DATABASE, (t) => t.includes(DATABASE), [swRel]],
      [MANIFEST_MARK, (t) => t.includes(MANIFEST_MARK), [swRel]],
      [SWITCH_KEY, (t) => t.includes(SWITCH_KEY), [swRel]],
      [origin, (t) => t.includes(origin), [swRel]],
      [RULE_MESSAGE, (t) => quoted(RULE_MESSAGE).test(t), [swRel, /^assets\/Fill-[\w-]+\.js$/]],
      [STATUS_MESSAGE, (t) => quoted(STATUS_MESSAGE).test(t), [swRel, /^assets\/RulesUpdate-[\w-]+\.js$/]],
    ];
    for (const [mark, has, where] of marks) {
      const hits = scripts.filter((f) => has(f.text)).map((f) => f.rel);
      const at = (rel) => where.some((w) => (typeof w === "string" ? rel === w : w.test(rel)));
      for (const rel of hits)
        if (!at(rel)) fail(`${rel}: names \`${mark}\`, which belongs to ${where.map(String).join(" and ")} alone`);
      for (const w of where)
        if (!hits.some((rel) => (typeof w === "string" ? rel === w : w.test(rel))))
          fail(
            `no shipped script ${typeof w === "string" ? w : `like ${w}`} names \`${mark}\` (the site rules' updater)`,
          );
    }
    // the switch's chunk: one, lazy, the settings page's (its own scripts load it by import(), nothing else names it)
    const chunks = assetNames.filter((n) => SWITCH_CHUNK.test(n));
    const settings = [...staticImports(htmlScripts("options/index.html"))];
    const withPages = pages.flatMap((p) => [...staticImports(htmlScripts(p.rel))]);
    const namers = (n) => scripts.filter((f) => f.rel !== `assets/${n}` && f.text.includes(n)).map((f) => f.rel);
    if (chunks.length !== 1)
      fail(`expected one site rules' switch chunk assets/RulesUpdate-*.js, found ${chunks.length}`);
    for (const n of chunks) {
      if (withPages.includes(resolve(dist, "assets", n))) fail(`assets/${n}: the switch's chunk is loaded with a page`);
      for (const rel of namers(n))
        if (!settings.includes(resolve(dist, rel)))
          fail(`${rel}: loads the site rules' switch (assets/${n}), which the settings page alone loads`);
      if (namers(n).length === 0) fail(`assets/${n}: no script of the settings page loads the switch's chunk`);
    }
    // its text: per language one chunk, exactly the generated file, within its budget, disjoint from the full catalog,
    // loaded by the switch's chunk alone
    for (const loc of readdirSync(resolve(dist, "_locales"))) {
      const prefix = `rules-update-locale-${loc}-`;
      const mine = assetNames.filter((n) => n.startsWith(prefix) && TEXT_CHUNK.test(n));
      if (mine.length !== 1) {
        fail(`locale ${loc}: expected one site rules' switch text chunk assets/${prefix}*.js, found ${mine.length}`);
        continue;
      }
      const file = resolve(dist, "assets", mine[0]);
      const gz = gzipSync(readFileSync(file)).length;
      console.log(`site rules' switch text ${loc}: ${gz} B gz (limit ${RULES_CATALOG_GZ} B)`);
      if (flavour !== "dev" && gz > RULES_CATALOG_GZ)
        fail(`site rules' switch text ${loc} is ${gz} B gz, over its limit of ${RULES_CATALOG_GZ} B`);
      for (const rel of namers(mine[0]))
        if (!chunks.some((c) => rel === `assets/${c}`))
          fail(`${rel}: loads the site rules' switch text (assets/${mine[0]}), which the switch's chunk alone loads`);
      let cat;
      try {
        cat = (await import(pathToFileURL(file).href)).default;
      } catch (e) {
        fail(`${mine[0]}: cannot be read as a catalog (${e})`);
        continue;
      }
      const want = resolve(root, "catalogs", `rules-${loc}.json`);
      if (!existsSync(want)) fail(`catalogs/rules-${loc}.json missing: run python3 scripts/messages.py`);
      else if (JSON.stringify(cat) !== JSON.stringify(JSON.parse(readFileSync(want, "utf8"))))
        fail(`${mine[0]} differs from catalogs/rules-${loc}.json`);
      const full = msgsOf(loc);
      for (const k of Object.keys(cat))
        if (Object.hasOwn(full, k)) fail(`site rules' switch text ${loc}: ${k} is also a key of the full catalog`);
    }
  }
  for (const f of scripts)
    if (f.rel !== swRel && f.text.includes(DATABASE))
      fail(`${f.rel}: names the site rules' database \`${DATABASE}\`: the worker alone opens it, never a page`);
  if (prod) {
    const pem = resolve(root, "test/fixtures/rules-keys");
    const lines = (existsSync(pem) ? readdirSync(pem) : [])
      .filter((n) => /^test-only-[a-z]+\.pem$/.test(n))
      .flatMap((n) => readFileSync(join(pem, n), "utf8").split(/\r?\n/))
      .filter((l) => /^[A-Za-z0-9+/=]{40,}$/.test(l));
    const test = TEST_RULES_KEYS.map(({ kid, spki }) => {
      const xy = Buffer.from(pointOf({ spki }) ?? "", "hex");
      const parts = [xy, xy.subarray(0, 32), xy.subarray(32)].filter((b) => b.length);
      return {
        kid,
        // (the SPKI in base64url needs no mark of its own: its 27-byte prefix is a whole number of base64's 3-byte groups,
        // so it ends with x‖y in base64url, a mark below)
        marks: [kid, spki, ...parts.flatMap((b) => [b.toString("hex"), b.toString("base64url")])],
      };
    });
    for (const f of shipped)
      for (const line of lines)
        if (f.text.includes(line))
          fail(`${f.rel}: holds a line of the site rules' test signing keys' private PEM in a store build`);
    for (const f of shipped)
      for (const k of test)
        if (k.marks.some((mark) => f.text.includes(mark)))
          fail(`${f.rel}: holds the site rules' test signing key ${k.kid} (TEST_RULES_KEYS) in a store build`);
    for (const k of STORE_RULES_KEYS)
      if (TEST_RULES_KEYS.some((t) => sameKey(t, k) || t.kid === k?.kid || t.spki === k?.spki))
        fail(`scripts/rules-keys.mjs: the store build's list pins the test signing key ${k?.kid}`);
    // (with the gate closed, every origin was looked for above)
    const testOrigins = testRulesHosts();
    if (RULES_UPDATE)
      for (const f of shipped)
        for (const host of new Set(testOrigins))
          if (f.text.includes(host))
            fail(`${f.rel}: names the dev and e2e builds' rules origin \`${host}\` in a store build`);
  }
  console.log(
    `site rules' updater: ${RULES_UPDATE ? "in" : "out"} (release gate RULES_UPDATE_IN_STORE_BUILD = ${RULES_UPDATE_IN_STORE_BUILD})`,
  );
}

// The prod build: no developer marker in any shipped file. Every build: no developer sync page, and no enrolment code
// (so nothing a user can reach turns sync on, SYNC-DESIGN §9 M5/M6; OWNER-DECISIONS/25).
if (prod)
  for (const f of shipped) {
    const text = /\.js$/.test(f.rel) ? f.text.replace(RESERVED_NAMES_LIST, "") : f.text;
    for (const d of DEV_MARKERS)
      if (f.rel !== "manifest.json" && text.includes(d)) fail(`${f.rel}: dev marker in a prod build: ${d}`);
  }
if (existsSync(resolve(dist, "devsync"))) fail(`devsync/ (the developer sync page) is in the ${flavour} build`);
for (const f of shipped)
  if (f.text.includes(DEV_SYNC_MARKER)) fail(`${f.rel}: the developer sync page's marker in the ${flavour} build`);
for (const f of scripts)
  for (const k of ENROLMENT_FINGERPRINTS)
    if (f.text.includes(k)) fail(`${f.rel}: enrolment code in the ${flavour} build (${k})`);
for (const f of shipped)
  for (const k of SYNC_BADGE_KEYS)
    if (f.text.includes(k)) fail(`${f.rel}: the server sync's toolbar badge (${k}) in the ${flavour} build`);
if (prod)
  for (const f of shipped)
    for (const k of SERVER_SYNC_RECORDS)
      if (f.text.includes(k))
        fail(
          `${f.rel}: names the server sync's records (${k}) in the ${flavour} build, whose worker never removes them`,
        );

// The Google Drive backup's marks (DRIVE_MARKS above), in no build, nor its developer page's folder.
if (existsSync(resolve(dist, "devcloud")))
  fail(`devcloud/ (the Google Drive backup's developer page) is in the ${flavour} build`);
for (const f of shipped)
  for (const word of DRIVE_MARKS)
    if (f.text.includes(word)) fail(`${f.rel}: the removed Google Drive backup in the ${flavour} build (${word})`);
// The worker's backup (CSB-3): in every build the backup in Chrome's sync storage (platform/csb-worker.ts, its debounce's
// alarm). Production has no Google credentials or network transport.
{
  const sw = shipped.find((f) => f.rel === swRel)?.text ?? "";
  if (!sw.includes("sk-csb-soon")) fail(`the ${flavour} build's worker has no backup in Chrome sync`);
  // The worker's size (CLOUD-BACKUP §6.4: patch 4 set its budget, patch 5 tightened it after A4's trim: review P4, A7).
  // It loads in no page, but every wake-up of the worker parses all of it; the cloud backup's code (its Drive client, the
  // write rule, Google's sign-in and transport, or the e2e build's fake) added about 11 KB gz to it, and left it in CSB-3
  // as the backup in Chrome sync's came in (about 1.6 KB gz less in the store build all told). Held in the minified
  // builds; a dev build's is unminified. The e2e build's limit has the site rules' updater's room too (RULES_UPDATER_GZ);
  // the store build's never follows the updater's gate (scripts/sw-budget.mjs: the maintainers' C33).
  const SW_BUDGET_GZ = swBudgetOf(flavour);
  const swGz = gzipSync(sw).length;
  console.log(
    `service worker ${swRel}: ${swGz} B gz (limit ${SW_BUDGET_GZ} B${flavour === "prod" ? "" : `, the site rules' updater's ${RULES_UPDATER_GZ} B included`}${flavour === "dev" ? ", not held in a dev build" : ""})`,
  );
  if (flavour !== "dev" && swGz > SW_BUDGET_GZ)
    fail(`${swRel}: ${swGz} B gz, over the worker's budget of ${SW_BUDGET_GZ} B`);
}

// install-source check (H4): a prod build has it turned on, and once the store ID exists (scripts/store-id.mjs),
// carries that ID. A build with the check off has none of its code (src/platform/install-source.ts), so finding the
// getSelf call means it is on. Dev and e2e builds have it off and no store ID. The test build has it off as well
// (always loaded unpacked, it would always show the notice a store copy never shows; scripts/build.mjs installCheck):
// no getSelf call in its scripts, so a store build checked as a test build fails here, and a test build checked as the
// store build fails above (its name and key) and here.
if (testBuild) {
  for (const f of scripts)
    if (f.text.includes("getSelf"))
      fail(`${f.rel}: the install-source check (chrome.management.getSelf) is on in the test build`);
} else if (prod) {
  const js = scripts.map((f) => f.text);
  if (!js.some((text) => text.includes("getSelf")))
    fail("install-source check (chrome.management.getSelf) is off or missing in this build");
  if (STORE_ID) {
    if (!/^[a-p]{32}$/.test(STORE_ID)) fail(`scripts/store-id.mjs: not an extension ID: ${STORE_ID}`);
    else if (!js.some((text) => text.includes(STORE_ID)))
      fail(`store ID ${STORE_ID} is set but not in the build's scripts`);
  }
}

// popup budget: entry script + static preloads + stylesheets, gzipped, plus the larger catalog the popup can load.
// Each page loads its catalogs outside the static graph (src/ui/i18n.ts loadCatalog; the settings page its parts,
// src/options/parts.tsx), so the biggest one the popup can reach is added here; otherwise moving text out of the static
// graph would hide its growth. Every locale must have exactly one popup catalog chunk, assets/popup-locale-<lang>-<hash>.js,
// and exactly one chunk per settings page part, assets/settings-locale-<part>-<lang>-<hash>.js (named in
// scripts/build.mjs): if the naming breaks, this fails instead of silently counting nothing. No chunk of a full catalog
// (assets/locale-<lang>-<hash>.js) may exist: no page loads one. Which catalogs a page can load is read from the files
// themselves: its static scripts and, transitively, every chunk their code names (import() and preload lists name chunks
// by file name). The popup must reach one popup catalog per locale and nothing else; the settings page every one of its
// parts, and none of them up front.
{
  const page = resolve(dist, "popup/index.html");
  const h = readFileSync(page, "utf8");
  // (a remote or protocol-relative one has failed above, as a remote resource; only the page's own files are counted)
  const urls = [...h.matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.(?:js|css))"/g)]
    .map((x) => x[1])
    .filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u));
  let staticGz = 0;
  for (const u of new Set(urls)) staticGz += gzipSync(readFileSync(resolve(dirname(page), u))).length;
  const assetNames = readdirSync(resolve(dist, "assets"));
  for (const n of assetNames.filter((x) => /^locale-.*\.js$/.test(x)))
    fail(`assets/${n}: a chunk of a full catalog; no page loads one (the settings page loads its parts)`);
  const chunks = assetNames.filter((n) => /^(?:popup|settings)-locale-.*\.js$/.test(n));
  const KINDS = ["popup", ...Object.keys(SETTINGS_CATALOG_GZ)];
  const catalogs = [];
  for (const loc of readdirSync(resolve(dist, "_locales"))) {
    for (const kind of KINDS) {
      const prefix = kind === "popup" ? `popup-locale-${loc}-` : `settings-locale-${kind}-${loc}-`;
      const mine = chunks.filter((n) => n.startsWith(prefix) && /^[A-Za-z0-9_-]+\.js$/.test(n.slice(prefix.length)));
      const what = kind === "popup" ? "popup" : `settings page (${kind})`;
      if (mine.length !== 1)
        fail(`locale ${loc}: expected one ${what} catalog chunk assets/${prefix}*.js, found ${mine.length}`);
      for (const n of mine)
        catalogs.push({ loc, kind, n, gz: gzipSync(readFileSync(resolve(dist, "assets", n))).length });
    }
  }
  const strays = chunks.filter((n) => !catalogs.some((c) => c.n === n));
  if (strays.length) fail(`catalog chunks without a locale or a part: ${strays.join(", ")}`);
  if (urls.some((u) => /\/(?:popup|settings)-locale-[^/]*\.js$/.test(u)))
    fail("popup/index.html preloads a catalog chunk statically; it would be counted twice");

  const js = assetNames.filter((n) => n.endsWith(".js"));
  /** Every file a page can load: its static scripts and, transitively, every chunk their code names. */
  const reachFrom = (html) => {
    const refs = [...readFileSync(html, "utf8").matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.js)"/g)]
      .map((x) => x[1])
      .filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u));
    const reach = new Set();
    const todo = refs.map((u) => resolve(dirname(html), u));
    while (todo.length) {
      const f = todo.pop();
      if (reach.has(f)) continue;
      reach.add(f);
      const text = readFileSync(f, "utf8");
      for (const n of js) if (text.includes(n)) todo.push(resolve(dist, "assets", n));
    }
    return { refs, reach };
  };
  const { reach } = reachFrom(page);
  const loadable = catalogs.filter((c) => reach.has(resolve(dist, "assets", c.n)));
  for (const c of loadable)
    if (c.kind !== "popup")
      fail(`the popup can load the settings page's catalog ${c.n}; it must load only assets/popup-locale-*.js`);
  for (const loc of new Set(catalogs.map((c) => c.loc)))
    if (!loadable.some((c) => c.loc === loc && c.kind === "popup")) fail(`the popup cannot load a catalog for ${loc}`);
  const largest = loadable.reduce((a, c) => (c.gz > a.gz ? c : a), { loc: "none", n: "", gz: 0 });
  const total = staticGz + largest.gz;
  const kb = (b) => (b / 1024).toFixed(1);
  const popupList = catalogs
    .filter((c) => c.kind === "popup")
    .map((c) => `${c.loc} ${kb(c.gz)}`)
    .join(", ");
  console.log(
    `popup gzip: ${kb(total)} KB (budget ${BUDGET_GZ / 1024} KB) = static ${kb(staticGz)} KB + largest catalog it loads ${largest.loc} ${kb(largest.gz)} KB [popup catalogs: ${popupList}]`,
  );
  // The budgets hold for the build that ships; dev and e2e builds carry test-only code (the i18n guard), so they print.
  if (prod && total > BUDGET_GZ) fail(`popup bundle ${total} B gz exceeds budget ${BUDGET_GZ} B`);
  console.log(`popup gzip, bytes: ${total} of ${BUDGET_GZ} = static ${staticGz} + catalog ${largest.gz}`);

  // The side panel (PANEL_BUDGET_GZ), counted as the popup is: its own static scripts and stylesheets, plus the larger
  // catalog it can load. It loads the popup's catalogs, one per locale, and no other kind; it preloads none.
  {
    const panelPage = resolve(dist, "sidepanel/index.html");
    if (existsSync(panelPage)) {
      const panelUrls = [
        ...readFileSync(panelPage, "utf8").matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.(?:js|css))"/g),
      ]
        .map((x) => x[1])
        .filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u));
      let panelStatic = 0;
      for (const u of new Set(panelUrls)) panelStatic += gzipSync(readFileSync(resolve(dirname(panelPage), u))).length;
      if (panelUrls.some((u) => /\/(?:popup|settings)-locale-[^/]*\.js$/.test(u)))
        fail("sidepanel/index.html preloads a catalog chunk statically; it would be counted twice");
      const panelReach = reachFrom(panelPage).reach;
      const panelLoads = catalogs.filter((c) => panelReach.has(resolve(dist, "assets", c.n)));
      for (const c of panelLoads)
        if (c.kind !== "popup")
          fail(
            `the side panel can load the settings page's catalog ${c.n}; it must load only assets/popup-locale-*.js`,
          );
      for (const loc of new Set(catalogs.map((c) => c.loc)))
        if (!panelLoads.some((c) => c.loc === loc && c.kind === "popup"))
          fail(`the side panel cannot load a catalog for ${loc}`);
      const panelCat = panelLoads.reduce((a, c) => (c.gz > a.gz ? c : a), { loc: "none", n: "", gz: 0 });
      const panelTotal = panelStatic + panelCat.gz;
      console.log(
        `side panel gzip, bytes: ${panelTotal} of ${PANEL_BUDGET_GZ} = static ${panelStatic} + catalog ${panelCat.gz} (${panelCat.loc})`,
      );
      if (prod && panelTotal > PANEL_BUDGET_GZ)
        fail(`side panel bundle ${panelTotal} B gz exceeds budget ${PANEL_BUDGET_GZ} B`);
    }
  }
  // What the popup and the side panel never draw stays out of what they count (AF3-4t; docs/design/notes/BUDGET-NOTES.md
  // §9): no rule of src/options/base.css (the settings page's chips and code box) or of src/popup/main/add.css (the Add
  // view's, loaded with its lazy chunk) is in a stylesheet either page counts, and no path of the settings page's own
  // icons (src/options/icons.tsx) is in a script either counts. Rules are compared by selector, each of a list on its own,
  // written as the minifier writes it; a path by its text. Each must still ship in a file neither page counts, so a
  // change of form cannot pass this by matching nothing.
  {
    const counted = new Set();
    for (const html of ["popup/index.html", "sidepanel/index.html"]) {
      const at = resolve(dist, html);
      if (!existsSync(at)) continue;
      for (const m of readFileSync(at, "utf8").matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.(?:js|css))"/g))
        if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(m[1])) counted.add(resolve(dirname(at), m[1]));
    }
    // (selectorsOf: scripts/css-selectors.mjs, the tests' reader too; a keyframes block's steps are no selectors)
    const own = new Map();
    for (const src of ["src/options/base.css", "src/popup/main/add.css"])
      for (const sel of selectorsOf(readFileSync(resolve(root, src), "utf8"))) own.set(sel, src);
    const iconSrc = readFileSync(resolve(root, "src/options/icons.tsx"), "utf8");
    const table = /const OWN = \{([\s\S]*?)\} as const;/.exec(iconSrc)?.[1] ?? "";
    const paths = [...table.matchAll(/^\s*(\w+):\s*"([^"]+)",?$/gm)].map((m) => ({ name: m[1], d: m[2] }));
    if (!own.size || !paths.length) fail("the rules and icons the counted files must not hold could not be read");
    const shipped = (re) => {
      const out = [];
      const walk = (d) => {
        for (const n of readdirSync(d)) {
          const f = join(d, n);
          if (statSync(f).isDirectory()) walk(f);
          else if (re.test(n)) out.push(f);
        }
      };
      walk(dist);
      return out;
    };
    const elsewhere = { css: new Set(), js: [] };
    for (const f of shipped(/\.css$/)) {
      const sels = selectorsOf(readFileSync(f, "utf8"));
      const rel = f.slice(dist.length + 1);
      if (counted.has(f)) {
        for (const sel of sels)
          if (own.has(sel))
            fail(`${rel}: the rule ${sel} of ${own.get(sel)} in a stylesheet the popup or the side panel counts`);
      } else for (const sel of sels) elsewhere.css.add(sel);
    }
    for (const f of shipped(/\.js$/)) {
      const text = readFileSync(f, "utf8");
      const rel = f.slice(dist.length + 1);
      for (const { name, d } of paths)
        if (text.includes(d)) {
          if (counted.has(f))
            fail(`${rel}: the settings page's icon ${name} in a script the popup or the side panel counts`);
          else elsewhere.js.push(name);
        }
    }
    for (const [sel, src] of own)
      if (!elsewhere.css.has(sel))
        fail(`the rule ${sel} of ${src} is in no stylesheet the build ships outside the counted ones`);
    // and where the settings page draws them from: a script its page loads (its HTML's and what they import statically).
    // A path that is also another thing's, in a lazy chunk, does not stand in for it
    const settingsJs = [...staticImports(htmlScripts("options/index.html"))].map((f) => readFileSync(f, "utf8"));
    for (const { name, d } of paths)
      if (!elsewhere.js.includes(name)) fail(`the settings page's icon ${name} is in no script the build ships`);
      else if (!settingsJs.some((t) => t.includes(d)))
        fail(`the settings page's icon ${name} is in no script the settings page loads with its page`);
    console.log(
      `kept out of the popup's and the side panel's counted files: ${own.size} rules (src/options/base.css, src/popup/main/add.css), ${paths.length} icons (src/options/icons.tsx)`,
    );
  }
  // The View menu: its code (assets/View-<hash>.js) and one text chunk per locale (assets/view-locale-<lang>-<hash>.js, named
  // in scripts/build.mjs). The popup and the side panel reach them by import() only, never from their HTML (so they are
  // not in the budgets above), the settings page not at all, and each chunk is exactly the generated file, with the full
  // catalog's text, the same keys in every language, within VIEW_CATALOG_GZ.
  {
    const code = assetNames.filter((n) => /^View-[A-Za-z0-9_-]+\.js$/.test(n));
    if (code.length !== 1) fail(`expected one View menu chunk assets/View-*.js, found ${code.length}`);
    const panelPage = resolve(dist, "sidepanel/index.html");
    const panelReach = existsSync(panelPage) ? reachFrom(panelPage).reach : null;
    const optionsReach = reachFrom(resolve(dist, "options/index.html")).reach;
    const sameText = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const seen = new Map();
    const sizes = [];
    for (const loc of new Set(catalogs.map((c) => c.loc))) {
      const prefix = `view-locale-${loc}-`;
      const mine = assetNames.filter(
        (n) => n.startsWith(prefix) && /^[A-Za-z0-9_-]+\.js$/.test(n.slice(prefix.length)),
      );
      if (mine.length !== 1) {
        fail(`locale ${loc}: expected one View menu catalog chunk assets/${prefix}*.js, found ${mine.length}`);
        continue;
      }
      const file = resolve(dist, "assets", mine[0]);
      const gz = gzipSync(readFileSync(file)).length;
      sizes.push(`${loc} ${gz}`);
      if (flavour !== "dev" && gz > VIEW_CATALOG_GZ)
        fail(`View menu catalog (${loc}) is ${gz} B gz, over its budget of ${VIEW_CATALOG_GZ} B`);
      if (urls.some((u) => u.includes(mine[0])))
        fail(`popup/index.html loads the View menu catalog ${mine[0]} up front`);
      if (!reach.has(file)) fail(`the popup cannot load its View menu catalog ${mine[0]}`);
      if (panelReach && !panelReach.has(file)) fail(`the side panel cannot load its View menu catalog ${mine[0]}`);
      if (optionsReach.has(file)) fail(`the settings page can load the View menu catalog ${mine[0]}`);
      const genFile = resolve(root, "catalogs", `view-${loc}.json`);
      if (!existsSync(genFile)) {
        fail(`catalogs/view-${loc}.json missing: run python3 scripts/messages.py`);
        continue;
      }
      let cat;
      try {
        cat = (await import(pathToFileURL(file).href)).default;
      } catch (e) {
        fail(`${mine[0]}: cannot be read as a catalog (${e})`);
        continue;
      }
      if (!sameText(cat, JSON.parse(readFileSync(genFile, "utf8"))))
        fail(`View menu catalog ${loc}: the chunk differs from catalogs/view-${loc}.json`);
      const full = msgsOf(loc);
      for (const [k, v] of Object.entries(cat))
        if (!sameText(v, full[k]))
          fail(`View menu catalog ${loc}: ${k} is not the full catalog's text (_locales/${loc})`);
      seen.set(loc, Object.keys(cat).sort().join(","));
    }
    if (new Set(seen.values()).size > 1) fail("the View menu catalogs have different keys per language");
    if (!seen.size || !seen.values().next().value) fail("the View menu catalog is empty");
    if (code.length === 1) {
      const file = resolve(dist, "assets", code[0]);
      if (!reach.has(file)) fail("the popup cannot load the View menu");
      if (panelReach && !panelReach.has(file)) fail("the side panel cannot load the View menu");
      if (optionsReach.has(file)) fail("the settings page can load the View menu");
      if (urls.some((u) => u.includes(code[0]))) fail(`popup/index.html loads the View menu ${code[0]} up front`);
    }
    console.log(`View menu catalogs (B gz, loaded when the menu opens): ${sizes.join(" / ")} of ${VIEW_CATALOG_GZ}`);
  }
  // Each settings catalog against its own budget, in every minified build (the catalogs are the same in prod and e2e).
  const parts = [];
  for (const [kind, budget] of Object.entries(SETTINGS_CATALOG_GZ)) {
    const mine = catalogs.filter((c) => c.kind === kind);
    const largestPart = mine.reduce((a, c) => (c.gz > a.gz ? c : a), { loc: "none", gz: 0 });
    parts.push(`${kind} ${mine.map((c) => `${c.loc} ${c.gz}`).join(" / ")} of ${budget}`);
    if (budget > FULL_CATALOG_GZ)
      fail(`settings catalog ${kind}: its budget ${budget} B is above ${FULL_CATALOG_GZ} B`);
    if (flavour !== "dev" && largestPart.gz > budget)
      fail(`settings catalog ${kind} (${largestPart.loc}) is ${largestPart.gz} B gz, over its budget of ${budget} B`);
  }
  console.log(`settings catalogs (B gz): ${parts.join("; ")}`);
  const views = [];
  for (const [view, kinds] of Object.entries(SETTINGS_VIEWS))
    for (const loc of new Set(catalogs.map((c) => c.loc))) {
      const chunksOfView = kinds.map((k) => catalogs.find((c) => c.kind === k && c.loc === loc));
      if (chunksOfView.some((c) => !c)) continue; // a missing chunk has failed above
      const gz = gzipSync(Buffer.concat(chunksOfView.map((c) => readFileSync(resolve(dist, "assets", c.n))))).length;
      views.push(`${view} ${loc} ${gz}`);
      if (flavour !== "dev" && gz > FULL_CATALOG_GZ)
        fail(
          `the settings page ${view} (${loc}) loads ${gz} B gz of text together, over the ${FULL_CATALOG_GZ} B its text had as one catalog`,
        );
    }
  console.log(`settings page text loaded together (B gz, limit ${FULL_CATALOG_GZ}): ${views.join("; ")}`);
  // The settings page reaches each of its parts, and none of them, nor any catalog, up front (each loads before its part
  // is drawn; src/options/parts.tsx).
  const options = reachFrom(resolve(dist, "options/index.html"));
  for (const u of options.refs)
    if (/\/(?:popup-|settings-)?locale-[^/]*\.js$/.test(u))
      fail(`options/index.html loads the catalog ${u} up front; each part's text loads before the part is drawn`);
  for (const c of catalogs)
    if (c.kind !== "popup" && !options.reach.has(resolve(dist, "assets", c.n)))
      fail(`the settings page cannot load its catalog ${c.n}`);

  // What the catalogs hold. Each popup catalog is a part of its language's full one (_locales, as this build ships it)
  // with the very same text, and every language's has the same keys. Each settings catalog is exactly the file
  // scripts/messages.py wrote, with the full catalog's text; the parts share no key, and each has the same keys in every
  // language. The chunks are plain data modules, so importing them runs nothing else.
  const loaded = {};
  for (const c of catalogs) {
    try {
      loaded[`${c.kind}:${c.loc}`] = (await import(pathToFileURL(resolve(dist, "assets", c.n)).href)).default;
    } catch (e) {
      fail(`${c.n}: cannot be read as a catalog (${e})`);
    }
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const keysOf = new Map();
  const partOf = new Map();
  for (const loc of new Set(catalogs.map((c) => c.loc))) {
    const full = msgsOf(loc);
    for (const kind of KINDS) {
      const cat = loaded[`${kind}:${loc}`];
      if (!cat) continue;
      const label = kind === "popup" ? `popup catalog ${loc}` : `settings catalog ${kind} ${loc}`;
      if (kind !== "popup") {
        const file = resolve(root, "catalogs", `settings-${kind}-${loc}.json`);
        if (!existsSync(file)) fail(`catalogs/settings-${kind}-${loc}.json missing: run python3 scripts/messages.py`);
        else if (!same(cat, JSON.parse(readFileSync(file, "utf8"))))
          fail(`${label}: the chunk differs from catalogs/settings-${kind}-${loc}.json`);
        for (const k of Object.keys(cat)) {
          if (partOf.has(k) && partOf.get(k) !== kind)
            fail(`${label}: ${k} is also in the settings catalog ${partOf.get(k)}`);
          partOf.set(k, kind);
        }
      }
      for (const [k, v] of Object.entries(cat))
        if (!same(v, full[k])) fail(`${label}: ${k} is not the full catalog's text (_locales/${loc})`);
      if (kind === "popup" && !Object.keys(cat).length) fail(`${label} is empty`);
      const ks = Object.keys(cat).sort().join(",");
      if (!keysOf.has(kind)) keysOf.set(kind, ks);
      else if (keysOf.get(kind) !== ks)
        fail(
          `${kind === "popup" ? "popup catalogs" : `settings catalogs ${kind}`} have different keys per language (${loc})`,
        );
    }
  }
}

// TOTP autofill, Stage 1 (TOTP-AUTOFILL §4; docs/design/notes/AUTOFILL1-NOTES.md). Three things ship for it, and each is held
// to what keeps the promise "code runs in a page only on the user's action, and does nothing but find a code box and type
// one code":
//   - inject/otp.js, the finder: exactly one file under inject/, a classic script (no import or export) that leaves the one
//     global __skOtp, within ENGINE_BUDGET_GZ, naming none of ENGINE_FORBIDDEN (minified builds: a dev build keeps comments);
//   - the Fill button's chunk and its text (assets/Fill-*.js, assets/autofill-locale-<lang>-*.js): lazy only, so not in the
//     popup's or the side panel's static graph (their budgets would otherwise count them, and the settings page would
//     carry them), one text chunk per language, exactly the generated catalogs/autofill-<lang>.json, within
//     AUTOFILL_CATALOG_GZ, with keys that are no key of the full catalogs;
//   - the site rules (Stage 3, AF3-3a; scripts/rules-package.mjs): under rules/ exactly the bundle and its licence; the
//     bundle byte for byte the repository's rules/build/baseline.json, accepted by the extension's own reader, within
//     RULES_BUDGET_GZ and the reader's byte limit; its licence file as the build writes it; the manifest naming no rules/
//     (never web-accessible, never a content script); none of the bundle's host lists in any shipped text file (source
//     maps included) but the bundle (dataProbes, normalised), no copy of the bundle under another name, and no JSON data:
//     URL in any script.
{
  const engineRel = "inject/otp.js";
  const suggestRel = "inject/suggest.js";
  const injected = shipped
    .filter((f) => f.rel.startsWith("inject/"))
    .map((f) => f.rel)
    .sort();
  if (injected.join() !== [engineRel, suggestRel].join())
    fail(`inject/ must hold exactly ${engineRel} and ${suggestRel}: ${JSON.stringify(injected)}`);
  // the content script: a classic script that leaves no global (one function run at once), within its budget, naming none
  // of SUGGEST_FORBIDDEN, and whose one chrome API is the one message, {type: "sk-af-cand"}
  const suggest = shipped.find((f) => f.rel === suggestRel);
  if (!suggest) fail(`${suggestRel} (the content script) missing from the build`);
  else {
    const gz = gzipSync(suggest.text).length;
    console.log(
      `content script ${suggestRel}: ${gz} B gz (limit ${SUGGEST_BUDGET_GZ} B${flavour === "dev" ? ", not held in a dev build" : ""})`,
    );
    if (flavour !== "dev" && gz > SUGGEST_BUDGET_GZ)
      fail(`${suggestRel} is ${gz} B gz, over its budget of ${SUGGEST_BUDGET_GZ} B`);
    // the record of the suggestion's decisions, for the e2e tests (scripts/build.mjs __SUGGEST_DBG__): that build's alone
    if (suggest.text.includes("__skSugLog") !== (flavour === "e2e" && SUGGEST_UI))
      fail(`${suggestRel}: the record of the suggestion's decisions (__skSugLog) is the e2e build's alone`);
    if (flavour !== "dev") {
      if (
        !/^\s*\((?:function\s*\(\)|\(\)\s*=>)\s*\{/.test(suggest.text) ||
        /^\s*(?:var|let|const)\s/m.test(suggest.text)
      )
        fail(`${suggestRel} is not one function run at once (a global of its own is visible in its world)`);
      if (!SUGGEST_UI) {
        // the in-page suggestion's gate closed: patch 3's content script, held to patch 3's rules
        for (const re of SUGGEST_FORBIDDEN) {
          const hit = re.exec(suggest.text)?.[0];
          if (hit !== undefined)
            fail(`${suggestRel}: the content script may not contain ${re} (found ${JSON.stringify(hit.trim())})`);
        }
        const apis = [...suggest.text.matchAll(/\bchrome\.[\w.]+/g)].map((x) => x[0]);
        if (apis.join() !== "chrome.runtime.sendMessage")
          fail(`${suggestRel}: its one chrome API must be one runtime.sendMessage: ${JSON.stringify(apis)}`);
        if (!/chrome\.runtime\.sendMessage\(\{type:\s*["'`]sk-af-cand["'`]\}\)/.test(suggest.text))
          fail(`${suggestRel}: its one message must be exactly {type: "sk-af-cand"}`);
      } else checkSuggestion(suggest.text);
    }
  }
  const engine = shipped.find((f) => f.rel === engineRel);
  if (!engine) fail(`${engineRel} (the code box finder) missing from the build`);
  else {
    const gz = gzipSync(engine.text).length;
    console.log(
      `code box finder ${engineRel}: ${gz} B gz (limit ${ENGINE_BUDGET_GZ} B${flavour === "dev" ? ", not held in a dev build: unminified, with comments" : ""})`,
    );
    // the budget is for the finder that ships (minified: prod, and the e2e build, which is built the same way); the dev build is
    // neither minified nor shipped, and keeps the source's comments
    if (flavour !== "dev" && gz > ENGINE_BUDGET_GZ)
      fail(`${engineRel} is ${gz} B gz, over its budget of ${ENGINE_BUDGET_GZ} B`);
    if (!/^\s*var __skOtp\s*=/.test(engine.text)) fail(`${engineRel} is not the classic script that sets __skOtp`);
    if (flavour !== "dev")
      for (const re of ENGINE_FORBIDDEN) {
        const hit = re.exec(engine.text)?.[0];
        if (hit !== undefined)
          fail(`${engineRel}: the finder may not contain ${re} (found ${JSON.stringify(hit.trim())})`);
      }
  }
  // The three chrome.scripting calls, as built (the review's m-6): the finder is installed with `files` and asked with a function
  // and exactly one argument (the site rule's hint, or null: TOTP autofill Stage 3, AF3-2), both in all frames; the fill goes
  // to one document by its ID, with exactly five arguments (the code, the page's origin, the one registered domain, the top
  // page's origin, the box's token), in no frame list and never in the page's own world. A call is told by its target: the
  // install has `files`, the fill `documentIds`, the look neither. The calls are in the worker and in the Fill chunk, and
  // nowhere else.
  {
    const balanced = (text, from) => {
      let depth = 0;
      for (let i = from; i < text.length; i++) {
        const c = text[i];
        if (c === "(" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") {
          if (depth === 0) return i;
          depth--;
        }
      }
      return -1;
    };
    const topLevelItems = (list) => {
      let depth = 0;
      let n = list.trim() ? 1 : 0;
      for (const c of list) {
        if (c === "(" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") depth--;
        else if (c === "," && depth === 0) n++;
      }
      return n;
    };
    for (const f of scripts) {
      const calls = [...f.text.matchAll(/\bscripting\.executeScript\(/g)].map((m) => {
        const from = m.index + m[0].length;
        return f.text.slice(from, balanced(f.text, from));
      });
      // the page's user name (src/platform/page-user.ts, a lazy chunk): exactly one call, a function with exactly one
      // argument (the length cap), the top frame only (no allFrames, frameIds or documentIds), no files, no world
      if (/^assets\/page-user-[\w-]+\.js$/.test(f.rel)) {
        const argsN = (c) => {
          const args = /args\s*:\s*\[/.exec(c);
          return args
            ? topLevelItems(c.slice(args.index + args[0].length, balanced(c, args.index + args[0].length)))
            : -1;
        };
        if (
          calls.length !== 1 ||
          !/\bfunc\s*:/.test(calls[0]) ||
          /allFrames|frameIds|documentIds|\bfiles\s*:|\bworld\s*:/.test(calls[0]) ||
          argsN(calls[0]) !== 1
        )
          fail(
            `${f.rel}: the page's user name is read by one call, a function with one argument, in the top frame only`,
          );
        continue;
      }
      const allowed = f.rel === swRel || /^assets\/Fill-[\w-]+\.js$/.test(f.rel);
      if (calls.length && !allowed)
        fail(`${f.rel}: chrome.scripting.executeScript outside the worker, the Fill chunk and the page-user chunk`);
      if (!allowed) continue;
      if (flavour === "dev") continue;
      if (calls.length !== 3) fail(`${f.rel}: expected the finder's 3 executeScript calls, found ${calls.length}`);
      let install = 0;
      let look = 0;
      let fillCall = 0;
      const argsOf = (c) => {
        const args = /args\s*:\s*\[/.exec(c);
        return args
          ? topLevelItems(c.slice(args.index + args[0].length, balanced(c, args.index + args[0].length)))
          : -1;
      };
      for (const c of calls) {
        if (/\bworld\s*:/.test(c))
          fail(`${f.rel}: an executeScript call names a world (the finder runs in the isolated world only)`);
        if (/\bfiles\s*:/.test(c)) {
          install++;
          if (!/allFrames\s*:\s*(?:!0|true)/.test(c) || /args\s*:|documentIds|frameIds/.test(c))
            fail(`${f.rel}: the finder's install call must be allFrames with files only`);
        } else if (/\bdocumentIds\s*:/.test(c)) {
          fillCall++;
          if (
            !/documentIds\s*:\s*\[[^\],]+\]/.test(c) ||
            /allFrames|frameIds|\bfiles\s*:|tabs\./.test(c) ||
            argsOf(c) !== 5
          )
            fail(
              `${f.rel}: the fill call must target one documentId and pass exactly five arguments: ${c.slice(0, 160)}`,
            );
        } else {
          look++;
          if (!/allFrames\s*:\s*(?:!0|true)/.test(c) || !/\bfunc\s*:/.test(c) || /frameIds/.test(c) || argsOf(c) !== 1)
            fail(
              `${f.rel}: the look call must be allFrames with a function and exactly one argument: ${c.slice(0, 160)}`,
            );
        }
      }
      if (calls.length === 3 && (install !== 1 || look !== 1 || fillCall !== 1))
        fail(`${f.rel}: the three calls must be one install, one look and one fill (${install}, ${look}, ${fillCall})`);
    }
    // No style is ever injected, and nothing uses declarativeContent. One script runs by itself (TOTP autofill Stage 2,
    // patch 3: src/platform/autofill-register.ts): registered only by the worker, as the one object below, for exactly the
    // sites reconcile lets in, its `matches` worked out at run time.
    for (const f of scripts)
      if (/\binsertCSS\b|\bremoveCSS\b|declarativeContent/.test(f.text))
        fail(`${f.rel}: a style is injected, or declarativeContent is used`);
    const REG =
      /\b(?:registerContentScripts|updateContentScripts|unregisterContentScripts|getRegisteredContentScripts)\b/g;
    for (const f of scripts) {
      const n = f.text.match(REG)?.length ?? 0;
      if (n && f.rel !== swRel) fail(`${f.rel}: a content script is registered outside the worker`);
      if (f.rel !== swRel) continue;
      for (const call of ["registerContentScripts", "updateContentScripts", "unregisterContentScripts"])
        if ((f.text.match(new RegExp(`\\.${call}\\(`, "g"))?.length ?? 0) !== 1)
          fail(`${f.rel}: expected exactly one ${call} call (src/platform/autofill-register.ts)`);
      const flat = f.text.replace(/\s+/g, "");
      const lits = [
        ...flat.matchAll(
          /\{id:[\w$]+,js:\[[^\]]*\],matches:[\w$]+,allFrames:(?:!0|true),runAt:"document_idle",persistAcrossSessions:(?:!0|true)\}/g,
        ),
      ];
      if (lits.length !== 1)
        fail(
          `${f.rel}: the registration must be the one object {id, js, matches, allFrames, runAt "document_idle", persistAcrossSessions} (found ${lits.length})`,
        );
      if (/\bmatchOriginAsFallback\b|\bmatchAboutBlank\b|\bexcludeMatches\b/.test(f.text))
        fail(`${f.rel}: the registration names matchOriginAsFallback, matchAboutBlank or excludeMatches`);
      if (/["'`]MAIN["'`]/.test(f.text)) fail(`${f.rel}: a script for the page's own world (MAIN)`);
      if (!flat.includes('"sk-suggest"') || !flat.includes('["inject/otp.js","inject/suggest.js"]'))
        fail(
          `${f.rel}: the registration's id must be "sk-suggest" and its js exactly ["inject/otp.js","inject/suggest.js"]`,
        );
      if ((flat.match(/"inject\/suggest\.js"/g)?.length ?? 0) !== 1)
        fail(`${f.rel}: inject/suggest.js named more than once (only the registration names it)`);
    }
  }
  {
    const dir = resolve(dist, "rules");
    const under = existsSync(dir)
      ? readdirSync(dir, { recursive: true })
          .map((n) => `rules/${String(n).split("\\").join("/")}`)
          .sort()
      : [];
    const want = [PACKAGED_BASELINE, PACKAGED_LICENCE].sort();
    if (JSON.stringify(under) !== JSON.stringify(want))
      fail(`rules/ in a build holds exactly ${want.join(" and ")}; found ${under.join(", ") || "nothing"}`);
    if (manifestText.includes("rules/"))
      fail("manifest.json names rules/: the bundle is read by the extension only, never web-accessible or injected");
    const bundle = shipped.find((f) => f.rel === PACKAGED_BASELINE)?.text;
    if (bundle !== undefined) {
      // the e2e build's: the committed bundle with its own test rules added (AF3-3b; rules-package.mjs e2eBaselineText),
      // read as that build's reader reads it, reserved names allowed; every other build's: the committed one, without
      let want = readFileSync(BASELINE_SOURCE, "utf8");
      if (flavour === "e2e")
        want = await e2eBaselineText(want).catch((e) => (fail(`the e2e build's test rules: ${e.message}`), want));
      if (bundle !== want)
        fail(
          `${PACKAGED_BASELINE} is not the repository's rules/build/baseline.json${flavour === "e2e" ? " with the e2e build's test rules" : ""}, byte for byte`,
        );
      try {
        const { maxBytes } = await checkedBaseline(bundle, PACKAGED_BASELINE, { allowReserved: flavour === "e2e" });
        if (Buffer.byteLength(bundle) > maxBytes) fail(`${PACKAGED_BASELINE} is over its reader's ${maxBytes} B`);
      } catch (e) {
        fail(e.message);
      }
      const gz = gzipSync(Buffer.from(bundle)).length;
      console.log(`site rules' bundle ${PACKAGED_BASELINE}: ${gz} B gz (limit ${RULES_BUDGET_GZ} B)`);
      if (gz > RULES_BUDGET_GZ) fail(`${PACKAGED_BASELINE} is ${gz} B gz, over its budget of ${RULES_BUDGET_GZ} B`);
    }
    // The bundle's data anywhere else in the build (the build's guard keeps it out of every module graph and every
    // emitted asset; this is what was built): the repository's bundle's host lists in any shipped text file but the bundle
    // itself, source maps included, each read with one kind of quote and no white space (rules-package.mjs normalised: a
    // bundler writes an imported list as [`a.com`,`b.com`], over indented lines, or as escaped JSON); a copy of the bundle
    // under any other name (a page's `new URL("…", import.meta.url)` emits one into assets/); and a JSON data: URL in a
    // script (a library build's way of writing such a file into the code; no script of Sixkey's has one).
    {
      const repoBundle = readFileSync(BASELINE_SOURCE);
      let probes = [];
      try {
        probes = dataProbes(repoBundle.toString("utf8"));
      } catch {
        // the repository's bundle is not JSON: no build is made of it (build.mjs)
      }
      const maps = readdirSync(dist, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".map"))
        .map((e) => {
          const at = join(e.parentPath, e.name);
          return {
            rel: at
              .slice(dist.length + 1)
              .split("\\")
              .join("/"),
            text: readFileSync(at, "utf8"),
          };
        });
      for (const f of [...shipped, ...maps]) {
        if (f.rel === PACKAGED_BASELINE) continue;
        const text = normalised(f.text);
        const hit = probes.find((x) => text.includes(x));
        if (hit !== undefined) fail(`${f.rel}: rule data in a shipped file (${hit.slice(0, 80)})`);
      }
      for (const e of readdirSync(dist, { recursive: true, withFileTypes: true })) {
        if (!e.isFile()) continue;
        const at = join(e.parentPath, e.name);
        const rel = at
          .slice(dist.length + 1)
          .split("\\")
          .join("/");
        if (rel !== PACKAGED_BASELINE && statSync(at).size === repoBundle.length && readFileSync(at).equals(repoBundle))
          fail(`${rel}: a copy of the site rules' bundle outside rules/ (only ${PACKAGED_BASELINE} may hold it)`);
      }
      for (const f of scripts)
        if (/data:application\/json/i.test(f.text))
          fail(
            `${f.rel}: a JSON data: URL in a script (a file written into the code; the site rules are read from the package)`,
          );
    }
    const licence = shipped.find((f) => f.rel === PACKAGED_LICENCE)?.text;
    if (licence !== undefined && licence !== rulesLicenceText())
      fail(`${PACKAGED_LICENCE} is not rules/NOTICE and then the AGPL-3.0 text, as the build writes them`);
  }

  const assetNames = readdirSync(resolve(dist, "assets"));
  const fillChunks = assetNames.filter((n) => /^Fill-[A-Za-z0-9_-]+\.js$/.test(n));
  if (fillChunks.length !== 1) fail(`expected one Fill button chunk assets/Fill-*.js, found ${fillChunks.length}`);
  // the site rules' reader (the script that reads the package file, held to one above), when it is not the Fill chunk
  const readerChunks = assetNames.filter(
    (n) =>
      /\.js$/.test(n) &&
      !/^Fill-/.test(n) &&
      /\bfetch\(chrome\.runtime\.getURL\(/.test(readFileSync(resolve(dist, "assets", n), "utf8")),
  );
  const gzOf = (n) => gzipSync(readFileSync(resolve(dist, "assets", n))).length;
  for (const n of fillChunks) {
    const gz = gzOf(n);
    const reader = readerChunks.reduce((a, r) => a + gzOf(r), 0);
    console.log(
      `Fill button chunk: ${gz} B gz, with the site rules' reader it loads (${reader} B gz): ${gz + reader} B (limit ${FILL_CHUNK_GZ} B)`,
    );
    if (flavour !== "dev" && gz + reader > FILL_CHUNK_GZ)
      fail(
        `assets/${n}: the Fill button chunk with the site rules' reader it loads is ${gz + reader} B gz, over its limit of ${FILL_CHUNK_GZ} B`,
      );
  }
  const aliasChunks = assetNames.filter((n) => /^aliases-[A-Za-z0-9_-]+\.js$/.test(n));
  if (aliasChunks.length !== 1)
    fail(`expected one "same sign-in" chunk assets/aliases-*.js, found ${aliasChunks.length}`);
  for (const n of aliasChunks) {
    const gz = gzOf(n);
    console.log(`"same sign-in" chunk: ${gz} B gz (limit ${ALIAS_CHUNK_GZ} B)`);
    if (flavour !== "dev" && gz > ALIAS_CHUNK_GZ)
      fail(`assets/${n}: the "same sign-in" chunk is ${gz} B gz, over its limit of ${ALIAS_CHUNK_GZ} B`);
  }
  const fillCatalogs = [];
  for (const loc of readdirSync(resolve(dist, "_locales"))) {
    const prefix = `autofill-locale-${loc}-`;
    const mine = assetNames.filter((n) => n.startsWith(prefix) && /^[A-Za-z0-9_-]+\.js$/.test(n.slice(prefix.length)));
    if (mine.length !== 1) {
      fail(`locale ${loc}: expected one Fill text chunk assets/${prefix}*.js, found ${mine.length}`);
      continue;
    }
    const file = resolve(dist, "assets", mine[0]);
    fillCatalogs.push(mine[0]);
    const gz = gzipSync(readFileSync(file)).length;
    console.log(`Fill button text ${loc}: ${gz} B gz (limit ${AUTOFILL_CATALOG_GZ} B)`);
    if (flavour !== "dev" && gz > AUTOFILL_CATALOG_GZ)
      fail(`Fill text ${loc} is ${gz} B gz, over its limit of ${AUTOFILL_CATALOG_GZ} B`);
    let cat;
    try {
      cat = (await import(pathToFileURL(file).href)).default;
    } catch (e) {
      fail(`${mine[0]}: cannot be read as a catalog (${e})`);
      continue;
    }
    const want = resolve(root, "catalogs", `autofill-${loc}.json`);
    if (!existsSync(want)) fail(`catalogs/autofill-${loc}.json missing: run python3 scripts/messages.py`);
    else if (JSON.stringify(cat) !== JSON.stringify(JSON.parse(readFileSync(want, "utf8"))))
      fail(`${mine[0]} differs from catalogs/autofill-${loc}.json`);
    if (!Object.keys(cat).length) fail(`Fill text ${loc} is empty`);
    const full = msgsOf(loc);
    for (const k of Object.keys(cat))
      if (Object.hasOwn(full, k)) fail(`Fill text ${loc}: ${k} is also a key of the full catalog`);
  }
  // lazy only: the closure of STATIC imports from each page's scripts (an import() is not followed) holds none of them
  const staticClosure = (page) => staticImports(htmlScripts(page));
  const lazy = [...fillChunks, ...aliasChunks, ...readerChunks, ...fillCatalogs].map((n) => resolve(dist, "assets", n));
  for (const page of ["popup/index.html", "sidepanel/index.html", "options/index.html"]) {
    const closure = staticClosure(page);
    for (const f of lazy)
      if (closure.has(f)) fail(`${page} loads ${basename(f)} statically; it must load on first use`);
  }
  // and the settings page cannot reach the Fill button at all (it is the popup's and the side panel's)
  {
    const html = resolve(dist, "options/index.html");
    const refs = existsSync(html)
      ? [...readFileSync(html, "utf8").matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.js)"/g)].map((x) =>
          resolve(dirname(html), x[1]),
        )
      : [];
    const seen = new Set();
    const todo = [...refs];
    const js = assetNames.filter((n) => n.endsWith(".js"));
    while (todo.length) {
      const f = todo.pop();
      if (seen.has(f) || !existsSync(f)) continue;
      seen.add(f);
      const text = readFileSync(f, "utf8");
      for (const n of js) if (text.includes(n)) todo.push(resolve(dist, "assets", n));
    }
    for (const f of lazy) if (seen.has(f)) fail(`the settings page can load ${basename(f)}`);
  }
}

// Recovery code shares (SHARES_CATALOG_GZ above): exactly one entry chunk, one wizard chunk and one text chunk per language
// (assets/shares-locale-<lang>-*.js, named in scripts/build.mjs), each text chunk exactly the generated file, within its
// budget, with keys of no other catalog and the same keys in every language; none of them in any page's static graph;
// the entry and the text reachable from the popup, the side panel and the settings page, the wizard from the settings
// page only.
{
  const assetNames = readdirSync(resolve(dist, "assets"));
  const js = assetNames.filter((n) => n.endsWith(".js"));
  const one = (re, what) => {
    const found = assetNames.filter((n) => re.test(n));
    if (found.length !== 1) fail(`expected one ${what}, found ${found.length}`);
    return found[0];
  };
  const entry = one(/^ShareEntry-[A-Za-z0-9_-]+\.js$/, "share entry chunk assets/ShareEntry-*.js");
  const wizard = one(/^ShareWizard-[A-Za-z0-9_-]+\.js$/, "shares wizard chunk assets/ShareWizard-*.js");
  const texts = [];
  const keysOf = new Map();
  for (const loc of readdirSync(resolve(dist, "_locales"))) {
    const prefix = `shares-locale-${loc}-`;
    const mine = assetNames.filter((n) => n.startsWith(prefix) && /^[A-Za-z0-9_-]+\.js$/.test(n.slice(prefix.length)));
    if (mine.length !== 1) {
      fail(`locale ${loc}: expected one shares text chunk assets/${prefix}*.js, found ${mine.length}`);
      continue;
    }
    const file = resolve(dist, "assets", mine[0]);
    texts.push(mine[0]);
    const gz = gzipSync(readFileSync(file)).length;
    console.log(`recovery code shares text ${loc}: ${gz} B gz (limit ${SHARES_CATALOG_GZ} B)`);
    if (flavour !== "dev" && gz > SHARES_CATALOG_GZ)
      fail(`shares text ${loc} is ${gz} B gz, over its limit of ${SHARES_CATALOG_GZ} B`);
    let cat;
    try {
      cat = (await import(pathToFileURL(file).href)).default;
    } catch (e) {
      fail(`${mine[0]}: cannot be read as a catalog (${e})`);
      continue;
    }
    const want = resolve(root, "catalogs", `shares-${loc}.json`);
    if (!existsSync(want)) fail(`catalogs/shares-${loc}.json missing: run python3 scripts/messages.py`);
    else if (JSON.stringify(cat) !== JSON.stringify(JSON.parse(readFileSync(want, "utf8"))))
      fail(`${mine[0]} differs from catalogs/shares-${loc}.json`);
    if (!Object.keys(cat).length) fail(`shares text ${loc} is empty`);
    const full = msgsOf(loc);
    for (const k of Object.keys(cat))
      if (Object.hasOwn(full, k)) fail(`shares text ${loc}: ${k} is also a key of the full catalog`);
    keysOf.set(loc, Object.keys(cat).sort().join(","));
  }
  if (new Set(keysOf.values()).size > 1) fail("the shares text chunks have different keys per language");
  // a vault's page with the shares' text in, as one gzip stream, per language
  const VAULT_PARTS = ["core", "security", "accounts", "backup", "misc", "general", "unlock"];
  for (const loc of readdirSync(resolve(dist, "_locales"))) {
    const names = [
      ...VAULT_PARTS.map((part) => assetNames.find((n) => n.startsWith(`settings-locale-${part}-${loc}-`))),
      assetNames.find((n) => n.startsWith(`shares-locale-${loc}-`)),
    ];
    if (names.some((n) => !n)) continue; // a missing chunk has failed above
    const gz = gzipSync(Buffer.concat(names.map((n) => readFileSync(resolve(dist, "assets", n))))).length;
    console.log(`a vault's page with the shares' text in (${loc}): ${gz} B gz (limit ${SHARES_PAGE_GZ} B)`);
    if (flavour !== "dev" && gz > SHARES_PAGE_GZ)
      fail(`a vault's page with the shares' text in (${loc}) is ${gz} B gz, over the ${SHARES_PAGE_GZ} B it may hold`);
  }
  /** A page's static closure (its HTML's scripts and what they import statically) and everything it can reach. */
  const graphs = (page) => {
    const html = resolve(dist, page);
    if (!existsSync(html)) return null;
    const refs = [...readFileSync(html, "utf8").matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.js)"/g)]
      .map((x) => x[1])
      .filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u))
      .map((u) => resolve(dirname(html), u));
    const walk = (follow) => {
      const seen = new Set();
      const todo = [...refs];
      while (todo.length) {
        const f = todo.pop();
        if (seen.has(f) || !existsSync(f)) continue;
        seen.add(f);
        todo.push(...follow(f, readFileSync(f, "utf8")));
      }
      return seen;
    };
    const statics = walk((f, text) =>
      [...text.matchAll(/\b(?:import|export)\s*(?:[\w$*{][^"';]*?\s*from\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g)].map(
        (m) => resolve(dirname(f), m[1]),
      ),
    );
    const reach = walk((_, text) => js.filter((n) => text.includes(n)).map((n) => resolve(dist, "assets", n)));
    return { statics, reach };
  };
  const at = (n) => resolve(dist, "assets", n);
  const lazy = [entry, wizard, ...texts].filter(Boolean);
  for (const page of ["popup/index.html", "sidepanel/index.html", "options/index.html"]) {
    const g = graphs(page);
    if (!g) continue;
    for (const n of lazy) if (g.statics.has(at(n))) fail(`${page} loads ${n} statically; it must load on first use`);
    for (const n of [entry, ...texts].filter(Boolean))
      if (!g.reach.has(at(n))) fail(`${page} cannot load ${n} (I have shares instead)`);
    if (wizard && page !== "options/index.html" && g.reach.has(at(wizard)))
      fail(`${page} can load the shares wizard ${wizard}; it is the settings page's`);
    if (wizard && page === "options/index.html" && !g.reach.has(at(wizard)))
      fail(`the settings page cannot load the shares wizard ${wizard}`);
  }
}

// The autofill switch's text (PLUGINS_CATALOG_GZ above): one text chunk per language, named in scripts/build.mjs
// (assets/plugins-locale-<lang>-*.js), exactly its generated file, within its budget, with keys of no other catalog and
// the same keys in every language. The settings page reaches it, the popup and the side panel never do
// (scripts/plugin-pages.mjs), so what is held to SHARES_PAGE_GZ below is a vault's view with it, the shares', the device
// unlock's and the PIN after a restart's text (messages.py PLUGINS_VIEW). Not the most one page can hold: the first-run
// wizard, which a vault's page can draw too, adds the firstrun part, which is counted in "every part" (FULL_CATALOG_GZ)
// but not here (budget work 3's notes say why).
// The grant store's code and text are in no page's static graph (its store's own key, sk_plugins_overlay, is named only
// by lazy chunks and the worker), and the worker opens no port (runtime.connect).
{
  const assetNames = readdirSync(resolve(dist, "assets"));
  // each kind's pages, and the pages that must never reach it: scripts/plugin-pages.mjs (checked there, below)
  const kinds = [
    { ...PLUGIN_TEXT_KINDS.find((k) => k.name === "plugins"), what: "autofill switch text", limit: PLUGINS_CATALOG_GZ },
  ];
  const textsOf = new Map();
  for (const kind of kinds) {
    const texts = [];
    const keysOf = new Map();
    for (const loc of readdirSync(resolve(dist, "_locales"))) {
      const prefix = `${kind.name}-locale-${loc}-`;
      const mine = assetNames.filter(
        (n) => n.startsWith(prefix) && /^[A-Za-z0-9_-]+\.js$/.test(n.slice(prefix.length)),
      );
      if (mine.length !== 1) {
        fail(`locale ${loc}: expected one ${kind.what} chunk assets/${prefix}*.js, found ${mine.length}`);
        continue;
      }
      const file = resolve(dist, "assets", mine[0]);
      texts.push(mine[0]);
      const gz = gzipSync(readFileSync(file)).length;
      console.log(`${kind.what} ${loc}: ${gz} B gz (limit ${kind.limit} B)`);
      if (flavour !== "dev" && gz > kind.limit)
        fail(`${kind.what} ${loc} is ${gz} B gz, over its limit of ${kind.limit} B`);
      let cat;
      try {
        cat = (await import(pathToFileURL(file).href)).default;
      } catch (e) {
        fail(`${mine[0]}: cannot be read as a catalog (${e})`);
        continue;
      }
      const want = resolve(root, "catalogs", `${kind.name}-${loc}.json`);
      if (!existsSync(want)) fail(`catalogs/${kind.name}-${loc}.json missing: run python3 scripts/messages.py`);
      else if (JSON.stringify(cat) !== JSON.stringify(JSON.parse(readFileSync(want, "utf8"))))
        fail(`${mine[0]} differs from catalogs/${kind.name}-${loc}.json`);
      if (!Object.keys(cat).length) fail(`${kind.what} ${loc} is empty`);
      const full = msgsOf(loc);
      for (const k of Object.keys(cat))
        if (Object.hasOwn(full, k)) fail(`${kind.what} ${loc}: ${k} is also a key of the full catalog`);
      keysOf.set(loc, Object.keys(cat).sort().join(","));
    }
    if (new Set(keysOf.values()).size > 1) fail(`the ${kind.what} chunks have different keys per language`);
    textsOf.set(kind.name, texts);
  }
  // a vault's page with the plugins' text and every other lazy catalog in, as one gzip stream, per language (its view's
  // parts and the four lazy catalogs, messages.py PLUGINS_VIEW; the firstrun part is not one of them, above)
  for (const loc of readdirSync(resolve(dist, "_locales"))) {
    const names = [
      ...["core", "security", "accounts", "backup", "misc", "general", "unlock"].map((part) =>
        assetNames.find((n) => n.startsWith(`settings-locale-${part}-${loc}-`)),
      ),
      assetNames.find((n) => n.startsWith(`shares-locale-${loc}-`)),
      assetNames.find((n) => n.startsWith(`device-locale-${loc}-`)),
      assetNames.find((n) => n.startsWith(`plugins-locale-${loc}-`)),
      assetNames.find((n) => n.startsWith(`restart-locale-${loc}-`)),
    ];
    if (names.some((n) => !n)) continue; // a missing chunk has failed above
    const gz = gzipSync(Buffer.concat(names.map((n) => readFileSync(resolve(dist, "assets", n))))).length;
    console.log(
      `a vault's page with the plugins' text and every other lazy catalog in (${loc}): ${gz} B gz (limit ${SHARES_PAGE_GZ} B)`,
    );
    if (flavour !== "dev" && gz > SHARES_PAGE_GZ)
      fail(
        `a vault's page with the plugins' text and every other lazy catalog in (${loc}) is ${gz} B gz, over ${SHARES_PAGE_GZ} B`,
      );
  }
  for (const problem of pluginPageProblems(dist, textsOf, kinds)) fail(problem);
  for (const f of scripts)
    if (f.rel === swRel && /\bruntime\.connect\(/.test(f.text))
      fail(`${f.rel}: runtime.connect in the worker; the worker opens no port`);
}

// The device unlock (DEVICE_CATALOG_GZ above): exactly one lock-screen chunk, one box chunk and one text chunk per language
// (assets/device-locale-<lang>-*.js, named in scripts/build.mjs), each text chunk exactly the generated file, within its
// budget, with keys of no other catalog and the same keys in every language; a vault's page with every lazy catalog in
// within SHARES_PAGE_GZ; none of them, and no WebAuthn call, in any page's static graph; the lock screen's chunk and the
// text reachable from the popup, the side panel and the settings page, the box from the settings page only.
{
  const assetNames = readdirSync(resolve(dist, "assets"));
  const js = assetNames.filter((n) => n.endsWith(".js"));
  const one = (re, what) => {
    const found = assetNames.filter((n) => re.test(n));
    if (found.length !== 1) fail(`expected one ${what}, found ${found.length}`);
    return found[0];
  };
  const button = one(/^DeviceUnlock-[A-Za-z0-9_-]+\.js$/, "device unlock chunk assets/DeviceUnlock-*.js");
  const box = one(/^DeviceBox-[A-Za-z0-9_-]+\.js$/, "device box chunk assets/DeviceBox-*.js");
  const texts = [];
  const keysOf = new Map();
  for (const loc of readdirSync(resolve(dist, "_locales"))) {
    const prefix = `device-locale-${loc}-`;
    const mine = assetNames.filter((n) => n.startsWith(prefix) && /^[A-Za-z0-9_-]+\.js$/.test(n.slice(prefix.length)));
    if (mine.length !== 1) {
      fail(`locale ${loc}: expected one device unlock text chunk assets/${prefix}*.js, found ${mine.length}`);
      continue;
    }
    const file = resolve(dist, "assets", mine[0]);
    texts.push(mine[0]);
    const gz = gzipSync(readFileSync(file)).length;
    console.log(`device unlock text ${loc}: ${gz} B gz (limit ${DEVICE_CATALOG_GZ} B)`);
    if (flavour !== "dev" && gz > DEVICE_CATALOG_GZ)
      fail(`device unlock text ${loc} is ${gz} B gz, over its limit of ${DEVICE_CATALOG_GZ} B`);
    let cat;
    try {
      cat = (await import(pathToFileURL(file).href)).default;
    } catch (e) {
      fail(`${mine[0]}: cannot be read as a catalog (${e})`);
      continue;
    }
    const want = resolve(root, "catalogs", `device-${loc}.json`);
    if (!existsSync(want)) fail(`catalogs/device-${loc}.json missing: run python3 scripts/messages.py`);
    else if (JSON.stringify(cat) !== JSON.stringify(JSON.parse(readFileSync(want, "utf8"))))
      fail(`${mine[0]} differs from catalogs/device-${loc}.json`);
    if (!Object.keys(cat).length) fail(`device unlock text ${loc} is empty`);
    const full = msgsOf(loc);
    for (const k of Object.keys(cat))
      if (Object.hasOwn(full, k)) fail(`device unlock text ${loc}: ${k} is also a key of the full catalog`);
    keysOf.set(loc, Object.keys(cat).sort().join(","));
  }
  if (new Set(keysOf.values()).size > 1) fail("the device unlock text chunks have different keys per language");
  // a vault's page with every lazy catalog in (the shares' and the device unlock's), as one gzip stream, per language
  const VAULT_PARTS = ["core", "security", "accounts", "backup", "misc", "general", "unlock"];
  for (const loc of readdirSync(resolve(dist, "_locales"))) {
    const names = [
      ...VAULT_PARTS.map((part) => assetNames.find((n) => n.startsWith(`settings-locale-${part}-${loc}-`))),
      assetNames.find((n) => n.startsWith(`shares-locale-${loc}-`)),
      assetNames.find((n) => n.startsWith(`device-locale-${loc}-`)),
    ];
    if (names.some((n) => !n)) continue; // a missing chunk has failed above
    const gz = gzipSync(Buffer.concat(names.map((n) => readFileSync(resolve(dist, "assets", n))))).length;
    console.log(`a vault's page with every lazy catalog in (${loc}): ${gz} B gz (limit ${SHARES_PAGE_GZ} B)`);
    if (flavour !== "dev" && gz > SHARES_PAGE_GZ)
      fail(
        `a vault's page with every lazy catalog in (${loc}) is ${gz} B gz, over the ${SHARES_PAGE_GZ} B it may hold`,
      );
  }
  const graphs = (page) => {
    const html = resolve(dist, page);
    if (!existsSync(html)) return null;
    const refs = [...readFileSync(html, "utf8").matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.js)"/g)]
      .map((x) => x[1])
      .filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u))
      .map((u) => resolve(dirname(html), u));
    const walk = (follow) => {
      const seen = new Set();
      const todo = [...refs];
      while (todo.length) {
        const f = todo.pop();
        if (seen.has(f) || !existsSync(f)) continue;
        seen.add(f);
        todo.push(...follow(f, readFileSync(f, "utf8")));
      }
      return seen;
    };
    const statics = walk((f, text) =>
      [...text.matchAll(/\b(?:import|export)\s*(?:[\w$*{][^"';]*?\s*from\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g)].map(
        (m) => resolve(dirname(f), m[1]),
      ),
    );
    const reach = walk((_, text) => js.filter((n) => text.includes(n)).map((n) => resolve(dist, "assets", n)));
    return { statics, reach };
  };
  const at = (n) => resolve(dist, "assets", n);
  const lazy = [button, box, ...texts].filter(Boolean);
  for (const page of ["popup/index.html", "sidepanel/index.html", "options/index.html"]) {
    const g = graphs(page);
    if (!g) continue;
    for (const n of lazy) if (g.statics.has(at(n))) fail(`${page} loads ${n} statically; it must load on first use`);
    for (const f of g.statics)
      if (/\bcredentials\.(?:get|create)\b/.test(readFileSync(f, "utf8")))
        fail(`${page} calls WebAuthn from its static graph (${basename(f)}); the device unlock is lazy`);
    for (const n of [button, ...texts].filter(Boolean))
      if (!g.reach.has(at(n))) fail(`${page} cannot load ${n} (the device unlock)`);
    if (box && page !== "options/index.html" && g.reach.has(at(box)))
      fail(`${page} can load the device box ${box}; it is the settings page's`);
    if (box && page === "options/index.html" && !g.reach.has(at(box)))
      fail(`the settings page cannot load the device box ${box}`);
  }
}

// The PIN's record (RESTART_CATALOG_GZ above): exactly one steps chunk (assets/pin-restart-steps-*.js), one chunk of the PIN
// box's lazy part (assets/PinRestartBox-*.js) and, per language, one text chunk of its catalog
// (assets/restart-locale-<lang>-*.js; named in scripts/build.mjs), each text chunk exactly the generated file, within its
// budget, with keys of no other catalog and the same keys in every language; none of them in any page's static graph, nor
// anything that carries the wrap's AAD prefix (its crypto) in the popup's or the side panel's (the settings page's own PIN
// box carries it: changing the PIN makes the record, pin-admin.ts). Every page reaches the steps chunk (its lock screen);
// the settings page reaches the PIN box's part and its text, and the popup and the side panel never do.
{
  const assetNames = readdirSync(resolve(dist, "assets"));
  const js = assetNames.filter((n) => n.endsWith(".js"));
  const one = (re, what) => {
    const found = assetNames.filter((n) => re.test(n));
    if (found.length !== 1) fail(`expected one ${what}, found ${found.length}`);
    return found[0];
  };
  const steps = one(/^pin-restart-steps-[A-Za-z0-9_-]+\.js$/, "PIN record steps chunk assets/pin-restart-steps-*.js");
  const box = one(/^PinRestartBox-[A-Za-z0-9_-]+\.js$/, "PIN box lazy part chunk assets/PinRestartBox-*.js");
  const texts = [];
  const keysOf = new Map();
  for (const loc of readdirSync(resolve(dist, "_locales"))) {
    const prefix = `restart-locale-${loc}-`;
    const mine = assetNames.filter((n) => n.startsWith(prefix) && /^[A-Za-z0-9_-]+\.js$/.test(n.slice(prefix.length)));
    if (mine.length !== 1) {
      fail(`locale ${loc}: expected one PIN record text chunk assets/${prefix}*.js, found ${mine.length}`);
      continue;
    }
    const file = resolve(dist, "assets", mine[0]);
    texts.push(mine[0]);
    const gz = gzipSync(readFileSync(file)).length;
    console.log(`PIN record text ${loc}: ${gz} B gz (limit ${RESTART_CATALOG_GZ} B)`);
    if (flavour !== "dev" && gz > RESTART_CATALOG_GZ)
      fail(`PIN record text ${loc} is ${gz} B gz, over its limit of ${RESTART_CATALOG_GZ} B`);
    let cat;
    try {
      cat = (await import(pathToFileURL(file).href)).default;
    } catch (e) {
      fail(`${mine[0]}: cannot be read as a catalog (${e})`);
      continue;
    }
    const want = resolve(root, "catalogs", `restart-${loc}.json`);
    if (!existsSync(want)) fail(`catalogs/restart-${loc}.json missing: run python3 scripts/messages.py`);
    else if (JSON.stringify(cat) !== JSON.stringify(JSON.parse(readFileSync(want, "utf8"))))
      fail(`${mine[0]} differs from catalogs/restart-${loc}.json`);
    if (!Object.keys(cat).length) fail(`PIN record text ${loc} is empty`);
    const full = msgsOf(loc);
    for (const k of Object.keys(cat))
      if (Object.hasOwn(full, k)) fail(`PIN record text ${loc}: ${k} is also a key of the full catalog`);
    keysOf.set(loc, Object.keys(cat).sort().join(","));
  }
  if (new Set(keysOf.values()).size > 1) fail("the PIN record text chunks have different keys per language");
  const graphs = (page) => {
    const html = resolve(dist, page);
    if (!existsSync(html)) return null;
    const refs = [...readFileSync(html, "utf8").matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.js)"/g)]
      .map((x) => x[1])
      .filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u))
      .map((u) => resolve(dirname(html), u));
    const walk = (follow) => {
      const seen = new Set();
      const todo = [...refs];
      while (todo.length) {
        const f = todo.pop();
        if (seen.has(f) || !existsSync(f)) continue;
        seen.add(f);
        todo.push(...follow(f, readFileSync(f, "utf8")));
      }
      return seen;
    };
    const statics = walk((f, text) =>
      [...text.matchAll(/\b(?:import|export)\s*(?:[\w$*{][^"';]*?\s*from\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g)].map(
        (m) => resolve(dirname(f), m[1]),
      ),
    );
    const reach = walk((_, text) => js.filter((n) => text.includes(n)).map((n) => resolve(dist, "assets", n)));
    return { statics, reach };
  };
  const at = (n) => resolve(dist, "assets", n);
  const lazy = [steps, box, ...texts].filter(Boolean);
  for (const page of ["popup/index.html", "sidepanel/index.html", "options/index.html"]) {
    const g = graphs(page);
    if (!g) continue;
    const settings = page === "options/index.html";
    for (const n of lazy) if (g.statics.has(at(n))) fail(`${page} loads ${n} statically; it must load on first use`);
    for (const f of settings ? [] : g.statics)
      if (readFileSync(f, "utf8").includes(RESTART_TAG))
        fail(`${page} carries the PIN record's crypto in its static graph (${basename(f)}); it is lazy`);
    const own = settings ? [steps, box, ...texts] : [steps];
    for (const n of own.filter(Boolean)) if (!g.reach.has(at(n))) fail(`${page} cannot load ${n} (the PIN's record)`);
    if (!settings)
      for (const n of [box, ...texts].filter(Boolean))
        if (g.reach.has(at(n))) fail(`${page} can load ${n}: the PIN box's lazy part is the settings page's own`);
  }
}

// The backup in Chrome's sync storage's text (CSB_CATALOG_GZ above): per language one chunk (assets/csb-locale-<lang>-
// *.js; named in scripts/build.mjs), exactly the generated file, within its budget, with keys of no other catalog and
// the same keys in every language; in no page's static graph; the settings page reaches it, the popup and the side panel
// never do. A vault's page with it in, and first run with it in, as one gzip stream, within SHARES_PAGE_GZ. Its pages
// are one lazy chunk (assets/CsbPages-*.js: the card, first run's parts, the merges), which the settings page loads on
// use and the popup and the side panel can never load: nothing of it is in their counted code.
{
  const assetNames = readdirSync(resolve(dist, "assets"));
  const keysOf = new Map();
  const texts = [];
  for (const loc of readdirSync(resolve(dist, "_locales"))) {
    const prefix = `csb-locale-${loc}-`;
    const mine = assetNames.filter((n) => n.startsWith(prefix) && /^[A-Za-z0-9_-]+\.js$/.test(n.slice(prefix.length)));
    if (mine.length !== 1) {
      fail(`locale ${loc}: expected one Chrome-sync backup text chunk assets/${prefix}*.js, found ${mine.length}`);
      continue;
    }
    const file = resolve(dist, "assets", mine[0]);
    texts.push(file);
    const gz = gzipSync(readFileSync(file)).length;
    console.log(`Chrome-sync backup text ${loc}: ${gz} B gz (limit ${CSB_CATALOG_GZ} B)`);
    if (flavour !== "dev" && gz > CSB_CATALOG_GZ)
      fail(`Chrome-sync backup text ${loc} is ${gz} B gz, over its limit of ${CSB_CATALOG_GZ} B`);
    let cat;
    try {
      cat = (await import(pathToFileURL(file).href)).default;
    } catch (e) {
      fail(`${mine[0]}: cannot be read as a catalog (${e})`);
      continue;
    }
    const want = resolve(root, "catalogs", `csb-${loc}.json`);
    if (!existsSync(want)) fail(`catalogs/csb-${loc}.json missing: run python3 scripts/messages.py`);
    else if (JSON.stringify(cat) !== JSON.stringify(JSON.parse(readFileSync(want, "utf8"))))
      fail(`${mine[0]} differs from catalogs/csb-${loc}.json`);
    if (!Object.keys(cat).length) fail(`Chrome-sync backup text ${loc} is empty`);
    const full = msgsOf(loc);
    for (const k of Object.keys(cat))
      if (Object.hasOwn(full, k)) fail(`Chrome-sync backup text ${loc}: ${k} is also a key of the full catalog`);
    keysOf.set(loc, Object.keys(cat).sort().join(","));
    const views = {
      "a vault's page": ["core", "security", "accounts", "backup", "misc", "general", "unlock"],
      "first run": ["core", "firstrun"],
    };
    for (const [view, parts] of Object.entries(views)) {
      const names = parts.map((part) => assetNames.find((n) => n.startsWith(`settings-locale-${part}-${loc}-`)));
      if (names.some((n) => !n)) continue; // a missing chunk fails elsewhere
      const all = [...names.map((n) => readFileSync(resolve(dist, "assets", n))), readFileSync(file)];
      const vgz = gzipSync(Buffer.concat(all)).length;
      console.log(`${view} with the Chrome-sync backup's text in (${loc}): ${vgz} B gz (limit ${SHARES_PAGE_GZ} B)`);
      if (flavour !== "dev" && vgz > SHARES_PAGE_GZ)
        fail(`${view} with the Chrome-sync backup's text in (${loc}) is ${vgz} B gz, over ${SHARES_PAGE_GZ} B`);
    }
  }
  if (new Set(keysOf.values()).size > 1) fail("the Chrome-sync backup text chunks have different keys per language");
  const pagesChunk = assetNames.filter((n) => /^CsbPages-[A-Za-z0-9_-]+\.js$/.test(n));
  if (pagesChunk.length !== 1)
    fail(`expected one chunk of the Chrome-sync backup's pages, assets/CsbPages-*.js, found ${pagesChunk.length}`);
  const lazy = [...texts, ...pagesChunk.map((n) => resolve(dist, "assets", n))];
  for (const page of ["popup/index.html", "sidepanel/index.html", "options/index.html"]) {
    const html = resolve(dist, page);
    if (!existsSync(html)) continue;
    const seen = new Set();
    const todo = [...readFileSync(html, "utf8").matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.js)"/g)]
      .map((x) => x[1])
      .filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u))
      .map((u) => resolve(dirname(html), u));
    const statics = staticImports(todo);
    while (todo.length) {
      const f = todo.pop();
      if (seen.has(f) || !existsSync(f)) continue;
      seen.add(f);
      const text = readFileSync(f, "utf8");
      for (const n of assetNames.filter((x) => x.endsWith(".js") && text.includes(x)))
        todo.push(resolve(dist, "assets", n));
    }
    for (const t of lazy) {
      if (statics.has(t)) fail(`${page} loads ${basename(t)} statically; the Chrome-sync backup's pages are lazy`);
      const reached = seen.has(t);
      if (page === "options/index.html" ? !reached : reached)
        fail(
          `${page} ${reached ? "can" : "cannot"} load ${basename(t)} (the Chrome-sync backup's pages are the settings page's)`,
        );
    }
  }
}

// The backup in Chrome's sync storage in the popup and the side panel (src/popup/main/CsbPop.tsx: the header pill, the
// footer's problem line and its one click; src/popup/screens/CsbFound.tsx: the welcome's copy found). Their text
// (CSB_POPUP_CATALOG_GZ above): per language one chunk (assets/csb-popup-locale-<lang>-*.js; named in
// scripts/build.mjs), exactly the generated file, within its budget, with keys of no other catalog and the same keys in
// every language; in no page's static graph; the popup and the side panel reach it, the settings page never does. The
// pill's chunk (assets/CsbPop-*.js): one, which both reach, lazily, so nothing of it is in their counted code. And
// nothing either can load, statically or lazily, names a message of the backup's (a string "sk-csb-…", as a message's
// type is written; a comment of a build that keeps them is not one): the settings page alone
// asks the worker for anything (src/platform/sender-policy.ts); the popup's "立即备份" only leaves "turn on now" for the
// card (src/platform/cloud-go.ts, its session key, which both reach).
{
  const assetNames = readdirSync(resolve(dist, "assets"));
  const keysOf = new Map();
  const texts = [];
  for (const loc of readdirSync(resolve(dist, "_locales"))) {
    const prefix = `csb-popup-locale-${loc}-`;
    const mine = assetNames.filter((n) => n.startsWith(prefix) && /^[A-Za-z0-9_-]+\.js$/.test(n.slice(prefix.length)));
    if (mine.length !== 1) {
      fail(
        `locale ${loc}: expected one Chrome-sync backup popup text chunk assets/${prefix}*.js, found ${mine.length}`,
      );
      continue;
    }
    const file = resolve(dist, "assets", mine[0]);
    texts.push(file);
    const gz = gzipSync(readFileSync(file)).length;
    console.log(`Chrome-sync backup popup text ${loc}: ${gz} B gz (limit ${CSB_POPUP_CATALOG_GZ} B)`);
    if (flavour !== "dev" && gz > CSB_POPUP_CATALOG_GZ)
      fail(`Chrome-sync backup popup text ${loc} is ${gz} B gz, over its limit of ${CSB_POPUP_CATALOG_GZ} B`);
    let cat;
    try {
      cat = (await import(pathToFileURL(file).href)).default;
    } catch (e) {
      fail(`${mine[0]}: cannot be read as a catalog (${e})`);
      continue;
    }
    const want = resolve(root, "catalogs", `csb-popup-${loc}.json`);
    if (!existsSync(want)) fail(`catalogs/csb-popup-${loc}.json missing: run python3 scripts/messages.py`);
    else if (JSON.stringify(cat) !== JSON.stringify(JSON.parse(readFileSync(want, "utf8"))))
      fail(`${mine[0]} differs from catalogs/csb-popup-${loc}.json`);
    if (!Object.keys(cat).length) fail(`Chrome-sync backup popup text ${loc} is empty`);
    const full = msgsOf(loc);
    for (const k of Object.keys(cat))
      if (Object.hasOwn(full, k)) fail(`Chrome-sync backup popup text ${loc}: ${k} is also a key of the full catalog`);
    keysOf.set(loc, Object.keys(cat).sort().join(","));
  }
  if (new Set(keysOf.values()).size > 1)
    fail("the Chrome-sync backup popup text chunks have different keys per language");
  const pop = assetNames.filter((n) => /^CsbPop-[A-Za-z0-9_-]+\.js$/.test(n));
  if (pop.length !== 1)
    fail(`expected one chunk of the Chrome-sync backup's pill and footer, assets/CsbPop-*.js, found ${pop.length}`);
  const pill = pop.map((n) => resolve(dist, "assets", n));
  for (const page of ["popup/index.html", "sidepanel/index.html", "options/index.html"]) {
    const html = resolve(dist, page);
    if (!existsSync(html)) continue;
    const seen = new Set();
    const todo = [...readFileSync(html, "utf8").matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.js)"/g)]
      .map((x) => x[1])
      .filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u))
      .map((u) => resolve(dirname(html), u));
    const statics = staticImports(todo);
    const surface = page !== "options/index.html";
    while (todo.length) {
      const f = todo.pop();
      if (seen.has(f) || !existsSync(f)) continue;
      seen.add(f);
      const text = readFileSync(f, "utf8");
      if (surface && /["'`]sk-csb-/.test(text))
        fail(
          `${page} can load ${basename(f)}, which names a message of the Chrome-sync backup's (the settings page's only)`,
        );
      for (const n of assetNames.filter((x) => x.endsWith(".js") && text.includes(x)))
        todo.push(resolve(dist, "assets", n));
    }
    for (const t of [...texts, ...pill]) {
      if (statics.has(t)) fail(`${page} loads ${basename(t)} statically; the Chrome-sync backup's popup part is lazy`);
      const reached = seen.has(t);
      if (reached !== surface)
        fail(
          `${page} ${reached ? "can" : "cannot"} load ${basename(t)} (the Chrome-sync backup's popup part is the popup's and the side panel's)`,
        );
    }
  }
}

// The settings page's Sync section (sign-in by e-mail, the code, the join), gone from every build with the developer
// sync page (OWNER-DECISIONS/25): no flavour may carry any of it (test/unit/no-sync-section.test.ts builds each and alters
// copies). What would show that it came back, under any file name and through minification:
//   - its files' names: its code was the chunk assets/sync-ui-<hash>.js, its text the catalogs
//     assets/sync-locale-<lang>-<hash>.js and assets/sync-manage-locale-<lang>-<hash>.js, its style assets/sync-<hash>.css,
//     and the engine's chunk assets/sync-engine-<hash>.js was the one it shared with the developer page: no asset of any
//     build is named sync-*;
//   - its route: the settings page's #sync and #sync/join, as a string of the code (the rail's link, the ways in);
//   - its elements' ids, its ways in and its lines elsewhere: SECTION_IDS (the section's own, the rail's line of the live
//     sync, the popup lock screen's line, first run's way to the join, the Security section's box), each a string the
//     minifier keeps;
//   - its text: SECTION_KEYS, keys of its two catalogs as they last were, named as strings or as the unquoted keys of a
//     minified catalog.
// In their place the rail shows the backup in Chrome sync's line (RAIL_CSB_ID), in the settings page's code (what it
// loads up front), in every build.
const SECTION_IDS = [
  "sync-off-card",
  "sync-turn-on",
  "sync-join-start",
  "sync-signin",
  "sync-email",
  "sync-send-code",
  "rail-sync",
  "lock-keys-elsewhere",
  "fr-to-join",
  "sec-keys-in-sync",
];
const SECTION_KEYS = ["syncLead", "syncOffTitle", "syncPairTitle", "syncClose", "syncLabel", "syncOff"];
const SECTION_ROUTE = /["'`]#sync(?:\/[A-Za-z-]*)?["'`]/;
const RAIL_CSB_ID = "rail-csb";
{
  const assetNames = readdirSync(resolve(dist, "assets"));
  for (const n of assetNames.filter((x) => x.startsWith("sync-")))
    fail(`assets/${n}: the Sync section in the ${flavour} build (no build carries it)`);
  const named = new RegExp(`(?<![A-Za-z0-9_$])(?:${SECTION_KEYS.join("|")})(?![A-Za-z0-9_$])`);
  for (const f of scripts) {
    const route = SECTION_ROUTE.exec(f.text)?.[0];
    if (route) fail(`${f.rel}: the Sync section's route (${route}) in the ${flavour} build`);
    for (const id of SECTION_IDS)
      if (f.text.includes(`"${id}"`) || f.text.includes(`'${id}'`) || f.text.includes(`\`${id}\``))
        fail(`${f.rel}: the Sync section's element ${id} in the ${flavour} build`);
    const key = named.exec(f.text)?.[0];
    if (key) fail(`${f.rel}: names the Sync section's text (${key}) in the ${flavour} build`);
  }
  const settings = [...staticImports(htmlScripts("options/index.html"))];
  if (!settings.some((f) => readFileSync(f, "utf8").includes(RAIL_CSB_ID)))
    fail(`the settings page's code has no rail line ${RAIL_CSB_ID} (the backup in Chrome sync's)`);
}

if (errors.length) {
  console.error(
    `check-dist (${idDraft ? "ID draft" : testBuild ? "test build" : flavour}) FAILED:\n - ` + errors.join("\n - "),
  );
  process.exit(1);
}
console.log(`check-dist (${idDraft ? "ID draft" : testBuild ? "test build" : flavour}) OK`);
