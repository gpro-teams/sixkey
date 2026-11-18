# Device unlock: Touch ID / Windows Hello (QUICK-UNLOCK Stage 2; docs/design/proposals/QUICK-UNLOCK.md §6.5,
# docs/design/notes/PRF-NOTES.md). Two kinds of text:
#   OVERRIDE_EN / _ZH  the security record's lines for the prf_* kinds, which M2 wrote for a security key (YUBIKEY C): they
#                      now name what this stage adds (in the settings page's security part, where they already are).
#   DEVICE_EN / _ZH    the device unlock's own catalog (catalogs/device-<lang>.json): the lock screen's button and lines
#                      (the popup, the side panel, the settings page's unlock bar) and Settings › Security's box, loaded
#                      with their lazy chunks (src/ui/device-text.ts) and counted in none of the pages' up-front budgets:
#                      the popup has no room for it. Held to 1,500 B gzipped (zh_CN), the maintainers' allowance of
#                      2026-10-23 (docs/design/notes/PRF-NOTES.md §9), so every line is as short as it can be and still
#                      say what it protects; words the settings page already has (passwordLabel, unlockToManage,
#                      pinNeedsPassword) are its own keys. "$1" is the first substitution: the name of this computer's
#                      sign-in (dvNameMac "Touch ID", dvNameWin "Windows Hello", dvNameOther), by the platform, for the
#                      words only. The recovery key is named as OWNER-DECISIONS/16 Q-C has it ("recovery key" / 恢复密钥).
# The labels are honest about what each level protects (§0.4): a passkey with a key of its own ("prf") survives a restart
# and a copy of the profile needs it; one without (the gate) only reopens Sixkey until the browser closes, and stops
# people at the computer, not programs on it or the browser's developer tools; a synced one puts the passkey in that
# company's cloud, and that account plus a copy of the profile can open Sixkey (Q2).
OVERRIDE_EN = {
    "secKPrfEnrolled": "Unlock with Touch ID or Windows Hello added",
    "secKPrfRemoved": "Unlock with Touch ID or Windows Hello removed",
    "secKPrfFailed": "Unlocking with Touch ID or Windows Hello failed",
}
OVERRIDE_ZH = {
    "secKPrfEnrolled": "添加了用 Touch ID 或 Windows Hello 解锁",
    "secKPrfRemoved": "移除了用 Touch ID 或 Windows Hello 解锁",
    "secKPrfFailed": "用 Touch ID 或 Windows Hello 解锁失败",
}
DEVICE_EN = {
    "dvNameMac": "Touch ID",
    "dvNameWin": "Windows Hello",
    "dvNameOther": "this computer's sign-in",
    # the lock screen (src/ui/DeviceUnlock.tsx); dvUnlock is the settings box's title too
    "dvUnlock": "Unlock with $1",
    "dvWindowNote": "Your computer will ask you to confirm it's you. The request may say “chrome-extension”: that is Sixkey.",
    "dvFailed": "That didn't work. Use your master password.",
    "dvDue": "Sixkey asks for the master password every 14 days, so that you don't forget it.",
    "dvPaused": "Keys replaced: $1 is paused until you turn it back on in Settings.",
    "dvWaiting": "$1 needs the master password once after a browser restart, and every 12 hours.",
    # Settings › Security (src/options/DeviceBox.tsx)
    "dvLead": "Open Sixkey with $1 instead of typing the master password.",
    "dvNone": "This computer's sign-in cannot be used here. The PIN still works.",
    "dvAdd": "Use $1",
    "dvPick": "In Chrome's dialog, iCloud Keychain or Google Password Manager (box ticked) work after restarts too; “This device only” until the browser closes.",
    "dvOptIn": "Allow a passkey that syncs to Apple, Google or your password manager",
    "dvOptInNotice": "It is then kept in that company's cloud and on your other devices. Anyone who gets into that account and also has a copy of this browser profile could open Sixkey without your master password. If unsure, leave it off: $1 still works until the browser closes.",
    "dvRowPrf": "Also after a restart. A copy of this browser profile still needs your master password.",
    "dvRowPrfSynced": "Also after a restart. Synced: that account plus a copy of this browser profile can open Sixkey too.",
    "dvRowGate": "Until the browser closes. It stops people at your computer, not programs on it or anyone who opens the browser's developer tools.",
    "dvRowGateShared": "Not used in this security mode.",
    "dvSynced": "Synced",
    "dvRemove": "Remove",
    "dvTurnOn": "Turn back on",
    "dvNotWorking": "Not working here, or lost this computer? Remove it: your master password and recovery key still open Sixkey.",
    "dvAlsoRestart": "Also after a restart",
    "dvKeyChanged": "Keys replaced: turn $1 back on with one touch, no password.",
    # answers
    "dvOn": "Turned on.",
    "dvSyncedRefused": "This passkey syncs, so it works only until the browser closes. For restarts too, choose “Also after a restart” beside it.",
    "dvNoPrf": "This passkey has no key of its own for Sixkey: it works until the browser closes.",
    "dvRemoved": "Removed. The passkey itself is still in $1: delete it there if you no longer need it.",
    "dvWhereIcloud": "the Passwords app",
    "dvWhereGoogle": "Google Password Manager",
    "dvWhereWindows": "Windows Settings › Accounts › Passkeys",
    "dvWhereUnknown": "your passkey provider",
    "dvCancelled": "Nothing was saved.",
    "dvExists": "Added already.",
    "dvRefused": "Sixkey cannot use this passkey; nothing was saved.",
    "dvFull": "At most 10. Remove one first.",
}
DEVICE_ZH = {
    "dvNameMac": "Touch ID",
    "dvNameWin": "Windows Hello",
    "dvNameOther": "这台电脑的登录验证",
    "dvUnlock": "用 $1 解锁",
    "dvWindowNote": "电脑会请你确认身份。请求方可能显示为“chrome-extension”，即 Sixkey。",
    "dvFailed": "未能完成，请使用主密码。",
    "dvDue": "Sixkey 每 14 天请你输入一次主密码，免得忘记。",
    "dvPaused": "密钥已更换，$1 已暂停，需在设置中重新开启。",
    "dvWaiting": "浏览器重启后以及每隔 12 小时，$1 需要先输一次主密码。",
    "dvLead": "用 $1 代替输入主密码来打开 Sixkey。",
    "dvNone": "这台电脑的登录验证在这里用不了。PIN 照常可用。",
    "dvAdd": "使用 $1",
    "dvPick": "在 Chrome 的对话框里：iCloud 钥匙串或 Google 密码管理器（先勾选上面的框）重启后也能用；“仅此设备”到浏览器关闭为止。",
    "dvOptIn": "允许会同步到 Apple、Google 或密码管理器的通行密钥",
    "dvOptInNotice": "它会保存在那家公司的云端和你的其他设备上。谁进了那个账户、又拿到这个浏览器配置文件的副本，就能不用主密码打开 Sixkey。拿不准就别开：不开的话，$1 在浏览器关闭前照样能用。",
    "dvRowPrf": "重启后也可以。拿到这个浏览器配置文件副本的人仍需要你的主密码。",
    "dvRowPrfSynced": "重启后也可以。它会同步：那个账户加上这个浏览器配置文件的副本也能打开 Sixkey。",
    "dvRowGate": "到浏览器关闭为止。它挡得住坐到你电脑前的人，挡不住电脑上的程序，也挡不住会打开浏览器开发者工具的人。",
    "dvRowGateShared": "这个安全模式下不使用。",
    "dvSynced": "会同步",
    "dvRemove": "移除",
    "dvTurnOn": "重新开启",
    "dvNotWorking": "在这里用不了，或电脑丢了？移除即可：主密码和恢复密钥照样能打开 Sixkey。",
    "dvAlsoRestart": "重启后也可以",
    "dvKeyChanged": "密钥已更换：按一次即可重新开启 $1，无需再输密码。",
    "dvOn": "已开启。",
    "dvSyncedRefused": "这个通行密钥会同步，所以只在浏览器关闭前有效。想重启后也能用，点它旁边的“重启后也可以”。",
    "dvNoPrf": "这个通行密钥没有给 Sixkey 的专属密钥，只在浏览器关闭前有效。",
    "dvRemoved": "已移除。通行密钥本身仍在 $1 中，不再需要请在那里删除。",
    "dvWhereIcloud": "“密码”App",
    "dvWhereGoogle": "Google 密码管理器",
    "dvWhereWindows": "Windows 设置 › 账户 › 通行密钥",
    "dvWhereUnknown": "你的通行密钥服务",
    "dvCancelled": "什么也没保存。",
    "dvExists": "已经添加过了。",
    "dvRefused": "Sixkey 用不了这个通行密钥，什么也没保存。",
    "dvFull": "最多 10 个，请先移除一个。",
}
