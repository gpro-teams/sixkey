// Which sites may be registered, with the table of shared suffixes (src/core/site-domains.ts): loaded only when a site
// is being added. Its own module, so the list (Main: "remember this site") reaches it without loading the edit dialog.
export const siteRules = () => import("../../core/site-domains");
