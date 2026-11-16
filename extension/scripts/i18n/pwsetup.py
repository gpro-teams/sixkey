# Setting a new password (docs/design/notes/PASSWORD-SETUP-NOTES.md): "Generate for me" first, with why it is strong
# enough and where to keep it (a password manager or paper, never a file); a passphrase of random words as the
# easier-to-type style; when a typed password is short of the bar, by how much, and a way to a generated one.
# PasswordFields (src/options/shared.tsx) and its strength line (src/ui/strength.ts meterView). The button keeps the key
# "generate", which errors.ts (popup too) names in its advice for a weak password; only its text changes.
# Wording: short, plain, no jargon beyond "bits" (the strength line already used it). No emoji.
# Since OWNER-DECISIONS/15 the master password's pages put one's own first, with a warning below the bar (ownpw.py,
# which also rewords pwWhyChars and pwWhyWords); backup files keep this order and this bar.
EN = {
    "pwOwn": "Choose my own",
    "strengthGenerated": "Generated: $1 bits. Strong enough.",
    "strengthFloor": "Too predictable: avoid keyboard runs, sequences and repeats.",
    "pwWhyChars": "$1 random characters: about $2 bits, well above the $3 bits needed.",
    "pwWhyWords": "$1 random words: about $2 bits, above the $3 bits needed.",
    "pwSaveMaster": "Save it in your password manager or write it on paper.",
    "pwSaveFile": "Save it in your password manager or write it on paper: the file cannot be opened without it.",
    "pwUseWords": "Easier to type: words",
    "pwUseChars": "Use characters instead",
    "pwUseGenerated": "Use a generated password instead",
}
ZH = {
    "pwOwn": "自己设置",
    "strengthGenerated": "已生成：$1 位，强度足够。",
    "strengthFloor": "太容易猜：请避开键盘连排、顺序和重复。",
    "pwWhyChars": "$1 个随机字符：约 $2 位，远高于要求的 $3 位。",
    "pwWhyWords": "$1 个随机单词：约 $2 位，高于要求的 $3 位。",
    "pwSaveMaster": "请存进你的密码管理器，或抄在纸上。",
    "pwSaveFile": "请存进你的密码管理器，或抄在纸上：没有它就打不开文件。",
    "pwUseWords": "改用单词（更好输入）",
    "pwUseChars": "改用字符",
    "pwUseGenerated": "改用生成的密码",
}
OVERRIDE_EN = {
    "generate": "Generate for me",
    "strengthLow": "Estimated $1 of $2 bits: $3 bits short. Make it longer or less predictable.",
}
OVERRIDE_ZH = {
    "generate": "帮我生成",
    "strengthLow": "估算强度 $1 / $2 位，还差 $3 位。请加长或避免常见组合。",
}
