# TOTP autofill, Stage 2 patch 2: per-site grants (docs/design/notes/AUTOFILL2-NOTES.md §7). The wording is a DRAFT,
# pending the owner's OQ3 (OWNER-DECISIONS/14): the offer and the Settings panel follow AUTOFILL2-PLAN §3.1 and §3.3. Patch 3
# (§9) made the offer's body say what patches 1 to 3 do (the toolbar badge, then the Fill shortcut) and, after the P2
# verify, that Chrome asks only the first time; patch 4's in-page suggestion would bring back "next to the box".
# The quoted Chrome phrase is Chrome's own permission line (verified in Chromium 156's locale files, en and zh_CN).
#   EN / ZH            Settings › Security › Autofill (src/options/Misc.tsx Autofill: the misc part; its title is also the
#                      link under the Security group's title, src/options/App.tsx: the core part).
#   AUTOFILL_EN / _ZH  the Fill card's offer (lazy, src/popup/main/Fill.tsx). "$1" is the site's host.
EN = {
    "afsTitle": "Autofill",
    "afsLead": "Sites where you turned on code suggestions. On each, Chrome lets Sixkey read and change the site's pages; Sixkey looks only for the verification-code box and sends nothing anywhere. Secure (https) pages only.",
    "afsNone": "No sites yet. After a fill on an https site, Sixkey offers to turn it on there.",
    "afsOn": "On",
    "afsOff": "Turned off in Chrome",
    "afsAgain": "Turn on again",
    "afsRemove": "Remove",
    "afsChrome": "Chrome keeps this list of sites in its own settings, unencrypted. Remove also gives back Chrome's access to that site; Chrome remembers that you allowed it once, so turning it on again does not ask again.",
    "afsOld": "Code suggestions need Chrome 140 or later.",
}
ZH = {
    "afsTitle": "自动填写",
    "afsLead": "你开启了验证码提示的网站。在这些网站上，Chrome 允许 Sixkey 读取和更改网页；Sixkey 只查找验证码输入框，不向任何地方发送数据。仅限安全（https）网页。",
    "afsNone": "还没有网站。在 https 网站上填写验证码后，Sixkey 会提示你为该网站开启。",
    "afsOn": "已开启",
    "afsOff": "已在 Chrome 中关闭",
    "afsAgain": "重新开启",
    "afsRemove": "移除",
    "afsChrome": "Chrome 会把这些网站的列表以未加密的形式保存在它自己的设置中。移除时也会交还 Chrome 对该网站的访问权限；Chrome 会记得你曾经允许过，所以再次开启时不会再询问。",
    "afsOld": "验证码提示需要 Chrome 140 或更高版本。",
}
PARTS = {
    "core": ["afsTitle"],
    "misc": ["afsLead", "afsNone", "afsOff", "afsAgain", "afsRemove", "afsChrome", "afsOld"],
}
AUTOFILL_EN = {
    "afSiteAsk": "Suggest codes automatically on $1?",
    "afSiteBody": "When you click or type in this site's verification-code box, Sixkey's toolbar icon shows 1: press the Fill shortcut to fill your code. It looks only for that box, and it sends nothing anywhere. The first time, Chrome asks you to let Sixkey \"read and change your data on $1\". Only on secure (https) pages. You can turn this off at any time in Settings › Security › Autofill. Chrome keeps the list of sites you turn on in its own settings.",
    "afSiteYes": "Turn on for $1",
    "afSiteNo": "Not now",
    "afSiteOn": "Code suggestions are on for $1.",
}
AUTOFILL_ZH = {
    "afSiteAsk": "在 $1 上自动提示验证码？",
    "afSiteBody": "当你点进此网站的验证码输入框或在其中输入时，Sixkey 的工具栏图标会显示 1：按填写快捷键即可填入验证码。它只查找这个输入框，不向任何地方发送数据。第一次开启时，Chrome 会询问是否允许 Sixkey“读取和更改您在 $1 上的数据”。仅限安全（https）网页。你可以随时在“设置 › 安全 › 自动填写”中关闭。你开启的网站列表会保存在 Chrome 自己的设置中。",
    "afSiteYes": "在 $1 上开启",
    "afSiteNo": "暂不",
    "afSiteOn": "已在 $1 上开启验证码提示。",
}
