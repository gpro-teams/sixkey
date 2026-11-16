# The side panel (docs/design/notes/SIDEPANEL-NOTES.md; ux-study §2.1): Settings > Appearance chooses what a click on the
# toolbar icon opens, and the popup's header has "Open in side panel". The panel draws the popup's screens; its one line
# of its own ("panelTabHint", for a tab the icon was not clicked on) is in the popup's catalog, which the panel loads
# (scripts/catalog-keys.mjs POPUP_PAGES), and counted in the popup's budget.
EN = {
    "lookOpen": "Clicking the icon opens",
    "lookOpenPopup": "Popup",
    "lookOpenPanel": "Side panel",
    "lookOpenNote": "The side panel stays open beside the page, and the keyboard shortcut opens it too. While it is open, Sixkey locks after 15 minutes without use, even if Automatic lock allows longer.",
    "lookOpenShared": "The side panel is not offered in a shared profile (Security mode).",
    "openPanel": "Open in side panel",
    "panelTabHint": "Click the Sixkey icon on this tab to match its site and scan it.",
}
ZH = {
    "lookOpen": "点击图标时打开",
    "lookOpenPopup": "弹窗",
    "lookOpenPanel": "侧边栏",
    "lookOpenNote": "侧边栏会一直开在网页旁边，快捷键打开的也是它。侧边栏开着时，Sixkey 闲置 15 分钟就会锁定，即使自动锁定允许更久。",
    "lookOpenShared": "共享的配置文件中不提供侧边栏（安全模式）。",
    "openPanel": "在侧边栏中打开",
    "panelTabHint": "在此标签页上点击 Sixkey 图标，才能识别网站并扫描。",
}
# The shortcut opens what the icon opens; the list's look and hidden codes apply to the side panel as to the popup.
OVERRIDE_EN = {
    "lookShortcutBody": "Opens Sixkey on any page, as a click on its icon does:",
    "lookLead": "How Sixkey looks in this browser, and how the popup and the side panel list your accounts.",
    "lookHide": "Hide codes in the popup and the side panel",
}
OVERRIDE_ZH = {
    "lookShortcutBody": "在任何页面打开 Sixkey，与点击图标相同：",
    "lookLead": "Sixkey 在这个浏览器里的样子，以及弹窗和侧边栏怎样列出你的账户。",
    "lookHide": "在弹窗和侧边栏中隐藏验证码",
}
# Settings > Appearance is the "general" part (src/options/Appearance.tsx); "openPanel" and "panelTabHint" are the
# popup's catalog's (no part).
PARTS = {"general": ["lookOpen", "lookOpenPopup", "lookOpenPanel", "lookOpenNote", "lookOpenShared"]}
