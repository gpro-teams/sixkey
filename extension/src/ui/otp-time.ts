// What the list and autofill know of an account's codes without making one: whether it makes codes, and how long the
// current one lasts. No key, no HMAC: autofill imports these from here, never from ui/otp.ts, whose codeAt makes codes
// (test/unit/plugins-w1b-source-rules.test.ts walks autofill's imports; the one way to a code is the platform's gate).
import { secondsRemaining } from "../core/totp/time";
import type { Entry } from "../core/vault/model";

export const canGenerate = (e: Entry) => e.type === "totp" && e.secret !== "";
export const remaining = (e: Entry, timeMs: number) => secondsRemaining(timeMs, e.period);
