# M6C (SYNC-DESIGN §6 O13 and P4's "[找回]", §3.5's dedupe after an approval join): finding accounts in an earlier
# version of the vault, and the notice that a join's duplicates went to the trash; the repair's line naming the devices
# it revokes again. The Sync section's catalog only (SYNC_EN, SYNC_ZH); the repair of server_older_key otherwise reuses
# part B's repair text (m6b.py).
# Wording: short, plain, what happened and what to do. No emoji.
SYNC_EN = {
    "syncFindTitle": "Find accounts",
    "syncFindBody": "Bring back accounts that were in an earlier version of the vault and are not in it now.",
    "syncFindServer": "On the server",
    "syncFindLocal": "On this device",
    "syncFindPick": "In this version, not in the vault now:",
    "syncFindNone": "Every account in this version is in the vault now.",
    "syncFindGo": "Bring back ($1)",
    "syncFindDone": "$1 account(s) are back in the vault.",
    "syncFindUnreadable": "This version can't be opened on this device.",
    "syncNoticeDuplicates": "$1 account(s) this profile added when it joined were in the synced vault already: the extra copies are in the trash.",
    "syncFindOlderKey": "older keys",
    "syncFindSameKey": "its key is in the vault now, under another name",
    "syncFindSameName": "an account with this name is in the vault now, with another key",
    "syncFindNoVersions": "None.",
    "syncRepairRevokeAgain": "Devices removed before the server's data went back are removed again first: $1. If one is missing here (removed from another device), cancel and remove it under Devices first.",
}
SYNC_ZH = {
    "syncFindTitle": "找回账户",
    "syncFindBody": "保险库较早的版本里有、现在没有的账户可以找回。",
    "syncFindServer": "服务器上",
    "syncFindLocal": "本机上",
    "syncFindPick": "这个版本里有、现在保险库里没有的账户：",
    "syncFindNone": "这个版本里的账户现在都在保险库里。",
    "syncFindGo": "找回（$1）",
    "syncFindDone": "$1 个账户已回到保险库。",
    "syncFindUnreadable": "这个版本无法在本机打开。",
    "syncNoticeDuplicates": "本配置文件加入时添加的 $1 个账户在同步库里已经有了，多出的副本已移到回收站。",
    "syncFindOlderKey": "旧密钥",
    "syncFindSameKey": "保险库里现在有用同一密钥的账户，名称不同",
    "syncFindSameName": "保险库里现在有同名账户，密钥不同",
    "syncFindNoVersions": "没有。",
    "syncRepairRevokeAgain": "服务器数据回退之前移除的设备会先再次移除：$1。如果这里少了某台（在另一台设备上移除的），请先取消，在“设备”里再移除它。",
}
