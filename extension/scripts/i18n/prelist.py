# Before the first Chrome Web Store listing: the manifest's description (__MSG_appDesc__, at most 132 characters), said as
# a fact. The earlier text promised that Sixkey never loses a code, which its known limits do not bear out (a power cut
# can lose the last save; Chrome can clear an extension's data), and that it has no content scripts, which stopped being
# true when sites the user turns on got Sixkey's own script. base.py is frozen, so the new text is an override here.
OVERRIDE_EN = {
    "appDesc": "A two-factor authenticator for Chrome: TOTP codes from an encrypted vault in your browser profile, with backups you control.",
}
OVERRIDE_ZH = {
    "appDesc": "Chrome 两步验证器：TOTP 密钥加密保存在你的浏览器配置文件里，备份与恢复由你掌控。",
}
