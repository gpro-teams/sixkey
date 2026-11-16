# The settings page's rail in a build without the Sync section (scripts/sync-ui.mjs): in place of the live sync's line,
# the backup in Chrome's sync storage, in a few of the words its card (catalogs/csb-<lang>.json) and the popup's pill
# (catalogs/csb-popup-<lang>.json) use: the act ("已交给", "handed over"), never "backed up". The label is the pill's
# (railCsb is cbPill, railCsbBrowser cbBrowser and csBrowser, railCsbStopped cbStopped; test/unit/rail-csb-dom.test.ts
# holds them equal), "Chrome 同步" written as this browser's word for it elsewhere (src/ui/csb-brand.ts). The time is
# the browser's (src/ui/ago.ts). A copy due is the card's csSaving, shortened ("正在交给…"). Off, and on with nothing
# to hand over yet, are the words the settings page uses for a switch's state (railCsbOff is clipOff, railCsbOn
# clipOn; the same test holds them equal), as keys of their own, so the clipboard's text can change without the rail's.
# All in the page's core: the rail is on every view.
EN = {
    "railCsb": "Chrome Sync",
    "railCsbBrowser": "browser sync",
    "railCsbOff": "Off",
    "railCsbOn": "On",
    "railCsbSaving": "Handing over…",
    "railCsbOk": "Handed over · $1",
    "railCsbSoon": "Handing over soon",
    "railCsbFailed": "Not handed over · will retry",
    "railCsbStopped": "Backup stopped",
}
ZH = {
    "railCsb": "Chrome 同步",
    "railCsbBrowser": "浏览器同步",
    "railCsbOff": "未开启",
    "railCsbOn": "已开启",
    "railCsbSaving": "正在交给…",
    "railCsbOk": "已交给 · $1",
    "railCsbSoon": "稍后自动交给",
    "railCsbFailed": "没交给 · 会自动重试",
    "railCsbStopped": "备份已停",
}
PARTS = {
    "core": [
        "railCsb",
        "railCsbBrowser",
        "railCsbOff",
        "railCsbOn",
        "railCsbSaving",
        "railCsbOk",
        "railCsbSoon",
        "railCsbFailed",
        "railCsbStopped",
    ],
}
