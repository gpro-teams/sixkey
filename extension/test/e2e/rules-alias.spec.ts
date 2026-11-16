// TOTP autofill Stage 3, AF3-4: "same sign-in" suggestions in the popup's and the side panel's list, in real Chromium
// through the extension (docs/design/notes/AUTOFILL3-NOTES.md §8). The e2e build's bundle adds one test group to Apple's
// (test/fixtures/rules/aliases.json): old.alias.test → new.alias.test, one way, as Apple writes twitter.com → x.com. The
// world's "Related" account is remembered for old.alias.test here; no account is registered for any alias host, so each
// page asks "Which account for <host>?". The pages are the fixture server's plain page, served on every host.
// Measured: how long after the list is built for the page the line comes (the side panel, which can watch from before);
// pinned: no row moves after that, nor on a click, nor on the clock's ticks.
import { expect, test } from "@playwright/test";
import { addSites, world, type World } from "./autofill-helpers";
import type { PanelPage } from "./panel-helpers";

let w: World | undefined;
test.afterEach(async () => {
  await w?.close();
  w = undefined;
});

const LINE = "Same sign-in as old.alias.test";
/**
 * Watches the list in the page: each time what it shows changes (the rows' sections, names and lines, and the "Which
 * account" question; not the codes), the time and the picture go into window.__pics.
 */
const OBSERVE = `(() => {
  const pic = () =>
    [...document.querySelectorAll('#list .row')]
      .map((r) => r.parentElement.className + ' | ' + [...r.querySelectorAll('.who b, .who i')].map((x) => x.textContent).filter(Boolean).join(' | '))
      .join('\\n') + '\\n? ' + (document.querySelector('#ask-q')?.textContent ?? '');
  let last = pic();
  window.__pics = [[performance.now(), last]];
  new MutationObserver(() => {
    const p = pic();
    if (p !== last) window.__pics.push([performance.now(), (last = p)]);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
})()`;
type Pics = [number, string][];
const pics = (s: PanelPage) => s.eval<Pics>("window.__pics");
const lineShown = `[...document.querySelectorAll('.sect.related .row .who i')].some((i) => i.textContent === ${JSON.stringify(LINE)})`;
/** The row of the account named `name`: its section's class and its lines. */
const rowOf = (s: PanelPage, name: string) =>
  s.eval<{ sect: string; lines: string[]; remember: boolean; fill: boolean } | null>(`(() => {
    const r = [...document.querySelectorAll('.row')].find((x) => x.querySelector('.who b')?.textContent === ${JSON.stringify(name)});
    return r && { sect: r.parentElement.className, lines: [...r.querySelectorAll('.who i')].map((i) => i.textContent).filter(Boolean),
      remember: !!r.querySelector('.remember'), fill: !!r.querySelector('.fillbtn') };
  })()`);
const search = (s: PanelPage, text: string) =>
  s.eval(
    `(() => { const q = document.getElementById('q'); q.value = ${JSON.stringify(text)}; q.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("side panel: the line on the group's page, measured; nothing moves after it; www. yes, a subdomain no", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "panel" });
  await addSites(w.p, "Related", ["old.alias.test"]);
  // first a registered page (fix.test: This site; no question, so nothing is looked up), then the group's page
  const home = await w.tab("app.fix.test", "/plain");
  const panel = await w.icon(home);
  await panel.until("document.querySelector('.sect.site')", "This site on app.fix.test");
  await panel.eval(OBSERVE);
  const page = await w.tab("new.alias.test", "/plain");
  await w.icon(page);
  await panel.until(
    "/new\\.alias\\.test/.test(document.getElementById('ask-q')?.textContent ?? '')",
    "the list for new.alias.test",
  );
  let inTime = true;
  try {
    await panel.until(lineShown, "the line", 3000);
  } catch {
    inTime = false; // a slow machine: the answer came after 300 ms, so it waits for the next rebuild of the list
  }
  const seen = await pics(panel);
  const built = seen.find(([, p]) => p.includes("? Which account for new.alias.test?"))!;
  const lined = seen.find(([, p]) => p.includes(LINE));
  const delay = lined ? Math.round(lined[0] - built[0]) : null;
  test.info().annotations.push({
    type: "alias delay",
    description: lined ? `${delay} ms after the list for new.alias.test was drawn` : "late: shown at the next search",
  });
  console.log(`alias line: ${lined ? `${delay} ms after the list was drawn` : "late, not shown by itself"}`);
  if (inTime) {
    // what it changed: the Related row moved to Possibly related, with its line; nothing else
    const i = seen.indexOf(built);
    expect(seen.slice(i + 1).map(([, p]) => p)).toEqual([lined![1]]);
    expect(lined![1]).toContain(`sect related | Related | carol | ${LINE}`);
  } else expect(seen.at(-1)).toBe(built);
  // then nothing moves: not on the clock's ticks, not on a click's render (a copy)
  const before = (await pics(panel)).length;
  await pause(1500);
  await panel.gesture("document.querySelector('.row .copy').click()");
  await pause(1500);
  expect((await pics(panel)).length).toBe(before);
  if (!inTime) {
    await search(panel, "rel");
    await panel.until(lineShown.replace(".sect.related ", ""), "the line, at the search");
    await search(panel, "");
    await panel.until(lineShown, "the line under Possibly related");
  }
  expect(await rowOf(panel, "Related")).toEqual({
    sect: "sect related",
    lines: ["carol", LINE],
    remember: true,
    fill: false,
  });
  expect(await panel.eval<string>("document.getElementById('ask-q').textContent")).toBe(
    "Which account for new.alias.test?",
  ); // the question and the line, both (N15)
  // www. on the page's side: the same member
  const www = await w.tab("www.new.alias.test", "/plain");
  await w.icon(www);
  await panel.until(
    "/www\\.new\\.alias\\.test/.test(document.getElementById('ask-q')?.textContent ?? '')",
    "www's list",
  );
  await panel.until(lineShown, "the line on www.new.alias.test", 5000);
  // a subdomain is not the member: no line, however long one waits
  const sub = await w.tab("m.new.alias.test", "/plain");
  await w.icon(sub);
  await panel.until(
    "/m\\.new\\.alias\\.test/.test(document.getElementById('ask-q')?.textContent ?? '')",
    "the subdomain's list",
  );
  await pause(2000);
  expect(await rowOf(panel, "Related")).toMatchObject({
    lines: ["carol"],
    sect: expect.not.stringContaining("related"),
  });
});

test("popup: the row under Possibly related with its line and Remember, no Fill; Remember makes it This site, with Fill", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup" });
  await addSites(w.p, "Related", ["old.alias.test"]);
  const page = await w.tab("new.alias.test", "/plain");
  const pop = await w.icon(page);
  const attached = await pop.eval<number>("performance.now()");
  await pop.until("document.querySelector('.row')", "the list");
  const already = await pop.eval<boolean>(lineShown);
  if (!already) await pop.eval(OBSERVE);
  let inTime = true;
  try {
    await pop.until(lineShown, "the line", 3000);
  } catch {
    inTime = false;
  }
  const at = await pop.eval<number>("performance.now()");
  console.log(
    `alias line in the popup: ${inTime ? (already ? `drawn by ${Math.round(attached)} ms (when the test attached)` : `seen at ${Math.round(at)} ms`) : "late"} after the popup's start`,
  );
  test.info().annotations.push({
    type: "alias line in the popup",
    description: inTime
      ? already
        ? `already drawn when the test attached, ${Math.round(attached)} ms after the popup's start`
        : `seen by ${Math.round(at)} ms after the popup's start`
      : "late: shown at the next search",
  });
  if (!inTime) {
    await search(pop, "rel");
    await search(pop, "");
    await pop.until(lineShown, "the line, after a search");
  }
  expect(await rowOf(pop, "Related")).toEqual({
    sect: "sect related",
    lines: ["carol", LINE],
    remember: true,
    fill: false,
  });
  expect(await pop.eval<number>("document.querySelectorAll('.sect.site').length")).toBe(0);
  // Remember: the sheet for new.alias.test, which names the account's own site; saved, the account is This site
  await pop.gesture("document.querySelector('.sect.related .row .remember').click()");
  await pop.until("document.querySelector('form.rm')", "the remember sheet");
  expect(await pop.eval<string>("document.getElementById('rm-warn')?.textContent ?? ''")).toMatch(
    /already remembered for old\.alias\.test/,
  );
  await pop.eval("document.querySelector('form.rm').requestSubmit()");
  await pop.until(
    "[...document.querySelectorAll('.sect.site .row .who b')].some((b) => b.textContent === 'Related')",
    "Related in This site",
  );
  expect(await rowOf(pop, "Related")).toMatchObject({ sect: "sect site", lines: ["carol"] });
  await pop.until("document.querySelector('.sect.site .row .fillbtn')", "its Fill button");
});

test("one way: an account remembered for new.alias.test gets no line on old.alias.test", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup" });
  await addSites(w.p, "Related", ["new.alias.test"]);
  const page = await w.tab("old.alias.test", "/plain");
  const pop = await w.icon(page);
  await pop.until("/old\\.alias\\.test/.test(document.getElementById('ask-q')?.textContent ?? '')", "the question");
  await pause(2500);
  expect(await rowOf(pop, "Related")).toMatchObject({ lines: ["carol"] });
  expect(await pop.eval<number>("document.querySelectorAll('.sect.related .row').length")).toBe(0);
});
