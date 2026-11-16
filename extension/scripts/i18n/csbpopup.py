# The backup in Chrome's sync storage in the popup and the side panel: a catalog of its own,
# catalogs/csb-popup-<lang>.json (src/ui/csb-popup-text.ts), loaded with their lazy chunks (src/popup/main/CsbPop.tsx: the
# header pill and the footer's words on a problem; src/popup/screens/CsbFound.tsx: the welcome's copy found) and counted
# in neither page's up-front budget; the settings page never loads it. "立即备份" is the popup's own backupNow; the time
# ("3 分钟前") is the browser's (Intl.RelativeTimeFormat). Disjoint keys, as every lazy catalog's.
# What the pill may claim is the settings card's: the act ("已交给 Chrome 同步"), never the outcome. The lines both pages
# show are the settings catalog's own text (catalogs/csb-<lang>.json: cbOk is csOk, cbTitle csTitle, cbFoundAt
# csFoundAt, cbArrived csArrived, cbRestore csRestore, cbBrowser csBrowser; test/unit/csb-popup-dom.test.ts holds them
# equal), so the two cannot drift apart. Where the browser is not Google Chrome, "Chrome 同步" reads cbBrowser
# (src/ui/csb-brand.ts); none of these lines names a Google account.
CSB_POPUP_EN = {
    "cbPill": "Chrome Sync",
    "cbBrowser": "browser sync",
    "cbOk": "Handed to Chrome Sync · $1",
    "cbTitle": "Automatic backup to Chrome Sync",
    "cbStopped": "Backup stopped",
    "cbProblem": "backup problem",
    "cbFoundAt": "Found a Sixkey backup in Chrome Sync (latest $1).",
    "cbArrived": "A Sixkey backup just arrived through Chrome Sync.",
    "cbRestore": "Restore from Chrome Sync",
}
CSB_POPUP_ZH = {
    "cbPill": "Chrome 同步",
    "cbBrowser": "浏览器同步",
    "cbOk": "已交给 Chrome 同步 · $1",
    "cbTitle": "自动备份到 Chrome 同步",
    "cbStopped": "备份已停",
    "cbProblem": "备份出了问题",
    "cbFoundAt": "在 Chrome 同步里找到了 Sixkey 的备份（最近一份 $1）。",
    "cbArrived": "Chrome 同步里刚到了一份 Sixkey 备份。",
    "cbRestore": "从 Chrome 同步恢复",
}
