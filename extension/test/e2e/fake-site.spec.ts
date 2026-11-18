// A page that looks like an account's site without being it, and a plain http page (the owner's request of 2026-11-18):
// said at the top of the popup; copying the imitated account's code there takes a second click.
import { expect, test } from "@playwright/test";
import { addSites, world, type World } from "./autofill-helpers";

let w: World | undefined;
test.afterEach(async () => {
  await w?.close();
  w = undefined;
});

const text = (s: Awaited<ReturnType<World["icon"]>>, sel: string) =>
  s.eval<string | null>(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const copyRow = (s: Awaited<ReturnType<World["icon"]>>, name: string) =>
  s.gesture(
    `[...document.querySelectorAll('.row')].find((r) => r.querySelector('.who b').textContent === ${JSON.stringify(name)}).querySelector('.copy').click()`,
  );

test("a page one letter off an account's site: warned at the top, and its code is copied only on a second click", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup" }); // Example (fix.test) and Related (no site)
  await addSites(w.p, "Related", ["relatd.test"]); // its site; the page below is related.test, one letter more
  const pop = await w.icon(await w.tab("related.test", "/otc"));
  await pop.until("document.querySelector('#site-fake')", "the warning");
  expect(await text(pop, "#site-fake")).toBe(
    "This may be a fake siterelated.test looks like Related's site relatd.test, but it is not. Don't enter Related's code here.",
  );
  expect(await pop.eval("document.querySelector('#site-http')")).toBeNull(); // the fake says more than http does
  await copyRow(pop, "Related");
  await pop.until("document.querySelector('.toast')?.textContent.includes('Click again')", "the second-click warning");
  await copyRow(pop, "Related");
  await pop.until("/Copied/.test(document.querySelector('.toast')?.textContent ?? '')", "copied on the second click");
  // another account is copied at once
  await copyRow(pop, "Example");
  await pop.until(
    "/Copied/.test(document.querySelector('.toast')?.textContent ?? '') && document.querySelector('.toast').textContent.includes('Example')",
    "Example copied",
  );
});

test("a plain http page is said to be not secure", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup" });
  const pop = await w.icon(await w.tab("evil.test", "/otc"));
  await pop.until("document.querySelector('#site-http')", "the http line");
  expect(await text(pop, "#site-http")).toBe(
    "This page is not secureevil.test uses http: a code typed here can be read on the way.",
  );
  expect(await pop.eval("document.querySelector('#site-fake')")).toBeNull();
});
