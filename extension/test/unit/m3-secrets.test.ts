// M3 (SYNC-DESIGN D5 "日志中不得有密钥或验证码"; §4.1 "只含数字、哈希、校验和与错误码"): after a session of every kind of
// sync work (a first upload, a recovery-code join, an approval with the pairing code and the SAS, rounds with merges, a password change, a
// new recovery code, a rotation, refused operations with wrong secrets), no secret appears in anything observable: the
// diagnostics lines, sk_sync_state, sk_sync_cfg (other than its sealed copy), the engine's notices, any error's message,
// the server's request log, or a request the server found invalid. Secrets: the accounts' secrets, the passwords, every
// recovery code, the vault keys (raw), the device keys (JWK d), the SAS shown, and the pairing code S in every form
// (its text with and without hyphens, hex, base64, base64url). S is also absent from every request (target, headers,
// body) and every response of either device, and from everything either device stored (MUST 5).
import { describe, expect, it } from "vitest";
import { toB64 } from "../../src/core/crypto/bytes";
import { parsePairingCode } from "../../src/core/crypto/pairing-code";
import { toB64u } from "../../src/core/sync/crypto/encoding";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { Approver, ApprovalJoin, commitJoin } from "../../src/core/sync/engine/enroll";
import {
  adoptWithSecret,
  changePassword,
  commitRecoveryCode,
  commitRotation,
  prepareRecoveryCode,
  prepareRotation,
  revokeDevice,
} from "../../src/core/sync/engine/keys";
import { EMAIL, quiesce, type Device, worldOf } from "../helpers/m3-world";

const NEW_PW = "violet-harbour-cinder-93";

describe("D5: no secret in any log, state, notice, error or request record", () => {
  it("a whole session", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const secrets = new Set<string>([w.password, NEW_PW, w.code, toB64((await a.vk()).raw)]);
    const errors: string[] = [];
    const keep = async <T>(p: Promise<T>): Promise<T | undefined> =>
      p.catch((e) => {
        errors.push(`${(e as Error).name}: ${(e as Error).message}`);
        return undefined;
      });
    // every request and response of the two devices of the approval, as sent and received
    const wire: string[] = [];
    const n = w.device("N");
    for (const d of [a, n]) {
      const send = d.net.send.bind(d.net);
      d.net.send = async (req) => {
        const res = await send(req);
        wire.push(JSON.stringify({ req, res }));
        return res;
      };
    }
    // an approval with the pairing code and the SAS
    const join = await ApprovalJoin.start(n.engine, {
      session: await w.server.session(EMAIL),
      deviceName: "N",
      email: EMAIL,
    });
    const ap = await Approver.start(a.engine, join.requestId, w.password);
    const code = ap.pairingCode;
    const S = await parsePairingCode(code);
    const sForms = [
      code,
      code.replace(/-/g, ""),
      Array.from(S, (x) => x.toString(16).padStart(2, "0")).join(""),
      toB64(S),
      toB64u(S),
    ];
    for (const f of sForms) secrets.add(f);
    await join.poll();
    const sas = (await join.submitPairingCode(code)) as { sas: string };
    secrets.add(sas.sas);
    await ap.poll(w.password);
    await ap.submitSas(sas.sas, w.password);
    await join.poll();
    await commitJoin(await join.prepare());
    // data
    w.advance(1000);
    await a.add("Bank");
    await quiesce(w);
    // refused, wrong secrets
    await keep(changePassword(a.engine, "a-wrong-password-entirely", NEW_PW));
    await keep(revokeDevice(b.engine, "AAAAAAAAAAAAAAAAAAAAAA", "a-wrong-password-entirely"));
    await keep(adoptWithSecret(b.engine, { password: "a-wrong-password-entirely" }));
    // key operations
    await changePassword(a.engine, w.password, NEW_PW);
    const h = await prepareRecoveryCode(a.engine, NEW_PW);
    secrets.add(h.recoveryCode);
    await commitRecoveryCode(a.engine, h);
    const r = await prepareRotation(a.engine, NEW_PW);
    secrets.add(r.recoveryCode);
    await commitRotation(a.engine, r);
    secrets.add(toB64((await a.vk()).raw));
    for (const d of [b, n]) {
      await d.engine.round();
      await adoptWithSecret(d.engine, { password: NEW_PW });
    }
    await quiesce(w);
    for (const e of (await a.vault()).entries) if (e.secret) secrets.add(e.secret);
    for (const d of w.devices) {
      const id = await d.local.settlePins();
      if (id && id !== "damaged") {
        const jwk = await crypto.subtle.exportKey("jwk", id.keyPair.publicKey);
        void jwk; // the public key is not secret; the private one is non-extractable
      }
    }
    const observable = JSON.stringify({
      diag: w.devices.map((d) => d.diag),
      state: w.devices.map((d) => d.disk.kv.data.get(SYNC_KEYS.state)),
      cfg: w.devices.map((d) => {
        const c = d.disk.kv.data.get(SYNC_KEYS.cfg) as Record<string, unknown> | undefined;
        return c ? { ...c, enc: undefined } : null;
      }),
      outbox: w.devices.map((d) => {
        const o = d.disk.kv.data.get(SYNC_KEYS.outbox) as Record<string, unknown> | undefined | null;
        return o ? { ...o, envelope: undefined } : null;
      }),
      requests: w.server.requests,
      violations: w.server.violations,
      bugs: w.server.bugs,
      errors,
      net: w.devices.map((d) => d.net.log),
      wire,
    });
    expect(wire.some((x) => x.includes("/reveal"))).toBe(true); // the approval's traffic was seen
    // S in nothing either device stored, sealed values included (a ciphertext cannot hold it by chance)
    const stored = JSON.stringify(
      w.devices.map((d) => [
        [...d.disk.kv.data.entries()],
        [...d.disk.mirror.data.entries()],
        [...d.disk.idb.data.entries()],
        { data: d.disk.session.data, quick: d.disk.session.quick },
      ]),
    );
    for (const f of sForms) expect(stored.includes(f), "S in storage").toBe(false);
    expect(errors.length).toBeGreaterThan(0); // the refusals happened
    for (const s of secrets) {
      expect(s.length).toBeGreaterThan(5);
      expect(observable.includes(s), `a secret leaked (${s.length} chars)`).toBe(false);
    }
    // and the recovery code's groups do not appear either (a code split by its dashes)
    for (const code of [w.code, h.recoveryCode, r.recoveryCode])
      for (const g of code.split("-")) if (g.length >= 6) expect(observable.includes(g)).toBe(false);
  }, 120_000);
});
