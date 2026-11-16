# TOTP autofill, Stage 3 (docs/design/notes/AUTOFILL3-NOTES.md).
#   AUTOFILL_EN / _ZH  the Fill card's own catalog (catalogs/autofill-<lang>.json), loaded with its lazy chunk
#                      (src/popup/main/Fill.tsx) and counted in neither the popup's nor the side panel's budget:
#                      - afAppend (AF3-5, §7): on a site that wants the code typed right after the password, in the same
#                        box (the site rules' baseline's appends, from Apple's list), the words the card says where it
#                        finds no code box: the strip's, and under the card after a Fill press. It replaces the "no code
#                        box" advice (open the step that asks for the code; a frame; too many boxes), which would send
#                        the user looking for a box such a sign-in does not have. The card's code is copied as on any
#                        page, so the line reads as what to do with it.
#                      - afAlias (AF3-4, §8): the line under an account that Apple's list says shares this page's sign-in
#                        ("same sign-in"), in the list's "Possibly related" section (src/popup/main/aliases.ts). "$1" is
#                        the account's own registered site, the one the list ties to this page (the maintainers' C29).
#                        Loaded with the alias chunk, which imports this catalog's lookup (src/popup/main/fill-text.ts).
AUTOFILL_EN = {
    "afAppend": "This site wants the code typed right after your password, in the same box.",
    "afAlias": "Same sign-in as $1",
}
AUTOFILL_ZH = {
    "afAppend": "此网站要求把验证码接在密码后面，填在同一个输入框里。",
    "afAlias": "与 $1 用同一账户登录",
}
