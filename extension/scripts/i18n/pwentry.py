# Typing a generated master password back (docs/design/notes/PASSWORD-SETUP-NOTES.md §8): the grouped input's box
# names, the way back to the plain field, and how to type the words. src/ui/PasswordGroups.tsx and
# src/options/MasterField.tsx; the box names and the way back are also on the popup's lock screen (§8.3), whose catalog
# takes them from the code (scripts/catalog-keys.mjs). Short; no emoji.
EN = {
    "pwGroup": "$1, group $2 of $3",
    "pwPlainField": "Use a plain password field",
    "pwWordsHint": "Type the 5 words; spaces or hyphens both work.",
}
ZH = {
    "pwGroup": "$1，第 $2 组，共 $3 组",
    "pwPlainField": "改用普通密码框",
    "pwWordsHint": "输入这 5 个词，用空格或连字符隔开都可以。",
}
