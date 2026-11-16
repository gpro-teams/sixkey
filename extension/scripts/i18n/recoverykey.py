# The recovery code is called the recovery key (OWNER-DECISIONS/16, question C, decided 2026-10-23): "Recovery key" /
# "恢复密钥", and its shares "Recovery key shares" / "恢复密钥分片". Only the words change: storage keys, security-log
# kinds, error codes, message types, the contract's fields, the domain tags and the code's names keep "recovery code".
# base.py is frozen, so its texts are rewritten here; the fragments that added the other texts were rewritten in place
# (a1, a4, c7, quick, m6, m6b, enroll2, shares). test/unit/recovery-key-words.test.ts keeps the old word out of every
# catalog. A bare "code" / "码" that meant the recovery code is now "key" / "恢复密钥" too.
OVERRIDE_EN = {
    "recoveryTitle": "Enter recovery key",
    "recoveryLabel": "Recovery key",
    "useRecovery": "Use recovery key",
    "wrongRecovery": "That recovery key does not match",
    "badRecoveryFormat": "That does not look like a recovery key",
    "lockHint": "If you forget the master password and lose the recovery key, your data cannot be recovered. We cannot help either.",
    "passwordLossWarning": "If you forget the master password and lose the recovery key, your data cannot be recovered. We cannot help either.",
    "newCodeTitle": "New recovery key",
    "newCodeBody": "Replaces the current key, which stops working.",
    "newCodeAction": "Create new recovery key",
    "rotateBody": "Use this if you think an old copy of your data or key may have leaked. Everything is re-encrypted with a new key and you get a new recovery key.",
    "recoveryShownTitle": "Save your recovery key",
    "recoveryShownBody": "If you forget the master password, this key is the only way back in. It is shown once. Keep it where it stays safe even if this computer is lost, such as a printout or a password manager on another device.",
    "recoverySavedCheck": "I have saved my recovery key",
    "stepRecovery": "Save the recovery key",
}
OVERRIDE_ZH = {
    "recoveryTitle": "输入恢复密钥",
    "recoveryLabel": "恢复密钥",
    "useRecovery": "使用恢复密钥",
    "wrongRecovery": "恢复密钥不匹配",
    "badRecoveryFormat": "这看起来不是恢复密钥",
    "lockHint": "忘记主密码且丢失恢复密钥，数据将无法找回，我们也无能为力。",
    "passwordLossWarning": "忘记主密码且丢失恢复密钥，数据将无法找回，我们也无能为力。",
    "newCodeTitle": "新的恢复密钥",
    "newCodeBody": "会替换当前恢复密钥，旧的随即失效。",
    "newCodeAction": "生成新的恢复密钥",
    "rotateBody": "如果你怀疑旧的数据副本或密钥泄露了，请使用。所有数据会用新密钥重新加密，并生成新的恢复密钥。",
    "recoveryShownTitle": "请保存你的恢复密钥",
    "recoveryShownBody": "忘记主密码时，这个恢复密钥是唯一的入口。它只显示这一次。请保存在电脑丢失后依然安全的地方，例如打印出来，或存进另一台设备上的密码管理器。",
    "recoverySavedCheck": "我已保存恢复密钥",
    "stepRecovery": "保存恢复密钥",
}
