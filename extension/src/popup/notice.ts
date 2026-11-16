// The popup's "N wrong passwords" notice (PHASE0X-PLAN C7, SYNC-DESIGN H6 / Z4): what it reads, when, and what it acks.
// Plain code, no JSX and no chrome.* at load, so test/unit/read-budget.test.ts and security-notice.test.ts call exactly
// what App calls.
//   - Read once per unlock, and only after an unlock in this popup (App's `unlocked`), once the first code is on screen:
//     never on the way to opening (loadScreen, openView) or on the list's mount. The unlock's own reads, and the first
//     code, are unchanged; the one read comes after them (perf.spec.ts READS.unlock.all allows it, and only it).
//   - Only an "ok" record with wrong attempts gives a count. A damaged record, one from a newer version, or a read that
//     fails says the record can't be read: never a clean zero.
//   - Acked only once the notice has been shown (App, from the notice's own effect), with the number shown, so a popup
//     closed before that acks nothing, and a wrong attempt made after the read is still counted next time.
//   - Its own role="status" line (Notices.tsx), apart from the "data restored" banner (role="alert", sk_events).
import type { PopupRuntime } from "../platform/runtime-base";

/**
 * `remind`: the shares reminder is due (security-log.ts `remind`; docs/design/notes/SHAMIR-NOTES.md §4), read in the same
 * read, shown beside the count after every unlock, never acked here (it goes when "Check my shares" passes after the
 * restart).
 */
export type SecNotice = { failed: number; remind?: true } | { unreadable: true } | { remind: true };

/** The one read: the notice to show after this unlock, or null for none. Never writes, never rejects. */
export async function readNotice(rt: Pick<PopupRuntime, "security">): Promise<SecNotice | null> {
  try {
    const v = await rt.security.read();
    if (v.state !== "ok") return { unreadable: true };
    const remind = v.remind === "shares" ? ({ remind: true } as const) : null;
    return v.failed > 0 ? { failed: v.failed, ...remind } : remind;
  } catch {
    return { unreadable: true };
  }
}

/** "Seen": takes the number shown off the count. Call once, after the notice has been on screen. */
export async function ackNotice(rt: Pick<PopupRuntime, "security">, n: SecNotice): Promise<void> {
  if ("failed" in n) await rt.security.ack(n.failed).catch(() => undefined);
}

/** The list has drawn its first code, or that it has none to draw: the same mark perf.spec.ts takes as the first code. */
const DRAWN = ".row .code:not(.wait), .row .hotp, #list > .empty";

/**
 * Resolves once the list shows its first code (a code, a hidden one, an HOTP row or the empty list) and the browser has
 * had a frame to paint it; after `maxMs` in any case, so a list that never draws one cannot hold the notice back.
 */
export function afterFirstCode(maxMs = 3000): Promise<void> {
  const end = Date.now() + maxMs;
  return new Promise((done) => {
    const look = (): unknown => {
      if (!document.querySelector(DRAWN) && Date.now() < end) return setTimeout(look, 40);
      let once = 0;
      const go = () => once++ || setTimeout(done);
      requestAnimationFrame(go);
      return setTimeout(go, 100); // no frame (a hidden page): go on anyway
    };
    look();
  });
}
