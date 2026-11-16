# SHORT-SETTINGS (docs/design/notes/SHORT-SETTINGS-NOTES.md): the settings page is planned in five groups and shows one leaf
# of a group at a time.
#   - grpAccounts (the rail's group; accountsLabel is the rail card's "number of accounts"), secLockTab, secKeysTab (two
#     leaves of Security): the names of the new groups and leaves (the others reuse their titles).
#   - loadedIntoAdd: a file under Backup that is another app's export waits in Backup until the person follows the link to
#     Add account (which is another leaf of the page, no longer "above"): the message ends in that link (Backup.tsx; the
#     link's text is addTitle).
#   - fileLockedMeanwhile: a file chosen under Backup while Sixkey locked during its read (it may be unlocked again by the
#     time the read ends) is not handed over; this says why, true in both cases (Backup.tsx).
#   - instDetails (the popup's "Details" button) is the toggle of the install notice on the settings page too: core.
EN = {
    "fileLockedMeanwhile": "Sixkey locked while the file was being read. Choose it again.",
    "grpAccounts": "Accounts",
    "secLockTab": "Locking",
    "secKeysTab": "Password & recovery",
}
ZH = {
    "fileLockedMeanwhile": "读取文件时 Sixkey 已锁定，请重新选择这个文件。",
    "grpAccounts": "账户",
    "secLockTab": "锁定",
    "secKeysTab": "密码与恢复",
}
OVERRIDE_EN = {
    "grpAccounts": "Accounts",
    "loadedIntoAdd": "This is not a Sixkey backup. Open it in",
}
OVERRIDE_ZH = {
    "grpAccounts": "账户",
    "loadedIntoAdd": "这不是 Sixkey 备份。请在这里打开：",
}
# secLogTitle moved from security to core (budget.py): App titles the leaf's link with it, Security's record leaf its page.
PARTS = {
    "backup": ["fileLockedMeanwhile"],
    "core": ["instDetails", "grpAccounts", "secLockTab", "secKeysTab", "secLogTitle"],
}
