# DV-0a (OWNER-DECISIONS/25): the settings page's Sync section is gone from every build, and with it the rail's item and
# line for it, whose label and "off" state were these two keys of base.py. The section's own catalogs went too (their
# tables are gone from m6.py and m6b.py, and m6c.py and enroll2.py, which held nothing else, are gone), and so did the
# keys of the ways into it in the full catalogs (first run's join, the Security section's box, the popup lock screen's
# line), taken out of the fragments that added them. "delete" and "retry", which the settings page used only in the
# section, are no longer placed in its core (budget.py): they stay the popup's.
REMOVE = ["syncLabel", "syncOff"]
