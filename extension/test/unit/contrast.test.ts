// PHASE0X-PLAN C4, a hard gate: the colour tokens in src/ui/styles.css meet WCAG 2.x contrast in both themes, and every
// dark rule in every stylesheet exists in both forms (chosen dark, and the system's dark unless light was chosen).
// Contrast is the WCAG 2.x relative-luminance ratio, as in the ux-study measurement (ux-study §2.7, [E6]).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../../src");
const CHOSEN = ':root[data-theme="dark"]';
const SYSTEM = ':root:not([data-theme="light"])';
const DARK_MEDIA = "@media (prefers-color-scheme: dark)";

type Rule = { sel: string; body: string };
type Sheet = { rules: Rule[]; media: { query: string; rules: Rule[] }[] };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Top-level rules and @media blocks of a stylesheet. Enough for our own CSS: no braces inside strings or urls. */
function parse(text: string): Sheet {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Sheet = { rules: [], media: [] };
  let i = 0;
  for (;;) {
    const open = css.indexOf("{", i);
    if (open === -1) return out;
    const head = squash(css.slice(i, open));
    if (head.startsWith("@")) {
      let depth = 1;
      let j = open + 1;
      for (; depth > 0 && j < css.length; j++) depth += css[j] === "{" ? 1 : css[j] === "}" ? -1 : 0;
      if (head.startsWith("@media")) out.media.push({ query: head, rules: parse(css.slice(open + 1, j - 1)).rules });
      i = j;
    } else {
      const close = css.indexOf("}", open);
      out.rules.push({ sel: head, body: squash(css.slice(open + 1, close)) });
      i = close + 1;
    }
  }
}

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) cssFiles(p, out);
    else if (n.endsWith(".css")) out.push(p);
  }
  return out;
}

const styles = parse(readFileSync(join(SRC, "ui/styles.css"), "utf8"));
const declarations = (body: string) =>
  Object.fromEntries([...body.matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+);?/g)].map((m) => [m[1]!, m[2]!.trim()]));
const block = (rules: Rule[], sel: string) => {
  const found = rules.filter((r) => r.sel === sel);
  expect(found, `exactly one ${sel} block`).toHaveLength(1);
  return found[0]!.body;
};
const light = declarations(block(styles.rules, ":root"));
const darkChosenBody = block(styles.rules, CHOSEN);
const darkSystemBody = block(
  styles.media.filter((m) => m.query === DARK_MEDIA).flatMap((m) => m.rules),
  SYSTEM,
);
const dark = declarations(darkChosenBody);

// WCAG 2.x relative luminance and contrast ratio.
const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function luminance(hex: string): number {
  expect(hex, "a #RRGGBB colour").toMatch(/^#[0-9a-f]{6}$/i);
  const [r, g, b] = [1, 3, 5].map((k) => channel(parseInt(hex.slice(k, k + 2), 16) / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text: 4.5:1 (WCAG 1.4.3 AA, normal size). Each colour against every background it is drawn on. */
const TEXT: readonly (readonly [string, readonly string[]])[] = [
  ["--ink", ["--surface", "--surface-2", "--bg", "--sunken", "--raised"]],
  ["--ink-2", ["--surface", "--surface-2", "--sunken", "--raised"]],
  ["--muted", ["--surface", "--surface-2", "--bg", "--sunken", "--raised"]],
  ["--warn", ["--surface", "--surface-2", "--warn-soft"]],
  ["--danger", ["--surface", "--surface-2", "--danger-soft"]],
  ["--good", ["--surface", "--good-soft"]],
  ["--brass-ink", ["--surface", "--brass-soft"]],
  ["--on-accent", ["--accent"]],
];
/**
 * Boundaries of controls: 3:1 (WCAG 1.4.11). --line-2 draws input, select, checkbox, radio and ghost-button borders, on
 * every background a control sits on (panels, boxes, the page, notices, the recovery-code card); --faint is the border
 * on hover; --focus the focus ring.
 */
const CONTROLS: readonly (readonly [string, readonly string[]])[] = [
  [
    "--line-2",
    ["--surface", "--surface-2", "--bg", "--sunken", "--brass-soft", "--warn-soft", "--danger-soft", "--good-soft"],
  ],
  ["--faint", ["--surface", "--surface-2"]],
  ["--focus", ["--surface", "--surface-2"]],
];

describe("contrast of the colour tokens (WCAG 2.x)", () => {
  for (const [name, t] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    const ratio = (fg: string, bg: string) => {
      expect(t[fg], `${name} ${fg}`).toBeDefined();
      expect(t[bg], `${name} ${bg}`).toBeDefined();
      return contrast(t[fg]!, t[bg]!);
    };
    it(`${name}: text colours reach 4.5:1 on their backgrounds`, () => {
      for (const [fg, bgs] of TEXT)
        for (const bg of bgs)
          expect(ratio(fg, bg), `${name}: ${fg} ${t[fg]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: control borders and the focus ring reach 3:1 on every background a control sits on`, () => {
      for (const [fg, bgs] of CONTROLS)
        for (const bg of bgs)
          expect(ratio(fg, bg), `${name}: ${fg} ${t[fg]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(3);
    });
    it(`${name}: the hover border (--faint) stands out more than the resting border (--line-2)`, () => {
      // hover rules outside styles.css switch a --line-2 border to --faint; it must never fade on hover
      for (const bg of ["--surface", "--surface-2"])
        expect(ratio("--faint", bg), `${name} on ${bg}`).toBeGreaterThan(ratio("--line-2", bg));
    });
  }
});

describe("the two themes in styles.css", () => {
  it("light and dark define the same tokens, and say which scheme they are", () => {
    expect(Object.keys(dark).sort()).toEqual(
      Object.keys(light)
        .filter((k) => k !== "--f-ui" && k !== "--f-num" && k !== "--ring-focus")
        .sort(),
    );
    expect(light["color-scheme"]).toBe("light");
    expect(dark["color-scheme"]).toBe("dark");
  });

  it("the chosen dark tokens and the system's dark tokens are the same block", () => {
    expect(darkSystemBody).toBe(darkChosenBody);
  });
});

describe("every dark rule exists in both forms, in every stylesheet", () => {
  const sheets = cssFiles(SRC).map((f) => {
    const sheet = parse(readFileSync(f, "utf8"));
    return { file: relative(SRC, f), sheet, sys: sheet.media.filter((m) => /prefers-color-scheme/.test(m.query)) };
  });

  it("dark media blocks are only ever `prefers-color-scheme: dark`, and each of their rules steps aside for a chosen light theme", () => {
    for (const { file, sys } of sheets) {
      for (const m of sys) {
        expect(m.query, file).toBe(DARK_MEDIA);
        for (const r of m.rules)
          for (const s of r.sel.split(",")) {
            expect(
              s.trim() === SYSTEM || s.trim().startsWith(`:where(${SYSTEM}) `),
              `${file}: "${r.sel}" would also apply when light is chosen`,
            ).toBe(true);
          }
      }
    }
  });

  it("a rule for the system's dark has the same rule for a chosen dark, and the other way round", () => {
    let total = 0;
    for (const { file, sheet, sys } of sheets) {
      const system = sys.flatMap((m) => m.rules).map((r) => ({ sel: r.sel.split(SYSTEM).join(CHOSEN), body: r.body }));
      const chosen = sheet.rules.filter((r) => r.sel.includes(CHOSEN));
      expect(chosen.map((r) => `${r.sel} {${r.body}}`).sort(), file).toEqual(
        system.map((r) => `${r.sel} {${r.body}}`).sort(),
      );
      total += chosen.length;
    }
    expect(total).toBeGreaterThanOrEqual(1 + 3 + 5 + 3); // tokens; .btn.danger .av .mk-tile; popup 5; options 3
  });

  it("component rules wrap the root in :where(), so they keep the specificity they had before themes", () => {
    for (const { file, sheet } of sheets) {
      for (const r of sheet.rules.filter((x) => x.sel.includes(CHOSEN) && x.sel !== CHOSEN)) {
        expect(r.sel.startsWith(`:where(${CHOSEN}) `), `${file}: ${r.sel}`).toBe(true);
      }
    }
  });
});
