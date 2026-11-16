// The limits of chrome.storage.sync that the backup in Chrome's sync storage plans its slots by, and the size bounds of
// its records (core/cloud/slots.ts, which re-exports them, has the rules that use them). A module of its own that imports
// nothing: the records' reader (platform/csb-config.ts), which the popup's chunk loads, and the card's model
// (options/csb/model.ts) need a bound or two, and neither brings the slots' code, the copy's format or the crypto with
// it.

/** chrome.storage.sync's limits (@types/chrome: QUOTA_BYTES, QUOTA_BYTES_PER_ITEM). */
export const QUOTA_BYTES = 102_400;
export const QUOTA_BYTES_PER_ITEM = 8_192;
/**
 * Kept free in every item slots.ts writes. Chromium counts an item as its key and its value's JSON as
 * base::JSONWriter writes it, which slots.ts's measure (itemBytes) follows: in Chromium 156 to the byte
 * (test/e2e/csb-probe.spec.ts: 8,192 accepted, 8,193 refused, every item of a real slot as itemBytes says). The margin
 * is kept for the browsers that were not measured and for a later change of how Chromium writes a value, and costs no
 * account at the sizes measured (csb-slots.test.ts).
 */
export const ITEM_MARGIN = 16;
/** The most an item of a slot takes, by slots.ts's measure. */
export const ITEM_BYTES = QUOTA_BYTES_PER_ITEM - ITEM_MARGIN;
/**
 * Kept free of the whole area. The other items are counted by Chrome itself (room's `inUse`); the plan's items and the
 * ones it overwrites are slots.ts's measure, which in Chromium 156 is Chrome's to the byte (a whole plan's
 * getBytesInUse is its bytes, before and after a shrink's remove: test/e2e/csb-probe.spec.ts). The margin is kept for
 * the browsers that were not measured and for a later change of how Chromium writes a double (a manifest's time), and
 * costs no account at the sizes measured.
 */
export const AREA_MARGIN = 256;
/** The most one slot, or all of them, may take. */
export const ROOM_BYTES = QUOTA_BYTES - AREA_MARGIN;
/** The most chunks a slot has: thirteen full chunks are past ROOM_BYTES, so any text that fits needs no more. */
export const MAX_CHUNKS = 13;
/**
 * A vault's ciphertext shorter than this is an empty vault's: an empty vault with the longest id (64 characters) is 168
 * base64 characters, and one entry, even an erased one at every field's shortest, makes it 356 (csb-slots.test.ts
 * derives both). The worker cannot decrypt, so this is how rule 1 knows.
 */
export const EMPTY_BELOW = 256;
/** How many of the slot ids it created a link remembers (the page's "another computer's backup arrived" line). */
export const MAX_MINE = 16;
