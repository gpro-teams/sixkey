// The site rules' updater's one network read (TOTP autofill Stage 3, AF3-U2; docs/design/notes/AUTOFILL3-NOTES.md §10;
// the plan's §5.3): a GET of a file of the rules origin, the signed manifest or the live bundle it names, made by the
// worker's updater (platform/rules-live.ts) and by nothing else. Behind the updater's release gate (scripts/rules-
// update.mjs): with the gate closed, scripts/rules-guard.mjs keeps this module out of every build.
//
// The request carries nothing of the user's: no cookies or HTTP authentication (`credentials: "omit"`), no referrer, no
// language but `*` (a header the browser lets a script set without a preflight: the plan's S10), and nothing from a cache
// (each answer is the server's of now). A redirect fails the read (`redirect: "error"`): the file is at the address the
// build names or nowhere. No host permission covers the origin (the plan's C11), so the server must answer with
// `Access-Control-Allow-Origin`, or the browser refuses the read; the CSP lets the worker reach exactly the origin's /v1/
// path (scripts/build.mjs). One attempt: a read that fails is not made again before the next daily check.
//
// Bounded: FETCH_MS for the whole read, the body's too (a lost answer ends it), and at most `max` bytes, counted as they
// arrive, the read cancelled at the first chunk past it (4,096 B for the manifest, 512 KiB for a bundle: signed.ts
// BOUNDS). Anything else (a network error, a CORS refusal, a redirect, a status other than 200, too large, too slow) is
// null: the caller needs no more than that.

/** The whole read, at most (the plan's §5.3). */
export const FETCH_MS = 20_000;

/** The request's fields, exactly (each read adds its own signal, FETCH_MS long). */
export const REQUEST = {
  method: "GET",
  credentials: "omit",
  referrerPolicy: "no-referrer",
  redirect: "error",
  cache: "no-store",
  headers: { "Accept-Language": "*" },
} as const satisfies RequestInit;

/** The body of `url` (read with `get`: the worker's fetch), at most `max` bytes, once, within FETCH_MS; else null. */
export async function getCapped(url: string, max: number, get: typeof fetch): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const res = await get(url, { ...REQUEST, headers: { ...REQUEST.headers }, signal: AbortSignal.timeout(FETCH_MS) });
    if (res.status !== 200 || !res.body) return null;
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  } catch {
    return null;
  }
}
