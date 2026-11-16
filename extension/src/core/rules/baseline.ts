// The site rules' baseline bundle as a Sixkey build carries it (TOTP autofill Stage 3, AF3-3a; docs/design/notes/
// AUTOFILL3-NOTES.md §4): rules/baseline.json in the package, the repository's rules/build/baseline.json byte for byte
// (scripts/build.mjs copies it; scripts/check-dist.mjs holds the copy to it). One function reads its text, the same in the
// build (which refuses to build without a bundle it accepts), in check-dist and in the extension (platform/package-
// data.ts): parsed, then checked whole by the format's own checker as a baseline bundle (format.ts validate), with the
// extension's own host checks. Pure: it reads no file and no API.
import { canonicalHost } from "../match";
import { isShared } from "../site-domains";
import { validate, type Bundle, type Checked } from "./format";

/** Where the package holds it: the one path the extension reads it from. */
export const BASELINE_FILE = "rules/baseline.json";
/**
 * The most of it the extension reads. The file is ASCII (hosts as the URL parser writes them, selectors of an ASCII
 * grammar), so this is its size in bytes as well; today's is about 20 KB. check-dist refuses a build whose copy is larger.
 */
export const BASELINE_MAX_BYTES = 1024 * 1024;

/**
 * The text of a baseline bundle: the bundle, or why it is not one. `allowReserved`: hosts under the reserved names
 * (`.test`, `.example`, ...) accepted, for the e2e build's test rules on its fixture hosts (AF3-3b); never in another build.
 */
export function parseBaseline(text: string, o: { allowReserved?: boolean } = {}): Checked<Bundle> {
  if (text.length > BASELINE_MAX_BYTES) return { ok: false, error: `larger than ${BASELINE_MAX_BYTES} bytes` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  return validate(raw, "baseline", { canonicalHost, isShared }, { allowReserved: o.allowReserved === true });
}
