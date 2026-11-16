// The platform's gate, open, for the tests of what autofill does around it (the gate itself, its switch, its ceiling and its
// log: test/unit/plugins-w1b-gate.test.ts): the account's code, as platform/plugins/autofill-gate.ts gatedCode answers
// when it allows one.
import type { Gated } from "../../src/platform/autofill";
import type { Entry } from "../../src/core/vault/model";
import { codeAt } from "../../src/ui/otp";

export const TEST_CODE = async (e: Entry, timeMs: number): Promise<Gated> => ({ code: await codeAt(e, timeMs) });
/** The worker's switch, on (platform/plugins/autofill-switch.ts switchedOff answers false). */
export const NOT_OFF = async (): Promise<boolean> => false;
