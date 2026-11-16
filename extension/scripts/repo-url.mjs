// The public repository's address, and where in it the source of a rules bundle is (TOTP autofill Stage 3; the plan's
// §3.6, S4, R4-5; docs/design/notes/AUTOFILL3-NOTES.md §2). The one place both are written down, as STORE_ID is in
// store-id.mjs.
//
// REPO_URL is the public repository on GitHub. While it was empty, before the repository was public, a baseline
// bundle's `source` was "" (rules/tools/bundle.mjs), which the format allows for a baseline; the store package refuses a
// bundle with an empty source, or with one that is not the address made from REPO_URL (scripts/rules-package.mjs
// sourceGate, AF3-3a). After a change here, rebuild the bundle (node rules/tools/bundle.mjs at the root) and commit it.
//
// RULES_SOURCE is the whole address of the rules folder at a release's tag, with {version} where the bundle's version
// goes. It is made from REPO_URL, so the two cannot name different repositories (the AF3-1b review's N9): REPO_URL and
// RULES_AT_TAG, the rest of the address in the forge's own form, are the values to set. GitHub's is
// `/tree/rules-v{version}/rules`, GitLab's `/-/tree/rules-v{version}/rules`, Gitea's and Codeberg's
// `/src/tag/rules-v{version}/rules`. The tag rules-v<version> is made on the commit that releases that version
// (rules/README.md, "Releasing a bundle").
export const REPO_URL = "https://github.com/gpro-teams/sixkey";
export const RULES_AT_TAG = "/tree/rules-v{version}/rules";
export const RULES_SOURCE = REPO_URL === "" ? "" : `${REPO_URL}${RULES_AT_TAG}`;

/** The `source` of the bundle of `version`: "" while RULES_SOURCE is empty, else the template filled in. */
export function rulesSource(version, template = RULES_SOURCE) {
  if (template === "") return "";
  if (!/^https:\/\/[\x21-\x7e]+$/.test(template) || !template.includes("{version}"))
    throw new Error(`repo-url.mjs: RULES_SOURCE must be an https address with {version} in it: ${template}`);
  return template.replaceAll("{version}", String(version));
}
