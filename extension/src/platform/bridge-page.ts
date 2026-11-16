// A page's transport for the sync engine (SYNC-DESIGN §4.9): pages never touch the network. A page that runs the engine
// (the settings page's sync section, M6; the developer sync page in dev and e2e builds) signs its requests itself, with
// the device key it reads from IndexedDB (non-extractable in IndexedDB, so every extension context can sign with it;
// its only exportable copy is encrypted under the vault key, §2.5), and hands each finished request to the service
// worker, which sends it with the one fetch transport and answers with the response (bridge-worker.ts). The worker
// only carries the exchange: it decides nothing, and never takes the sixkey-sync lock on a page's behalf (§4.9 D10).
// Who signs (SYNC-DESIGN §4.9, §4.14): a page signs its own requests, and the worker relays a finished request without
// signing it, storing it or inspecting it beyond four checks: the sender, the shape, the origin pin and the target
// exactly as signed. The worker signs only its own rounds, pushes and polls.
//
// A page's account session token (§0.1) travels in the request's Authorization header like any other header and is
// never stored by the worker.
import { NetworkError, type HttpRequest, type HttpResponse, type Transport } from "../core/sync/engine/transport";

/** The message type the service worker serves (bridge-worker.ts). */
export const BRIDGE_MESSAGE = "sk-api";
/**
 * The message a page sends after it changed sync's state itself (turned sync on or off, finished a round): the worker
 * brings the badge and its periodic alarm up to date (sync-worker.ts SyncWorker.changed).
 */
export const SYNC_CHANGED_MESSAGE = "sk-sync-changed";

/** The worker's answer: the response, or why there is none ("refused": the worker sent nothing). */
export type BridgeReply =
  { ok: true; res: HttpResponse } | { ok: false; reason: "offline" | "timeout" | "aborted" | "unknown" | "refused" };

const REASONS: ReadonlySet<string> = new Set(["offline", "timeout", "aborted", "unknown"]);
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The response in a reply, if it has exactly the shape a response has (the reply is checked, not trusted). */
export function responseOf(x: unknown): HttpResponse | null {
  if (!isObject(x) || x.ok !== true || !isObject(x.res)) return null;
  const { status, headers, body } = x.res;
  if (
    !Number.isSafeInteger(status) ||
    (status as number) < 100 ||
    (status as number) > 599 ||
    typeof body !== "string" ||
    !isObject(headers)
  )
    return null;
  if (!Object.values(headers).every((v) => typeof v === "string")) return null;
  return { status: status as number, headers: headers as Record<string, string>, body };
}

export class BridgeTransport implements Transport {
  constructor(
    private readonly post: (message: unknown) => Promise<unknown> = (message) => chrome.runtime.sendMessage(message),
  ) {}

  async send(req: HttpRequest): Promise<HttpResponse> {
    let reply: unknown;
    try {
      reply = await this.post({ type: BRIDGE_MESSAGE, req });
    } catch {
      throw new NetworkError("unknown"); // the worker stopped or did not answer: the request may have gone out
    }
    const res = responseOf(reply);
    if (res) return res;
    const reason =
      isObject(reply) && typeof reply.reason === "string" && REASONS.has(reply.reason)
        ? (reply.reason as "offline" | "timeout" | "aborted" | "unknown")
        : "unknown";
    throw new NetworkError(reason); // "refused" (nothing sent) is reported as unknown too: the engine never needs the difference
  }
}
