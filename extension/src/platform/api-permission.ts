// The sync API's host permission (SYNC-DESIGN §7, §4.9, §3.1, §3.10; revision 21). The network switch of the extension:
//   - prod and dev builds declare the API origin as an OPTIONAL host permission (next to the optional pattern of every
//     https site, from which TOTP autofill asks for one site at a time: platform/autofill-sites.ts; the two are kept apart
//     below). Nothing is granted at install; the settings page asks for it in the click that turns sync on or joins a
//     vault (requestApiPermission, the first thing the click handler does, before any await: Chrome requires the user's
//     gesture), and removes it when sync is turned off, when the sync identity is removed, and when an enable or join
//     flow fails or is cancelled. The user can also withdraw it at any time in chrome://extensions; sync then pauses
//     (permission_removed): nothing is lost or sent, and only the local upkeep a sync round does anyway still runs (the
//     steps before the engine's check);
//   - the e2e build declares it as REQUIRED (automated tests cannot answer Chrome's prompt): always granted, and it cannot
//     be removed (removeApiPermission says false).
// The service worker asks before every request (permissionGated) and the engine in every round and push, after the
// steps that send nothing and before its first request (EngineDeps.networkAllowed, revision 22), so honest code sends
// nothing at all without it, not even a CORS preflight. Code that skipped both checks gets little more: in production
// the server is deployed to answer no CORS request (§5.2; M8 leaves SIXKEY_CORS_ORIGINS empty), so without the grant at
// most a CORS-simple request (no signature, no account session, a response the extension cannot read) or the preflight
// of any other request can leave; a request with the engine's headers never leaves whole.
import type { HttpRequest, HttpResponse, Transport } from "../core/sync/engine/transport";
import { NetworkError } from "../core/sync/engine/transport";
import { API_ORIGIN } from "./api-origin";
import { grantedExactly, type GrantList } from "./permission-grants";

/** The one origin pattern this build may be granted. */
export const API_PERMISSION: { origins: string[] } = { origins: [`${API_ORIGIN}/*`] };

/** The chrome.permissions calls used here (tests pass fakes). */
export type PermissionsLike = {
  contains(p: { origins: string[] }): Promise<boolean>;
  request(p: { origins: string[] }): Promise<boolean>;
  remove(p: { origins: string[] }): Promise<boolean>;
};
const browserPermissions = (): PermissionsLike => chrome.permissions as unknown as PermissionsLike;

/** Whether the API origin may be reached now. A failure to ask counts as "no". */
export async function apiPermissionGranted(p: PermissionsLike = browserPermissions()): Promise<boolean> {
  try {
    return await p.contains(API_PERMISSION);
  } catch {
    return false;
  }
}

/**
 * Asks the user for the permission (Chrome's prompt; true if granted, or already granted). Call it synchronously as the
 * first statement of the click handler that turns sync on or joins, before any await: a gesture spent on an earlier
 * await is gone, and Chrome then refuses the request.
 */
export function requestApiPermission(p: PermissionsLike = browserPermissions()): Promise<boolean> {
  return p.request(API_PERMISSION);
}

/** Withdraws it (turning sync off, removing the identity, a failed or cancelled enable). False when it cannot go. */
export async function removeApiPermission(p: PermissionsLike = browserPermissions()): Promise<boolean> {
  try {
    return await p.remove(API_PERMISSION);
  } catch {
    return false; // a required permission (the e2e build), or not granted
  }
}

/**
 * Whether a chrome.permissions.onAdded / onRemoved event may be about the API origin: any event that names a host. Kept
 * that wide on purpose (AUTOFILL2-PLAN-REVIEW m5), although the manifest's optional host permissions are now two, the API
 * origin and autofill's https://*\/* (check-dist): an event for one autofill site (https://github.com/*) is not the API
 * permission, and costs one harmless check, because neither handler trusts the event. permissionWithdrawn pauses sync only
 * if contains() of the API pattern now says no, and permissionAdded runs a round only with sync on, whose engine asks
 * contains() again before its first request. That also holds for "On all sites" (https://*\/*), which does cover the API
 * origin: this does not depend on how Chrome spells the patterns it reports. Events about API permissions alone (the
 * clipboard pair) are not sync's.
 */
export const concernsApi = (e: { origins?: string[] } | undefined): boolean => (e?.origins?.length ?? 0) > 0;

/**
 * Whether a chrome.permissions.onAdded / onRemoved event names any host besides the API origin's pattern, so may be about
 * TOTP autofill's sites (src/background/sw.ts reconciles them then): the API's pattern never covers a site, whose host may
 * not be the API's (core/autofill-sites.ts). However Chrome spells a pattern, an event that might be a site's is one; an
 * extra reconcile is harmless. Events about API permissions alone (the clipboard pair) are not.
 */
export const beyondApi = (e: { origins?: string[] } | undefined): boolean =>
  (e?.origins ?? []).some((o) => o !== API_PERMISSION.origins[0]);

/** Whether Chrome lists exactly the API origin's pattern (not merely a broad grant that covers it). */
export const apiGrantedExactly = (p: GrantList): Promise<boolean> => grantedExactly(API_PERMISSION.origins[0]!, p);

/** Whether this build declares the permission as required (the e2e build), from its manifest. */
export const apiPermissionRequired = (manifest: object): boolean => {
  const hp = (manifest as { host_permissions?: unknown }).host_permissions;
  return Array.isArray(hp) && hp.includes(API_PERMISSION.origins[0]);
};

/**
 * A transport that sends nothing while the permission is not granted: every request is refused before it leaves (a
 * NetworkError, nothing sent), so no preflight goes out either. A permission withdrawn between the engine's check and
 * this one is that request's ordinary network error; the engine's next round then reports permission_removed.
 */
export function permissionGated(t: Transport, granted: () => Promise<boolean>): Transport {
  return {
    async send(req: HttpRequest): Promise<HttpResponse> {
      if (!(await granted())) throw new NetworkError("offline");
      return t.send(req);
    },
  };
}
