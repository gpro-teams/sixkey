# Source of truth for _locales and for the page catalogs in catalogs/. Run: python3 scripts/messages.py  (writes both
# _locales/<lang>/messages.json files and every catalogs/*.json file; all of them are generated, never edited by hand, and
# never part of a patch: whoever applies one runs this again).
# _locales holds the full catalogs: every key but the Sync section's, for Chrome (the manifest's __MSG_ names, the
# service worker's chrome.i18n.getMessage) and as the text the page catalogs are cut from. No page loads them whole:
#   - the popup ships only the keys its code can use: scripts/build.mjs cuts that part from these files on every build
#     (scripts/catalog-keys.mjs), so nothing here or in a fragment changes for it;
#   - the settings page loads its text in parts (docs/design/notes/BUDGET-NOTES.md): catalogs/settings-<part>-<lang>.json,
#     one per part of the page (scripts/catalog-keys.mjs SETTINGS_PARTS), each loaded before that part is drawn
#     (src/options/parts.tsx). Which part a key is in is data: the fragments' PARTS tables (below). A key the page's code
#     uses must be in the core or in the part that uses it, and every placed key must be used there:
#     test/unit/budget-split.test.ts works out, from the code, which keys each part can show, and fails on any difference
#     (node scripts/catalog-keys.mjs --settings prints where each key is used). A key in no part is not the settings
#     page's (the popup's, or Chrome's);
#   - the popup's View menu (src/popup/main/View.tsx, docs/design/notes/QUICKVIEW-NOTES.md) loads its text when the menu
#     opens: catalogs/view-<lang>.json, the keys a fragment lists in VIEW (keys of the full catalogs, new or existing:
#     the Appearance texts it shares with the settings page are listed again here, not moved), merged over the popup's
#     catalog. Which keys View.tsx can show is worked out from its code (scripts/catalog-keys.mjs viewKeys) and
#     must be exactly VIEW (test/unit/view-catalog.test.ts); the popup's own catalog does not carry them;
#   - the autofill switch's text (Settings › Security › Autofill: the switch and its recent requests) is a catalog of its
#     own, catalogs/plugins-<lang>.json (src/ui/plugins/text.ts; the name is the removed plugin platform's, whose
#     settings-page catalog it was), loaded with the switch's lazy chunk and counted in none of the settings page's
#     up-front budgets or views, as the shares' is; what a vault's page holds with it in (PLUGINS_VIEW) is held to
#     SHARES_PAGE_LIMIT. Its keys are disjoint from every other catalog's.
#   - the Sync section's text is a catalog of its own, in two files (catalogs/sync-<lang>.json, and the managing screens'
#     catalogs/sync-manage-<lang>.json), both loaded by that section before it is drawn (src/options/sync/text.ts) and
#     never by the popup, so a build without the sync user interface (scripts/sync-ui.mjs) carries none of it. Its keys
#     are disjoint from the full catalogs'.
#   - the Fill button's text (TOTP-AUTOFILL, Stage 1) is a catalog of its own, catalogs/autofill-<lang>.json, loaded with the
#     button's lazy chunk (src/popup/main/Fill.tsx, src/popup/main/fill-text.ts) and never counted in the popup's catalog:
#     the popup has no room for it. Its keys are disjoint from the full catalogs'. What the service worker shows for the
#     `fill` shortcut (the toolbar title) and the shortcut's description are keys of the full catalogs, for Chrome.
#   - the recovery code shares' text (docs/design/notes/SHAMIR-NOTES.md §6) is a catalog of its own,
#     catalogs/shares-<lang>.json, loaded with the shares' lazy chunks (src/ui/share-text.ts: the share entry, the wizard,
#     the printed share) by the popup, the side panel and the settings page, and counted in none of their up-front budgets
#     or the settings page's views (AGGREGATES): it has a budget of its own, and what a vault's page holds with it open is
#     printed beside the views (SHARES_VIEW). Its keys are disjoint from the full catalogs' and the others'.
#   - the device unlock's text (Touch ID / Windows Hello, QUICK-UNLOCK Stage 2; docs/design/notes/PRF-NOTES.md) is a
#     catalog of its own, catalogs/device-<lang>.json, loaded with the device unlock's lazy chunks (src/ui/device-text.ts:
#     the lock screen's button in the popup, the side panel and the settings page's unlock bar; Settings › Security's box)
#     and counted in none of their up-front budgets, as the shares' is. Held to a budget of its own, and what a vault's
#     page holds with every lazy catalog in (DEVICE_VIEW, the shares' with it) to SHARES_PAGE_LIMIT. Disjoint keys.
#   - the PIN record's text (OWNER-DECISIONS/20; docs/design/notes/PIN-RESTART-NOTES.md §8, §18) is a catalog of its own,
#     catalogs/restart-<lang>.json (src/ui/restart-text.ts: what the PIN costs, in Settings › Security's PIN box and its
#     inventory line), one of the lazy catalogs a vault's page can hold together (PLUGINS_VIEW, held to
#     SHARES_PAGE_LIMIT), with a budget of its own, loaded with its lazy chunk. Disjoint keys. (Its lock screen's catalog,
#     restart-popup, went with the "Also after a restart" switch on 2026-10-30.)
#   - the backup in Chrome's sync storage's text (catalogs/csb-<lang>.json, src/ui/csb-text.ts: Settings › Backup's card,
#     first run's box, the restore from Chrome Sync, what a restore found, "Choose file" opening a downloaded copy of the
#     backup) is a catalog of its own, loaded with that lazy chunk (src/options/csb/), with a budget of its own, and held
#     with a vault's view (CSB_VIEW) and with first run's (CSB_FIRSTRUN_VIEW) to SHARES_PAGE_LIMIT, as the Google Drive
#     backup's was (its catalogs went with its code). Disjoint keys.
#     Its popup's (catalogs/csb-popup-<lang>.json, src/ui/csb-popup-text.ts: the popup's and the side panel's header pill,
#     the footer's words and the welcome's copy found) is loaded with their lazy chunks, with a budget of its own, and is
#     in no view of the settings page, which never loads it; disjoint keys.
#   - the site rules' updater's text (TOTP autofill Stage 3, AF3-U2; docs/design/notes/AUTOFILL3-NOTES.md §10) is a catalog
#     of its own, catalogs/rules-<lang>.json (src/options/RulesUpdate.tsx: Settings › Security › Autofill's "Get the latest
#     site rules"), loaded with that lazy chunk, which the settings page loads only in a build whose updater's release gate
#     is open (scripts/rules-update.mjs), so a build without the updater carries none of it (as the Sync section's). A
#     budget of its own; disjoint keys.
# Every catalog a page loads has a budget (BUDGETS, gzipped, the larger language counted), and so does what a page loads
# together (AGGREGATES: each view's catalogs as one gzip stream, held to the 12 KB the settings page's whole text had as one
# catalog, and the Sync section's). This script measures each file as the build emits it (with node; see
# ESTIMATE_MARGIN), refuses one over its budget before it writes anything, and scripts/check-dist.mjs measures the built
# chunks against the same numbers (restated there; test/unit/budget-split.test.ts checks the two agree).
#
# The text lives in scripts/i18n/. base.py holds every key that existed before Phase 0.x and is frozen. Each work
# package keeps its own fragment, scripts/i18n/<package, lower case>.py (a1.py, b2.py, ...), so packages that run in
# parallel never edit the same file. A fragment is pure data and may define any of:
#   EN, ZH                    new keys; both languages, the same keys
#   OVERRIDE_EN, OVERRIDE_ZH  new text for keys that already exist; every rewrite must be declared here
#   REMOVE                    keys to delete (a list), e.g. text whose last use the package removed
#   PARTS                     where keys of the full catalogs go on the settings page: {part: [keys]} (any existing
#                             key, its own or another's; each key in one part, placed once across all fragments)
#   VIEW                      keys of the full catalogs that the popup's View menu loads when it opens: [keys] (any
#                             key, also one that a part or the popup's catalog has; each listed once)
#   SYNC_EN, SYNC_ZH          new keys of the Sync section's catalog; both languages, the same keys
#   SYNC_MANAGE_EN, SYNC_MANAGE_ZH  new keys of the Sync section's managing screens' catalog; the same rules
#   PLUGINS_EN, PLUGINS_ZH    new keys of the autofill switch's catalog (above); the same rules
#   AUTOFILL_EN, AUTOFILL_ZH  new keys of the Fill button's catalog (below); the same rules
#   SHARES_EN, SHARES_ZH      new keys of the recovery code shares' catalog (below); the same rules
#   DEVICE_EN, DEVICE_ZH      new keys of the device unlock's catalog (below); the same rules
#   RESTART_EN, RESTART_ZH    new keys of the PIN record's settings-page catalog (below); the same rules
#   RULES_EN, RULES_ZH        new keys of the site rules' updater's catalog (above); the same rules
#   CSB_EN, CSB_ZH            new keys of the backup in Chrome's sync storage's catalog (above); the same rules
#   CSB_POPUP_EN, _ZH         new keys of its popup catalog (the popup's and the side panel's); the same rules
# Any other public name is an error, so a misspelt OVERRIDE cannot be ignored without anyone noticing.
# Files are read by path (runpy), never imported. Output order: base keys first, then each fragment's new keys,
# fragments sorted by file name; a rewritten key keeps its place. This stops with an error on: a key added twice
# (by two fragments, or again over an existing key without OVERRIDE), two fragments rewriting the same key,
# rewriting or removing a key that does not exist, removing a key twice or one that is also rewritten, English
# and Chinese ending up with different keys, a key placed in a part that does not exist, placed twice, or not a key
# (removed, or the Sync section's), a manifest __MSG_ name or a getMessage key with no text, and a catalog over budget.
import glob, json, os, re, runpy, subprocess, sys, zlib

I18N = os.path.join(os.path.dirname(__file__), "i18n")
EXT = os.path.join(os.path.dirname(__file__), "..")
FRAGMENT_NAMES = {
    "EN",
    "ZH",
    "OVERRIDE_EN",
    "OVERRIDE_ZH",
    "REMOVE",
    "PARTS",
    "VIEW",
    "PLUGINS_EN",
    "PLUGINS_ZH",
    "SYNC_EN",
    "SYNC_ZH",
    "SYNC_MANAGE_EN",
    "SYNC_MANAGE_ZH",
    "AUTOFILL_EN",
    "AUTOFILL_ZH",
    "SHARES_EN",
    "SHARES_ZH",
    "DEVICE_EN",
    "DEVICE_ZH",
    "RESTART_EN",
    "RESTART_ZH",
    "RULES_EN",
    "RULES_ZH",
    "CSB_EN",
    "CSB_ZH",
    "CSB_POPUP_EN",
    "CSB_POPUP_ZH",
}
# The settings page's parts, in the order the page's text is listed (scripts/catalog-keys.mjs SETTINGS_PARTS has their
# entry modules; "core" is the rest of the page, loaded before anything is drawn).
SETTINGS_PARTS = ["core", "security", "accounts", "backup", "misc", "general", "firstrun", "unlock"]
# Gzipped bytes, the larger language counted (docs/design/notes/BUDGET-NOTES.md: each set at its measured size plus at
# least 1.5 KB, rounded up to 512 B; the Sync section's two keep that section's limit, 12 KB, each). None above 12 KB,
# the old full catalog's limit.
BUDGETS = {
    "settings-core": 5120,
    "settings-security": 5120,
    "settings-accounts": 3072,
    "settings-backup": 3072,
    "settings-misc": 3072,
    "settings-general": 3072,
    "settings-firstrun": 3072,
    "settings-unlock": 3072,
    "view": 2048,
    # the plugin platform's settings-page catalog's budget, kept for the autofill switch's text, which is all that is left
    # of it
    "plugins": 3072,
    "sync": 12288,
    "sync-manage": 12288,
    "autofill": 4096,
    # 1,5xx B (zh_CN) when it was introduced, plus at least 1.5 KB, rounded up to 512 B (docs/design/notes/SHAMIR-NOTES.md §6)
    "shares": 3072,
    # the maintainers' allowance (2026-10-23): 1,500 B (zh_CN), 1,487 B when it was introduced; raised to 1,600 B (of the
    # 1,700 allowed) with OWNER-DECISIONS/17's texts (PRF-NOTES.md §9)
    "device": 1600,
    # the PIN record's (PIN-RESTART-NOTES.md §8): its measured size when it was made plus at least 1.5 KB, rounded up to
    # 512 B, as the settings parts'
    "restart": 2048,
    # the site rules' updater's (AF3-U2): its measured size when it was made (about 400 B zh_CN) plus at least 1.5 KB,
    # rounded up to 512 B, as the settings parts'
    "rules": 2048,
    # the backup in Chrome's sync storage's: its measured size when it was made (2,4xx B zh_CN) plus at least 1.5 KB,
    # rounded up to 512 B, as the settings parts'
    "csb": 4096,
    # and its popup's: the same rule (about 400 B zh_CN when it was made)
    "csb-popup": 2048,
}
# What a page loads together, held as one gzip stream (each language) to the measure the old limits were set on: the
# settings page's whole text as one catalog (12 KB, check-dist's FULL_CATALOG_GZ) and the Sync section's as one (12 KB,
# SYNC_CATALOG_GZ). The catalogs of each view, concatenated in load order: the core, then src/options/parts.tsx partsFor's
# parts (with no vault: the wizard's; with one: the sections and the lock's), and every part together, the most one page
# can hold; the Sync section loads both of its catalogs before it draws. check-dist holds the built chunks to the same.
VIEW_LIMIT = 12288
AGGREGATES = {
    "settings page with no vault": ["settings-core", "settings-firstrun"],
    "settings page with a vault": [
        "settings-core",
        "settings-security",
        "settings-accounts",
        "settings-backup",
        "settings-misc",
        "settings-general",
        "settings-unlock",
    ],
    "settings page, every part": ["settings-" + p for p in SETTINGS_PARTS],
    "Sync section": ["sync", "sync-manage"],
}
# The most a vault's page can hold with the shares' text in: its view and the shares' catalog. Not held to VIEW_LIMIT:
# the shares' catalog is lazy and has a budget of its own, like the Fill button's in the popup (the owner's decision,
# 2026-10-23: SHAMIR-NOTES.md §6). Held instead to SHARES_PAGE_LIMIT, VIEW_LIMIT + BUDGETS["shares"] = 15 KB.
SHARES_PAGE_LIMIT = 15360
SHARES_VIEW = [
    "settings-core",
    "settings-security",
    "settings-accounts",
    "settings-backup",
    "settings-misc",
    "settings-general",
    "settings-unlock",
    "shares",
]
# The same page with the device unlock's lazy text in as well (Settings › Security's box, the unlock bar's button). Held
# to SHARES_PAGE_LIMIT too (docs/design/notes/PRF-NOTES.md).
DEVICE_VIEW = SHARES_VIEW + ["device"]
# The same page with the autofill switch's lazy text in as well (Settings › Security › Autofill): every lazy catalog the
# settings page can load, held to SHARES_PAGE_LIMIT too.
# The PIN record's (Settings › Security's PIN box: what the PIN costs) is one (PIN-RESTART-NOTES.md §8).
# What this holds to SHARES_PAGE_LIMIT is a vault's view (SHARES_VIEW's parts) with these four lazy catalogs: an extension
# of the owner's rule for the shares' (SHAMIR-NOTES.md §6), not the most one page can hold. A vault's page can also draw
# the first-run wizard (Backup's restore, Advanced › Start over), which loads the firstrun part; with it, it holds about
# 520 B more (15,783 B zh_CN at 539e9f6), which no limit holds (docs/design/notes/BUDGET3-NOTES.md §2, §6).
PLUGINS_VIEW = DEVICE_VIEW + ["plugins", "restart"]
# The backup in Chrome's sync storage's: a vault's view with its card's text in (Settings › Backup), and first run's
# with its box's and its restore's (the wizard's catalog and its own). Each a lazy catalog's page, held to
# SHARES_PAGE_LIMIT as the shares' is; neither added to PLUGINS_VIEW (a vault's page shows the card or the autofill
# page, the rule the Google Drive backup's catalog had).
CSB_VIEW = SHARES_VIEW[:-1] + ["csb"]
CSB_FIRSTRUN_VIEW = ["settings-core", "settings-firstrun", "csb"]
# The sizes are measured with Node's gzip (the one check-dist uses), on the text of each chunk exactly as the build emits
# it. Without node, Python's zlib estimates them; it compresses a little differently (up to 3.1% smaller, on short Chinese
# catalogs; 1.5% on the Sync section's), so the estimate stops this far short of a budget, which refuses whatever the
# exact measure would. check-dist holds the built chunks to the budgets themselves.
ESTIMATE_MARGIN = 0.04
GZIP_JS = (
    'const z=require("zlib");let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>'
    "console.log(JSON.stringify(JSON.parse(s).map((t)=>z.gzipSync(t).length))))"
)


def fail(msg):
    sys.exit("messages.py: " + msg)


def text_table(where, name, d):
    if not isinstance(d, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in d.items()):
        fail(f"{where}: {name} must be a dict of str -> str")
    return d


def read(path, allowed):
    where = os.path.relpath(path)
    g = {k: v for k, v in runpy.run_path(path).items() if not k.startswith("_")}
    unknown = sorted(set(g) - allowed)
    if unknown:
        fail(f"{where}: unexpected name(s) {unknown}; allowed: {sorted(allowed)}")
    out = {
        name: text_table(where, name, g.get(name, {}))
        for name in (
            "EN",
            "ZH",
            "OVERRIDE_EN",
            "OVERRIDE_ZH",
            "SYNC_EN",
            "SYNC_ZH",
            "SYNC_MANAGE_EN",
            "SYNC_MANAGE_ZH",
            "PLUGINS_EN",
            "PLUGINS_ZH",
            "AUTOFILL_EN",
            "AUTOFILL_ZH",
            "SHARES_EN",
            "SHARES_ZH",
            "DEVICE_EN",
            "DEVICE_ZH",
            "RESTART_EN",
            "RESTART_ZH",
            "RULES_EN",
            "RULES_ZH",
            "CSB_EN",
            "CSB_ZH",
            "CSB_POPUP_EN",
            "CSB_POPUP_ZH",
        )
    }
    remove = g.get("REMOVE", [])
    if not isinstance(remove, (list, tuple, set)) or not all(isinstance(k, str) for k in remove):
        fail(f"{where}: REMOVE must be a list of keys")
    if len(set(remove)) != len(list(remove)):
        fail(f"{where}: REMOVE lists a key twice")
    out["REMOVE"] = list(remove)
    parts = g.get("PARTS", {})
    if not isinstance(parts, dict) or not all(
        isinstance(p, str) and isinstance(ks, (list, tuple)) and all(isinstance(k, str) for k in ks)
        for p, ks in parts.items()
    ):
        fail(f"{where}: PARTS must be a dict of part -> list of keys")
    out["PARTS"] = {p: list(ks) for p, ks in parts.items()}
    view = g.get("VIEW", [])
    if not isinstance(view, (list, tuple)) or not all(isinstance(k, str) for k in view):
        fail(f"{where}: VIEW must be a list of keys")
    out["VIEW"] = list(view)
    return where, out


base_where, base = read(os.path.join(I18N, "base.py"), {"EN", "ZH"})
EN, ZH = dict(base["EN"]), dict(base["ZH"])

fragments = []
for path in sorted(p for p in glob.glob(os.path.join(I18N, "*.py")) if os.path.basename(p) != "base.py"):
    if not re.fullmatch(r"[a-z][a-z0-9_]*\.py", os.path.basename(path)):
        fail(f"{os.path.relpath(path)}: fragment names are lower case, like a1.py")
    fragments.append(read(path, FRAGMENT_NAMES))

# 1. New keys, from every fragment, before any rewrite or removal, so the result does not depend on file order.
added_by = {}
for where, f in fragments:
    if f["EN"].keys() != f["ZH"].keys():
        fail(f"{where}: EN and ZH add different keys: {sorted(f['EN'].keys() ^ f['ZH'].keys())}")
    for k in f["EN"]:
        if k in added_by:
            fail(f"{where}: key {k!r} is also added by {added_by[k]}")
        if k in EN:
            fail(
                f"{where}: key {k!r} already exists in {base_where}; to change its text, list it in OVERRIDE_EN / OVERRIDE_ZH"
            )
        added_by[k] = where
        EN[k], ZH[k] = f["EN"][k], f["ZH"][k]

# 2. Declared rewrites of keys that exist (in base or added above). A key keeps its position.
rewritten_by = {}
for where, f in fragments:
    for lang, table in (("EN", EN), ("ZH", ZH)):
        for k, v in f["OVERRIDE_" + lang].items():
            if k not in table:
                fail(f"{where}: OVERRIDE_{lang} rewrites {k!r}, which does not exist")
            if (lang, k) in rewritten_by:
                fail(f"{where}: OVERRIDE_{lang} rewrites {k!r}, which {rewritten_by[(lang, k)]} also rewrites")
            rewritten_by[(lang, k)] = where
            table[k] = v

# 3. Removals.
removed_by = {}
for where, f in fragments:
    for k in f["REMOVE"]:
        if k in removed_by:
            fail(f"{where}: REMOVE {k!r}, which {removed_by[k]} also removes")
        if k not in EN or k not in ZH:
            fail(f"{where}: REMOVE {k!r}, which does not exist")
        for lang in ("EN", "ZH"):
            if (lang, k) in rewritten_by:
                fail(f"{where}: REMOVE {k!r}, which {rewritten_by[(lang, k)]} rewrites")
        removed_by[k] = where
        del EN[k], ZH[k]

if EN.keys() != ZH.keys():
    fail(f"English and Chinese have different keys: {sorted(EN.keys() ^ ZH.keys())}")

# 4. The Sync section's catalogs: new keys only, both languages, none of them a key of the full catalogs, and the two
#    catalogs disjoint.
SYNC = {"sync": ({}, {}), "sync-manage": ({}, {})}
sync_by = {}
for where, f in fragments:
    for name, prefix in (("sync", "SYNC_"), ("sync-manage", "SYNC_MANAGE_")):
        en, zh = f[prefix + "EN"], f[prefix + "ZH"]
        if en.keys() != zh.keys():
            fail(f"{where}: {prefix}EN and {prefix}ZH add different keys: {sorted(en.keys() ^ zh.keys())}")
        for k in en:
            if k in sync_by:
                fail(f"{where}: sync key {k!r} is also added by {sync_by[k]}")
            if k in EN or k in added_by or k in removed_by:
                fail(f"{where}: sync key {k!r} is also a key of the full catalogs (the two sets are disjoint)")
            sync_by[k] = where
            SYNC[name][0][k], SYNC[name][1][k] = en[k], zh[k]

# 4b. The Fill button's catalog: new keys only, both languages, none of them a key of the full catalogs or the Sync section's.
AUTOFILL = ({}, {})
autofill_by = {}
for where, f in fragments:
    en, zh = f["AUTOFILL_EN"], f["AUTOFILL_ZH"]
    if en.keys() != zh.keys():
        fail(f"{where}: AUTOFILL_EN and AUTOFILL_ZH add different keys: {sorted(en.keys() ^ zh.keys())}")
    for k in en:
        if k in autofill_by:
            fail(f"{where}: autofill key {k!r} is also added by {autofill_by[k]}")
        if k in EN or k in added_by or k in removed_by or k in sync_by:
            fail(f"{where}: autofill key {k!r} is also a key of another catalog (the sets are disjoint)")
        autofill_by[k] = where
        AUTOFILL[0][k], AUTOFILL[1][k] = en[k], zh[k]

# 4b'. The autofill switch's catalog: new keys only, both languages, none of them a key of any other catalog (the
#      shares' are checked against them below, in 4c's turn, through plugins_by).
PLUGIN_TABLES = {
    "PLUGINS_": ({}, {}),
}
plugins_by = {}
for where, f in fragments:
    for prefix, table in PLUGIN_TABLES.items():
        en, zh = f[prefix + "EN"], f[prefix + "ZH"]
        if en.keys() != zh.keys():
            fail(f"{where}: {prefix}EN and {prefix}ZH add different keys: {sorted(en.keys() ^ zh.keys())}")
        for k in en:
            if k in plugins_by:
                fail(f"{where}: plugins key {k!r} is also added by {plugins_by[k]}")
            if k in EN or k in added_by or k in removed_by or k in sync_by or k in autofill_by:
                fail(f"{where}: plugins key {k!r} is also a key of another catalog (the sets are disjoint)")
            plugins_by[k] = where
            table[0][k], table[1][k] = en[k], zh[k]
PLUGINS = PLUGIN_TABLES["PLUGINS_"]

# 4c. The recovery code shares' catalog: new keys only, both languages, none of them a key of any other catalog.
SHARES = ({}, {})
shares_by = {}
for where, f in fragments:
    en, zh = f["SHARES_EN"], f["SHARES_ZH"]
    if en.keys() != zh.keys():
        fail(f"{where}: SHARES_EN and SHARES_ZH add different keys: {sorted(en.keys() ^ zh.keys())}")
    for k in en:
        if k in shares_by:
            fail(f"{where}: shares key {k!r} is also added by {shares_by[k]}")
        if k in EN or k in added_by or k in removed_by or k in sync_by or k in autofill_by or k in plugins_by:
            fail(f"{where}: shares key {k!r} is also a key of another catalog (the sets are disjoint)")
        shares_by[k] = where
        SHARES[0][k], SHARES[1][k] = en[k], zh[k]

# 4d. The device unlock's catalog: new keys only, both languages, none of them a key of any other catalog.
DEVICE = ({}, {})
device_by = {}
for where, f in fragments:
    en, zh = f["DEVICE_EN"], f["DEVICE_ZH"]
    if en.keys() != zh.keys():
        fail(f"{where}: DEVICE_EN and DEVICE_ZH add different keys: {sorted(en.keys() ^ zh.keys())}")
    for k in en:
        if k in device_by:
            fail(f"{where}: device key {k!r} is also added by {device_by[k]}")
        if k in EN or k in added_by or k in removed_by or k in sync_by or k in autofill_by or k in shares_by:
            fail(f"{where}: device key {k!r} is also a key of another catalog (the sets are disjoint)")
        device_by[k] = where
        DEVICE[0][k], DEVICE[1][k] = en[k], zh[k]

# 4e. The PIN record's catalog: new keys only, both languages, none of them a key of any other catalog.
RESTART_TABLES = {"RESTART_": ({}, {})}
restart_by = {}
for where, f in fragments:
    for prefix, table in RESTART_TABLES.items():
        en, zh = f[prefix + "EN"], f[prefix + "ZH"]
        if en.keys() != zh.keys():
            fail(f"{where}: {prefix}EN and {prefix}ZH add different keys: {sorted(en.keys() ^ zh.keys())}")
        for k in en:
            if k in restart_by:
                fail(f"{where}: restart key {k!r} is also added by {restart_by[k]}")
            if (
                k in EN
                or k in added_by
                or k in removed_by
                or k in sync_by
                or k in autofill_by
                or k in shares_by
                or k in plugins_by
                or k in device_by
            ):
                fail(f"{where}: restart key {k!r} is also a key of another catalog (the sets are disjoint)")
            restart_by[k] = where
            table[0][k], table[1][k] = en[k], zh[k]
RESTART = RESTART_TABLES["RESTART_"]

# 4h. The site rules' updater's catalog: new keys only, both languages, none of them a key of any other catalog.
RULES = ({}, {})
rules_by = {}
for where, f in fragments:
    en, zh = f["RULES_EN"], f["RULES_ZH"]
    if en.keys() != zh.keys():
        fail(f"{where}: RULES_EN and RULES_ZH add different keys: {sorted(en.keys() ^ zh.keys())}")
    for k in en:
        if k in rules_by:
            fail(f"{where}: rules key {k!r} is also added by {rules_by[k]}")
        if (
            k in EN
            or k in added_by
            or k in removed_by
            or k in sync_by
            or k in autofill_by
            or k in shares_by
            or k in plugins_by
            or k in device_by
            or k in restart_by
        ):
            fail(f"{where}: rules key {k!r} is also a key of another catalog (the sets are disjoint)")
        rules_by[k] = where
        RULES[0][k], RULES[1][k] = en[k], zh[k]

# 4i. The backup in Chrome's sync storage's catalogs (the settings page's, the popup's): new keys only, both languages,
#     none of them a key of any other catalog.
CSB = ({}, {})
CSB_POPUP = ({}, {})
csb_by = {}
for where, f in fragments:
    for prefix, table in (("CSB_", CSB), ("CSB_POPUP_", CSB_POPUP)):
        en, zh = f[prefix + "EN"], f[prefix + "ZH"]
        if en.keys() != zh.keys():
            fail(f"{where}: {prefix}EN and {prefix}ZH add different keys: {sorted(en.keys() ^ zh.keys())}")
        for k in en:
            if k in csb_by:
                fail(f"{where}: csb key {k!r} is also added by {csb_by[k]}")
            if (
                k in EN
                or k in added_by
                or k in removed_by
                or k in sync_by
                or k in autofill_by
                or k in shares_by
                or k in plugins_by
                or k in device_by
                or k in restart_by
                or k in rules_by
            ):
                fail(f"{where}: csb key {k!r} is also a key of another catalog (the sets are disjoint)")
            csb_by[k] = where
            table[0][k], table[1][k] = en[k], zh[k]

# 5. The settings page's parts: every placed key is a key of the full catalogs, in one part, placed once.
placed_by = {}
part_of = {}
for where, f in fragments:
    for part, keys in f["PARTS"].items():
        if part not in SETTINGS_PARTS:
            fail(
                f"{where}: PARTS names {part!r}, which is not a part of the settings page ({', '.join(SETTINGS_PARTS)})"
            )
        for k in keys:
            if k in placed_by:
                fail(f"{where}: PARTS places {k!r}, which {placed_by[k]} places too (in {part_of[k]!r})")
            if k not in EN:
                why = "the Sync section's" if k in sync_by else "removed" if k in removed_by else "not a key"
                fail(f"{where}: PARTS places {k!r}, which is {why}: only keys of the full catalogs go in a part")
            placed_by[k], part_of[k] = where, part

# 5b. The popup's View menu: every listed key is a key of the full catalogs, listed once (it may also be in a part or in
#     the popup's catalog: the texts are the same, the files are loaded by different pages).
view_by = {}
for where, f in fragments:
    for k in f["VIEW"]:
        if k in view_by:
            fail(f"{where}: VIEW lists {k!r}, which {view_by[k]} lists too")
        if k not in EN:
            why = "the Sync section's" if k in sync_by else "removed" if k in removed_by else "not a key"
            fail(f"{where}: VIEW lists {k!r}, which is {why}: only keys of the full catalogs go in the view part")
        view_by[k] = where

# 6. Chrome's own use of _locales: every __MSG_ name in the manifests, and every key the code passes to
#    chrome.i18n.getMessage, has text in both languages (scripts/check-dist.mjs checks the built files again).
chrome_keys = set()
for path in sorted(glob.glob(os.path.join(EXT, "manifest*.json"))):
    chrome_keys |= set(re.findall(r"__MSG_(\w+)__", open(path, encoding="utf-8").read()))
for path in sorted(glob.glob(os.path.join(EXT, "src", "**", "*.ts*"), recursive=True)):
    for k in re.findall(r"\bi18n\.getMessage\(\s*[\"']([A-Za-z0-9_]+)[\"']", open(path, encoding="utf-8").read()):
        chrome_keys.add(k)
for k in sorted(chrome_keys):
    if k not in EN:
        fail(f"{k!r} is named by a manifest or chrome.i18n.getMessage but has no text in _locales")


def write(path, d):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({k: {"message": v} for k, v in d.items()}, f, ensure_ascii=False, indent=2)
        f.write("\n")


def template_literal(s):
    return "`" + s.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${") + "`"


def chunk_text(d):
    """The catalog as the build emits its chunk: an object of template literals (scripts/check-dist.mjs measures it)."""
    return (
        "var e={" + ",".join(f"{k}:{{message:{template_literal(v)}}}" for k, v in d.items()) + "};export{e as default};"
    )


def gzip_sizes(texts):
    """Gzipped sizes, by Node's zlib when node runs here (exact), else Python's (an estimate); and which it was."""
    try:
        r = subprocess.run(["node", "-e", GZIP_JS], input=json.dumps(texts), capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            return json.loads(r.stdout), True
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    sizes = []
    for t in texts:
        c = zlib.compressobj(6, zlib.DEFLATED, 31)
        sizes.append(len(c.compress(t.encode("utf-8")) + c.flush()))
    return sizes, False


catalogs = {}
for part in SETTINGS_PARTS:
    keys = [k for k in EN if part_of.get(k) == part]
    catalogs["settings-" + part] = ({k: EN[k] for k in keys}, {k: ZH[k] for k in keys})
catalogs["view"] = ({k: EN[k] for k in EN if k in view_by}, {k: ZH[k] for k in ZH if k in view_by})
catalogs.update(SYNC)
catalogs["plugins"] = PLUGINS
catalogs["autofill"] = AUTOFILL
catalogs["shares"] = SHARES
catalogs["device"] = DEVICE
catalogs["restart"] = RESTART
catalogs["rules"] = RULES
catalogs["csb"] = CSB
catalogs["csb-popup"] = CSB_POPUP

# 7. The budgets, measured before anything is written: each catalog, then each view's catalogs together.
names = list(catalogs)
texts = {(name, i): chunk_text(catalogs[name][i]) for name in names for i in (0, 1)}
together = {
    (view, i): "".join(texts[(name, i)] for name in parts) for view, parts in AGGREGATES.items() for i in (0, 1)
}
together.update({("plugins view", i): "".join(texts[(name, i)] for name in PLUGINS_VIEW) for i in (0, 1)})
together.update({("shares view", i): "".join(texts[(name, i)] for name in SHARES_VIEW) for i in (0, 1)})
together.update({("device view", i): "".join(texts[(name, i)] for name in DEVICE_VIEW) for i in (0, 1)})
together.update({("csb view", i): "".join(texts[(name, i)] for name in CSB_VIEW) for i in (0, 1)})
together.update({("csb first run", i): "".join(texts[(name, i)] for name in CSB_FIRSTRUN_VIEW) for i in (0, 1)})
measured, exact = gzip_sizes([*texts.values(), *together.values()])
size = dict(zip([*texts, *together], measured))
mark = "" if exact else "~"
sizes = []
for name in names:
    gz, budget = max(size[(name, 0)], size[(name, 1)]), BUDGETS[name]
    sizes.append(f"{name} {len(catalogs[name][0])} keys, {mark}{gz} of {budget} B")
    if gz > (budget if exact else int(budget * (1 - ESTIMATE_MARGIN))):
        fail(
            f"catalog {name} is {'' if exact else 'about '}{gz} B gzipped, over {'' if exact else 'the estimate margin of '}"
            f"its budget of {budget} B (docs/design/notes/BUDGET-NOTES.md: move text to another part, or the budget is "
            "the owner's decision); nothing was written"
        )
views = []
for view in AGGREGATES:
    gz = max(size[(view, 0)], size[(view, 1)])
    views.append(f"{view} {mark}{gz} of {VIEW_LIMIT} B")
    if gz > (VIEW_LIMIT if exact else int(VIEW_LIMIT * (1 - ESTIMATE_MARGIN))):
        fail(
            f"what the {view} loads together is {'' if exact else 'about '}{gz} B gzipped, over "
            f"{'' if exact else 'the estimate margin of '}the {VIEW_LIMIT} B its text had as one catalog "
            "(docs/design/notes/BUDGET-NOTES.md; the limit is the owner's decision); nothing was written"
        )

for view, what in (
    ("shares view", "the shares' text"),
    ("device view", "every lazy catalog"),
    ("csb view", "the backup in Chrome sync's text"),
    ("csb first run", "the backup in Chrome sync's text (first run)"),
):
    lazy_page = max(size[(view, 0)], size[(view, 1)])
    if lazy_page > (SHARES_PAGE_LIMIT if exact else int(SHARES_PAGE_LIMIT * (1 - ESTIMATE_MARGIN))):
        fail(
            f"a vault's page with {what} in is {'' if exact else 'about '}{lazy_page} B gzipped, over the "
            f"{SHARES_PAGE_LIMIT} B a page with a lazy catalog may hold (SHAMIR-NOTES.md §6); nothing was written"
        )

plugins_page = max(size[("plugins view", 0)], size[("plugins view", 1)])
if plugins_page > (SHARES_PAGE_LIMIT if exact else int(SHARES_PAGE_LIMIT * (1 - ESTIMATE_MARGIN))):
    fail(
        f"a vault's page with the plugins' and the shares' text in is {'' if exact else 'about '}{plugins_page} B "
        f"gzipped, over the {SHARES_PAGE_LIMIT} B a page with lazy catalogs may hold (PLUGINS-W1A-NOTES.md §6); nothing "
        "was written"
    )

root = os.path.join(EXT, "_locales")
for loc, d in (("en", EN), ("zh_CN", ZH)):
    os.makedirs(os.path.join(root, loc), exist_ok=True)
    write(os.path.join(root, loc, "messages.json"), d)
cat_root = os.path.join(EXT, "catalogs")
os.makedirs(cat_root, exist_ok=True)
wanted = set()
for name, (en, zh) in catalogs.items():
    for loc, d in (("en", en), ("zh_CN", zh)):
        file = f"{name}-{loc}.json"
        wanted.add(file)
        write(os.path.join(cat_root, file), d)
for file in os.listdir(cat_root):
    if (
        re.fullmatch(
            r"(settings|sync|view|autofill|shares|device|plugins|restart|cloud|rules|csb)(-[a-z]+)*-[A-Za-z_]+\.json",
            file,
        )
        and file not in wanted
    ):
        os.remove(os.path.join(cat_root, file))  # a catalog of a part there is no more

print(
    len(EN),
    "messages,",
    len(placed_by),
    "of them on the settings page,",
    sum(len(en) for en, _ in SYNC.values()),
    "in the Sync section's catalogs,",
    len(view_by),
    "in the popup's view part,",
    len(AUTOFILL[0]),
    "in the Fill button's,",
    len(SHARES[0]),
    "in the shares',",
    len(DEVICE[0]),
    "in the device unlock's,",
    len(RESTART[0]),
    "in the PIN record's,",
    len(RULES[0]),
    "in the site rules' updater's,",
    len(CSB[0]),
    "in the backup in Chrome sync's,",
    len(CSB_POPUP[0]),
    "in its popup's",
)
print(f"catalogs, gzipped ({'Node' if exact else 'estimated without node'}):", "; ".join(sizes))
print("loaded together:", "; ".join(views))
print(
    f"a vault's page with the shares' text in (lazy, not held to {VIEW_LIMIT} B; SHAMIR-NOTES.md §6): "
    f"{mark}{max(size[('shares view', 0)], size[('shares view', 1)])} of {SHARES_PAGE_LIMIT} B; "
    f"with the device unlock's too: {mark}{max(size[('device view', 0)], size[('device view', 1)])} of "
    f"{SHARES_PAGE_LIMIT} B"
)
print(
    f"the autofill switch's text: {len(PLUGINS[0])} keys; a vault's page with it and every other lazy catalog in: "
    f"{mark}{plugins_page} of {SHARES_PAGE_LIMIT} B"
)
print(
    f"the backup in Chrome sync's text (lazy): a vault's page with it in "
    f"{mark}{max(size[('csb view', 0)], size[('csb view', 1)])} of {SHARES_PAGE_LIMIT} B; first run with it in "
    f"{mark}{max(size[('csb first run', 0)], size[('csb first run', 1)])} of {SHARES_PAGE_LIMIT} B"
)
if fragments:
    print("fragments:", ", ".join(w for w, _ in fragments))
