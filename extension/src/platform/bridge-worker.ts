// The service worker's half of the page transport (bridge-page.ts; SYNC-DESIGN §4.9). A page hands over a request it
// has built and signed; the worker checks who is asking and what is asked, sends it with the one fetch transport, and
// answers with the response. It never signs, never stores what passes through (an account session's token included),
// and never takes the sixkey-sync lock (§4.9 D10: the page running a round holds it).
// Who signs (SYNC-DESIGN §4.9, §4.14): a page signs its own requests, and the worker relays a finished request without
// signing it, storing it or inspecting it beyond four checks: the sender, the shape, the origin pin and the target
// exactly as signed. The worker signs only its own rounds, pushes and polls.
// Here: the sender and the shape; the fetch transport: the origin pin and the target exactly as signed.
//
// Who may ask: only this extension's own pages that run the sync engine (the settings page; in dev and e2e builds also
// the developer sync page). The extension has no content scripts and does not accept outside connections (check-dist),
// so only its own pages can send messages at all; the page list narrows that further. The list is a boundary because
// no page can reach the network by itself: each one carries its own connect-src 'none' (§7), which the browser
// enforces on top of the manifest's policy. Code running in the popup reaches no host directly, and none through here.
// The worker also sends nothing while the API host permission is not granted (api-permission.ts).
// What may be asked: a request of the shape the engine's API client builds, with only its headers and sizes. Anything
// else is refused without being sent.
import { SYNC_CONSTANTS } from "../core/sync/crypto/constants";
import { NetworkError, type HttpRequest, type Transport } from "../core/sync/engine/transport";
import { BRIDGE_MESSAGE, type BridgeReply } from "./bridge-page";
import { RefusedRequest } from "./fetch-transport";

// Replaced by scripts/build.mjs (Vite define): true in dev and e2e builds, which also serve the developer sync page.
declare const __SYNC_DEV__: boolean;
const DEV_PAGES = typeof __SYNC_DEV__ === "boolean" && __SYNC_DEV__;

/** The pages that may use the bridge: the settings page, and in dev and e2e builds the developer sync page. */
export const BRIDGE_PAGES: readonly string[] = ["/options/index.html", ...(DEV_PAGES ? ["/devsync/index.html"] : [])];

/** The request headers the engine's API client sets (api.ts), compared without case. Nothing else is carried. */
const HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "authorization",
  "sixkey-device",
  "sixkey-enroll",
  "sixkey-ts",
  "sixkey-sig",
  "sixkey-new-sig",
]);
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_TARGET = 2048;
const MAX_HEADER_VALUE = 8192;
/**
 * The longest body carried, in UTF-16 code units (string length). The server's own limit is 9 MiB of bytes on the three
 * envelope operations and 64 KiB elsewhere (§5.4 N13); the engine's bodies are JSON in ASCII, where the two measures
 * agree, and the server checks the bytes anyway. This only keeps an absurd message from being sent at all.
 */
export const MAX_BRIDGE_BODY = SYNC_CONSTANTS.MAX_ENVELOPE_BYTES + 1024 * 1024;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The request in a bridge message, if it has exactly the engine's shape; null otherwise. */
export function bridgeRequestOf(msg: unknown): HttpRequest | null {
  if (!isObject(msg) || msg.type !== BRIDGE_MESSAGE || !isObject(msg.req)) return null;
  const { method, target, headers, body } = msg.req;
  if (typeof method !== "string" || !METHODS.has(method)) return null;
  if (typeof target !== "string" || target.length > MAX_TARGET || !target.startsWith("/")) return null;
  if (!isObject(headers)) return null;
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (!HEADERS.has(name) || seen.has(name) || typeof v !== "string" || v.length > MAX_HEADER_VALUE) return null;
    seen.add(name);
  }
  if (body !== undefined && (typeof body !== "string" || body.length > MAX_BRIDGE_BODY)) return null;
  for (const k of Object.keys(msg.req)) if (!["method", "target", "headers", "body"].includes(k)) return null;
  return {
    method: method as HttpRequest["method"],
    target,
    headers: headers as Record<string, string>,
    ...(body !== undefined ? { body } : {}),
  };
}

/** Whether a message sender is one of this extension's bridge pages (by its own extension ID and the page's path). */
export function isBridgePage(
  sender: { id?: string; url?: string } | undefined,
  selfId: string,
  pages: readonly string[] = BRIDGE_PAGES,
): boolean {
  if (!sender || sender.id !== selfId || typeof sender.url !== "string") return false;
  let u: URL;
  try {
    u = new URL(sender.url);
  } catch {
    return false;
  }
  return u.protocol === "chrome-extension:" && u.host === selfId && pages.includes(u.pathname);
}

/**
 * Serves one bridge message: null when it is not one this worker answers (another message type, or not from a bridge
 * page: no answer at all), else the reply to send back.
 */
export async function serveBridge(
  msg: unknown,
  sender: { id?: string; url?: string } | undefined,
  o: { transport: Transport; selfId: string; pages?: readonly string[] },
): Promise<BridgeReply | null> {
  if (!isObject(msg) || msg.type !== BRIDGE_MESSAGE || !isBridgePage(sender, o.selfId, o.pages)) return null;
  const req = bridgeRequestOf(msg);
  if (!req) return { ok: false, reason: "refused" };
  try {
    return { ok: true, res: await o.transport.send(req) };
  } catch (e) {
    if (e instanceof RefusedRequest) return { ok: false, reason: "refused" };
    return { ok: false, reason: e instanceof NetworkError ? e.reason : "unknown" };
  }
}
