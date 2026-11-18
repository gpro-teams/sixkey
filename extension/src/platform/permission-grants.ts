// What Chrome lists as granted (chrome.permissions.getAll), and the one question asked of it: whether one exact origin
// pattern is granted as itself, not merely covered by a broader one. "On all sites" in Chrome's extensions menu grants the
// pattern of every https site, under which contains() of any https pattern is true, so contains() cannot tell. Used where a
// grant is given back (a site's on Remove, platform/autofill-sites.ts; each listed site's when autofill is switched off,
// platform/plugins/autofill-switch.ts): only a grant Chrome lists exactly is removed, never one from under a broad grant.
// It imports nothing, so the popup's lazy Fill chunk takes nothing more with it.

/** chrome.permissions.getAll, the grants as Chrome lists them (tests pass fakes). */
export type GrantList = { getAll(): Promise<{ origins?: string[] }> };

/** Whether Chrome lists exactly this origin pattern as granted. A failure to ask counts as "no". */
export async function grantedExactly(pattern: string, p: GrantList): Promise<boolean> {
  try {
    return ((await p.getAll()).origins ?? []).includes(pattern);
  } catch {
    return false;
  }
}
