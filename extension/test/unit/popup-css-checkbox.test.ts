// The popup's `.field input` rule styles text fields (full width, 38px high, padded). A checkbox inside a `.field`
// (the unlock screen's "Show" box) inherited it and was drawn as a wide bar with its label squeezed into a column.
// `.field .show input` must undo that, and nothing in the popup may put an unstyled checkbox in a `.field`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "../../src/popup/popup.css"), "utf8");

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}

describe("popup checkbox inside .field", () => {
  const r = rule(".field .show input");
  it("is a small fixed-size box, not a text field", () => {
    expect(r).toMatch(/flex:\s*none/);
    expect(r).toMatch(/width:\s*16px/);
    expect(r).toMatch(/height:\s*16px/);
    expect(r).toMatch(/min-height:\s*0/);
    expect(r).toMatch(/padding:\s*0/);
  });
});
