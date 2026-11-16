// PHASE0X-PLAN B2: an account's sites. The editor's Sites field adds, refuses, removes and keeps them; search finds an
// account by its sites; the keyboard shortcut is declared. Which section an account lands in on a real page needs the
// real toolbar popup (activeTab), which a popup opened as a tab does not get: that part is unit-tested (match, list-model)
// and checked in a real browser by hand (PHASE0X-PLAN §4.2).
import { expect, test, type Page } from "@playwright/test";
import { addByPaste, AWS_URI, close, GITHUB_URI, launch, openPopup, startFresh, type Profile } from "./harness";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

const row = (pop: Page, name: string) => pop.locator(".row", { has: pop.locator(".who b", { hasText: name }) });
const chips = (pop: Page) => pop.locator(".sites .dchip span");
async function edit(pop: Page, name: string) {
  await row(pop, name).hover(); // shows the row's edit button
  await row(pop, name).locator(".more").click();
  await expect(pop.locator("#e-site")).toBeVisible();
}
async function addSite(pop: Page, text: string) {
  await pop.locator("#e-site").fill(text);
  await pop.locator("#e-site").press("Enter");
}
const save = (pop: Page) => pop.getByRole("button", { name: /^(Save|保存)$/ }).click();

test("the editor's Sites field: refuses shared names, adds, removes, keeps; search finds an account by its site", async () => {
  test.setTimeout(90_000);
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}`);
  let pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(2);
  // a popup opened as a tab has no current page, so no site sections and nothing to remember
  await expect(pop.locator(".sect.site, .sect.related, .row .remember")).toHaveCount(0);

  await edit(pop, "GitHub");
  await expect(chips(pop)).toHaveCount(0);
  // refused, each with its reason: a single label, a country's generic level, a hosting platform, not a host at all
  for (const [typed, reason] of [
    ["com", /\bcom\b/],
    ["co.uk", /co\.uk/],
    ["github.io", /github\.io/],
    ["not a site", /example\.com/],
  ] as const) {
    await addSite(pop, typed);
    await expect(pop.locator(".sites .err")).toContainText(reason);
    await expect(chips(pop)).toHaveCount(0);
  }
  // Enter adds and does not save; a pasted address keeps only its host; an international name is kept as punycode
  await addSite(pop, "https://GitHub.com/login?next=/");
  await expect(chips(pop)).toHaveText(["github.com"]);
  await expect(pop.locator(".sites .err")).toHaveCount(0);
  await expect(pop.locator("#e-issuer")).toBeVisible();
  await pop.locator("#e-site").fill("Bücher.de");
  await pop.locator(".dadd button").click();
  await addSite(pop, "gist.github.com");
  await addSite(pop, "github.com"); // already there: nothing changes
  await expect(chips(pop)).toHaveText(["github.com", "xn--bcher-kva.de", "gist.github.com"]);
  await pop.getByRole("button", { name: /^(Remove|移除) gist\.github\.com$/ }).click();
  await expect(chips(pop)).toHaveText(["github.com", "xn--bcher-kva.de"]);
  // typed but not added yet: Save adds it too
  await pop.locator("#e-site").fill("octo.example.net");
  await save(pop);
  await expect(pop.locator("#e-issuer")).toHaveCount(0);
  expect((pop as unknown as { _errors: string[] })._errors).toEqual([]);
  await pop.close();

  // kept: a new popup reads them back from the vault
  pop = await openPopup(p);
  await edit(pop, "GitHub");
  await expect(chips(pop)).toHaveText(["github.com", "xn--bcher-kva.de", "octo.example.net"]);
  // a typed site that may not be registered stops Save, with the reason, and nothing is lost
  await pop.locator("#e-site").fill("vercel.app");
  await save(pop);
  await expect(pop.locator(".sites .err")).toContainText("vercel.app");
  await expect(pop.locator("#e-issuer")).toBeVisible();
  await pop.keyboard.press("Escape");
  await expect(pop.locator("#e-issuer")).toHaveCount(0);

  // search finds accounts by sites their names do not contain
  await pop.locator("#q").fill("octo");
  await expect(pop.locator(".row .who b")).toHaveText(["GitHub"]);
  await pop.locator("#q").fill("bcher");
  await expect(pop.locator(".row .who b")).toHaveText(["GitHub"]);
  await pop.locator("#q").fill("example.net");
  await expect(pop.locator(".row .who b")).toHaveText(["GitHub"]);
  await pop.locator("#q").fill("");
  await expect(pop.locator(".row")).toHaveCount(2);

  // the other account is untouched; then every site removed is no sites at all
  await edit(pop, "AWS");
  await expect(chips(pop)).toHaveCount(0);
  await pop.keyboard.press("Escape");
  await edit(pop, "GitHub");
  for (const d of ["github.com", "xn--bcher-kva.de", "octo.example.net"])
    await pop.getByRole("button", { name: new RegExp(`^(Remove|移除) ${d.replace(/\./g, "\\.")}$`) }).click();
  await save(pop);
  await expect(pop.locator("#e-issuer")).toHaveCount(0);
  await pop.close();
  pop = await openPopup(p);
  await edit(pop, "GitHub");
  await expect(chips(pop)).toHaveCount(0);
  await pop.locator("#q").evaluate((el) => el.blur());
  expect((pop as unknown as { _errors: string[] })._errors).toEqual([]);
});

test("an account holds at most 16 sites; the seventeenth is refused and the sixteen are kept", async () => {
  test.setTimeout(90_000);
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  let pop = await openPopup(p);
  await edit(pop, "GitHub");
  for (let i = 0; i < 16; i++) await addSite(pop, `s${i}.example.com`);
  await expect(chips(pop)).toHaveCount(16);
  await addSite(pop, "one-more.example.com");
  await expect(pop.locator(".sites .err")).toContainText("16");
  await expect(chips(pop)).toHaveCount(16);
  await pop.locator("#e-site").fill("");
  await save(pop);
  await expect(pop.locator("#e-issuer")).toHaveCount(0);
  await pop.close();
  pop = await openPopup(p);
  await edit(pop, "GitHub");
  await expect(chips(pop)).toHaveCount(16);
  await expect(chips(pop).last()).toHaveText("s15.example.com");
});

test("the keyboard shortcut opens the popup (commands, which adds no permission)", async () => {
  const pop = await openPopup(p);
  const m = await pop.evaluate(() => chrome.runtime.getManifest());
  expect(m.commands?._execute_action?.suggested_key).toEqual({ default: "Alt+Shift+K" });
  const commands = await pop.evaluate(() => chrome.commands.getAll());
  const action = commands.find((c) => c.name === "_execute_action");
  expect(action, JSON.stringify(commands)).toBeDefined();
  expect(action!.shortcut, "assigned on a fresh profile").toMatch(/K$/); // "Alt+Shift+K", or "⌥⇧K" on macOS
});
