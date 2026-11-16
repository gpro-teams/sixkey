# PHASE0X-PLAN B3 (U1): "paste anything" in the popup, and its confirm page. The page never shows a key back; the
# texts name accounts by issuer or account only. Line-level reasons reuse the settings page's (rNotOtpauth, ...).
EN = {
    "paZone": "Paste a link, key or QR screenshot",
    "paZoneHelp": "An otpauth:// or Google export link, a key on its own, or a screenshot of the QR code. Nothing is added until you confirm.",
    "paPaste": "Paste",
    "paScan": "Scan this page",
    "paTitle": "Check and add",
    "paReading": "Reading the image…",
    "paNoQr": "No QR code found in the image. Try a larger, sharper screenshot.",
    "paNothing": "Nothing to add",
    "paBadOne": "Sixkey cannot use this: $1.",
    "paExists": "Already in Sixkey as $1. Nothing to add.",
    "paSameKey": "This key is already saved as $1. It may be the same QR code scanned twice.",
    "paRebind": "You already have $1 with a different key. If the site gave you a new one, replace the old key.",
    "paKeepBoth": "Keep both",
    "paReplace": "Replace: the old one goes to the trash",
    "paSite": "Show first on $1",
    "paFromText": "Read as a plain key: 6 digits every 30 seconds, the usual setting. Check that it is a real 2FA key.",
    "paNext": "Next: enter this code on the website to finish. If the site says it is wrong, first check that your computer sets its clock automatically.",
    "paAddCopy": "Add and copy code",
    "paAddOnly": "Add only",
    "paAdded": "Added $1",
    "paColumns": "These lines have several columns, such as name|key|password. In Settings you choose the key column, and the others are never saved. Paste them there.",
    "paSettings": "Continue in Settings",
    "paMore": "Paste the next screenshot here, or continue in Settings.",
    "paTagExists": "already added",
    "paTagSame": "same key as $1",
    "paTagRebind": "new key for $1",
}
ZH = {
    "paZone": "粘贴链接、密钥或二维码截图",
    "paZoneHelp": "otpauth:// 或 Google 导出链接、单独的密钥，或二维码截图。确认之前不会添加任何账户。",
    "paPaste": "粘贴",
    "paScan": "扫描本页",
    "paTitle": "确认添加",
    "paReading": "正在读取图片…",
    "paNoQr": "图片里没有找到二维码。请换一张更大、更清晰的截图。",
    "paNothing": "没有可添加的账户",
    "paBadOne": "无法使用：$1。",
    "paExists": "已在 Sixkey 中，名为 $1，无需添加。",
    "paSameKey": "这个密钥已保存为 $1，可能是重复扫描了同一个二维码。",
    "paRebind": "你已有一个密钥不同的 $1。如果网站给了新密钥，可以替换旧的。",
    "paKeepBoth": "保留两个",
    "paReplace": "替换：旧的移到回收站",
    "paSite": "在 $1 上排在最前",
    "paFromText": "按纯文本密钥读取：6 位、每 30 秒，即常用设置。请确认它是真正的 2FA 密钥。",
    "paNext": "下一步：在网站上输入这个验证码完成绑定。网站说验证码错误时，先检查电脑时间是否自动校准。",
    "paAddCopy": "添加并复制验证码",
    "paAddOnly": "仅添加",
    "paAdded": "已添加 $1",
    "paColumns": "这些行分成了多列，例如 名称|密钥|密码。在设置页可以选择哪一列是密钥，其他列一律不保存。请在那里粘贴。",
    "paSettings": "在设置页继续",
    "paMore": "可以在这里粘贴下一张截图，或到设置页继续。",
    "paTagExists": "已存在",
    "paTagSame": "与 $1 密钥相同",
    "paTagRebind": "$1 的新密钥",
}
# The empty list now has its own Paste and Scan buttons, and says how to paste ($1: Ctrl+V or ⌘V). "No QR code" says
# what to try next (ux-study §2.9).
OVERRIDE_EN = {
    "emptyList": "Paste a setup link, key or QR screenshot with $1, or scan the QR code on this page.",
    "scanNone": "No QR code on the visible part of this page. Scroll it into view, or paste it.",
}
OVERRIDE_ZH = {
    "emptyList": "用 $1 粘贴绑定链接、密钥或二维码截图，或扫描本页上的二维码。",
    "scanNone": "当前页面的可见区域没有二维码。请把它滚动到可见处，或改用粘贴。",
}
# The popup's "Paste otpauth:// links" option became the paste zone; its description has no other use.
REMOVE = ["optPasteD"]
