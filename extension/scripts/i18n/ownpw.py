# The master password is the user's own (OWNER-DECISIONS/15; docs/design/notes/OWN-PASSWORD-NOTES.md). PasswordFields
# (src/options/shared.tsx) on the master password's pages: the hint under an empty field, the line below the 50-bit bar
# (now a warning) or refused by the floor, the warning itself ($1: how long one graphics card takes, written by Intl in
# the page's language, e.g. "36 days" / "36天"), and its "Use anyway". The generated password's box says "bar" rather than
# "needed", since 50 bits is now needed only for backup files. lockPinWaiting: the lock screen's line (popup, side panel,
# the settings page's unlock bar) when a PIN is set up but cannot be used until the master password is typed once.
# strengthCommon: refused outright below 10⁶ guesses (strength.ts MIN_GUESS_BITS; OWNER-DECISIONS/15 item 1).
# deviceOnlyBody (base.py, the Phase 0 box that turns the password on) no longer says a password "fixes" profile access.
# Wording: short, plain, no jargon beyond "bits" (the strength line already used it). No emoji.
EN = {
    "strengthHintOwn": "At least $1 characters. $2 bits or more is best: a few random words work well.",
    "strengthLowOwn": "Estimated $1 bits, below the $2 we recommend.",
    "strengthShort": "Too short: at least $1 characters.",
    "strengthCommon": "Too easy to guess: too close to a common password.",
    "pwWeakWhy": "Someone who copies this browser profile can guess offline, with no limit on tries: one graphics card finds a password this strong in about $1, and more cards are faster.",
    "pwUseAnyway": "Use anyway",
    "lockPinWaiting": "After a browser restart, an extension reload, 12 hours or 5 wrong tries, the PIN needs the master password once.",
}
ZH = {
    "strengthHintOwn": "至少 $1 个字符。最好达到 $2 位以上：几个随机词语就很好。",
    "strengthLowOwn": "估算强度 $1 位，低于建议的 $2 位。",
    "strengthShort": "太短：至少 $1 个字符。",
    "strengthCommon": "太容易猜：和常见密码太像。",
    "pwWeakWhy": "拷走这个浏览器配置文件的人可以离线猜，不限次数：一张显卡大约 $1 就能猜出这种强度的密码，显卡越多越快。",
    "pwUseAnyway": "仍然使用",
    "lockPinWaiting": "浏览器重启、扩展重新加载、超过 12 小时或输错 5 次后，PIN 需要先输一次主密码。",
}
OVERRIDE_EN = {
    "pwWhyChars": "$1 random characters: about $2 bits, well above the $3-bit bar.",
    "pwWhyWords": "$1 random words: about $2 bits, above the $3-bit bar.",
    "deviceOnlyBody": "Your accounts are protected only by a key stored next to them. That stops casual reading but not someone, or malware, with access to this browser profile. With a master password, a copy of the profile is as safe as the password you choose.",
}
OVERRIDE_ZH = {
    "pwWhyChars": "$1 个随机字符：约 $2 位，远高于 $3 位的门槛。",
    "pwWhyWords": "$1 个随机单词：约 $2 位，高于 $3 位的门槛。",
    "deviceOnlyBody": "你的账户目前只受一把存放在旁边的密钥保护。它能防止随手查看，但挡不住能访问这个浏览器配置文件的人或恶意软件。设置主密码后，配置文件被拷走时有多安全，取决于你选的密码。",
}
# PasswordFields is drawn by several parts, so its keys are core's; the unlock bar is the "unlock" part. lockPinWaiting is
# also in the popup's catalog, which the build cuts from the popup's code.
PARTS = {
    "core": ["strengthHintOwn", "strengthLowOwn", "strengthShort", "strengthCommon", "pwWeakWhy", "pwUseAnyway"],
    "unlock": ["lockPinWaiting"],
}
