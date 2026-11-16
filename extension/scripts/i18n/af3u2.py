# TOTP autofill, Stage 3: the site rules' updater (AF3-U2; docs/design/notes/AUTOFILL3-NOTES.md §10).
#   RULES_EN / _ZH  the updater's own catalog (catalogs/rules-<lang>.json), loaded with its switch's lazy chunk
#                   (src/options/RulesUpdate.tsx), which the settings page loads in a build whose updater's release
#                   gate is open (scripts/rules-update.mjs) and in no other; never in _locales, so a build without the
#                   updater carries none of it (check-dist). Settings › Security › Autofill, at the foot of the page:
#                   - ruTitle: the switch (off unless the user turns it on: the plan's §5.4);
#                   - ruLead: what it does and what the rules server learns ("$1": its host; the plan's S10: the IP
#                     address and the time, never an account or a site);
#                   - ruBuiltIn / ruUpdated: the status line, the built-in rules' version, or the day this browser took
#                     the downloaded ones and their version ("$1" the date, formatDate; "$2" the version);
#                   - ruWaiting: after off and on again, the downloaded version the next one must pass (the floor), so
#                     the page does not promise an update at once (AF3-U1's §9.8);
#                   - ruChecking: in the status line's place while turning it on waits for its check;
#                   - ruFailed: a turn the worker did not answer (the switch then shows what the worker says now, or
#                     what it showed before the click), until the next turn that is answered;
#                   - ruUnread: the first read failed twice (the switch drawn disabled).
#                   The words: the maintainers' C33 (the design's §6) and C34 (the review's S1 and N6: what the server
#                   sees includes the browser's version).
RULES_EN = {
    "ruTitle": "Get the latest site rules",
    "ruLead": "Once a day, Sixkey asks $1 for newer site rules, signed by Sixkey, that help it find code boxes. That server sees your IP address, your browser's version and when you asked, never your accounts or sites.",
    "ruBuiltIn": "Site rules: built in, version $1",
    "ruUpdated": "Site rules: updated on $1 (version $2)",
    "ruWaiting": "Waiting for a version newer than $1",
    "ruChecking": "Checking for newer site rules…",
    "ruFailed": "That didn't go through. Try again.",
    "ruUnread": "This setting can't be read right now. Reload the page to try again.",
}
RULES_ZH = {
    "ruTitle": "获取最新的网站规则",
    "ruLead": "Sixkey 每天向 $1 查询一次有没有更新的网站规则（经 Sixkey 签名），用来更准确地找到验证码输入框。对方能看到你的 IP 地址、浏览器版本和查询时间，看不到你的账户和网站。",
    "ruBuiltIn": "网站规则：自带，版本 $1",
    "ruUpdated": "网站规则：已于 $1 更新（版本 $2）",
    "ruWaiting": "正在等待比版本 $1 更新的规则",
    "ruChecking": "正在检查有没有更新的网站规则…",
    "ruFailed": "没能完成，请再试一次。",
    "ruUnread": "暂时读不到这项设置，请刷新页面后再试。",
}
