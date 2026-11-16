// PHASE0X-PLAN B1: the popup list. Hidden codes, compact rows, sorting by name, the rows' structure for screen readers
// and the keyboard, the countdown under reduced motion, and the red zone.
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  acceptable,
  addByPaste,
  AWS_URI,
  close,
  digitsOf,
  GITHUB_URI,
  launch,
  openPopup,
  SECRET,
  startFresh,
  type Profile,
} from "./harness";
import { accountLines, pageTextAndAttributes, setDisplay } from "./list-helpers";

const AWS_SECRET = "JBSWY3DPEHPK3PXP";
let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

const clipboard = (pop: Page) => pop.evaluate(() => navigator.clipboard.readText());
const row = (pop: Page, name: string) => pop.locator(".row", { has: pop.locator(".who b", { hasText: name }) });

/** Every code a correct app could show for either account right now, whole and split in two as displayed. */
async function allCodes(): Promise<string[]> {
  const codes = [...(await acceptable(SECRET)), ...(await acceptable(AWS_SECRET, 8))];
  return codes.flatMap((c) => [c, `${c.slice(0, c.length / 2)} ${c.slice(c.length / 2)}`]);
}
async function expectNoCodeInPage(pop: Page) {
  const seen = await pageTextAndAttributes(pop);
  for (const c of await allCodes()) expect(seen, "a code is in the page").not.toContain(c.replace(/\s/g, ""));
}
async function shownCode(r: Locator): Promise<string> {
  await expect(r.locator(".code:not(.hid):not(.wait)")).toBeVisible();
  return digitsOf(await r.locator(".code").textContent());
}

test("hidden codes: no code anywhere in the page, a click still copies, Space and press-and-hold show one row for 5 seconds", async () => {
  test.setTimeout(90_000);
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}`);
  await setDisplay(p, { hideCodes: true });

  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(2);
  await expect(pop.locator(".row .code.hid")).toHaveCount(2);
  await expect(pop.locator(".row .code.hid").first().locator("i")).toHaveCount(6); // one dot per digit
  await expect(row(pop, "AWS").locator(".code.hid i")).toHaveCount(8);
  await pop.waitForTimeout(300); // codes are worked out in the background; give them time to (not) appear
  await expectNoCodeInPage(pop);
  await expect(row(pop, "GitHub").locator(".copy")).toHaveAccessibleName(/GitHub.*Code hidden/);

  // a click copies without showing anything
  await row(pop, "GitHub").click();
  await expect(pop.locator(".toast")).toContainText(/GitHub|next code/);
  expect(await acceptable(SECRET)).toContain(await clipboard(pop));
  await expectNoCodeInPage(pop);

  // Space on a focused row shows that row only, and does not copy it
  await pop.evaluate(() => navigator.clipboard.writeText("untouched"));
  await pop.locator("body").click({ position: { x: 5, y: 5 } });
  await pop.keyboard.press("ArrowDown"); // the second row, AWS, gets the focus
  await expect(row(pop, "AWS").locator(".copy")).toBeFocused();
  await pop.keyboard.press(" ");
  expect(await acceptable(AWS_SECRET, 8)).toContain(await shownCode(row(pop, "AWS")));
  await expect(row(pop, "GitHub").locator(".code.hid")).toBeVisible();
  expect(await clipboard(pop)).toBe("untouched");
  // hidden again after 5 seconds
  await expect(row(pop, "AWS").locator(".code.hid")).toBeVisible({ timeout: 7_000 });
  await expectNoCodeInPage(pop);
  // Space on another button still presses that button: the row's edit button opens the editor and shows nothing
  await pop.keyboard.press("Tab");
  await expect(row(pop, "AWS").locator(".more")).toBeFocused();
  await pop.keyboard.press(" ");
  await expect(pop.locator("#e-issuer")).toBeFocused();
  await expectNoCodeInPage(pop);
  await pop.keyboard.press("Escape");
  await expect(pop.locator("#e-issuer")).toHaveCount(0);

  // press and hold shows, and releasing does not copy; a plain click afterwards still copies
  const box = (await row(pop, "GitHub").locator(".copy").boundingBox())!;
  await pop.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await pop.mouse.down();
  await pop.waitForTimeout(700);
  expect(await acceptable(SECRET)).toContain(await shownCode(row(pop, "GitHub")));
  await pop.mouse.up();
  await pop.waitForTimeout(200);
  expect(await clipboard(pop)).toBe("untouched");
  await row(pop, "GitHub").click();
  await expect.poll(() => clipboard(pop)).not.toBe("untouched");
  expect(await acceptable(SECRET)).toContain(await clipboard(pop));
  expect((pop as unknown as { _errors: string[] })._errors).toEqual([]);
});

test("compact rows are about 38 px tall, standard ones 54 px, and both show the right code", async () => {
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}`);
  const height = (pop: Page) =>
    pop
      .locator(".row")
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);

  const std = await openPopup(p);
  expect(await acceptable(SECRET)).toContain(await shownCode(row(std, "GitHub")));
  expect(Math.abs((await height(std)) - 54)).toBeLessThanOrEqual(1);
  await std.close();

  await setDisplay(p, { density: "compact" });
  const pop = await openPopup(p);
  await expect(pop.locator(".list.compact")).toBeVisible();
  expect(await acceptable(SECRET)).toContain(await shownCode(row(pop, "GitHub")));
  expect(Math.abs((await height(pop)) - 38)).toBeLessThanOrEqual(1);
  // one line: the account name and its label sit side by side
  const [b, i] = await Promise.all([
    row(pop, "GitHub").locator(".who b").boundingBox(),
    row(pop, "GitHub").locator(".who i").boundingBox(),
  ]);
  expect(i!.x).toBeGreaterThan(b!.x + b!.width - 1);
});

test("sorting by name orders the list by the language's collation, and turns dragging off", async () => {
  await startFresh(p);
  const names = ["Zeta", "alpha", "Beta", "Server 10", "Server 9"];
  await addByPaste(
    p,
    accountLines(names.length, (i) => names[i]!),
  );

  const manual = await openPopup(p);
  await expect(manual.locator(".row")).toHaveCount(5);
  await expect(manual.locator(".who b")).toHaveText(names);
  await expect(manual.locator('.row[draggable="true"]')).toHaveCount(5);
  // dragging a row (by its copy button, which fills it) still reorders the manual order
  await row(manual, "Server 9").locator(".copy").dragTo(row(manual, "Zeta"));
  const dragged = ["Server 9", "Zeta", "alpha", "Beta", "Server 10"];
  await expect(manual.locator(".who b")).toHaveText(dragged);
  await manual.close();

  await setDisplay(p, { sort: "name" });
  const pop = await openPopup(p);
  await expect(pop.locator(".who b")).toHaveText(["alpha", "Beta", "Server 9", "Server 10", "Zeta"]);
  await expect(pop.locator('.row[draggable="true"]')).toHaveCount(0);
  // the arrow keys follow the order on screen
  await pop.locator("body").click({ position: { x: 5, y: 5 } });
  await pop.keyboard.press("ArrowDown");
  await expect(row(pop, "Beta").locator(".copy")).toBeFocused();
});

test("rows: no button inside an option or another control, two buttons per row, roving focus, a countdown in words", async () => {
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}\n${accountLines(1, () => "Cloudflare")}`);
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(3);
  await expect(pop.locator(".row .code:not(.wait)")).toHaveCount(3);

  // structure
  expect(await pop.locator('[role="option"]').count()).toBe(0);
  expect(await pop.locator('[role="option"] :is(button, a, input, select, textarea, [tabindex])').count()).toBe(0);
  expect(await pop.locator(":is(button, a) :is(button, a, input, select, textarea)").count()).toBe(0);
  expect(await pop.locator('[role="list"] > [role="listitem"].row').count()).toBe(3);
  for (const r of await pop.locator(".row").all()) {
    await expect(r.locator(":scope > button")).toHaveCount(2);
    await expect(r.locator(":scope > button.copy")).toHaveCount(1);
    await expect(r.locator(":scope > button.more")).toHaveCount(1);
  }
  await expect(row(pop, "GitHub").locator(".more")).toHaveAccessibleName(/GitHub/);

  // the countdown, readable by a screen reader (and not a live region), and big enough to read on screen
  await expect(row(pop, "GitHub").locator(".vh")).toHaveText(/^\d{1,2} seconds left$/);
  expect(await pop.locator("[aria-live]").count()).toBe(0);
  // the name, the code digit by digit (each digit is its own box), then the time left
  await expect(row(pop, "GitHub").locator(".copy")).toHaveAccessibleName(
    /^GitHub\s*alice@example\.com\s*(\d\s*){6}\s*\d{1,2} seconds left$/,
  );
  expect(
    parseFloat(
      await row(pop, "GitHub")
        .locator(".ring .sec")
        .evaluate((el) => getComputedStyle(el).fontSize),
    ),
  ).toBeGreaterThanOrEqual(9.5);
  // waiting dots use the muted colour, not the faint one (contrast)
  const colour = (cls: string, style = "") =>
    pop.evaluate(
      ([c, st]) => {
        const s = document.createElement("span");
        s.className = c!;
        s.setAttribute("style", st!);
        document.querySelector(".row .otp")!.append(s);
        const out = getComputedStyle(s).color;
        s.remove();
        return out;
      },
      [cls, style],
    );
  expect(await colour("code wait")).toBe(await colour("", "color: var(--muted)"));
  expect(await colour("code wait")).not.toBe(await colour("", "color: var(--faint)"));

  // roving tabindex: one row is in the tab order; arrows, Home and End move the focus between copy buttons
  await expect(pop.locator('.row .copy[tabindex="0"]')).toHaveCount(1);
  await pop.locator("body").click({ position: { x: 5, y: 5 } });
  await pop.keyboard.press("ArrowDown");
  await expect(row(pop, "AWS").locator(".copy")).toBeFocused();
  await expect(row(pop, "AWS").locator(".copy")).toHaveAttribute("tabindex", "0");
  await expect(pop.locator('.row .copy[tabindex="0"]')).toHaveCount(1);
  await pop.keyboard.press("End");
  await expect(row(pop, "Cloudflare").locator(".copy")).toBeFocused();
  await pop.keyboard.press("Home");
  await expect(row(pop, "GitHub").locator(".copy")).toBeFocused();
  await pop.keyboard.press("ArrowUp");
  await expect(row(pop, "GitHub").locator(".copy")).toBeFocused();
  // Tab goes from the copy button to the same row's edit button
  await pop.keyboard.press("Tab");
  await expect(row(pop, "GitHub").locator(".more")).toBeFocused();
  await pop.keyboard.press("Shift+Tab");

  // Enter on the focused copy button copies that row once
  await pop.keyboard.press("ArrowDown");
  await pop.keyboard.press("Enter");
  await expect.poll(async () => (await clipboard(pop)).length).toBe(8);
  expect(await acceptable(AWS_SECRET, 8)).toContain(await clipboard(pop));

  // typing while a row has the focus still searches
  await pop.keyboard.type("cl");
  await expect(pop.locator("#q")).toBeFocused();
  await expect(pop.locator("#q")).toHaveValue("cl");
  await expect(pop.locator(".row")).toHaveCount(1);
  expect((pop as unknown as { _errors: string[] })._errors).toEqual([]);
});

test("reduced motion: the ring still shows the time left, and follows it", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await p.ctx.newPage();
  await pop.emulateMedia({ reducedMotion: "reduce" });
  await pop.goto(`chrome-extension://${p.id}/popup/index.html`);
  await expect(pop.locator(".row .code:not(.wait)")).toHaveCount(1);
  expect(await pop.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

  // What the ring draws (from the styles in effect, so an animation would show), against the time actually left. The
  // ring is redrawn just after each whole second and only ever drains within a period, so each segment must lie between
  // what is due now and what was due 1.5 s ago; that allows for a late tick without letting a wrong drawing through.
  const sample = () =>
    pop
      .locator(".row .ring")
      .first()
      .evaluate((svg) => {
        const fills = [...svg.querySelectorAll(".fil")].map(
          (el) => 1 + parseFloat(getComputedStyle(el).strokeDashoffset),
        );
        const due = (ms: number) => {
          const gone = (((ms / 1000) % 30) / 30) * 360;
          return Array.from({ length: 6 }, (_, i) => {
            const a0 = i * 60 + 4.5,
              a1 = (i + 1) * 60 - 4.5;
            return Math.max(0, Math.min(1, (a1 - Math.max(a0, gone)) / (a1 - a0)));
          });
        };
        const now = Date.now();
        return { fills, now: due(now), before: due(now - 1500), rem: 30 - ((now / 1000) % 30) };
      });
  let checked = 0;
  for (let k = 0; k < 6 && checked < 3; k++) {
    const { fills, now, before, rem } = await sample();
    expect(fills).toHaveLength(6);
    if (rem <= 28.5) {
      // not just after a new period began (then "1.5 s ago" belongs to the previous period)
      fills.forEach((f, i) => {
        expect(f, `segment ${i} at ${rem.toFixed(2)} s left`).toBeGreaterThanOrEqual(now[i]! - 0.01);
        expect(f, `segment ${i} at ${rem.toFixed(2)} s left`).toBeLessThanOrEqual(before[i]! + 0.01);
      });
      if (rem > 1.5) expect(fills.reduce((a, b) => a + b, 0)).toBeGreaterThan(0); // never shown as used up early
      checked++;
    }
    await pop.waitForTimeout(1100);
  }
  expect(checked).toBeGreaterThanOrEqual(2);
});

test("the last five seconds turn only the ring and its number red; the code keeps its colour", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await p.ctx.newPage();
  // three seconds before a period ends (the page's clock only; timers keep running)
  await pop.clock.setFixedTime(Math.ceil(Date.now() / 30_000) * 30_000 + 27_000);
  await pop.goto(`chrome-extension://${p.id}/popup/index.html`);
  const r = pop.locator(".row").first();
  await expect(r).toHaveClass(/\blow\b/);
  await expect(r.locator(".code:not(.wait)")).toBeVisible();
  const colours = await r.evaluate((el) => ({
    code: getComputedStyle(el.querySelector(".code")!).color,
    name: getComputedStyle(el.querySelector(".who b")!).color,
    ring: getComputedStyle(el.querySelector(".ring .fil")!).stroke,
    sec: getComputedStyle(el.querySelector(".ring .sec")!).fill,
  }));
  expect(colours.code).toBe(colours.name); // the ink colour
  expect(colours.ring).not.toBe(colours.code);
  expect(colours.sec).toBe(colours.ring); // both the danger colour
});
