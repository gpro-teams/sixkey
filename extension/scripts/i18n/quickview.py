# The popup's View menu (src/popup/main/View.tsx; docs/design/notes/QUICKVIEW-NOTES.md): the four Appearance choices
# that change how the list looks (theme, row density, order, hidden codes), one click from the search field. Its text is
# loaded when the menu opens (catalogs/view-<lang>.json), so none of it is in the popup's budget; the Appearance texts
# are listed again in VIEW, not moved: the settings page still loads its own. "lookTitle" (the button's name) is the
# popup catalog's, and so is "errorTitle" (the menu's one line when its own text cannot be read, and a failed write: the
# page's catalog is never touched by the menu). The two new keys are short forms that fit a 320 px menu ("Follow the system"
# would not). The Chinese hint's "5 秒" is kept together (a no-break space), so a narrow menu does not leave "秒。" alone.
EN = {
    "viewAuto": "Auto",
    "viewHide": "Hide codes",
}
ZH = {
    "viewAuto": "自动",
    "viewHide": "隐藏验证码",
}
OVERRIDE_EN = {}
OVERRIDE_ZH = {"listRevealHint": "点击即复制，不显示数字；按住或按空格键可显示\u00a05\u00a0秒。"}
VIEW = [
    "lookTheme",
    "viewAuto",
    "lookThemeLight",
    "lookThemeDark",
    "lookDensity",
    "lookDensityStandard",
    "lookDensityCompact",
    "lookSort",
    "lookSortManual",
    "lookSortName",
    "viewHide",
    "listRevealHint",
]
