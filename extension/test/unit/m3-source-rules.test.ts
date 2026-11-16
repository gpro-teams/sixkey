// M3's rules about the source (SYNC-DESIGN §4 "Transport / Clock / KV all injected", §4.9; M2-NOTES §7 items 6, 18):
// what holds by construction and that no run-time check would notice a new line breaking. Comments are not code.
//   - the engine is pure and injectable: no browser API, network, timer, clock, logging or platform module;
//   - outside the engine only M5's wiring of the contexts that sync imports it, and the popup's module graph holds none
//     of it; it holds the outbox writer, which M5 wired into the runtime's port (measured: docs/design/notes/M5-NOTES.md);
//   - sk_sync_state and sk_sync_outbox are written only by M2's writers and the engine's one helper; sk_sync_cfg likewise;
//   - the clone-detection cursor travels only in PUT /v1/vault (§4.10 T2).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { popupKeys } from "../../scripts/catalog-keys.mjs";

const ROOT = join(__dirname, "../../src");
function sources(dir = ROOT): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const files = sources().map((p) => ({ path: relative(ROOT, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
const ENGINE = (p: string) => p.startsWith("core/sync/engine/");

describe("M3 source rules", () => {
  it("finds the engine's sources (so the rules are not vacuous)", () => {
    for (const p of [
      "core/sync/engine/engine.ts",
      "core/sync/engine/api.ts",
      "core/sync/engine/state.ts",
      "core/sync/engine/transport.ts",
      "core/sync/engine/keys.ts",
      "core/sync/engine/enroll.ts",
      "core/sync/local/outbox.ts",
    ]) {
      expect(
        files.some((f) => f.path === p),
        p,
      ).toBe(true);
    }
  });

  it("the engine is a pure, injectable state machine: no browser API, network, timer, clock, logging, dynamic import or platform module", () => {
    const ours = files.filter((f) => ENGINE(f.path));
    expect(ours.length).toBeGreaterThanOrEqual(10);
    for (const f of ours) {
      const t = code(f.text);
      for (const bad of [
        /\bchrome\./,
        /\bfetch\s*\(/,
        /\bconsole\./,
        /localStorage|sessionStorage|indexedDB/,
        /XMLHttpRequest|WebSocket|EventSource|sendBeacon/,
        /Date\.now|new Date\(/,
        /setTimeout|setInterval/,
        /\bnavigator\./,
        /\bimport\s*\(\s*["'`]/,
      ]) {
        expect(bad.test(t), `${f.path}: ${bad}`).toBe(false);
      }
      for (const m of t.matchAll(/from "([^"]+)"/g)) {
        const spec = m[1]!;
        expect(
          /^\.\/[a-z-]+$|^\.\.\/(crypto|local)\/[a-z-]+$|^\.\.\/\.\.\/(crypto|storage|vault|service)\/[a-z-]+$/.test(
            spec,
          ),
          `${f.path} imports ${spec}`,
        ).toBe(true);
      }
    }
  });

  it("outside the engine, only M5's wiring of the contexts that sync imports it (the service worker's, a sync page's, the transport, its permission gate and the bridge, the developer sync page); the outbox writer is imported by the engine and the runtime's port (M5)", () => {
    const engineImporters = new Set<string>();
    const outboxImporters = new Set<string>();
    for (const f of files) {
      if (ENGINE(f.path)) continue;
      const imports = [...code(f.text).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of imports) {
        if (/(^|\/)engine(\/|$)/.test(spec)) engineImporters.add(f.path);
        if (
          f.path !== "core/sync/local/outbox.ts" &&
          f.path !== "core/sync/local/outbox-writer.ts" &&
          /local\/outbox(?:-writer)?$|^\.\/outbox(?:-writer)?$/.test(spec)
        )
          outboxImporters.add(f.path);
      }
    }
    // M6: the settings page's Sync section reaches the engine through its one door, options/sync/gateway.ts
    expect([...engineImporters].sort()).toEqual([
      "devsync/main.ts",
      "options/sync/gateway.ts",
      "platform/api-permission.ts",
      "platform/bridge-page.ts",
      "platform/bridge-worker.ts",
      "platform/fetch-transport.ts",
      "platform/sync-engine.ts",
      "platform/sync-worker.ts",
    ]);
    expect([...outboxImporters].sort()).toEqual(["platform/runtime-base.ts"]); // the wiring every context shares
  });

  it("M2-NOTES §7 item 6: sk_sync_state, sk_sync_outbox and sk_sync_cfg are named only by their writers: M2's, the outbox writer and the engine's one helper", () => {
    const naming = (re: RegExp) =>
      files
        .filter((f) => re.test(code(f.text)))
        .map((f) => f.path)
        .sort();
    // (revision 4: the outbox writer reads the state through local/state.ts stateIfSyncOn, with the configuration, so it no
    // longer names the key itself: one file fewer)
    expect(naming(/SYNC_KEYS\.state\b|["']sk_sync_state["']/)).toEqual([
      "core/sync/engine/state.ts",
      "core/sync/local/keys.ts",
      "core/sync/local/pins.ts",
      "core/sync/local/state.ts",
    ]);
    // (M6: the writer is its own module, outbox-writer.ts, so that the popup loads it without the records' parsers; the
    // turn-off's keep rule, which reads the outbox, is its own module too, kept-at-turn-off.ts)
    expect(naming(/SYNC_KEYS\.outbox\b|["']sk_sync_outbox["']/)).toEqual([
      "core/sync/engine/state.ts",
      "core/sync/local/kept-at-turn-off.ts",
      "core/sync/local/keys.ts",
      "core/sync/local/outbox-writer.ts",
      "core/sync/local/pins.ts",
      "core/sync/local/state.ts",
    ]);
    expect(naming(/SYNC_KEYS\.cfg\b|["']sk_sync_cfg["']/)).toEqual([
      "core/sync/engine/state.ts",
      "core/sync/local/keys.ts",
      "core/sync/local/records.ts",
      "core/sync/local/state.ts",
    ]);
    // the engine writes them only through state.ts: no kv.set in the rest of the engine
    for (const f of files.filter((x) => ENGINE(x.path) && x.path !== "core/sync/engine/state.ts"))
      expect(/\.set\(\s*\{/.test(code(f.text)), f.path).toBe(false);
  });

  it("§4.10 T2: the cursor travels only in PUT /v1/vault (the API client names it only there)", () => {
    const api = code(files.find((f) => f.path === "core/sync/engine/api.ts")!.text);
    // the one mention of the cursor is inside the PutVaultBody type (its braces matched, however it is laid out)
    expect(api.match(/cursor/g)?.length).toBe(1);
    const at = api.indexOf("export type PutVaultBody = {");
    expect(at).toBeGreaterThanOrEqual(0);
    let end = api.indexOf("{", at);
    for (let depth = 0; end < api.length; end++) {
      if (api[end] === "{") depth++;
      else if (api[end] === "}" && --depth === 0) break;
    }
    expect(api.slice(at, end)).toMatch(/cursor/);
    expect(api).not.toMatch(/Sixkey-Cursor/i);
  });
});

describe("the popup's module graph carries none of the engine (M3)", () => {
  let popup: { modules: string[] };
  beforeAll(() => {
    popup = popupKeys(resolve(__dirname, "../.."));
  }, 30_000);
  it("no src/core/sync/engine/ module, nor M5's wiring of the contexts that sync; the outbox writer is there (M5 wired it into the runtime's port, and M2's exact list names it), its records' parsers are not (M6)", () => {
    expect(popup.modules).toContain("src/core/service/service-core.ts"); // not vacuous
    expect(popup.modules.filter((m) => m.startsWith("src/core/sync/engine/"))).toEqual([]);
    expect(popup.modules).toContain("src/core/sync/local/outbox-writer.ts");
    expect(popup.modules).not.toContain("src/core/sync/local/outbox.ts");
    expect(popup.modules).not.toContain("src/core/service/sync-flows.ts");
    for (const m of ["sync-engine", "sync-worker", "fetch-transport", "bridge-page", "bridge-worker"])
      expect(popup.modules).not.toContain(`src/platform/${m}.ts`);
    expect(popup.modules.filter((m) => m.startsWith("src/devsync/"))).toEqual([]);
  });
});
