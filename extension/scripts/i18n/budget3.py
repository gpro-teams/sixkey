# Budget work 3 (docs/design/notes/BUDGET3-NOTES.md): room on a vault's page first, then two features that draw text there.
#   REMOVE    - secKOathOn, secKOathOff: the labels of oath_on / oath_off, kinds reserved for the YubiKey features that
#               nothing ever recorded (security-kinds.ts; SYNC-DESIGN revision 25 made the reservation unnecessary), so
#               never shown (§3, (i-b)).
#             - protPassword, restoreAction, afsOn: each had the very text of another key in both languages, which its
#               one use now draws (Rail.tsx passwordLabel, Backup.tsx restore, Misc.tsx clipOn; §3, (i-a)). The fourth
#               merge is the plugin catalog's pxTitle, gone from scripts/i18n/plugins.py (the removed Settings › Plugins
#               drew pxMenu in its place).
REMOVE = ["secKOathOn", "secKOathOff", "protPassword", "restoreAction", "afsOn"]
