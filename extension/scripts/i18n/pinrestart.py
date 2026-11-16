# The PIN's record (OWNER-DECISIONS/20 and its two 2026-10-30 notes; docs/design/notes/PIN-RESTART-NOTES.md §1, §8,
# §17, §18):
# the PIN opens Sixkey until 5 wrong tries in a row, also after a restart. Two kinds of text:
#   RESTART_EN / _ZH        the settings page's own catalog (catalogs/restart-<lang>.json): what the PIN costs, in the
#                           owner's words, above the PIN's form in Settings › Security › PIN quick unlock and in what
#                           Sixkey keeps in this profile (src/options/PinRestartBox.tsx, with src/ui/restart-text.ts).
#                           Loaded with the PIN box's lazy part; a vault's page with every lazy catalog in had 137 B left
#                           (PIN-RESTART-NOTES.md §8), so it holds this one line only: the lazy part's other words are the
#                           device unlock's and the settings page's own (dvTurnOn, dvFailed, pinBoxTitle, passwordLabel,
#                           pinLabel). The "Also after a restart" switch's lines went with the switch: rsSix (its 6
#                           digits), and the lock screen's catalog of rsLock (its 14 days) and rsPaused (its pause until
#                           Settings), whose one remaining sense is lockPinWaiting's below.
#   OVERRIDE_EN / _ZH       the PIN's existing lines made true of it now, each no longer than before: pinLead (no more
#                           "until the browser closes, at most 12 hours"), pinOn (no more "until <date>": no time limit),
#                           lockPinWaiting (no more "after a restart, 12 hours": what is left is that the master password
#                           once makes the PIN work again, after 5 wrong tries, "End quick unlock now", a key change, or a
#                           PIN set before the record was its one way). pinHonest, pinRoot, pinWaiting, pinTriesLeft,
#                           pinExhausted, pinEnded, pinWeak (now said, not refused) stay true as they are.
# The cost is said honestly, in the owner's words (OWNER-DECISIONS/20; "this browser profile", as the device unlock's
# lines say it): anyone with a copy of the profile can guess the PIN offline, and a longer PIN is harder to guess.
RESTART_EN = {
    "rsCost": "Anyone with a copy of this browser profile can guess your PIN offline; a longer PIN is harder to guess.",
}
RESTART_ZH = {
    "rsCost": "拿到这个浏览器配置文件副本的人可以离线猜你的 PIN；PIN 越长越难猜。",
}
OVERRIDE_EN = {
    "pinLead": "A PIN of 4 to 8 digits opens Sixkey again after it locks, also after the browser restarts. Don't reuse your phone or bank PIN.",
    "pinOn": "On ($1 digits).",
    "lockPinWaiting": "The PIN works again once you type the master password.",
}
OVERRIDE_ZH = {
    "pinLead": "4 到 8 位数字的 PIN 可以在 Sixkey 锁定后重新打开它，浏览器重启后也可以。不要用手机或银行卡的 PIN。",
    "pinOn": "已开启（$1 位）。",
    "lockPinWaiting": "输一次主密码后，PIN 就能重新使用。",
}
