// The developer sync page's handling of the API host permission (src/devsync/main.ts), as M6's flows are to do it
// (M5-NOTES §12): a first upload or a join keeps the permission only when it ends "done" or "unconfirmed" (a join:
// "enrolled" or "unconfirmed"); every other outcome, a result such as vault_exists or keyring_changed or an exception,
// gives it back while sync is not on; turning sync off removes it last; the grant button asks first, before any await.
// The page runs over stand-in chrome.* APIs and a stand-in document; the enrolment flows are replaced by stubs.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const flows = vi.hoisted(() => ({
  firstUpload: { kind: "done" } as { kind: string } | Error,
  join: "enrolled" as string | Error,
  calls: [] as string[],
}));
vi.mock("../../src/core/sync/engine/enroll", () => ({
  firstUpload: async () => {
    flows.calls.push("firstUpload");
    if (flows.firstUpload instanceof Error) throw flows.firstUpload;
    return flows.firstUpload;
  },
  joinWithRecoveryCode: async () => ({ plan: true }),
  commitJoin: async () => {
    flows.calls.push("commitJoin");
    if (flows.join instanceof Error) throw flows.join;
    return flows.join;
  },
}));
vi.mock("../../src/core/sync/engine/keys", () => ({
  turnSyncOff: async () => {
    flows.calls.push("turnSyncOff");
  },
}));

const SELF = "abcdefghijklmnopabcdefghijklmnop";
function area() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}
const b64u = (s: string) => Buffer.from(s).toString("base64url");
const TOKEN = `h.${b64u(JSON.stringify({ sub: "8f14e45f-ceea-467a-9575-6e2c1d1b9c11" }))}.s`;

function fake() {
  const perm = { granted: true, log: [] as string[] };
  const handlers: Record<string, () => void> = {};
  const local = area();
  const chrome = {
    runtime: {
      id: SELF,
      getManifest: () => ({ version: "0.1.0" }),
      sendMessage: async (m: { type?: string; req?: { target: string } }) => {
        if (m.type !== "sk-api") return undefined;
        if (m.req?.target === "/v1/auth/verify")
          return {
            ok: true,
            res: {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ account_token: TOKEN, expires_at: 1_900_000_000 }),
            },
          };
        return { ok: false, reason: "offline" };
      },
    },
    storage: { local, session: area() },
    permissions: {
      contains: async () => {
        perm.log.push("contains");
        return perm.granted;
      },
      request: async () => {
        perm.log.push("request");
        perm.granted = true;
        return true;
      },
      remove: async () => {
        perm.log.push("remove");
        const was = perm.granted;
        perm.granted = false;
        return was;
      },
    },
  };
  const el = (id: string) => ({
    id,
    textContent: "",
    addEventListener: (type: string, fn: () => void) => {
      handlers[`${id}:${type}`] = fn;
    },
  });
  const els = new Map(["out", "grant", "revoke"].map((id) => [id, el(id)]));
  const document = { getElementById: (id: string) => els.get(id) ?? null };
  return { chrome, document, perm, handlers, local };
}

type DevSync = {
  signIn(email: string, code: string): Promise<unknown>;
  firstUpload(o: Record<string, string>): Promise<string>;
  joinWithRecoveryCode(o: Record<string, string>): Promise<string>;
  turnSyncOff(password: string): Promise<void>;
};

describe("src/devsync/main.ts and the API permission", () => {
  // the page defines sixkeyDevSync once and for good (not configurable), so it is loaded once; each test resets the rest
  const f = fake();
  let dev: DevSync;
  beforeAll(async () => {
    vi.stubGlobal("chrome", f.chrome);
    vi.stubGlobal("document", f.document);
    await import("../../src/devsync/main");
    dev = (globalThis as unknown as { sixkeyDevSync: DevSync }).sixkeyDevSync;
    await dev.signIn("e@example.com", "123456");
  });
  beforeEach(() => {
    flows.calls.length = 0;
    flows.firstUpload = { kind: "done" };
    flows.join = "enrolled";
    f.perm.granted = true;
    f.perm.log.length = 0;
    f.local.data.delete("sk_sync_cfg");
  });
  afterAll(() => vi.unstubAllGlobals());

  const upload = () => dev.firstUpload({ password: "p", recoveryCode: "r", deviceName: "d", email: "e@example.com" });
  const join = () => dev.joinWithRecoveryCode({ recoveryCode: "r", deviceName: "d", email: "e@example.com" });

  for (const kind of ["done", "unconfirmed"]) {
    it(`a first upload that ends "${kind}" keeps the permission`, async () => {
      flows.firstUpload = { kind };
      expect(await upload()).toBe(kind);
      expect(f.perm.log).not.toContain("remove");
    });
  }
  for (const kind of ["vault_exists", "keyring_changed"]) {
    it(`a first upload that ends "${kind}" (a result, not an exception) gives the permission back`, async () => {
      flows.firstUpload = { kind };
      expect(await upload()).toBe(kind);
      expect(f.perm.log).toContain("remove");
      expect(f.perm.granted).toBe(false);
    });
  }
  it("a first upload that throws gives the permission back", async () => {
    flows.firstUpload = new Error("offline");
    await expect(upload()).rejects.toThrow("offline");
    expect(f.perm.granted).toBe(false);
  });
  it("a join that ends enrolled or unconfirmed keeps it; one that throws gives it back", async () => {
    for (const r of ["enrolled", "unconfirmed"]) {
      flows.join = r;
      expect(await join()).toBe(r);
    }
    expect(f.perm.log).not.toContain("remove");
    flows.join = new Error("gone");
    await expect(join()).rejects.toThrow("gone");
    expect(f.perm.granted).toBe(false);
  });
  it("with sync on (a configuration written), a failed flow keeps the permission it needs", async () => {
    f.local.data.set("sk_sync_cfg", { v: 1 });
    flows.firstUpload = { kind: "keyring_changed" };
    await upload();
    expect(f.perm.log).not.toContain("remove");
  });
  it("turning sync off removes the permission, after the turn-off", async () => {
    await dev.turnSyncOff("p");
    expect(flows.calls.at(-1)).toBe("turnSyncOff");
    expect(f.perm.log.at(-1)).toBe("remove");
  });
  it("the grant button asks for the permission at once, before anything else", () => {
    f.handlers["grant:click"]!();
    expect(f.perm.log).toEqual(["request"]); // synchronously: Chrome refuses a request after the gesture's first await
  });
});
