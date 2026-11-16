// The selectors of a stylesheet's rules, as one list: what scripts/check-dist.mjs compares to keep the settings page's and
// the Add view's rules out of the files the popup and the side panel count (AF3-4t; docs/design/notes/BUDGET-NOTES.md
// §9), and what test/unit/budget4t-check-dist.test.ts reads the sources with. One function for both, so the two read a
// stylesheet the same way (AF3-4t's review; done with AF3-4).
//
// Each entry of a selector list on its own (a comma inside parentheses, as in `:is(a, b)`, does not split), written as the
// minifier writes it: `::before` as `:before` (and the other three old pseudo-elements), no space around a combinator,
// one space elsewhere. Comments are dropped. At-rules' own heads (`@media …`, `@keyframes …`) are no selectors, and
// neither are a keyframes block's steps (`from`, `to`, `50%`, `0%, 100%`): an animation in either stylesheet is not a rule
// of the page.

/** One selector as the minifier writes it. */
export const norm = (sel) =>
  sel
    .replace(/::(before|after|first-line|first-letter)\b/g, ":$1")
    .replace(/\s*([>+~])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** A keyframes block's step: `from`, `to`, or a percentage, alone or in a list. */
const STEP = /^(?:from|to|\d+(?:\.\d+)?%)(?:\s*,\s*(?:from|to|\d+(?:\.\d+)?%))*$/i;

/** The selectors of `css`'s rules, each of a list on its own. */
export function selectorsOf(css) {
  const out = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)) {
    const head = m[1].trim();
    if (!head || head.startsWith("@") || STEP.test(head)) continue;
    let depth = 0;
    let cur = "";
    for (const ch of head) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        out.push(norm(cur));
        cur = "";
      } else cur += ch;
    }
    out.push(norm(cur));
  }
  return out;
}
