// REUSE.toml as REUSE reads it, for tests that ask which licence a path gets (the AF3-1b review's N6). The rules are the
// REUSE specification's (3.3, REUSE.toml): "*" matches everything but "/", "**" and "**/" match everything including "/"
// (so "**/" also matches no folder at all), "\*" is a star; when several [[annotations]] match a path, the last one wins.
// The glob translation follows reuse-tool's (global_licensing.py, AnnotationsItem's path regex), which CI's reuse-action
// runs: a "/" right after "**" is not written, nor is the "*" that may follow it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A REUSE.toml path glob as a regular expression over a path relative to the repository's root. */
export function reuseGlob(path: string): RegExp {
  let out = "";
  let escaping = false;
  let globstar = false;
  let prev = "";
  for (const c of path) {
    if (c === "\\") {
      if (prev === "\\" && escaping) {
        escaping = false;
        out += "\\\\";
      } else escaping = true;
    } else if (c === "*") {
      if (escaping) {
        out += "\\*";
        escaping = false;
      } else if (prev === "*" && !globstar) {
        globstar = true;
        out += ".*";
      }
    } else if (c === "/") {
      if (!globstar) {
        if (prev === "*") out += "[^/]*";
        out += "/";
      }
      escaping = false;
    } else {
      if (prev === "*" && !globstar) out += "[^/]*";
      out += escape(c);
      globstar = false;
      escaping = false;
    }
    prev = c;
  }
  if (prev === "*" && !globstar) out += "[^/]*";
  return new RegExp(`^(?:${out})$`);
}

export type Annotation = { paths: string[]; id: string | undefined; text: string };

/** The [[annotations]] of the repository's REUSE.toml, in order: their path globs, licence and text. */
export function annotations(repo: string): Annotation[] {
  return readFileSync(resolve(repo, "REUSE.toml"), "utf8")
    .split("[[annotations]]")
    .slice(1)
    .map((e) => {
      const m = /\npath = (\[[\s\S]*?\]|"[^"]*")\n/.exec(e);
      const paths: string[] = m
        ? m[1]!.startsWith("[")
          ? JSON.parse(m[1]!.replace(/,\s*\]$/, "]"))
          : [JSON.parse(m[1]!)]
        : [];
      return { paths, id: /\nSPDX-License-Identifier = "([^"]+)"/.exec(e)?.[1], text: e };
    });
}

/** The annotation REUSE gives `path`: the last one with a glob that matches it. */
export const annotationOf = (entries: Annotation[], path: string) =>
  entries.filter((e) => e.paths.some((g) => reuseGlob(g).test(path))).at(-1);
