# TOTP autofill, Stage 2 patch 1: the pending fill request (docs/design/notes/AUTOFILL2-NOTES.md).
#   EN / ZH            a key of the popup's catalog: the lock screen's line for the page a pending fill is for (the lock screen
#                      is the popup's own; src/popup/screens/Locked.tsx).
#   AUTOFILL_EN / _ZH  the Fill button's own catalog (lazy, src/popup/main/Fill.tsx): what the list says after an unlock made
#                      for a pending fill that it could not finish by itself. "$1" is the first substitution.
EN = {
    "lockFillFor": "Unlock to fill the code on $1",
}
ZH = {
    "lockFillFor": "解锁后在 $1 上填入验证码",
}
AUTOFILL_EN = {
    "afResumeTab": "Not filled: this is not the tab you asked to fill. Press Fill to fill this one.",
    "afResumeOther": "Not filled: the page changed, Sixkey locked, or a minute passed since you asked. Press Fill to fill this page.",
    "afResumeChoose": "Choose the account to fill the code on $1.",
    "afResumeNone": "Not filled: no account is registered for $1.",
}
AUTOFILL_ZH = {
    "afResumeTab": "没有填写：这不是你要求填写的标签页。如需填写这个标签页，请点填写。",
    "afResumeOther": "没有填写：从你要求填写到现在，页面已变化、Sixkey 已锁定或已过一分钟。如需填写此页面，请点填写。",
    "afResumeChoose": "请选择要在 $1 上填入验证码的账户。",
    "afResumeNone": "没有填写：没有为 $1 登记的账户。",
}
