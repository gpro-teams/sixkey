// PHASE0X-PLAN C7 (SYNC-DESIGN H6, Z4): the popup's "N wrong passwords" notice (src/popup/notice.ts) and the rules for
// who may read, ack and clear the security record. The reads it costs are in read-budget.test.ts; the screens in
// test/e2e/security-log.spec.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SECURITY_LOG_KEY, SecurityLog, securityReader } from "../../src/core/service/security-log";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import { ackNotice, readNotice } from "../../src/popup/notice";

/** Counts reads and writes, and can fail them. */
class SpyKV implements KV {
  gets: string[][] = [];
  sets = 0;
  failGet = false;
  constructor(readonly inner = new MemoryKV()) {}
  async get(keys: string[]) {
    this.gets.push(keys);
    if (this.failGet) throw new Error("IO error");
    return this.inner.get(keys);
  }
  async set(items: Record<string, unknown>) {
    this.sets++;
    return this.inner.set(items);
  }
  async remove(keys: string[]) {
    return this.inner.remove(keys);
  }
  async keys() {
    return this.inner.keys();
  }
}

function world() {
  const kv = new SpyKV();
  let now = 1_700_000_000_000;
  const log = new SecurityLog({ kv, now: () => (now += 1000) });
  const rt = { security: securityReader(log) };
  const failed = () => (kv.inner.data.get(SECURITY_LOG_KEY) as { failed?: number } | undefined)?.failed;
  return { kv, log, rt, failed };
}

describe("the popup's notice after an unlock", () => {
  it("no record yet, or no wrong attempt since the last ack: no notice (an ok record of 0 is the only clean zero)", async () => {
    const w = world();
    expect(await readNotice(w.rt)).toBeNull();
    await w.log.append("export_plain");
    await w.log.append("password_changed");
    expect(await readNotice(w.rt)).toBeNull();
  });

  it("wrong attempts: the count, passwords and recovery codes together; reading it is one get of the record and writes nothing", async () => {
    const w = world();
    for (let i = 0; i < 2; i++) await w.log.append("unlock_failed");
    await w.log.append("recovery_failed");
    await w.log.append("export_encrypted");
    w.kv.gets = [];
    w.kv.sets = 0;
    expect(await readNotice(w.rt)).toEqual({ failed: 3 });
    expect(w.kv.gets).toEqual([[SECURITY_LOG_KEY]]);
    expect(w.kv.sets).toBe(0); // not acked by being read: a popup closed now acks nothing
    expect(w.failed()).toBe(3);
    expect(await readNotice(w.rt)).toEqual({ failed: 3 }); // and the next unlock says it again
  });

  it("a damaged record, one from a newer version, or a read that fails: 'can't be read', never shown as 0", async () => {
    for (const bad of ["garbage", { v: 1, entries: "nope" }, [1, 2], { v: 3, entries: [] }, { v: 7 }]) {
      // R8: version 2 is this one; newer is 3
      const w = world();
      w.kv.inner.data.set(SECURITY_LOG_KEY, bad);
      expect(await readNotice(w.rt), JSON.stringify(bad)).toEqual({ unreadable: true });
      expect(w.kv.sets).toBe(0);
    }
    const w = world();
    await w.log.append("unlock_failed");
    w.kv.failGet = true;
    expect(await readNotice(w.rt)).toEqual({ unreadable: true });
  });

  it("the ack takes off exactly the number shown: a wrong attempt made after the read is still counted next time", async () => {
    const w = world();
    for (let i = 0; i < 3; i++) await w.log.append("unlock_failed");
    const shown = await readNotice(w.rt);
    expect(shown).toEqual({ failed: 3 });
    await w.log.append("unlock_failed"); // another page, between the read and the ack
    await ackNotice(w.rt, shown!);
    expect(w.failed()).toBe(1);
    expect(await readNotice(w.rt)).toEqual({ failed: 1 });
    await ackNotice(w.rt, { failed: 1 });
    expect(await readNotice(w.rt)).toBeNull();
    expect((await w.log.read()).entries.filter((e) => e.kind === "unlock_failed")).toHaveLength(4); // the entries stay
  });

  it("'can't be read' acks nothing, and an ack that fails does not throw", async () => {
    const w = world();
    w.kv.inner.data.set(SECURITY_LOG_KEY, { v: 3, entries: [], failed: 9 });
    await ackNotice(w.rt, { unreadable: true });
    expect(w.kv.sets).toBe(0);
    expect(w.kv.inner.data.get(SECURITY_LOG_KEY)).toEqual({ v: 3, entries: [], failed: 9 });
    const v = world();
    await v.log.append("unlock_failed");
    v.kv.failGet = true;
    await expect(ackNotice(v.rt, { failed: 1 })).resolves.toBeUndefined();
  });
});

describe("who reads, acks and clears the record (source rules)", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? files(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : [],
    );
  const src = resolve(import.meta.dirname, "../../src");
  const read = (f: string) => readFileSync(f, "utf8");
  const users = (dir: string, re: RegExp) =>
    files(join(src, dir))
      .filter((f) => re.test(read(f)))
      .map((f) => f.slice(src.length + 1));

  it("in the popup, only notice.ts touches the record, and only App calls it: readNotice in the unlock handler, ackNotice once shown", () => {
    expect(users("popup", /\.security\.(read|ack|failuresSinceAck|recent)\(/)).toEqual(["popup/notice.ts"]);
    expect(users("popup", /\breadNotice\(/)).toEqual(["popup/App.tsx", "popup/notice.ts"]);
    expect(users("popup", /\backNotice\(/)).toEqual(["popup/App.tsx", "popup/notice.ts"]);
    const app = read(join(src, "popup/App.tsx"));
    const handler = app.slice(app.indexOf("const unlocked = useCallback("), app.indexOf("const shown = useCallback("));
    expect(handler).toMatch(
      /setScreen\(screenOf\(info\.view, mark\.current\)\);\s*void afterFirstCode\(\)\s*\.then\(\(\) => readNotice\(rt\)\)/,
    ); // after the view (with the count of the backup's record changes), after its first code
    expect(app.match(/readNotice\(/g)).toHaveLength(1);
    expect(handler.match(/readNotice\(/g)).toHaveLength(1);
    // an unlock by any other way than the master password (the PIN, Touch ID / Windows Hello) shows it and never acks it:
    // its count comes off only for someone who typed the master password (REVIEW S5; prf.spec.ts holds it on screen)
    expect(handler).toMatch(/viaPin\.current = info\?\.via !== undefined;/);
    const locked = read(join(src, "popup/screens/Locked.tsx"));
    expect(locked).toMatch(/onUnlocked\(own\(r\.view, deviceReq\.current, "device"\)\)/);
    expect(locked).toMatch(/own\([^)]*"pin"\)/);
    // never on the way to opening
    for (const f of ["popup/load.ts", "popup/main/Main.tsx", "popup/main/List.tsx", "popup/screens/Locked.tsx"])
      expect(read(join(src, f)), f).not.toMatch(/\.security\.|readNotice|afterFirstCode/);
  });

  it("no page clears the record but through the service's password check, and the settings page never acks it", () => {
    expect(users("popup", /clearSecurityLog|\.clear\(\)/)).toEqual([]);
    expect(users("options", /\.ack\(|ackNotice/)).toEqual([]);
    expect(users("options", /clearSecurityLog\(/)).toEqual(["options/SecurityCard.tsx"]);
  });
});
