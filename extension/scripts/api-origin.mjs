// The sync API origin of each build (the sync design's server and permission rules). It is a build-time constant:
// sync's host permission (optional in dev builds and in a prod build with the sync user interface, granted when sync is
// turned on; required in the e2e build), the CSP's only connect-src source, the origin the fetch transport may reach and
// the host every request signature covers. Nothing at run time can change it. The store build with the sync user
// interface out (scripts/sync-ui.mjs) names it in neither its manifest nor its CSP (scripts/build.mjs).
//   prod  the public API (TLS);
//   dev   the local M4 server (`make run` in api/server), plain HTTP on the loopback address;
//   e2e   the same fixed loopback port the end-to-end tests serve on (127.0.0.1:8787, §5.2).
// scripts/build.mjs injects it (Vite define __API_ORIGIN__) and checks that the manifest it writes names exactly this
// origin; scripts/check-dist.mjs checks the built result against its own copy of these values.
export const API_ORIGINS = Object.freeze({
  prod: "https://api.sixkey.app",
  dev: "http://127.0.0.1:8787",
  e2e: "http://127.0.0.1:8787",
});

/** The manifest's host permission entry for an origin (optional_host_permissions, or host_permissions in the e2e build). */
export const hostPermissionOf = (origin) => `${origin}/*`;

/**
 * The extension pages' (and the service worker's) content security policy for an origin. connect-src names the API
 * origin and nothing else: the service worker's fetch needs it, and the CSP applies to the worker too. `origin` null
 * (the store build without the sync user interface): connect-src 'none'. `extra`: the site rules' updater's one path, in
 * a build whose updater's gate is open (scripts/rules-update.mjs rulesPathOf); no other source is ever passed. Every page
 * still narrows connect-src to 'none' itself.
 */
export const cspOf = (origin, extra = []) => {
  const sources = [...(origin ? [origin] : []), ...extra];
  return `script-src 'self'; object-src 'self'; default-src 'self'; connect-src ${sources.length ? sources.join(" ") : "'none'"}; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
};
