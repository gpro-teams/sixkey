# TOTP autofill, Stage 2 patch 4a: Sixkey's own surface opened by the in-page suggestion (docs/design/notes/AUTOFILL2-NOTES.md
# §12). The suggestion's own words, drawn in the page, come with patch 4b (keys of the full catalogs, for chrome.i18n).
#   EN / ZH  keys of the popup's catalog, both looked up only inside the suggestion's release gate (`SUGGEST_UI && t(...)`,
#            scripts/catalog-keys.mjs rule 5), so a build with the gate closed carries neither in the popup's text:
#            - pinLength: with a page's fill request on the lock screen, a PIN sent by Enter whose length is not the PIN's is
#              cleared and not tried, so no try is spent (review R2-M1 c). "$1" is the PIN's length, which the screen already
#              reveals by sending the PIN at it;
#            - afSugGo: the line under the Fill strip while a page's fill request is offered there, saying what Enter will
#              do (review S-5). "$1" is the host.
#            Patch 4b's, keys of the full catalogs for Chrome only (the content script reads them with chrome.i18n, in the
#            browser's language; no page's catalog carries them): the suggestion drawn next to the code box.
#            - afSugFill: its words, "$1" the page's host;
#            - afSugNo: the × that dismisses it for the page (its accessible name and tooltip);
#            - afSugWait: its words for a few seconds after a click it refused as too early, or on a page that held its
#              rendering (4B-FU, the 4b review's S-3: warn, do not block).
EN = {
    "pinLength": "Your PIN has $1 digits. Type it again.",
    "afSugGo": "Press Enter to fill the code on $1",
    "afSugFill": "Fill code with Sixkey · $1",
    "afSugNo": "Not now",
    "afSugWait": "One moment, then click again",
}
ZH = {
    "pinLength": "你的 PIN 是 $1 位数字，请重新输入。",
    "afSugGo": "按回车在 $1 上填入验证码",
    "afSugFill": "用 Sixkey 填入验证码 · $1",
    "afSugNo": "暂不",
    "afSugWait": "稍等片刻，再点一次",
}
