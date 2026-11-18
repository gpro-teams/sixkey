# The owner's report of 2026-11-17: on a second computer that already found the backup in Chrome Sync, "Start (set a
# master password first)" led to a second, separate vault. With the restore offered first, the other way says what it
# makes.
EN = {"welcomeStartAlone": "Don't restore: make a separate vault"}
ZH = {"welcomeStartAlone": "不恢复，新建一个独立的保险库"}

# The owner's report of 2026-11-18: restored with the recovery key, the second computer asked for a new master password,
# so one vault had a different password on each computer. The copy's master password now goes on, unless the person
# sets a new one (for a forgotten password).
CSB_EN = {
    "csKeepPasswordLine": "Opened with your recovery key. Keep using the same master password as on your other computers, or set a new one if you've forgotten it.",
    "csKeepPassword": "Keep the same master password",
    "csOrNewPassword": "Or set a new master password",
}
CSB_ZH = {
    "csKeepPasswordLine": "已用恢复密钥打开。可以继续用和其他电脑一样的主密码；忘了主密码的话，再设一个新的。",
    "csKeepPassword": "继续用原来的主密码",
    "csOrNewPassword": "或者设置新的主密码",
}

# The owner's report of 2026-11-18: resetting the master password with the recovery key issued a new recovery key too.
# It keeps the recovery key now, so the page says so, and the note about the new key's screen is gone. The shares link
# says what shares are, for someone who never made any.
OVERRIDE_EN = {
    "resetLead": "Set a new master password with your recovery key. The recovery key stays the same and keeps working.",
    "sharesInsteadLink": "I split my recovery key into shares",
}
OVERRIDE_ZH = {
    "resetLead": "用恢复密钥设置新的主密码。恢复密钥不变，继续有效。",
    "sharesInsteadLink": "我把恢复密钥分成了几份（分片）",
}
REMOVE = ["resetCodeNote"]
