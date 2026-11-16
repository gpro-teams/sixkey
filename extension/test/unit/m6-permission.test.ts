// The API permission against every outcome of a first upload and a join (SYNC-DESIGN §7, revision 23; permission.ts):
// kept for "done" and "unconfirmed" (a join's "enrolled" and "unconfirmed"), given back for every other outcome, results
// that are not exceptions included, while sync is not on; with sync on (a configuration written) it stays. The enrolment
// calls are stubbed here so that every outcome can be produced; m6-flows.test.ts reaches the reachable ones for real.
import { beforeEach, describe, expect, it, vi } from "vitest";

const stub = vi.hoisted(() => ({
  upload: { kind: "done" } as { kind: string } | Error,
  join: "enrolled" as string | Error,
  syncOn: false,
  hasVault: false,
}));
vi.mock("../../src/options/sync/gateway", async (orig) => {
  const real = await orig<typeof import("../../src/options/sync/gateway")>();
  return {
    ...real,
    firstUpload: async () => {
      if (stub.upload instanceof Error) throw stub.upload;
      return stub.upload;
    },
    recoveryOpensLocal: async () => true,
    joinWithRecoveryCode: async () => ({ prepared: { mode: "empty", added: 0, skipped: 0 } }),
    joinSummary: (p: { prepared: unknown }) => p.prepared,
    vaultStatus: async () => "empty",
    commitJoin: async () => {
      if (stub.join instanceof Error) throw stub.join;
      return stub.join;
    },
  };
});

import { EnableFlow } from "../../src/options/sync/enable";
import type { SyncKit } from "../../src/options/sync/gateway";
import { JoinFlow } from "../../src/options/sync/join";
import { asking, giveBack, KEPT_OUTCOMES, settlePermission } from "../../src/options/sync/permission";
import { click, permissions, until, type PermFake } from "../helpers/m6-kit";

const TOKEN = `h.${Buffer.from(JSON.stringify({ sub: "8f14e45f-ceea-467a-9575-6e2c1d1b9c11" })).toString("base64url")}.s`;
function kit(perm: PermFake): SyncKit {
  return {
    perm,
    changed: () => undefined,
    copy: async () => true,
    uncopy: () => undefined,
    service: { verifyPassword: async () => undefined, status: async () => ({ state: "unlocked" }) },
    engine: {
      view: async () => ({ syncOn: stub.syncOn }),
      deps: { now: () => 0 },
      api: {
        otp: async () => undefined,
        signIn: async () => ({ token: TOKEN, sub: "8f14e45f-ceea-467a-9575-6e2c1d1b9c11", expiresAt: 1 }),
        account: async () => ({ has_vault: stub.hasVault }),
      },
    },
  } as unknown as SyncKit;
}

async function upload(perm: PermFake): Promise<EnableFlow> {
  const k = kit(perm);
  const f = new EnableFlow(k);
  click(
    perm,
    asking(k, (g) => void f.start(g)),
  );
  await until(() => f.state.at === "password");
  await f.submitPassword("pw");
  await until(() => f.state.at === "signin");
  await f.signin.send("e@example.com");
  await f.signin.verify("123456");
  await until(() => f.state.at === "name");
  f.submitName("Device");
  f.enterCode();
  await f.submitCode("CODE");
  return f;
}
async function join(perm: PermFake): Promise<JoinFlow> {
  const k = kit(perm);
  stub.hasVault = true;
  const j = new JoinFlow(k);
  click(
    perm,
    asking(k, (g) => void j.start(g)),
  );
  await until(() => j.state.at === "signin");
  await j.signin.send("e@example.com");
  await j.signin.verify("123456");
  await until(() => j.state.at === "choose");
  j.setName("Device");
  await j.chooseRecovery();
  await j.submitRecovery("CODE");
  await j.commit();
  return j;
}

beforeEach(() => {
  stub.upload = { kind: "done" };
  stub.join = "enrolled";
  stub.syncOn = false;
  stub.hasVault = false;
});

describe("the first upload's outcomes", () => {
  for (const kind of ["done", "unconfirmed"]) {
    it(`"${kind}": the permission is kept`, async () => {
      stub.upload = { kind };
      const p = permissions(false);
      const f = await upload(p);
      expect(f.state.at).toBe(kind);
      expect(p.log).toEqual(["request"]);
      expect(p.granted).toBe(true);
    });
  }
  for (const kind of ["vault_exists", "keyring_changed"]) {
    it(`"${kind}" (a result, not an exception): given back at once`, async () => {
      stub.upload = { kind };
      const p = permissions(false);
      const f = await upload(p);
      expect(f.state.at).toBe(kind === "vault_exists" ? "vault_exists" : "failed");
      expect(p.log).toEqual(["request", "remove"]);
      expect(p.granted).toBe(false);
    });
  }
  it("an exception: given back", async () => {
    stub.upload = Object.assign(new Error("x"), { code: "internal_error" });
    const p = permissions(false);
    const f = await upload(p);
    expect(f.state).toMatchObject({ at: "failed", failure: { code: "internal_error" } });
    expect(p.granted).toBe(false);
  });
  it("with sync on (a configuration written meanwhile), a failed one keeps the permission the next round needs", async () => {
    stub.upload = { kind: "keyring_changed" };
    stub.syncOn = true;
    const p = permissions(false);
    await upload(p);
    expect(p.log).toEqual(["request"]);
  });
});

describe("the join's outcomes", () => {
  for (const r of ["enrolled", "unconfirmed"]) {
    it(`"${r}": the permission is kept`, async () => {
      stub.join = r;
      const p = permissions(false);
      const j = await join(p);
      expect(j.state.at).toBe(r === "enrolled" ? "done" : "unconfirmed");
      expect(p.granted).toBe(true);
    });
  }
  it("an exception at the commit: given back", async () => {
    stub.join = Object.assign(new Error("x"), { code: "bad_state" });
    const p = permissions(false);
    const j = await join(p);
    expect(j.state.at).toBe("failed");
    expect(p.granted).toBe(false);
  });
});

describe("the rules themselves", () => {
  it("the kept outcomes are exactly done, unconfirmed and enrolled", () => {
    expect([...KEPT_OUTCOMES].sort()).toEqual(["done", "enrolled", "unconfirmed"]);
  });
  it("settlePermission gives back every other outcome, giveBack nothing while sync is on", async () => {
    const p = permissions(true);
    const k = kit(p);
    for (const o of ["done", "unconfirmed", "enrolled"]) expect(await settlePermission(k, o)).toBe(false);
    expect(p.granted).toBe(true);
    stub.syncOn = true;
    expect(await giveBack(k)).toBe(false);
    expect(p.granted).toBe(true);
    stub.syncOn = false;
    expect(await settlePermission(k, "cancelled")).toBe(true);
    expect(p.granted).toBe(false);
  });
  it("asking() asks before anything else the handler does (Chrome's gesture), and passes the answer on", async () => {
    const p = permissions(false);
    const k = kit(p);
    const order: string[] = [];
    const h = asking(k, (g) => {
      order.push(p.log.length ? "after the request" : "before the request");
      void g.then((x) => order.push(`answer ${x}`));
    });
    click(p, h);
    await until(() => order.length === 2);
    expect(order).toEqual(["after the request", "answer true"]);
  });
});
