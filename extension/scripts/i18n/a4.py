# PHASE0X-PLAN A4 (docs/audit/internal-reviews/GM2-REVIEW.md GM2-13, docs/audit/internal-reviews/A4-REVIEW.md A4R-1, A4R-8): resetting the master password with the
# recovery code moves from the popup to a settings tab (src/options/Reset.tsx), where saving the new code elsewhere does
# not close the page. The new code is shown before anything is written; "Continue" after "I have saved my recovery code"
# writes it. $1 in resetCodeNote: the name of that button, filled from `continue` so the two never drift.

EN = {
    "resetLead": "Your recovery key lets you choose a new master password. You get a new recovery key with it, and nothing changes until you have saved that one.",
    "resetCodeNote": "Nothing has changed yet: your current recovery key and password keep working until you press “$1” below. If you close this page before that, nothing changes, and this new key opens nothing.",
    "resetChanged": "Your password or recovery key was changed in another window meanwhile, so nothing was changed here and the key that was shown will not work. Start again.",
    "resetDone": "Your master password was reset. Use the new password and the new recovery key from now on.",
    "resetDoneLocked": "Your master password was reset. Unlock with the new password.",
}

ZH = {
    "resetLead": "用恢复密钥可以设置新的主密码。同时会生成新的恢复密钥；在你保存好它之前，什么都不会改变。",
    "resetCodeNote": "现在还没有任何改动：点下方“$1”之前，当前的恢复密钥和密码仍然有效。如果在那之前关闭此页，什么都不会改变，这个新恢复密钥也打不开任何东西。",
    "resetChanged": "在此期间，密码或恢复密钥已在另一个窗口中被更改，所以这里什么都没有改变，刚才显示的恢复密钥也不会生效。请重新开始。",
    "resetDone": "主密码已重设。今后请使用新密码和新恢复密钥。",
    "resetDoneLocked": "主密码已重设。请用新密码解锁。",
}

# The popup no longer resets: its reset form, its "Reset and unlock" button and its new-code screen are gone.
REMOVE = ["resetAction", "newRecoveryTitle", "newRecoveryBody", "savedIt"]
