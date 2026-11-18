// What of Sixkey can be uploaded to the Chrome Web Store, and the one way to make it (scripts/store-gates.mjs):
//   node scripts/package.mjs                (npm run package) the store package: release/sixkey-<version>.zip, from a
//                                           prod build in dist/ that check-dist (prod) has just passed. Refused, before
//                                           anything is built, with every reason that holds: while Sixkey's own
//                                           STORE_ID (scripts/store-id.mjs) is empty or the developer build's ID
//                                           (storeIdGate): its install-source check would have no store ID to
//                                           compare; and while the site rules' bundle names no
//                                           source, or not the one REPO_URL in scripts/repo-url.mjs gives
//                                           (scripts/rules-package.mjs sourceGate, the plan's §3.6): a store package
//                                           must say where the source of its AGPL rules is. The first uploads' step 2
//                                           (set: the store's ID for Sixkey's item) lifts the first; the repository's
//                                           address, step 3 (set: the public repository), the second.
//   node scripts/package.mjs --id-draft     the first upload's ID draft, for nothing but getting Sixkey's store ID:
//                                           release/sixkey-<version>-id-draft-do-not-publish.zip, from
//                                           scripts/build.mjs --id-draft in dist-id-draft/, checked by check-dist
//                                           --id-draft. Its name is "Sixkey (ID draft, do not publish)", so it is not
//                                           taken for a release. Refused once STORE_ID is set: the draft is done then.
//   node scripts/package.mjs --local-only   the prod build into dist/ and check-dist (prod) on it, for loading unpacked
//                                           on this computer (chrome://extensions, "Load unpacked"). It writes no zip:
//                                           nothing it makes can be uploaded by mistake.
// The first store uploads, step by step: README.md, "Publishing". The store package and the ID draft carry no manifest
// `key` (check-dist (prod) refuses one); the store assigns the ID.
// dev, e2e and test builds go to their own directories (dist-dev/, dist-e2e/, dist-test/) and fail the prod check
// anyway; nothing else writes a zip. A zip is made only of dist/ or dist-id-draft/, each built and checked just before;
// the test build (npm run build:test: the prod build with a manifest key and its own name, for loading unpacked by hand)
// is never packaged, and --test is refused here rather than ignored. The archive is deterministic (scripts/zip.mjs):
// entries in path order, whatever order the file system lists them in, one fixed timestamp, deflated, no extra fields.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipDirectory } from "./zip.mjs";
import { ID_DRAFT_FILE, idDraftGate, storeIdGate } from "./store-gates.mjs";
import { STORE_ID } from "./store-id.mjs";
import { sourceGate } from "./rules-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localOnly = process.argv.includes("--local-only");
const idDraft = process.argv.includes("--id-draft");
const refuse = (why) => {
  console.error(`package: ${why} No package written.`);
  process.exit(1);
};
if (localOnly && idDraft) refuse("--local-only and --id-draft are two different builds; pass one of them.");
if (process.argv.includes("--test"))
  refuse(
    "--test is the build for testing by hand (npm run build:test, dist-test/), loaded unpacked; it is never packaged.",
  );
/**
 * Why the store package may not be made: every reason that holds, in the first uploads' order (step 2, the store ID),
 * then the rules' source (step 3: set when the repository is public; checked before step 4's package).
 */
const storeGates = () => [storeIdGate(STORE_ID), sourceGate()].filter(Boolean).join("\npackage: ") || null;
const refused = idDraft ? idDraftGate(STORE_ID) : localOnly ? null : storeGates();
if (refused) refuse(refused);

function step(what, args) {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`package: ${what} failed; no package written`);
    process.exit(1);
  }
}
const flag = idDraft ? ["--id-draft"] : [];
step(`the ${idDraft ? "ID draft's" : "prod"} build`, ["scripts/build.mjs", ...flag]);
step(`check-dist (${idDraft ? "ID draft" : "prod"})`, ["scripts/check-dist.mjs", ...flag]);
const dist = resolve(root, idDraft ? "dist-id-draft" : "dist");
if (localOnly) {
  console.log(
    `package: ${relative(root, dist)}/ is checked; load it unpacked on this computer. No zip is written: nothing to upload.`,
  );
  process.exit(0);
}

const { zip, names } = zipDirectory(dist);

const version = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")).version;
const out = resolve(root, "release", `sixkey-${version}${idDraft ? `-${ID_DRAFT_FILE}` : ""}.zip`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zip);
console.log(
  `package: ${relative(root, out)} (${names.length} files, ${zip.length} bytes, sha256 ${createHash("sha256").update(zip).digest("hex")})`,
);
if (idDraft)
  console.log(
    "package: an ID draft: upload it as a new item to get Sixkey's store ID, never submit it for review " +
      '(README.md, "Publishing").',
  );
