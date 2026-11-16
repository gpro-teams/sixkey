# PHASE0X-PLAN A1 (SYNC-DESIGN H1 + H5): the master password comes before the first account; first run in four steps
# (password -> recovery code -> one question -> first account), on the settings page. Wording of the question:
# docs/research/ux-study.md §2.8.

EN = {
    "frTitle": "Set up Sixkey",
    "frRestoreLead": "Choose the backup, then set a master password for this computer: the accounts are saved under it from the start.",
    "frStartOverLead": "A new, empty vault with a master password. Nothing is erased until you finish.",
    "frStepFile": "Backup file",
    "frStepProfile": "This profile",
    "frStepAccount": "First account",
    "frPasswordTitle": "Choose a master password",
    "frPreparing": "Preparing…",
    "frCodeNote": "Nothing is saved until you finish. If you close this page before that, this key will not open anything; you will get a new one.",
    "frRiskTitle": "Is this browser profile used only by you?",
    "frRiskBody": "Could it be used by others, synced to an anti-detect browser vendor's cloud, or controlled by scripts or automation tools?",
    "frSoloTitle": "Only me (standard)",
    "frSoloBody": "Locks after 15 idle minutes or when the screen locks.",
    "frSharedTitle": "Shared, cloud-synced or script-controlled",
    "frSharedBody": "Locks every time you close Sixkey, and codes are hidden by default. Do not turn on sync in such a profile.",
    "frRiskNote": "You can change this later in Settings › Security › Security mode.",
    "frFinish": "Finish",
    "frClipLead": "Recommended for a shared or automated profile.",
    "frChanged": "Sixkey was set up or changed in another page meanwhile. Nothing was changed here.",
    "frRestoreInstead": "Restore from a backup instead",
    "frCreateInstead": "Start with an empty vault instead",
    "frReadyTitle": "Sixkey is ready",
    "frAddBelow": "Add your first account below.",
    "frScanHint": "You can also click the Sixkey icon on a website to read a QR code shown on the page.",
    "frRailLink": "Set a master password now",
}

ZH = {
    "frTitle": "开始使用 Sixkey",
    "frRestoreLead": "先选择备份，再为这台电脑设置主密码：账户从一开始就在主密码的保护下保存。",
    "frStartOverLead": "新建一个有主密码的空保险库。完成之前不会清除任何数据。",
    "frStepFile": "备份文件",
    "frStepProfile": "这个配置文件",
    "frStepAccount": "第一个账户",
    "frPasswordTitle": "设置主密码",
    "frPreparing": "正在准备…",
    "frCodeNote": "完成之前什么都不会保存。如果在那之前关闭此页，这个恢复密钥打不开任何东西，下次会给你一个新的。",
    "frRiskTitle": "这个浏览器配置文件只有你在用吗？",
    "frRiskBody": "会不会被别人使用、同步到指纹浏览器厂商的云端，或由脚本 / 自动化工具控制？",
    "frSoloTitle": "只有我用（标准）",
    "frSoloBody": "闲置 15 分钟或锁屏时锁定。",
    "frSharedTitle": "会被共享、云同步或脚本控制",
    "frSharedBody": "每次关闭 Sixkey 都锁定，验证码默认隐藏，不建议在此开启同步。",
    "frRiskNote": "以后可在 设置 › 安全 › 安全模式 中更改。",
    "frFinish": "完成",
    "frClipLead": "共享或自动化的配置文件建议开启。",
    "frChanged": "另一个页面在此期间完成了设置或改动了数据，这里没有做任何改动。",
    "frRestoreInstead": "改为从备份恢复",
    "frCreateInstead": "改为从空保险库开始",
    "frReadyTitle": "Sixkey 已准备就绪",
    "frAddBelow": "在下面添加第一个账户。",
    "frScanHint": "也可以在网站页面上点 Sixkey 图标，识别页面上的二维码。",
    "frRailLink": "现在设置主密码",
}

# The text that described the old first run.
OVERRIDE_EN = {
    "welcomeStartSecure": "Start (set a master password first)",
    "emptyOptions": "No vault yet. First a master password, then a recovery key; nothing is saved until both are done.",
    "restored": "Restored $1 account(s).",
}
OVERRIDE_ZH = {
    "welcomeStartSecure": "开始（先设置主密码）",
    "emptyOptions": "还没有保险库。先设主密码，再保存恢复密钥；两步都完成之前什么都不会保存。",
    "restored": "已恢复 $1 个账户。",
}

# "Start without a password": the button is gone (H1), and the no-dead-text test requires every key to be used.
# noPasswordNotice stays: the popup still shows it for a Phase 0 device-key vault.
REMOVE = ["welcomeStart"]
