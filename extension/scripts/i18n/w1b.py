# The plugin platform, wave 1b: autofill as the built-in official plugin (docs/design/proposals/MOD-PLATFORM.md §7.2
# Option I; OWNER-DECISIONS/16 Q-A (a); docs/design/notes/PLUGINS-W1B-NOTES.md). Its words in the plugin platform's own
# catalog (the autofill page's switch: lazy, PLUGINS_*) and the Fill button's (the popup's
# lines when autofill is off, and when Sixkey locked during the wait for a new code: AUTOFILL_*).
# the `fill` shortcut's tooltip when Sixkey does not hold `scripting` (src/background/fill-command.ts; the worker's text)
EN = {
    "fillTitleAsk": "Sixkey: open it and click Fill code",
}
ZH = {
    "fillTitleAsk": "Sixkey：打开它，点“填写验证码”",
}
PLUGINS_EN = {
    "pxAfName": "Autofill",
    "pxAfOff": "Off gives back Chrome's permission to run in pages and to each site. Your sites stay listed for when you turn it on again.",
}
PLUGINS_ZH = {
    "pxAfName": "自动填写",
    "pxAfOff": "关闭时，Sixkey 交还在网页中运行的权限和对各网站的访问权限。网站列表会保留，重新打开时继续使用。",
}
AUTOFILL_EN = {
    "afOffNow": "Autofill is off. Turn it on in Settings › Security › Autofill.",
    "afLockedNow": "Not filled: Sixkey locked while it waited for the new code.",
    "afAskNo": "Chrome did not let Sixkey into this page. Click Fill code again.",
}
AUTOFILL_ZH = {
    "afOffNow": "自动填写已关闭。可在 设置 › 安全 › 自动填写 中打开。",
    "afLockedNow": "没有填写：等待新的验证码时，Sixkey 已锁定。",
    "afAskNo": "Chrome 没有让 Sixkey 进入此页面。请再点一次“填写验证码”。",
}
