# PHASE0X-PLAN C6 (SYNC-DESIGN H2, H3, Z3): Settings > Backup. Every export asks for the master password again (H3;
# expPwLead is also the fixed line in Settings > Security > Security mode: it is part of neither mode), and "Export
# selected accounts" (H2). The field reuses passwordLabel and its box lockedTitle; the device-key vault's box reuses
# deviceOnlyTitle; the ungrouped accounts reuse ungrouped; the preview reuses fieldGroup and siteField. Kept short: the
# catalogs count against the popup budget.
EN = {
    "expPwLead": "Every export asks you to confirm again, even while Sixkey is unlocked: with your PIN, or your master password when there is no PIN.",
    "expNoPw": "This vault has no master password for an export to ask for: anyone at this browser can save your secret keys. Turn one on under Security.",
    "expSubTitle": "Export selected accounts",
    "expSubBody": "For a shared or vendor-cloud profile: whoever uses it gets only these accounts. The file has its own password; open it there with Restore or Import.",
    "expSubAll": "Select all",
    "expSubNone": "Select none",
    "expSubCount": "$1 of $2 selected",
    "expSubOnly": "The file holds only these $1 account(s):",
    "expSubSave": "Save $1 account(s)",
    "expSubSamePw": "Use a password other than your master password: whoever opens the file will know it.",
    "expSubSaved": "File with $1 account(s) created. Check that your browser saved it.",
    "expSubChanged": "The selected accounts changed in another page. Nothing was saved: check the list and save again.",
}
ZH = {
    "expPwLead": "每次导出都要再确认一次，即使 Sixkey 已解锁：输 PIN；没有 PIN 时输主密码。",
    "expNoPw": "这个库没有主密码，导出时无从验证：任何能用这个浏览器的人都能导出你的密钥。请在“安全”中开启主密码。",
    "expSubTitle": "导出所选账户",
    "expSubBody": "适合放进共享或厂商云配置文件：对方只会得到这几个账户。文件有单独的密码，在那里用“恢复”或“导入”打开。",
    "expSubAll": "全选",
    "expSubNone": "全不选",
    "expSubCount": "已选 $1 / $2",
    "expSubOnly": "文件里只有这 $1 个账户：",
    "expSubSave": "保存这 $1 个账户",
    "expSubSamePw": "请换一个与主密码不同的密码：打开文件的人会知道它。",
    "expSubSaved": "已生成包含 $1 个账户的文件。请确认浏览器已保存。",
    "expSubChanged": "所选账户已在其他页面中被更改，未保存任何文件。请检查列表后重新保存。",
}
