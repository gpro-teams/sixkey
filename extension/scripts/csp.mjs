// The extension pages' (and the service worker's) content security policy. connect-src names nothing ('none') but, in a
// build whose site rules' updater's gate is open, that updater's one path (scripts/rules-update.mjs rulesPathOf), which
// the worker's fetch needs: the CSP applies to the worker too. No other source is ever passed, and every page still
// narrows connect-src to 'none' itself. (The server sync's API origin was the other source, in the dev and e2e builds,
// with its host permission, until that sync's client went: OWNER-DECISIONS/25, DV-0b; this file was scripts/api-origin.mjs.)
// scripts/build.mjs writes it into the manifest it makes; scripts/check-dist.mjs checks the built result against its own
// copy of it.
export const cspOf = (extra = []) =>
  `script-src 'self'; object-src 'self'; default-src 'self'; connect-src ${extra.length ? extra.join(" ") : "'none'"}; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
