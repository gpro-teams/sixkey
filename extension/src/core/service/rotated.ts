// Each page's own key change (VaultService.rotateKey), the master password typed for it: the new key's id and when.
// Memory only, this page's service only (kept here, not as a field of VaultService: budget-split.test.ts). The device
// box's one-touch "turn back on" right after it reads it (device-admin.ts target(); OWNER-DECISIONS/17 Q3); nothing
// else does.
// And each page's own key event of any kind (VaultService.committed: a key change, a new master password, a reset, a new
// recovery key, shares confirmed; with sync on, the same through the sync engine), its secret typed for it: the keyring's
// wraps it left and when (never a key adopted, a join or a restore: nobody typed anything for them). The PIN box's
// "turn back on" of the PIN after a restart reads it: right after this page's own key event, the PIN alone turns it
// back on (OWNER-DECISIONS/20: "在设置里输一次 PIN 就能重新开启"; pin-restart-admin.ts); nothing else does.

export type Rotated = { vkId: string; at: number };
export type Rewrapped = { vkId: string; wraps: string; at: number };

/** Written by rotateKey once its key change has committed; keyed by the service object, so it dies with the page. */
export const rotatedHere = new WeakMap<object, Rotated>();

/** This service's own last key change, if any. */
export const rotatedBy = (s: object): Rotated | undefined => rotatedHere.get(s);

/** Written by committed() once a key event of this page has committed and been cleaned up; dies with the page. */
export const rewrappedHere = new WeakMap<object, Rewrapped>();

/** This service's own last key event, if any. */
export const rewrappedBy = (s: object): Rewrapped | undefined => rewrappedHere.get(s);
