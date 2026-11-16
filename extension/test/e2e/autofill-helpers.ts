// Helpers for the TOTP autofill end-to-end tests (autofill1.spec.ts, visual-guard.spec.ts): a profile with accounts registered for
// the fixture sites, the browser's own click on the toolbar icon (which grants activeTab for the clicked tab, as a person's click
// does: panel-helpers.ts), and the popup or the side panel read and driven through the DevTools protocol.
import { expect, type Page } from "@playwright/test";
import { servePages } from "../helpers/autofill-pages";
import { acceptable, addByPaste, openOptions, openPopup, SECRET, startFresh, type Profile } from "./harness";
import { closeDriven, drive, launchDriven, type Driver, type PanelPage } from "./panel-helpers";

export const EXAMPLE_URI = `otpauth://totp/Example:alice@example.com?secret=${SECRET}&issuer=Example`;
export const WORK_URI = `otpauth://totp/Work:bob?secret=JBSWY3DPEHPK3PXP&issuer=Work&digits=8`;
export const RELATED_URI = `otpauth://totp/Related:carol?secret=JBSWY3DPEHPK3PXQ&issuer=Related`;

/**
 * The host names of the fixture sites: all on the local server. `fix.test` is the registered domain of the accounts;
 * ws.g.test is the owner's page of AFMATCH (afmatch.spec.ts): a label of 2, and no account registered for it.
 */
export const HOSTS = ["app.fix.test", "auth.fix.test", "evil.test", "related.test", "down.fix.test", "ws.g.test"];
/** The hosts of the e2e build's test rules (TOTP autofill Stage 3, AF3-3b; test/fixtures/rules/sites): one rule each. */
export const RULE_HOSTS = ["rules.fix.test", "rules2.fix.test"];
/**
 * The e2e build's test host of the code typed after the password (AF3-5; test/fixtures/rules/appends.json), a subdomain
 * of it, and a look-alike that is neither (rules-appends.spec.ts). The accounts' fix.test covers all three.
 */
export const APPEND_HOSTS = ["append.fix.test", "us.append.fix.test", "notappend.fix.test"];
/**
 * The e2e build's test "same sign-in" group's hosts (AF3-4; test/fixtures/rules/aliases.json: old.alias.test → new.alias.test,
 * one way), its www. variant, and a subdomain that is not the member (rules-alias.spec.ts). No account is registered for
 * any of them by the world: a spec remembers old.alias.test (or new.alias.test) for an account.
 */
export const ALIAS_HOSTS = ["new.alias.test", "www.new.alias.test", "m.new.alias.test", "old.alias.test"];
/**
 * The dev and e2e builds' rules origin's host (scripts/rules-update.mjs RULES_ORIGINS; AF3-U2), with the world's
 * `rulesPort`; and a page host for the live bundles of the updater's tests (rules-update.spec.ts), which no built-in rule
 * names.
 */
export const RULES_ORIGIN_HOST = "rules.fix.test";
export const LIVE_HOST = "live.fix.test";
/** The https fixture host (the world's `tls` option): registered like the others, served over TLS. */
export const TLS_HOST = "tls.fix.test";
/**
 * The Stage 2 fixture hosts (AUTOFILL2 patch 2): the e2e build grants them up front as required host permissions, its
 * tests being unable to answer Chrome's prompt (manifest.e2e.json; check-dist holds the list). Stage 1's hosts above stay
 * ungranted. GRANTED_TLS is served over TLS (with the `tls` option) at the default port: the host rule maps it to the
 * TLS server's port, so its address has none, as a site's that may be turned on (core/autofill-sites.ts siteOfUrl).
 */
export const GRANTED = "granted.fix.test";
export const GRANTED_TLS = "grantedtls.fix.test";

export type Site = Awaited<ReturnType<typeof servePages>>;
export type World = {
  p: Profile;
  d: Driver;
  site: Site;
  /** A new tab on a fixture page, brought to the front. */
  tab(host: string, path: string): Promise<Page>;
  /** The browser's click on the toolbar icon on this tab: opens the surface the icon opens (the side panel, or the popup) and returns it. */
  icon(page: Page): Promise<PanelPage>;
  close(): Promise<void>;
};

/** The page's address: http on the plain server, https for the TLS host. */
export const urlOf = (site: Site, host: string, path: string) =>
  host === GRANTED_TLS
    ? `https://${host}${path}`
    : host === TLS_HOST
      ? `https://${host}:${site.tlsPort}${path}`
      : `http://${host}:${site.port}${path}`;

export async function addSites(p: Profile, name: string, sites: string[]) {
  const pop = await openPopup(p);
  const row = pop.locator(".row", { has: pop.locator(".who b", { hasText: name }) });
  await row.hover();
  await row.locator(".more").click();
  for (const s of sites) {
    await pop.locator("#e-site").fill(s);
    await pop.locator("#e-site").press("Enter");
  }
  await pop.getByRole("button", { name: /^(Save|保存)$/ }).click();
  await expect(pop.locator("#e-issuer")).toHaveCount(0);
  await pop.close();
}

/** Opener "panel" (the toolbar icon opens the side panel) or "popup". */
async function pickOpener(p: Profile, v: "popup" | "panel") {
  const opt = await openOptions(p, "#appearance");
  await opt.locator(`#look-open-${v}`).check();
  await expect
    .poll(() => p.ctx.serviceWorkers()[0]!.evaluate(() => chrome.action.getPopup({})))
    .toBe(v === "panel" ? "" : `chrome-extension://${p.id}/popup/index.html`);
  await opt.close();
}

/**
 * `scripting` granted as a person's click grants it (optional since wave 1b of the plugin platform: PLUGINS-W1B-NOTES.md):
 * Playwright's click on a button in one of Sixkey's pages is a real input event, so the request is in its gesture, and
 * Chrome grants this permission without a dialog. Resolves once Sixkey holds it.
 */
export async function grantScripting(p: Profile): Promise<void> {
  const page = await openOptions(p, "#appearance");
  await page.evaluate(() => {
    const b = document.createElement("button");
    b.id = "sk-test-scripting";
    b.textContent = "scripting";
    b.style.cssText = "position:fixed;top:0;left:0;z-index:99999";
    b.onclick = () =>
      void chrome.permissions.request({ permissions: ["scripting"] }).then((r) => (b.dataset.r = String(r)));
    document.body.append(b);
  });
  await page.click("#sk-test-scripting");
  await expect.poll(() => page.evaluate(() => document.getElementById("sk-test-scripting")?.dataset.r)).toBe("true");
  await page.close();
}
/** Whether Sixkey holds `scripting` now (Chrome's answer; the namespace alone stays after it is given back). */
export const holdsScripting = (p: Profile) =>
  p.ctx.serviceWorkers()[0]!.evaluate(() => chrome.permissions.contains({ permissions: ["scripting"] }));

/**
 * A fresh profile with accounts: Example (registered for fix.test and 127.0.0.1), Work (8 digits, registered for fix.test),
 * Related (no sites). `surface`: what the icon opens. `scripting`: granted first (the default: as after a first Fill click
 * or a site turned on); false: as a fresh install has it, not asked for yet.
 */
export async function world(o: {
  surface: "panel" | "popup";
  accounts?: ("example" | "work" | "related")[];
  /** Also serve https at tls.fix.test (a throw-away certificate; the browser ignores certificate errors). */
  tls?: boolean;
  /** More to paste with the accounts (another app's export, say): added as it comes, with no sites. */
  paste?: string;
  scripting?: boolean;
  /** More switches for the browser (its language, say). */
  args?: string[];
  /** The build loaded: the e2e build's (dist-e2e/) unless another is named (the store build's, dist/). */
  dist?: string;
  /**
   * The site rules' origin's port (test/helpers/rules-server.ts, AF3-U2): rules.fix.test, the dev and e2e builds' rules
   * origin, is then that server (over TLS, certificate errors ignored), not the pages' (so its test rule's page is not
   * served), and LIVE_HOST is a page host.
   */
  rulesPort?: number;
}): Promise<World> {
  const site = await servePages(!!o.tls);
  const pageHosts = [...HOSTS, ...RULE_HOSTS, ...APPEND_HOSTS, ...ALIAS_HOSTS, GRANTED].filter(
    (h) => !(o.rulesPort && h === RULES_ORIGIN_HOST),
  );
  const hosts = [
    ...[...pageHosts, ...(o.rulesPort ? [LIVE_HOST] : [])].map((h) => `MAP ${h} 127.0.0.1:${site.port}`),
    ...(o.tls ? [TLS_HOST, GRANTED_TLS].map((h) => `MAP ${h} 127.0.0.1:${site.tlsPort}`) : []),
    ...(o.rulesPort ? [`MAP ${RULES_ORIGIN_HOST} 127.0.0.1:${o.rulesPort}`] : []),
  ];
  const p = await launchDriven(
    hosts,
    [...(o.tls || o.rulesPort ? ["--ignore-certificate-errors"] : []), ...(o.args ?? [])],
    [],
    o.dist,
  );
  await startFresh(p);
  const want = new Set(o.accounts ?? ["example", "related"]);
  await addByPaste(
    p,
    [want.has("example") && EXAMPLE_URI, want.has("work") && WORK_URI, want.has("related") && RELATED_URI, o.paste]
      .filter(Boolean)
      .join("\n"),
  );
  if (want.has("example")) await addSites(p, "Example", ["fix.test", "127.0.0.1"]);
  if (want.has("work")) await addSites(p, "Work", ["fix.test"]);
  await pickOpener(p, o.surface);
  if (o.scripting !== false) await grantScripting(p);
  const d = await drive(p);
  const tab = async (host: string, path: string) => {
    const page = await p.ctx.newPage();
    await page.goto(urlOf(site, host, path));
    await page.bringToFront();
    return page;
  };
  const icon = async (page: Page): Promise<PanelPage> => {
    await page.bringToFront();
    await d.clickIconOn(page); // that very tab, found by its own target (a failed load's error page too: AF286)
    return o.surface === "panel" ? d.panel() : popupPage(d, p);
  };
  return {
    p,
    d,
    site,
    tab,
    icon,
    async close() {
      await closeDriven(p, d);
      await site.close();
    },
  };
}

/** The action popup, which the browser opened for the icon click, read through its DevTools target. */
export async function popupPage(d: Driver, p: Profile): Promise<PanelPage> {
  const url = `chrome-extension://${p.id}/popup/index.html`;
  let id = "";
  let seen: string[] = [];
  try {
    await expect
      .poll(
        async () => {
          const { targetInfos } = (await d.bs.send("Target.getTargets")) as {
            targetInfos: { targetId: string; url: string; type: string }[];
          };
          seen = targetInfos.map((t) => `${t.type} ${t.url.replace(`chrome-extension://${p.id}`, "ext")}`);
          id = targetInfos.filter((t) => t.url === url && t.type !== "tab").map((t) => t.targetId)[0] ?? "";
          return id;
        },
        // 15 s: a popup the worker opens can take that long on a machine under heavy load (AUTOFILL2-P1-VERIFY NIT-3)
        { message: "the popup's page", timeout: 15_000 },
      )
      .not.toBe("");
  } catch (e) {
    // what the browser had instead (AF2-77: a rare flake of autofill2.spec.ts:77 whose cause a run must show): every
    // target at the last look, so a failure says whether the popup came at another address, as a tab, or not at all
    throw new Error(`${(e as Error).message}\ntargets at the last look: ${JSON.stringify(seen)}`);
  }
  const { sessionId } = (await d.bs.send("Target.attachToTarget", { targetId: id, flatten: false } as never)) as {
    sessionId: string;
  };
  let next = 1;
  const waiting = new Map<
    number,
    (r: {
      result?: { result?: { value?: unknown }; exceptionDetails?: { text: string } };
      error?: { message: string };
    }) => void
  >();
  d.bs.on("Target.receivedMessageFromTarget", (e: { message: string; sessionId?: string }) => {
    const m = JSON.parse(e.message) as { id?: number };
    if (m.id !== undefined) waiting.get(m.id)?.(m as never);
  });
  const call = (method: string, params: Record<string, unknown>) =>
    new Promise<{
      result?: { result?: { value?: unknown }; exceptionDetails?: { text: string } };
      error?: { message: string };
    }>((resolve) => {
      const i = next++;
      waiting.set(i, (r) => {
        waiting.delete(i);
        resolve(r);
      });
      void d.bs.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id: i, method, params }),
      } as never);
    });
  await call("Runtime.enable", {});
  const run = async <T>(expression: string): Promise<T> => {
    const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error(r.error.message);
    if (r.result?.exceptionDetails) throw new Error(`in the popup: ${r.result.exceptionDetails.text}: ${expression}`);
    return r.result?.result?.value as T;
  };
  return {
    eval: run,
    async until(expression, what, timeout = 10_000) {
      await expect
        .poll(() => run<boolean>(`!!(${expression})`).catch(() => false), { message: what, timeout })
        .toBe(true);
    },
    async gesture(expression) {
      const r = await call("Runtime.evaluate", { expression, userGesture: true });
      if (r.error) throw new Error(r.error.message);
    },
    missingText: () => [],
    async cdp(method, params) {
      const r = await call(method, params);
      if (r.error) throw new Error(r.error.message);
      return r.result;
    },
  };
}

/** Wait until the page's list in the surface shows the Fill strip with this text pattern. */
export const barText = (s: PanelPage) => s.eval<string>("document.querySelector('.fillbar')?.textContent ?? ''");
/**
 * The card of the account `name` in "This site": its Fill button is clicked (by name: a card's button comes and goes with its
 * state), in a user gesture, as a person's click (the first Fill asks Chrome for `scripting` in it: wave 1b).
 */
export const clickFill = (s: PanelPage, name?: string) =>
  s.gesture(
    `(() => { const rows = [...document.querySelectorAll('.sect.site .row')]; const row = ${name === undefined ? "rows[0]" : `rows.find((r) => r.querySelector('.who b').textContent === ${JSON.stringify(name)})`}; row.querySelector('.fillbtn').click(); })()`,
  );
/** Fill, answering "not secure (http)" with Fill anyway when the page asks (a *.fix.test page is http, and no IP address). */
export async function clickFillAnyway(s: PanelPage, name?: string): Promise<void> {
  await clickFill(s, name);
  await s.until("document.querySelector('.fillnote.warn')", "the not-secure question");
  await s.eval("document.querySelector('.fillanyway').click()");
}
export const rowNames = (s: PanelPage) =>
  s.eval<string[]>("[...document.querySelectorAll('.sect.site .row .who b')].map((b) => b.textContent)");

/** Wait until the current code window has at least `s` seconds left (the fill takes the current code then). */
export async function windowOpen(s = 8, period = 30): Promise<void> {
  const left = () => period - ((Date.now() / 1000) % period);
  if (left() < s) await new Promise((r) => setTimeout(r, (left() + 0.3) * 1000));
}
export const codesNow = (digits: 6 | 8 = 6, secret = SECRET) => acceptable(secret, digits);
