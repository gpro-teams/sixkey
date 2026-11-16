// Budget work 3's screen, rendered by Preact into a minimal document (test/helpers/mini-dom.ts; budget work 3's notes):
//   - Settings › Security › Record (src/options/SecurityCard.tsx): the record reads back every entry of a kind's form, a
//     newer version's too, and the card lists those it has a label for, only those (an own property of its table: never
//     one of Object's), counting "older" among them; the PIN after a restart's two lines.
// (Its second, the trash's mark of an account a plugin moved there, went with the plugin platform.) The real page is
// test/e2e/pin-restart.spec.ts's.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityLogView } from "../../src/core/service/security-log";
import { fullCatalog } from "../../src/ui/catalog-full";
import { loadCatalog, setLangChoice, t } from "../../src/ui/i18n";
import { installMiniDom, type MiniElement } from "../helpers/mini-dom";

const { SecurityCard } = await import("../../src/options/SecurityCard");

let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
beforeAll(async () => {
  setLangChoice("en");
  await loadCatalog(fullCatalog);
});
beforeEach(() => {
  dom = installMiniDom();
  root = dom.doc.body;
  (globalThis as Record<string, unknown>).chrome = {
    storage: { onChanged: { addListener: () => undefined, removeListener: () => undefined } },
  };
});
afterEach(() => {
  render(null, root as unknown as Element);
  vi.restoreAllMocks();
  dom.undo();
});
/** Lets the lazy chunk's import and every read it starts finish (a few turns of the event loop, not microtasks only). */
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};
const cls = (e: MiniElement) => e.attrs.get("class") ?? "";

describe("Settings › Security › Record: the kinds it has a label for, and only those", () => {
  async function card(entries: { at: number; kind: string }[]) {
    const view: SecurityLogView = { state: "ok", entries, failed: 0, ackAt: null };
    const rt = {
      security: { read: async () => view },
      store: { snapshots: async () => [] },
      mirror: null,
      service: { lastBackupAt: async () => null },
      local: { get: async () => ({}) },
    };
    act(() =>
      render(
        h(SecurityCard, {
          rt: rt as never,
          status: { state: "unlocked", passwordProtected: true } as never,
          vault: null,
          reload: async () => undefined,
        }),
        root as unknown as Element,
      ),
    );
    await settle();
    const list = root.byId("sec-log-list");
    return list ? list.all((e) => e.localName === "li") : [];
  }
  const label = (li: MiniElement) => li.all((e) => e.localName === "span")[0]?.textContent;

  it("the retired PIN switch's kinds (2026-10-30), a newer version's kinds, Object's names and the YubiKey reservation: kept in the record, not listed", async () => {
    const lis = await card([
      { at: 9, kind: "pin_restart_off" },
      { at: 8, kind: "from_a_newer_version" },
      { at: 7, kind: "constructor" },
      { at: 6, kind: "to_string" },
      { at: 5, kind: "oath_on" },
      { at: 4, kind: "has_own_property" },
      { at: 3, kind: "pin_restart_on" },
      { at: 2, kind: "unlock_failed" },
      { at: 1, kind: "toString" }, // not even a kind's form: the record would not read it; the card still lists nothing
    ]);
    expect(lis.map(label)).toEqual([t("secKUnlockFailed")]);
    expect(lis.map(cls)).toEqual(["bad"]); // a wrong guess is marked as one
  });

  it("the newest 15 of those it lists, and 'older' counts the rest of them only", async () => {
    const named = Array.from({ length: 20 }, (_, i) => ({ at: 100 - i, kind: "export_plain" }));
    const unknown = Array.from({ length: 7 }, (_, i) => ({ at: 50 - i, kind: "made_up" }));
    const lis = await card([...named.slice(0, 10), ...unknown, ...named.slice(10)]);
    expect(lis).toHaveLength(16);
    expect(lis.slice(0, 15).every((li) => label(li) === t("secKExportPlain"))).toBe(true);
    expect(lis[15]!.textContent).toBe(t("secLogOlder", 5));
  });

  it("a record of nothing it has a label for says so, as an empty one, and offers nothing to clear", async () => {
    await card([{ at: 1, kind: "from_a_newer_version" }]);
    expect(root.byId("sec-log-list")).toBe(null);
    expect(root.textContent).toContain(t("secLogEmpty"));
    expect(root.byId("sec-log-clear")).toBe(null); // what it does not list stays for the version that wrote it
    // one it lists: the list, and Clear
    render(null, root as unknown as Element);
    await card([{ at: 2, kind: "export_plain" }]);
    expect(root.byId("sec-log-list")).not.toBe(null);
    expect(root.byId("sec-log-clear")).not.toBe(null);
  });
});
