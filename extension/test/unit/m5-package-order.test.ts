// The store package's archive (scripts/zip.mjs, used by scripts/package.mjs) is in path order whatever order the file
// system lists a directory in: APFS happens to list names sorted, ext4 and others do not, so a test of two builds on one
// Mac would not notice an unsorted walk. Here: the entries of a directory with names whose per-directory order and path
// order differ, the same bytes for the same files created in different orders, and every walk sorted.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { zipDirectory } from "../../scripts/zip.mjs";

const work = mkdtempSync(join(tmpdir(), "sixkey-package-order-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A directory with these files (path -> text), created in the order given. */
function tree(name: string, files: [string, string][]): string {
  const dir = join(work, name);
  for (const [p, text] of files) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}
const FILES: [string, string][] = [
  ["a/x.js", "1"],
  ["a-b.js", "2"],
  ["B.json", "3"],
  ["a/b/c.css", "4"],
  ["_locales/en/messages.json", "5"],
  ["a.js", "6"],
];

describe("scripts/zip.mjs", () => {
  it("entries are in path order (code units of the archive names), not in a walk's per-directory order", () => {
    const { names } = zipDirectory(tree("one", FILES));
    expect(names).toEqual(["B.json", "_locales/en/messages.json", "a-b.js", "a.js", "a/b/c.css", "a/x.js"]);
  });

  it("the same files created in another order give the same bytes", () => {
    const a = zipDirectory(tree("forward", FILES)).zip;
    const b = zipDirectory(tree("backward", [...FILES].reverse())).zip;
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it("every directory walk sorts what it lists", () => {
    const src = readFileSync(resolve(__dirname, "../../scripts/zip.mjs"), "utf8");
    const walks = [...src.matchAll(/readdirSync\(([^)]*)\)(\.sort\(\))?/g)];
    expect(walks.length).toBeGreaterThan(0);
    for (const w of walks) expect(w[2], w[0]).toBe(".sort()");
  });
});
