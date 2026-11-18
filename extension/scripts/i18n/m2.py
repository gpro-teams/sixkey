# M2 (SYNC-DESIGN §0.0i req. 15, YUBIKEY-DESIGN R8): the security record's version 2 kinds, one label each
# (src/options/SecurityCard.tsx KIND_LABEL), and the error text only the settings page shows (src/options/shared.tsx
# PAGE_ONLY). Settings-page text only: no module the popup loads mentions these keys, so the popup catalog
# (scripts/catalog-keys.mjs) does not carry them. The server sync's kinds and its "sync is on" error went with that
# sync's client (OWNER-DECISIONS/25, DV-0b), and so did their text here.
EN = {
    # The settings page's text for a service code only it can meet (src/options/shared.tsx PAGE_ONLY, RR-11): a
    # rotation while a cleanup is pending (§0.0i item 10).
    "errCleanupPending": "An earlier key change is still being finished on this computer",
    "errNextCleanupPending": "Lock Sixkey and unlock it again, then try again. Nothing was changed.",
    "secKPrfEnrolled": "Security key added for unlocking",
    "secKPrfRemoved": "Security key removed",
    "secKPrfFailed": "Unlocking with the security key failed",
    "secKOathOn": "YubiKey accounts turned on",
    "secKOathOff": "YubiKey accounts turned off",
}
ZH = {
    "errCleanupPending": "这台电脑上还有一次密钥更改没有收尾",
    "errNextCleanupPending": "请先锁定 Sixkey 再解锁，然后重试。数据没有被改动。",
    "secKPrfEnrolled": "添加了用于解锁的安全密钥",
    "secKPrfRemoved": "移除了安全密钥",
    "secKPrfFailed": "用安全密钥解锁失败",
    "secKOathOn": "开启了 YubiKey 账户",
    "secKOathOff": "关闭了 YubiKey 账户",
}
