# Enrolment v2 (SYNC-DESIGN revision 27, §0.0aa; §3.2 MUST 10; §6 O5, O9; §7): the approval join's pairing code. The
# approving device shows it after answering the request, with Copy and what copying means; the new device types it
# before it shows its six digits. The confirmation code is gone: its keys were removed from m6.py and m6b.py, and the
# texts that named it rewritten there (the Sync section's catalog has no OVERRIDE or REMOVE, and nothing has shipped).
# The Sync section's catalog only (SYNC_EN, SYNC_ZH). Wording: short, plain, what happened and what to do. No emoji.
SYNC_EN = {
    "syncPairTitle": "Type the pairing code",
    "syncPairBody": "The other device now shows a pairing code of 28 characters. Type it here, or paste it.",
    "syncPairLabel": "Pairing code",
    "syncPairMalformed": "That is not a pairing code: it has 28 letters and digits, in 7 groups of 4.",
    "syncPairWrong": "This code has an error. Check it against the code on the other device.",
    "syncFailJoinEnded": "The request has ended. If the pairing code was mistyped, start again.",
    "syncApprovePairBody": "On the new device, type this pairing code:",
    "syncApprovePairWaiting": "Waiting for the code to be entered on the new device…",
    "syncPairCopyNote": "Copying goes through the system clipboard. If your clipboard is shared with other devices (such as Universal Clipboard on macOS or the cloud clipboard on Windows), the code can leave this computer: type it by hand instead. If clearing the clipboard is on, Sixkey clears it after 30 seconds, or sooner if this step ends first.",
    "syncApproveMismatch": "The pairing code did not match: the new device used a different code, or the request was changed on the way. This request is over: start again on the new device.",
    "syncSasMalformed": "Enter the 6 digits shown on the other device.",
    "syncCodeTooLong": "Too long: it has 28 letters and digits. Check it for an extra character.",
}
SYNC_ZH = {
    "syncPairTitle": "输入配对码",
    "syncPairBody": "另一台设备上现在显示了一个 28 个字符的配对码。在这里输入，也可以粘贴。",
    "syncPairLabel": "配对码",
    "syncPairMalformed": "格式不对：配对码是 28 个字母和数字，分成 7 组，每组 4 个。",
    "syncPairWrong": "这个码有误，请对照另一台设备上的码核对。",
    "syncFailJoinEnded": "请求已结束；如果配对码输错了，请重新开始。",
    "syncApprovePairBody": "在新设备上输入这个配对码：",
    "syncApprovePairWaiting": "正在等待新设备输入……",
    "syncPairCopyNote": "复制会经过系统剪贴板。如果剪贴板与其他设备共享（例如 macOS 的通用剪贴板、Windows 的云剪贴板），这个码可能离开这台电脑，这种情况下请手动输入。如果开启了清空剪贴板，Sixkey 会在 30 秒后清空它；这一步先结束时会更早清空。",
    "syncApproveMismatch": "配对码不符：新设备用了别的码，或者请求在途中被改动。这个请求已结束，请在新设备上重新开始。",
    "syncSasMalformed": "请输入另一台设备上显示的 6 位数字。",
    "syncCodeTooLong": "太长了：应为 28 个字母和数字，请检查是否多输了字符。",
}
