# C2 (H7): plain text key lines in Settings > Add account. Only the key column and the name column are kept; the
# preview describes columns by position and length, never by content.
EN = {
    "linesHelp": "$1 line(s) have columns split by |. Only the key column and the name column are read. Every other column, such as a password, is dropped and never saved.",
    "linesKey": "Key column",
    "linesName": "Name column",
    "linesChoose": "Choose a column",
    "linesNoName": "No name",
    "linesColumn": "Column $1 · $2 characters · a key in $3 of $4 lines",
    "linesPending": "Choose the key column: $1 line(s) are not added until you do.",
    "linesTag": "text",
    "linesFromText": "$1 from plain text, set to 6 digits every 30 seconds, the usual setting. Check that each is a real 2FA key.",
    "linesUnnamed": "$1 without a name. You can name them in the popup after adding.",
    "rNotKey": "too short for a key (16 characters or more)",
}
ZH = {
    "linesHelp": "有 $1 行用 | 分成了多列。只读取密钥列和名称列，其他列（例如密码）一律丢弃，不会保存。",
    "linesKey": "密钥列",
    "linesName": "名称列",
    "linesChoose": "请选择一列",
    "linesNoName": "不设名称",
    "linesColumn": "第 $1 列 · $2 个字符 · $4 行中有 $3 行像密钥",
    "linesPending": "请选择密钥列：在此之前，这 $1 行不会被添加。",
    "linesTag": "文本",
    "linesFromText": "$1 个来自纯文本，按常用设置：6 位、每 30 秒。请确认每一个都是真正的 2FA 密钥。",
    "linesUnnamed": "$1 个没有名称，添加后可以在弹窗里命名。",
    "rNotKey": "太短，不像密钥（至少 16 个字符）",
}
OVERRIDE_EN = {
    "pasteHelp": "Paste otpauth:// links, Google Authenticator export links, or plain keys (a key alone, or name|key), one per line, or choose files below. Nothing is added until you confirm.",
    "rNotOtpauth": "not a link or a key",
}
OVERRIDE_ZH = {
    "pasteHelp": "粘贴 otpauth:// 链接、Google Authenticator 导出链接或纯文本密钥（单独一个密钥，或 名称|密钥），每行一条，也可以在下面选择文件。确认之前不会添加任何账户。",
    "rNotOtpauth": "不是链接，也不是密钥",
}
