# The autofill switch's words (Settings › Security › Autofill: options/AutofillSwitch.tsx), in the catalog the plugin
# platform's settings-page text had (catalogs/plugins-<lang>.json; src/ui/plugins/text.ts), loaded with the switch's lazy
# chunk and counted in no page's up-front budget. The plugin platform was removed on 2026-11-12, and every word of it
# with it: its rail entry, Settings › Plugins and its approval screen, the popup's and the side panel's plugin entries,
# lines and change lists (their two catalogs, plugins-popup and plugins-changes, went too), the trash's mark and the
# toolbar's waiting title. What is left: the line for a grant record whose tag fails, said without the word plugin, and
# autofill's recent requests, which moved here from Settings › Plugins: their heading, and each line's outcome in words
# (the log keeps protocol words: core/plugins/session.ts). w1b.py and w2a.py hold the switch's other words.
PLUGINS_EN = {
    # the grant record that holds autofill's switch does not verify: the switch is read from it tighten-only, and a flip
    # writes a new, tagged record (core/plugins/store.ts)
    "pxBadTag": "Sixkey could not check its saved autofill setting. Turn autofill off and on again to save it anew.",
    # the request log's last lines for autofill, under the switch
    "pxRecent": "Recent requests",
    # a line's outcome (options/AutofillSwitch.tsx): the gate's "ok", "locked" and "disabled", and any other word
    "pxLogOk": "Code given for the page",
    "pxLogLocked": "No code: Sixkey was locked",
    "pxLogOff": "No code: autofill was off",
    "pxLogOther": "No code",
}
PLUGINS_ZH = {
    "pxBadTag": "Sixkey 无法核对已保存的自动填写设置。请把自动填写关闭再打开一次，重新保存。",
    "pxRecent": "最近的请求",
    "pxLogOk": "已为网页提供验证码",
    "pxLogLocked": "未提供验证码：Sixkey 已锁定",
    "pxLogOff": "未提供验证码：自动填写已关闭",
    "pxLogOther": "未提供验证码",
}
