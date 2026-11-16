// What of Sixkey can be uploaded to the Chrome Web Store (scripts/package.mjs, README.md "Publishing"):
//   - the store package (scripts/package.mjs with no mode): never while Sixkey's STORE_ID is empty or the developer
//     build's (storeIdGate), never with a manifest `key` (check-dist), and never while the site rules' bundle names no
//     source (scripts/rules-package.mjs sourceGate);
//   - an ID draft (--id-draft), made only to get the extension ID from the store before the store package can be built:
//     its manifest name and its file name say it is not to be published (ID_DRAFT_NAME, ID_DRAFT_FILE);
//   - nothing else: --local-only builds Sixkey for loading unpacked on this computer and writes no zip.
// (These gates were scripts/cloud-plugin.mjs's, shared with the official cloud plugin's own build until the Google Drive
// backup's code went.)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** An extension's ID from its manifest `key`: the first 128 bits of the key's SHA-256, in the letters a to p. */
export const idOfKey = (key) =>
  [
    ...createHash("sha256")
      .update(Buffer.from(String(key), "base64"))
      .digest("hex")
      .slice(0, 32),
  ]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");

/** The developer build's Sixkey ID: manifest.dev.json's key's (the SDK's SIXKEY_DEV_ID), a key in this repository. */
export const devSixkeyId = () => idOfKey(JSON.parse(readFileSync(resolve(root, "manifest.dev.json"), "utf8")).key);

/**
 * Why a store package may not be made while Sixkey's store ID (STORE_ID, scripts/store-id.mjs) is `storeId`, or null.
 * Empty, which it was until Sixkey's ID draft was uploaded and the store's ID pinned (the first uploads' steps 1 and 2):
 * the store package would carry no store ID for its install-source check (src/platform/install-source.ts), so a copy
 * listed again under another ID would go unreported in the first public version. Not an extension ID, or the developer
 * build's, whose key is in this repository: neither is the store's.
 */
export function storeIdGate(storeId) {
  const file = "scripts/store-id.mjs";
  const steps = 'README.md, "Publishing", steps 1 and 2';
  if (storeId === "")
    return (
      `Sixkey's store ID (STORE_ID in ${file}) is empty: a store package would carry no ID for its install-source ` +
      `check, which would then not report a copy listed under another ID. Upload the ID draft first (--id-draft), ` +
      `then set STORE_ID to the ID the store gave it (${steps}).`
    );
  if (!/^[a-p]{32}$/.test(storeId)) return `STORE_ID in ${file} is not an extension ID (${storeId}).`;
  if (storeId === devSixkeyId())
    return `STORE_ID is the developer build's ID (${storeId}), whose key is in this repository: it is not the store's (${steps}).`;
  return null;
}

/** What an ID draft's manifest name and file name carry, so that no one takes it for a release. */
export const ID_DRAFT_NAME = "ID draft, do not publish";
export const ID_DRAFT_FILE = "id-draft-do-not-publish";

/**
 * Why an ID draft may not be made, or null: it is for the first upload alone, so it is refused once Sixkey's STORE_ID
 * (`storeId`) is set.
 */
export function idDraftGate(storeId = "") {
  if (storeId !== "")
    return `Sixkey's store ID is set already (STORE_ID in scripts/store-id.mjs, ${storeId}): an ID draft is only for the first upload, which gets it. Build the store package (npm run package) instead.`;
  return null;
}
