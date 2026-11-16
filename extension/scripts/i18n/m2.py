# M2 (SYNC-DESIGN §0.0i req. 15, YUBIKEY-DESIGN R8): the security record's version 2 kinds, one label each
# (src/options/SecurityCard.tsx KIND_LABEL), and two error texts only the settings page shows (src/options/shared.tsx
# PAGE_ONLY). Settings-page text only: no module the popup loads mentions these keys, so the popup catalog
# (scripts/catalog-keys.mjs) does not carry them (test/unit/m2-source-rules.test.ts checks that).
EN = {
    # The settings page's text for two service codes only it can meet (src/options/shared.tsx PAGE_ONLY, M2-REREVIEW
    # RR-11): a Phase 0 key operation while sync is on (§0.0i item 18), a rotation while a cleanup is pending (item 10).
    "errSyncOn": "Sync is on in this profile, so this change has to go through sync",
    "errNextSyncOn": "Make it from the sync settings, so that every device gets it. Nothing was changed.",
    "errCleanupPending": "An earlier key change is still being finished on this computer",
    "errNextCleanupPending": "Lock Sixkey and unlock it again, then try again. Nothing was changed.",
    "secKSyncOn": "Sync turned on in this profile",
    "secKSyncOff": "Sync turned off in this profile",
    "secKIdentityRestored": "This device's sync identity restored from its encrypted copy",
    "secKKeysAdopted": "Keys changed on another device were taken over here",
    "secKDeviceApproved": "A new device was approved from this profile",
    "secKDeviceRevoked": "A device was revoked from this profile",
    "secKHistoryCleared": "The server's history was cleared",
    "secKPrfEnrolled": "Security key added for unlocking",
    "secKPrfRemoved": "Security key removed",
    "secKPrfFailed": "Unlocking with the security key failed",
    "secKOathOn": "YubiKey accounts turned on",
    "secKOathOff": "YubiKey accounts turned off",
}
ZH = {
    "errSyncOn": "此配置文件已开启同步，这项改动必须经同步进行",
    "errNextSyncOn": "请在同步设置中进行，这样每台设备都会更新。数据没有被改动。",
    "errCleanupPending": "这台电脑上还有一次密钥更改没有收尾",
    "errNextCleanupPending": "请先锁定 Sixkey 再解锁，然后重试。数据没有被改动。",
    "secKSyncOn": "在此配置文件中开启了同步",
    "secKSyncOff": "在此配置文件中关闭了同步",
    "secKIdentityRestored": "从加密副本恢复了本设备的同步身份",
    "secKKeysAdopted": "采用了在另一台设备上更改的密钥",
    "secKDeviceApproved": "从此配置文件批准了一台新设备",
    "secKDeviceRevoked": "从此配置文件吊销了一台设备",
    "secKHistoryCleared": "清除了服务器上的历史版本",
    "secKPrfEnrolled": "添加了用于解锁的安全密钥",
    "secKPrfRemoved": "移除了安全密钥",
    "secKPrfFailed": "用安全密钥解锁失败",
    "secKOathOn": "开启了 YubiKey 账户",
    "secKOathOff": "关闭了 YubiKey 账户",
}
