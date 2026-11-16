// Enrolment v2 (SYNC-DESIGN revision 27, §0.0aa; §3.2 MUST 5, MUST 10; §7): the pairing code as a code (its reading,
// its check bits and their domain), the pairing secret's hygiene on the way between a settings page and the service
// worker (the bridge, §4.9, and the clipboard clean-up's message), and source rules: the confirmation code is gone from
// the code and the contract, no input that takes a recovery code or a pairing code is a text field (ENROLL-V2-NOTES.md),
// the scam warning is beside both codes, and the typed code does not outlive its step.
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toB64 } from "../../src/core/crypto/bytes";
import {
  PAIRING_CODE_TAG,
  formatPairingCode,
  generatePairingCode,
  parsePairingCode,
} from "../../src/core/crypto/pairing-code";
import { formatRecoveryCode, parseRecoveryCode } from "../../src/core/crypto/recovery-code";
import { ENROLL_TAG } from "../../src/core/sync/crypto/enroll-labels";
import { toB64u } from "../../src/core/sync/crypto/encoding";
import { Approver, ApprovalJoin, commitJoin, firstUpload } from "../../src/core/sync/engine/enroll";
import type { Transport } from "../../src/core/sync/engine/transport";
import { createMutex } from "../../src/core/storage/kv";
import { BridgeTransport } from "../../src/platform/bridge-page";
import { serveBridge } from "../../src/platform/bridge-worker";
import { codeGroups, codeSymbols } from "../../src/options/code-text";
import { contextOver, EMAIL, newDisk, tryMutex, World } from "../helpers/m3-world";
import { createProtected } from "../helpers/vaults";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const RUNS = { numRuns: 200 };
const bytes16 = fc.uint8Array({ minLength: 16, maxLength: 16 });
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const codeOf = async (input: string) =>
  parsePairingCode(input).then(
    (s) => hex(s),
    (e: { code: string }) => e.code,
  );

describe("the pairing code (§3.2 MUST 10)", () => {
  it("round trip: 28 symbols in 7 groups of 4; generatePairingCode draws 16 bytes and shows them", async () => {
    await fc.assert(
      fc.asyncProperty(bytes16, async (s) => {
        const text = await formatPairingCode(s);
        return /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/.test(text) && (await codeOf(text)) === hex(s);
      }),
      RUNS,
    );
    const g = await generatePairingCode();
    expect([g.secret.length, await codeOf(g.text)]).toEqual([16, hex(g.secret)]);
    await expect(formatPairingCode(new Uint8Array(15))).rejects.toThrow(RangeError);
  });
  it("read the way it is read: any case, spaces, '-', '_', O as 0, I and L as 1; pasted with surrounding whitespace", async () => {
    await fc.assert(
      fc.asyncProperty(
        bytes16,
        fc.array(fc.constantFrom(" ", "-", "\n", "\t", "_", ""), { minLength: 28, maxLength: 28 }),
        async (s, seps) => {
          const flat = (await formatPairingCode(s)).replace(/-/g, "");
          const mangled = [...flat]
            .map((c, i) => (i % 3 ? c.toLowerCase() : c).replace("0", "O").replace("1", i % 2 ? "I" : "l") + seps[i])
            .join("");
          return (await codeOf(`  ${mangled}  `)) === hex(s);
        },
      ),
      RUNS,
    );
  });
  it("wrong length and symbols outside the alphabet are pairing_length / pairing_char; typos almost always pairing_checksum", async () => {
    const s = crypto.getRandomValues(new Uint8Array(16));
    const flat = (await formatPairingCode(s)).replace(/-/g, "");
    expect(await codeOf(flat.slice(1))).toBe("pairing_length");
    expect(await codeOf(`${flat}A`)).toBe("pairing_length");
    expect(await codeOf("")).toBe("pairing_length");
    expect(await codeOf(`${flat.slice(1)}U`)).toBe("pairing_char");
    expect(await codeOf(`${flat.slice(1)}*`)).toBe("pairing_char");
    // every single-symbol substitution: the 12 check bits miss about 1 in 4096 of them, never more than a handful here
    const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let accepted = 0;
    let caught = 0;
    for (let i = 0; i < 28; i++)
      for (const c of A) {
        if (c === flat[i]) continue;
        const r = await codeOf(flat.slice(0, i) + c + flat.slice(i + 1));
        if (r === "pairing_checksum") caught++;
        else if (r !== "pairing_char") accepted++; // a different secret that happens to pass
      }
    expect(caught + accepted).toBe(28 * 31);
    expect(accepted).toBeLessThanOrEqual(3);
  });
  it("the check bits are domain-separated: a recovery code is not a pairing code, and the other way round (about 1 in 4096 slips)", async () => {
    expect(PAIRING_CODE_TAG).toBe("sixkey-pairing-code|1|");
    expect(ENROLL_TAG.pairingCode).toBe(PAIRING_CODE_TAG);
    let crossed = 0;
    const N = 4096;
    for (let i = 0; i < N; i++) {
      const s = crypto.getRandomValues(new Uint8Array(16));
      const rc = await formatRecoveryCode(s);
      const pc = await formatPairingCode(s);
      const asPairing = await codeOf(rc);
      const asRecovery = await parseRecoveryCode(pc).then(
        () => "accepted",
        (e: { code: string }) => e.code,
      );
      if (asPairing === hex(s)) crossed++;
      else expect(asPairing).toBe("pairing_checksum");
      if (asRecovery === "accepted") crossed++;
      else expect(asRecovery).toBe("recovery_checksum");
    }
    expect(crossed).toBeLessThanOrEqual(12); // expected ~2 of 8192
  }, 60_000);
  it("the page's reading of a code as typed is the same reading, grouped for showing", () => {
    expect(codeSymbols(" ab-cd o1il efgh")).toBe("ABCD0111EFGH");
    expect(codeGroups(codeSymbols("abcdefghjk"))).toBe("ABCD-EFGH-JK");
    // nothing is cut off: a 29th symbol stays, so the code's reading says "not a code" (MUST 10) and the field "too long"
    expect(codeSymbols("x".repeat(40)).length).toBe(40);
  });
  it("a 29th symbol is not cut off: what the field holds is what the codec reads (pairing_length, as the vectors say)", async () => {
    const s = new Uint8Array(16).fill(7);
    const text = await formatPairingCode(s);
    for (const typed of [text + "0", "0" + text]) {
      expect(codeSymbols(typed)).toHaveLength(29);
      await expect(parsePairingCode(codeSymbols(typed))).rejects.toMatchObject({ code: "pairing_length" });
    }
    expect(await parsePairingCode(codeSymbols(text))).toEqual(s);
  });
  it("the recovery code and the pairing code of the same 16 bytes differ only in their last symbols, and refuse each other", async () => {
    for (let i = 0; i < 256; i++) {
      const s = crypto.getRandomValues(new Uint8Array(16));
      const p = await formatPairingCode(s);
      const r = await formatRecoveryCode(s);
      expect(p.slice(0, 31)).toBe(r.slice(0, 31)); // 25 symbols and 6 hyphens: 125 of the 128 secret bits, unchanged
      if (p !== r) {
        await expect(parsePairingCode(r)).rejects.toMatchObject({ code: "pairing_checksum" });
        await expect(parseRecoveryCode(p)).rejects.toMatchObject({ code: "recovery_checksum" });
      }
    }
  });
});

/** A page context whose every request goes through the bridge to the worker (§4.9), which sends it to the server. */
function pageOverBridge(w: World, log: string[]) {
  const server = w.server.transport();
  const worker: Transport = { send: (r) => server.send(r) };
  const SELF = "abcdefghijklmnopabcdefghijklmnop";
  const sender = { id: SELF, url: `chrome-extension://${SELF}/options/index.html#sync` };
  const page = new BridgeTransport(async (m) => {
    log.push(JSON.stringify(m));
    const reply = await serveBridge(m, sender, { transport: worker, selfId: SELF });
    log.push(JSON.stringify(reply));
    return reply;
  });
  const disk = newDisk();
  return {
    disk,
    ctx: contextOver({
      ...disk,
      lock: createMutex(),
      identityLock: createMutex(),
      syncLock: tryMutex(),
      transport: page,
      clock: () => w.clock.now,
    }),
  };
}

describe("the pairing secret between the pages and the worker (MUST 5)", () => {
  it("an approval join with both pages on the bridge: S is in no message to the worker, no reply, and nothing either page stored", async () => {
    const w = new World();
    const log: string[] = [];
    const a = pageOverBridge(w, log);
    const r = await createProtected(a.ctx.svc, w.password);
    await a.ctx.svc.openView();
    w.advance(1000);
    const up = await firstUpload(a.ctx.engine, {
      session: await w.server.session(EMAIL),
      password: w.password,
      recoveryCode: r.recoveryCode,
      deviceName: "A",
      email: EMAIL,
    });
    expect(up.kind).toBe("done");
    const n = pageOverBridge(w, log);
    const join = await ApprovalJoin.start(n.ctx.engine, {
      session: await w.server.session(EMAIL),
      deviceName: "N",
      email: EMAIL,
    });
    const approver = await Approver.start(a.ctx.engine, join.requestId, w.password);
    const code = approver.pairingCode;
    const s = await parsePairingCode(code);
    const forms = [code, code.replace(/-/g, ""), hex(s), toB64(s), toB64u(s)];
    expect(await join.poll()).toEqual({ kind: "enter_code" });
    const sas = await join.submitPairingCode(code);
    if (sas.kind !== "show_sas") throw new Error(sas.kind);
    expect((await approver.poll(w.password)).kind).toBe("enter_sas");
    expect((await approver.submitSas(sas.sas, w.password)).kind).toBe("approved");
    expect(await join.poll()).toEqual({ kind: "approved" });
    expect(await commitJoin(await join.prepare())).toBe("enrolled");
    const traffic = log.join("\n");
    expect(traffic).toContain("/reveal");
    expect(traffic).toContain("/approve");
    for (const f of forms) expect(traffic.includes(f), `S on the bridge: ${f.length} chars`).toBe(false);
    const stored = JSON.stringify(
      [a.disk, n.disk].map((d) => [[...d.kv.data.entries()], [...d.mirror.data.entries()], [...d.idb.data.entries()]]),
    );
    for (const f of forms) expect(stored.includes(f), "S in storage").toBe(false);
    expect(w.server.violations).toEqual([]);
  });
  it("Copy's clean-up (§7): the message to the worker carries a hash of the copied text, never the text", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("chrome", {
      permissions: { contains: async () => true },
      runtime: { sendMessage: async (m: unknown) => (sent.push(m), { ok: true }) }, // the worker takes it (sw.ts)
    });
    try {
      const { armClipboardClear, sha256Hex, CLEAR_AFTER_MS } = await import("../../src/platform/clipboard");
      const code = (await generatePairingCode()).text;
      expect(await armClipboardClear(code)).toBe(true);
      expect(sent).toEqual([{ type: "sk-clip-arm", hash: await sha256Hex(code), delayMs: CLEAR_AFTER_MS }]);
      expect(CLEAR_AFTER_MS).toBe(30_000);
      expect(JSON.stringify(sent).includes(code.replace(/-/g, "").slice(0, 8))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const rel = (p: string) => p.slice(SRC.length);

describe("source rules (revision 27)", () => {
  it("no confirmation code anywhere: no CC identifier, label, state, string key or element id in src/ or the text", () => {
    const CC =
      /\bccOf\b|\bconfirmationCode\b|\bsubmitConfirmationCode\b|\bsubmitCc\b|\benter_cc\b|\bcc_mismatch\b|\bCcResult\b|enroll-confirm|\bsyncCc[A-Z]|\bsyncApproveCc|\bsyncFailCc|sync-cc\b|sync-cc-|approve-cc|\bat: "cc"|\bcase "cc"|\.cc\b|\bcc:\s/;
    const hits: string[] = [];
    for (const f of files(SRC))
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (CC.test(line) || /\bCC_ATTEMPTS\b/.test(line)) hits.push(`${rel(f)}:${i + 1}`);
        });
    expect(hits).toEqual([]);
    // nor in the contract: no CC constant, and no word of it in the operations' descriptions
    const openapi = readFileSync(join(SRC, "../../api/openapi.yaml"), "utf8");
    expect(openapi).not.toMatch(/\bCC(_ATTEMPTS)?\b/);
    expect(JSON.parse(openapi)["x-sixkey-constants"]).not.toHaveProperty("CC_ATTEMPTS");
    for (const f of ["../scripts/i18n/m6.py", "../scripts/i18n/m6b.py", "../scripts/i18n/enroll2.py"]) {
      const t = readFileSync(join(SRC, f), "utf8");
      expect(t, f).not.toMatch(/"sync(Cc|ApproveCc|FailCc|ApproveFinished)[A-Za-z]*":/);
      expect(t, f).not.toMatch(/confirmation code"|确认码"/);
    }
  });
  it('every input that takes a recovery or pairing code is a password field (shown only by its own toggle), never type="text"', () => {
    const inputs: { f: string; tag: string }[] = [];
    for (const f of files(SRC).filter((x) => x.endsWith(".tsx"))) {
      const t = readFileSync(f, "utf8");
      for (let at = t.indexOf("<input"); at >= 0; at = t.indexOf("<input", at + 1))
        inputs.push({ f: rel(f), tag: t.slice(at, t.indexOf("/>", at) + 2) });
    }
    expect(inputs.length).toBeGreaterThan(20);
    // the text fields that may exist, by file and id: none of them takes a code
    const TEXT_OK = new Set([
      "options/AddAccounts.tsx#m-issuer",
      "options/AddAccounts.tsx#m-label",
      "options/AddAccounts.tsx#m-secret",
      "options/Misc.tsx#so-confirm",
      "options/sync/EnableView.tsx#{id}", // NameField: the device name
      "options/sync/widgets.tsx#{p.id}", // Digits: the email code and the SAS (neither a recovery nor a pairing code)
      "popup/main/Main.tsx#q",
    ]);
    const idOf = (tag: string) => tag.match(/\bid=("[^"]*"|\{[^}]*\})/)?.[1]?.replace(/^"|"$/g, "") ?? "(none)";
    const problems: string[] = [];
    for (const { f, tag } of inputs) {
      const where = `${f}#${idOf(tag)}`;
      const type = tag.match(/\btype=("[^"]*"|\{[^}]*\})/)?.[1] ?? "(none)";
      if (type === '"text"' && !TEXT_OK.has(where)) problems.push(`${where}: type="text"`);
      if (type.startsWith("{") && type !== '{shown ? "text" : "password"}') problems.push(`${where}: type=${type}`);
    }
    expect(problems).toEqual([]);
    // the code inputs themselves: the shared one, the typed-back groups, the popup's recovery field
    const shared = readFileSync(join(SRC, "options/shared.tsx"), "utf8");
    const field = shared.slice(
      shared.indexOf("export function CodeField("),
      shared.indexOf("export function RecoveryCodeBox("),
    );
    expect(field).toMatch(/type=\{shown \? "text" : "password"\}/);
    expect(field).toMatch(/useState\(false\)/); // hidden until the user ticks Show
    expect(field).toMatch(/autoComplete="off"/);
    expect(field).toMatch(/autoCapitalize="off"/);
    expect(field).toMatch(/spellcheck=\{false\}/);
    expect(field.replace(/<Icon name="[a-zA-Z]+"/g, "")).not.toMatch(/\bname=/); // the field has no name
    expect(field).not.toMatch(/onPaste/); // paste is allowed
    expect(field).toMatch(/addEventListener\("pagehide", wipe\)/);
    expect(field).toMatch(/if \(LOCK_EPOCH_KEY in changes\) wipe\(\)/); // a lock from any page empties it too
    expect(field).toMatch(/aria-describedby=\{described\}/);
    expect(field).toMatch(/aria-controls=\{p\.id\}/);
    const widgets = readFileSync(join(SRC, "options/sync/widgets.tsx"), "utf8");
    // the recovery code's fields have "I have shares instead" (RecoveryCodeInput: the same CodeField, or the shares' entry,
    // whose field is held to the same rules below; docs/design/notes/SHAMIR-NOTES.md §5)
    expect(widgets).toMatch(/export function RecoveryField\(p: CodeFieldProps\) \{\s+return \(\s+<RecoveryCodeInput/);
    expect(widgets).toMatch(/export function PairingField\(p: CodeFieldProps\) \{\s+return <CodeField/);
    expect(readFileSync(join(SRC, "options/Reset.tsx"), "utf8")).toMatch(/<RecoveryCodeInput\s+id="reset-code-in"/);
    const input = readFileSync(join(SRC, "options/RecoveryCodeInput.tsx"), "utf8");
    expect(input).toMatch(/<CodeField \{\.\.\.field\} \/>/);
    const entry = readFileSync(join(SRC, "ui/ShareEntry.tsx"), "utf8");
    expect(entry).toMatch(/type=\{shown \? "text" : "password"\}/);
    expect(entry).toMatch(/const \[shown, setShown\] = useState\(false\);/);
    expect(entry).toMatch(/autoComplete="off"/);
    expect(entry).toMatch(/autoCapitalize="off"/);
    expect(entry).toMatch(/spellcheck=\{false\}/);
    expect(entry).not.toMatch(/\bname=/);
    expect(entry).toMatch(/addEventListener\("pagehide", gone\)/);
    expect(entry).toMatch(/if \(latest\.current\.lockKey in changes\) wipeRef\.current\(\)/);
    // too long is said at once, not cut off (MUST 10's reading), and marks the field invalid
    expect(field).toMatch(/const over = symbols\.length > CODE_SYMBOLS;/);
    expect(field).toMatch(/aria-invalid=\{p\.invalid \|\| over \? "true" : undefined\}/);
    expect(field).toMatch(/\{over && p\.tooLong && \(\s*<span class="err" role="alert" id=\{`\$\{p\.id\}-long`\}>/);
    expect(widgets.match(/tooLong=\{st\("syncCodeTooLong"\)\}/g)).toHaveLength(2); // the recovery and the pairing field
    // the popup's recovery field: masked, with its own Show (never for the password or the PIN)
    const locked = readFileSync(join(SRC, "popup/screens/Locked.tsx"), "utf8");
    expect(locked).toMatch(/const \[show, setShow\] = useState\(false\);/);
    expect(locked).toMatch(/const shown = mode === "recovery" && show;/);
    expect(locked).toMatch(/type=\{shown \? "text" : "password"\}/);
    expect(locked).toMatch(/id="secret-show"\s+checked=\{show\}\s+aria-controls="secret"/);
    expect(locked).toMatch(/setError\(null\);\s+setShow\(false\);/); // hidden again whenever the mode changes
    // nor in the grouped boxes the input hint can bring (PASSWORD-SETUP-NOTES §8.3): the popup's one use of them has no
    // Show, and the component draws its Show only where the page allows it
    expect(locked.match(/<PasswordGroups\b[^>]*>/g)).toEqual([expect.stringMatching(/\sshowable=\{false\}\s/)]);
    const groups = readFileSync(join(SRC, "ui/PasswordGroups.tsx"), "utf8");
    expect(groups).toMatch(/\{p\.showable !== false && \(\s*<button/);
    expect(groups).toMatch(/const \[shown, setShown\] = useState\(false\);/);
    expect(groups.match(/setShown\(/g)).toHaveLength(2); // its button, and off again whenever emptied
  });
  it("the developer page's one approval ends (its machine and S) at a new pick and when the page goes", () => {
    const dev = readFileSync(join(SRC, "devsync/main.ts"), "utf8");
    expect(dev).toMatch(/const dropApprover = \(\): void => \{\s*approver\?\.discard\(\);\s*approver = null;\s*\};/);
    expect(dev).toMatch(/globalThis\.addEventListener\?\.\("pagehide", dropApprover\);/);
    expect(dev).toMatch(/dropApprover\(\);\s*approver = await Approver\.start\(/);
  });
  it("the typed pairing code does not outlive its step: the join view drops it, and the code field tells its owner when it goes", () => {
    expect(readFileSync(join(SRC, "options/sync/JoinView.tsx"), "utf8")).toMatch(
      /useEffect\(\(\) => \{\s*if \(s\.at !== "code"\) setPairing\(""\);\s*\}, \[s\.at\]\);/,
    );
    const t = readFileSync(join(SRC, "options/shared.tsx"), "utf8");
    const body = t.slice(t.indexOf("export function CodeField("), t.indexOf("export function RecoveryCodeBox("));
    const cleanup = body.slice(body.indexOf("return () => {"), body.indexOf("}, []);", body.indexOf("return () => {")));
    expect(cleanup).toMatch(/onValue\.current\(""\)/);
  });
  it("the scam warning is on both code screens and on both six-digit screens (§3.2, §6 O9, §7)", () => {
    const part = (file: string, from: string, to: string) => {
      const t = readFileSync(join(SRC, file), "utf8");
      const at = t.indexOf(from);
      const end = t.indexOf(to, at + from.length);
      expect(
        [at, end].every((x) => x > 0),
        `${file}: ${from} … ${to}`,
      ).toBe(true);
      return t.slice(at, end);
    };
    const WARNING = /<span>\{st\("syncScamWarning"\)\}<\/span>/;
    // the approving device: the pairing code it shows, then the six digits typed
    const approve = part("options/sync/ManageViews.tsx", "export function ApproveView(", "export function KeyOpView(");
    expect(approve.slice(approve.indexOf('case "code":'), approve.indexOf('case "sas":'))).toMatch(WARNING);
    expect(approve.slice(approve.indexOf('case "sas":'), approve.indexOf('case "mismatch":'))).toMatch(WARNING);
    // the new device: the pairing code typed, then the six digits shown
    expect(part("options/sync/JoinView.tsx", 'case "code":', "</form>")).toMatch(WARNING);
    expect(part("options/sync/JoinView.tsx", "function SasStep(", "function Summary(")).toMatch(WARNING);
  });
});
