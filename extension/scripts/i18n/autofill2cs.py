# TOTP autofill, Stage 2 patch 3: the content script, without in-page UI (docs/design/notes/AUTOFILL2-NOTES.md §9). The
# wording is a DRAFT, pending the owner's OQ3 (OWNER-DECISIONS/14).
#   EN / ZH  keys of the full catalogs, for Chrome: the toolbar tooltip the service worker sets on a tab whose code box the
#            user clicked or typed in, on a site they turned on (src/platform/content-channel.ts showCanFill; chrome.i18n).
#            "$1" is the Fill shortcut as the user set it (chrome://extensions/shortcuts).
EN = {
    "afCanFill": "Sixkey can fill the code here: press $1",
    "afCanFillOpen": "Sixkey can fill the code here: open Sixkey",
}
ZH = {
    "afCanFill": "Sixkey 可以在这里填入验证码：按 $1",
    "afCanFillOpen": "Sixkey 可以在这里填入验证码：打开 Sixkey",
}
