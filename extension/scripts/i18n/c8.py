# C8 (U1, ux-study §2.12 P0): error text says what happened and what to do next, never an internal error name or code.
# src/ui/errors.ts pairs a "what" (no closing full stop, like the existing short texts it reuses) with a "next", and
# errLine joins them. $1 in a "next" is a place or a button name, filled from the real titles so the two never drift.
EN = {
    "errLine": "$1. $2",
    "errRead": "Sixkey could not read its data on this computer",
    "errSave": "This change could not be saved, and your accounts are as they were",
    "errSpace": "There is not enough free disk space to save",
    "errNextRetry": "Try again. If it keeps failing, save diagnostics under $1.",
    "errNextRestore": "Try again. If it keeps failing, restore from a backup file under $1.",
    "errNextSpace": "Free up some disk space on this computer, then try again.",
    "errNextCheck": "Check it and try again.",
    "errNextWeak": "Make it longer: a few random words work well, or use “$1”.",
    "errNextReload": "Reload this page and try again.",
    "errNextUnlock": "Unlock it with your master password, then try again.",
    "errNextBackupPw": "Enter the password this backup was saved with. It can differ from your master password.",
    "errNextBackupFile": "Choose a file saved with “$1”.",
    "errNextUpdate": "Update Sixkey, then try again. Nothing has been changed.",
}
ZH = {
    "errLine": "$1。$2",
    "errRead": "无法读取这台电脑上的 Sixkey 数据",
    "errSave": "这次改动没能保存，账户保持原样",
    "errSpace": "磁盘空间不足，无法保存",
    "errNextRetry": "请重试；仍然失败的话，到 $1 保存诊断信息。",
    "errNextRestore": "请重试；仍然失败的话，到 $1 从备份文件恢复。",
    "errNextSpace": "请先清理这台电脑的磁盘空间，然后重试。",
    "errNextCheck": "请检查后重试。",
    "errNextWeak": "请设得更长一些：几个随机词语就很好，也可以点“$1”。",
    "errNextReload": "请刷新此页面后重试。",
    "errNextUnlock": "请先用主密码解锁，然后重试。",
    "errNextBackupPw": "请输入保存这份备份时设置的密码，它可以与主密码不同。",
    "errNextBackupFile": "请选择用“$1”保存的文件。",
    "errNextUpdate": "请先更新 Sixkey，然后重试。数据没有被改动。",
}
# errorTitle is now the "what" of an unexpected error. errorBody ("Error: $1") showed the internal name; nothing in this
# package uses it any more, but Backup.tsx and FirstRun.tsx (not this package's files) still call t("errorBody", ...)
# for an unexpected error, so it cannot be removed yet: it becomes the whole generic line, with no placeholder.
# needUnlock becomes a "what" ("Unlock first" was an instruction; errNextUnlock is now the instruction).
OVERRIDE_EN = {
    "errorTitle": "Something unexpected went wrong",
    "errorBody": "Something unexpected went wrong. Try again. If it keeps failing, save diagnostics under Settings › Advanced.",
    "needUnlock": "Sixkey is locked",
}
OVERRIDE_ZH = {
    "errorTitle": "发生了意外错误",
    "errorBody": "发生了意外错误。请重试；仍然失败的话，到 设置 › 高级 保存诊断信息。",
    "needUnlock": "Sixkey 已锁定",
}
