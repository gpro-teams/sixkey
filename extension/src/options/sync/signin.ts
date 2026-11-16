// Signing in to the sync account with the one-time code mailed to the user (SYNC-DESIGN §3.1 step 2, §5.2, §6 O2): the
// email, then the six digits, with a resend after a minute. What it yields is the account session, which lives in this
// object's memory only (§4.9): it is never stored, logged or shown, and it only creates a vault, asks to enrol a new
// device or joins with the recovery code (§0.1). It expires on its own after 15 minutes (ACCOUNT_SESSION_TTL_S); a flow
// that meets session_invalid comes back here.
import { failureOf, type AccountSession, type Failure, type SyncKit } from "./gateway";
import { Store } from "./store";

/** The server lets a new code be mailed at most 3 times in 10 minutes (§5.5); the resend button waits a minute. */
export const RESEND_MS = 60_000;

export type SignInState =
  | { at: "email"; email: string; failure?: Failure }
  | { at: "sending"; email: string }
  | { at: "code"; email: string; sentAt: number; failure?: Failure }
  | { at: "verifying"; email: string; sentAt: number }
  | { at: "in"; email: string };

/** A light check that the address is one (the server says so exactly, invalid_email): something@something.tld. */
export const emailOk = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
/** The six digits of a one-time code, from what was typed or pasted ("123 456", "123-456"), or null. */
export const sixDigits = (input: string): string | null => {
  const d = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(d) ? d : null;
};

export class SignIn extends Store<SignInState> {
  #session: AccountSession | null = null;

  constructor(
    private readonly kit: SyncKit,
    email = "",
  ) {
    super({ at: "email", email });
  }

  /** The session once signed in (null before, and after `forget`). */
  get session(): AccountSession | null {
    return this.#session;
  }

  get email(): string {
    return this.state.email;
  }

  /** Mail a code to `email` (POST /v1/auth/otp). The server answers the same whether or not the address has an account. */
  async send(input: string): Promise<void> {
    const email = input.trim();
    if (!emailOk(email)) return this.set({ at: "email", email, failure: { code: "invalid_email" } });
    const run = this.epoch;
    this.set({ at: "sending", email });
    try {
      await this.kit.engine.api.otp(email);
      if (this.live(run)) this.set({ at: "code", email, sentAt: this.kit.engine.deps.now() });
    } catch (e) {
      if (this.live(run)) this.set({ at: "email", email, failure: failureOf(e) });
    }
  }

  /** Mail a new code, once a minute has passed since the last one. */
  async resend(): Promise<void> {
    const s = this.state;
    if (s.at !== "code" || this.kit.engine.deps.now() - s.sentAt < RESEND_MS) return;
    await this.send(s.email);
  }

  /** The code the user typed: the account session (POST /v1/auth/verify). Wrong or expired codes stay on this step. */
  async verify(input: string): Promise<void> {
    const s = this.state;
    if (s.at !== "code") return;
    const code = sixDigits(input);
    if (code === null) return this.set({ ...s, failure: { code: "otp_format" } });
    const run = this.epoch;
    this.set({ at: "verifying", email: s.email, sentAt: s.sentAt });
    try {
      const session = await this.kit.engine.api.signIn(s.email, code);
      if (!this.live(run)) return;
      this.#session = { token: session.token, sub: session.sub };
      this.set({ at: "in", email: s.email });
    } catch (e) {
      if (this.live(run)) this.set({ at: "code", email: s.email, sentAt: s.sentAt, failure: failureOf(e) });
    }
  }

  /** Back to the email (a different address, or a session that expired: `failure` says why). */
  again(failure?: Failure): void {
    this.bump();
    this.#session = null;
    this.set({ at: "email", email: this.state.email, ...(failure ? { failure } : {}) });
  }

  /** The session dropped (the flow ended). */
  forget(): void {
    this.bump();
    this.#session = null;
  }
}
