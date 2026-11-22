// The fill shortcut's side of the link with Sixkey for Mac (platform/mac-link.ts asks the app): the app's answer as the
// shortcut fills it. Types only come in, so the fill path reaches no module that makes codes through here: the code is
// the app's, made there after its Touch ID.
import type { Entry } from "../core/vault/model";
import type { GatedCode } from "./autofill";

/** What the app answered a fill with: its codes (now and next, each with the time it stops) and the account's sites,
 * digits and period, which the page's frames and box are checked against as for an account of this vault. */
export type MacFill = { codes: { code: string; until: number }[]; digits: 6 | 8; period: number; domains: string[] };

/**
 * The shortcut's fill for the app's answer: the account as the fill checks it (its sites, digits and period; no key, so
 * nothing here can make a code) and its code, the app's one still valid at the fill's time.
 */
export function macAccount(f: MacFill): { entry: Entry; code: GatedCode } {
  const entry = {
    id: "sixkey-for-mac",
    createdAt: 0,
    type: "totp",
    issuer: "",
    label: "",
    secret: "SIXKEYFORMAC", // never used: canGenerate asks for a key to be there; the code below is the app's
    algorithm: "SHA1",
    digits: f.digits,
    period: f.period,
    domains: f.domains,
    hlc: "",
    order: "",
    phlc: "",
  } as unknown as Entry;
  const code: GatedCode = async (_e, timeMs) => {
    const c = f.codes.find((x) => timeMs < x.until);
    return c ? { code: c.code } : { no: "locked" };
  };
  return { entry, code };
}
