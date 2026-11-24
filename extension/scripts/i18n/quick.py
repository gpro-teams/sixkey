# QUICK-UNLOCK Stage 1 (docs/design/proposals/QUICK-UNLOCK.md §5, §5.12, §6; docs/design/notes/QUICK-PIN-NOTES.md):
# the session PIN and the quick lock. Honest about what a PIN protects (people at this computer, 5 tries) and what it
# does not (programs on this computer, the browser's developer tools). Nothing here names Touch ID or Windows Hello:
# this stage has neither.
#
# The lock screen (popup): pinTitle, pinLabel, pinTriesLeft, pinWrong, pinExhausted, pinEnded, pinRetry,
# useMasterPassword, usePin. Settings › Security: the PIN box (pinBox*, pin*), "End quick unlock now", the lock
# shortcut line, the security record's four kinds. cmdLock is the manifest's description of the `lock` command.
# eraseNeedsPassword: the line beside the master-password field of every delete that cannot be undone (the Trash's
# "Delete forever", the Sync section's kept vaults and parked saves): the owner's rule that such a delete always asks
# for the master password, so that a PIN can never reach it.
EN = {
    "cmdLock": "Lock Sixkey",
    "pinTitle": "Enter your PIN",
    "pinLabel": "PIN",
    "pinTriesLeft": "Tries left: $1. After that, the master password.",
    "pinWrong": "Wrong PIN. Tries left: $1.",
    "pinExhausted": "Too many wrong PINs. Enter the master password.",
    "pinEnded": "The PIN can't be used now. Enter the master password.",
    "pinRetry": "Sixkey locked meanwhile. Enter the PIN again.",
    "useMasterPassword": "Use master password",
    "usePin": "Use PIN",
    "pinBoxTitle": "PIN quick unlock",
    "pinLead": "A PIN of 4 to 8 digits opens Sixkey again after it locks. It works only until you quit or restart the browser, and at most 12 hours after you last typed the master password. Don't reuse your phone or bank PIN.",
    "pinHonest": "A PIN stops people at your computer: after 5 wrong tries only the master password opens Sixkey. It does not stop programs on this computer, or anyone who opens the browser's developer tools.",
    "pinRoot": "The master password always works. While the PIN opens Sixkey, exports, deleting for good and changing the PIN ask for the PIN again; key changes ask for the master password.",
    "pinClose": "To lock whenever the popup closes, choose “$1” under Automatic lock. The PIN opens it again.",
    "pinOn": "On ($1 digits). It opens Sixkey until $2.",
    "pinWaiting": "On ($1 digits). It works again after you next type the master password.",
    "pinShared": "Not available: this profile is declared shared or controlled by scripts (Security mode), and they could read a PIN.",
    "pinNeedsPassword": "Set a master password first.",
    "pinNew": "New PIN",
    "pinAgain": "New PIN again",
    "pinFormat": "Use 4 to 8 digits.",
    "pinWeak": "Too easy to guess. Avoid repeated digits, runs like 1234 and common PINs.",
    "pinDiffer": "The two PINs differ.",
    "pinSet": "Set PIN",
    "pinChange": "Change PIN",
    "pinRemove": "Remove PIN",
    "pinSaved": "PIN saved. It works now.",
    "pinRemoved": "PIN removed.",
    "quickEndNow": "End quick unlock and lock",
    "quickEnded": "Ended. Sixkey is locked, and the master password opens it.",
    "lockShortcutBody": "Locks Sixkey from any page:",
    "secKPinSet": "PIN set",
    "secKPinRemoved": "PIN removed",
    "secKPinFailed": "Wrong PIN",
    "secKQuickEnded": "PIN quick unlock ended",
    "eraseNeedsPassword": "Deleting for good cannot be undone, so it asks for your PIN, or your master password when there is no PIN.",
}
ZH = {
    "cmdLock": "锁定 Sixkey",
    "pinTitle": "输入 PIN",
    "pinLabel": "PIN",
    "pinTriesLeft": "还可以试 $1 次，之后需要主密码。",
    "pinWrong": "PIN 不对，还可以再试 $1 次。",
    "pinExhausted": "PIN 输错次数过多，请输入主密码。",
    "pinEnded": "现在不能用 PIN，请输入主密码。",
    "pinRetry": "期间 Sixkey 已锁定，请重新输入 PIN。",
    "useMasterPassword": "使用主密码",
    "usePin": "使用 PIN",
    "pinBoxTitle": "PIN 快速解锁",
    "pinLead": "4 到 8 位数字的 PIN 可以在 Sixkey 锁定后重新打开它。它只在退出或重启浏览器之前有效，并且最多到你上次输入主密码后 12 小时。不要用手机或银行卡的 PIN。",
    "pinHonest": "PIN 能挡住坐到你电脑前的人：输错 5 次后只有主密码能打开 Sixkey。它挡不住这台电脑上的程序，也挡不住会打开浏览器开发者工具的人。",
    "pinRoot": "主密码始终可用。PIN 能打开 Sixkey 时，导出、永久删除、更改 PIN 这类操作改为再输一次 PIN；更改密钥仍要主密码。",
    "pinClose": "想每次关闭弹窗就锁定，请在“自动锁定”中选择“$1”，之后用 PIN 重新打开。",
    "pinOn": "已开启（$1 位）。在 $2 之前可以用它打开 Sixkey。",
    "pinWaiting": "已开启（$1 位）。下次输入主密码之后重新生效。",
    "pinShared": "不可用：这个配置文件被设为共享或由脚本控制（见“安全模式”），它们可能读到 PIN。",
    "pinNeedsPassword": "请先设置主密码。",
    "pinNew": "新 PIN",
    "pinAgain": "再次输入新 PIN",
    "pinFormat": "请输入 4 到 8 位数字。",
    "pinWeak": "太容易被猜到。请避开重复数字、1234 这样的连续数字和常见 PIN。",
    "pinDiffer": "两次输入的 PIN 不一致。",
    "pinSet": "设置 PIN",
    "pinChange": "更改 PIN",
    "pinRemove": "移除 PIN",
    "pinSaved": "PIN 已保存，现在即可使用。",
    "pinRemoved": "PIN 已移除。",
    "quickEndNow": "结束快速解锁并锁定",
    "quickEnded": "已结束。Sixkey 已锁定，需要用主密码打开。",
    "lockShortcutBody": "在任何页面锁定 Sixkey：",
    "secKPinSet": "设置了 PIN",
    "secKPinRemoved": "移除了 PIN",
    "secKPinFailed": "PIN 输错",
    "secKQuickEnded": "PIN 快速解锁已结束",
    "eraseNeedsPassword": "永久删除无法撤销，所以要再确认一次：输 PIN；没有 PIN 时输主密码。",
}
# The popup's notice counts wrong PINs with the wrong passwords and recovery codes (security-log.ts FAILURES).
OVERRIDE_EN = {
    "secNoticeFailed": "$1 wrong password, recovery key or PIN attempt(s) since you last saw this.",
}
OVERRIDE_ZH = {
    "secNoticeFailed": "自上次提示以来，主密码、恢复密钥或 PIN 输错 $1 次。",
}
