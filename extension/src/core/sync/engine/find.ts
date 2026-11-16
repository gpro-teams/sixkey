// "Find accounts" (SYNC-DESIGN §6 O13; §4.4 D6, §4.6, §5.8): accounts that were in an earlier version of the vault and
// are not in it now, brought back by the user's choice. D6 says plainly that the guard stops only a one-step erase: a
// holder of the vault key can delete accounts (into every device's trash) and erase them a few minutes later, and what
// really stands behind them is this device's snapshots and the server's history, reached only through here. §5.8 keeps
// that history as the newest 30 versions plus each UTC day's last version for 30 days, within 64 MiB: on a busy account
// a version that is not its day's last goes after 30 more uploads.
//
// The sources: the server's history (GET /v1/vault/versions, hour precision; only versions under a key this device
// holds: the current one or one its keyring's previous list really unwraps) and this device's snapshots (the store's
// rolling and daily ones, read from the same storage the store writes, never written here; among them the old vault's
// snapshots a join re-encrypted under the cloud key, which keep that vault's id, §3.5 ⑥). Not sk_prejoin's kept vaults:
// re-importing those is a separate design (§3.5 ④, §9 M8 item 17).
//
// What is listed of a source: its live accounts that no live account here is now, by id (the same vault) or by the
// account's identity, issuer and label (addedModeKey, the added mode's rule), each once. Only issuer and label leave this
// module; the source's entries (their secrets) stay in a plan held for the handle until the flow drops it (dropFound).
// Bringing them back is one local edit (SyncFlows.recoverAccounts: the service's own mutate), synced as any edit is:
// nothing of a source is ever sent as it is, and nothing is merged automatically (§4.3 R5: a version under a previous key
// is used only here, by the user's choice).
//
// Errors are KeyOpError with a fixed code (locked, not_enrolled, offline, the contract's codes): never data.
import { decryptVault, isEnvelopeIntact, validateEnvelope, type EncryptedVault } from "../../crypto/envelope";
import { unwrapPreviousVks } from "../../crypto/keyring";
import type { Vk } from "../../crypto/vk";
import { ServiceError } from "../../service/service-error";
import { KEYS } from "../../storage/format";
import { entryIdentity, isAlive, type Entry, type Vault } from "../../vault/model";
import { addedModeKey } from "../../vault/ops";
import { deserializeVault, VaultError } from "../../vault/validate";
import { ApiError, type DeviceSigner } from "./api";
import type { SyncEngine } from "./engine";
import { KeyOpError } from "./keys";
import { NetworkError } from "./transport";

/** A version to look into: one of the server's history (by its version number) or one of this device's snapshots. */
/**
 * `older`: a server version under a previous key of the keyring, not the current one (from before a key change; anyone
 * who held that key then could have written it, a device revoked since among them, with the server's help).
 */
export type FindSource =
  | Readonly<{ kind: "server"; version: number; at: number | null; older: boolean }>
  | Readonly<{ kind: "local"; id: string; at: number }>;

export type FindSources = Readonly<{
  /** The server's history, newest first, under keys this device holds; null when it could not be read (`error`). */
  server: readonly FindSource[] | null;
  /** Why the server's history could not be read: a short code (offline, the contract's), or null. */
  error: string | null;
  /** This device's snapshots, newest first. */
  local: readonly FindSource[];
}>;

/**
 * An account a source holds and the vault does not now: what the page shows of it (never its secret). `note` tells it
 * apart from a live account it resembles: "same_key", a live account has its secret under another name (renamed since:
 * bringing it back makes a second one); "same_name", a live account has its issuer and label with another secret (the
 * key was replaced since).
 */
export type FoundAccount = Readonly<{ ref: string; issuer: string; label: string; note?: "same_key" | "same_name" }>;
/** A source opened. `unreadable`: not under a key held here, damaged, or gone; `newer_schema`: update Sixkey first. */
export type Found = Readonly<{ status: "ok" | "unreadable" | "newer_schema"; accounts: readonly FoundAccount[] }>;

type Plan = { entries: ReadonlyMap<string, Entry>; sameVault: boolean };
const plans = new WeakMap<Found, Plan>();

const asKeyOp = (err: unknown): never => {
  throw err instanceof NetworkError
    ? new KeyOpError("offline")
    : err instanceof ApiError
      ? new KeyOpError(err.code)
      : err;
};

/** The vault open here and every key this device holds for it (requireVk: locked is KeyOpError "locked"). */
async function held(e: SyncEngine): Promise<{ vault: Vault; keys: Vk[] }> {
  try {
    const cur = await e.deps.flows.current();
    return { vault: cur.vault, keys: [cur.vk, ...(await unwrapPreviousVks(cur.gen.keyring, cur.vk))] };
  } catch (err) {
    if (err instanceof ServiceError && err.code === "locked") throw new KeyOpError("locked");
    throw err;
  }
}

async function signer(e: SyncEngine): Promise<DeviceSigner> {
  const st = await e.deps.local.status();
  if (st.kind !== "on") throw new KeyOpError("not_enrolled");
  return { kind: "device", deviceId: st.identity.deviceId, key: st.identity.keyPair.privateKey };
}

/** A server time shown only when it is a plain number of milliseconds (the server is not trusted for anything here). */
const timeOrNull = (x: unknown): number | null =>
  Number.isSafeInteger(x) && (x as number) >= 0 ? (x as number) : null;

/**
 * At most this many server versions are offered, newest first: an honest server keeps the newest 30 and one a day for
 * 30 days (§5.8), about 60; a list past that is cut, not shown whole.
 */
const MAX_SERVER_SOURCES = 64;

/** Where accounts can be found: the server's history and this device's snapshots. Reads only. */
export async function findSources(e: SyncEngine): Promise<FindSources> {
  const { keys } = await held(e);
  const ids = new Set(keys.map((k) => k.id));
  // the store's own list, newest first (VaultStore.snapshots: a read that fails shows none; it writes nothing)
  const index = await e.deps.flows.snapshots();
  const local: FindSource[] = index.map((m) => Object.freeze({ kind: "local", id: m.id, at: m.at }));
  const s = await signer(e);
  try {
    const list = await e.api.versions(s);
    const server: FindSource[] = list
      .filter((v) => ids.has(v.vk_id))
      .sort((x, y) => y.version - x.version)
      .slice(0, MAX_SERVER_SOURCES)
      .map((v) =>
        Object.freeze({
          kind: "server",
          version: v.version,
          at: timeOrNull(v.created_at),
          older: v.vk_id !== keys[0]!.id,
        }),
      );
    return Object.freeze({ server, error: null, local });
  } catch (err) {
    const code = err instanceof NetworkError ? "offline" : err instanceof ApiError ? err.code : null;
    if (code === null) throw err;
    return Object.freeze({ server: null, error: code, local });
  }
}

/** An envelope opened with whichever held key it names; its vault parsed as untrusted data. */
async function openWith(
  envelope: unknown,
  keys: readonly Vk[],
): Promise<{ kind: "ok"; vault: Vault; vaultId: string } | { kind: "unreadable" | "newer_schema" }> {
  let env: EncryptedVault;
  try {
    env = validateEnvelope(envelope);
    if (!(await isEnvelopeIntact(env))) return { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
  const key = keys.find((k) => k.id === env.vkId);
  if (!key) return { kind: "unreadable" };
  let plain: Uint8Array;
  try {
    plain = await decryptVault(env, key);
  } catch {
    return { kind: "unreadable" };
  }
  try {
    const vault = deserializeVault(plain);
    return vault.vaultId === env.vaultId ? { kind: "ok", vault, vaultId: env.vaultId } : { kind: "unreadable" };
  } catch (err) {
    return err instanceof VaultError && err.code === "newer_schema" ? { kind: "newer_schema" } : { kind: "unreadable" };
  } finally {
    plain.fill(0);
  }
}

/**
 * The accounts of `source` that `now` does not hold: alive there; not alive here by id (the same vault) nor by
 * addedModeKey; each account once. In the source's order (by id).
 */
export function missingFrom(source: Vault, now: Vault): Entry[] {
  const sameVault = source.vaultId === now.vaultId;
  const liveIds = new Set(now.entries.filter(isAlive).map((x) => x.id));
  const liveKeys = new Set(now.entries.filter(isAlive).map(addedModeKey));
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const s of source.entries) {
    if (!isAlive(s)) continue;
    const key = addedModeKey(s);
    if (key === null || liveKeys.has(key) || seen.has(key) || (sameVault && liveIds.has(s.id))) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Open one source and list what it holds that the vault does not now. Reads only. */
export async function openFound(e: SyncEngine, src: FindSource): Promise<Found> {
  const { vault, keys } = await held(e);
  let envelope: unknown = null;
  if (src.kind === "server") {
    try {
      const r = await e.api.version(await signer(e), src.version);
      envelope = r.version === src.version ? JSON.parse(r.envelope) : null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404)
        envelope = null; // pruned since the list was read
      else if (err instanceof SyntaxError) envelope = null;
      else asKeyOp(err);
    }
  } else {
    // the snapshot record as the store wrote it ({v: 1, meta, envelope}); its envelope is checked by openWith. Gone
    // (pruned since the list was read), of a newer record format, or damaged: unreadable here
    try {
      const rec: unknown = (await e.deps.kv.get([KEYS.snap(src.id)]))[KEYS.snap(src.id)];
      envelope =
        typeof rec === "object" && rec !== null && (rec as { v?: unknown }).v === 1
          ? ((rec as { envelope?: unknown }).envelope ?? null)
          : null;
    } catch {
      envelope = null;
    }
  }
  const o = envelope === null ? ({ kind: "unreadable" } as const) : await openWith(envelope, keys);
  // the server's history is this vault's: a version of another vault from there is not one to take accounts from
  if (o.kind === "ok" && src.kind === "server" && o.vaultId !== vault.vaultId)
    return Object.freeze({ status: "unreadable", accounts: Object.freeze([]) });
  if (o.kind !== "ok") return Object.freeze({ status: o.kind, accounts: Object.freeze([]) });
  const missing = missingFrom(o.vault, vault);
  const live = vault.entries.filter(isAlive);
  const keysNow = new Set(live.map(entryIdentity));
  const nameOf = (x: Entry) => `${x.issuer.toLowerCase()}\u0000${x.label.toLowerCase()}`;
  const namesNow = new Set(live.map(nameOf));
  const noteOf = (x: Entry): FoundAccount["note"] =>
    keysNow.has(entryIdentity(x)) ? "same_key" : namesNow.has(nameOf(x)) ? "same_name" : undefined;
  const found: Found = Object.freeze({
    status: "ok",
    accounts: Object.freeze(
      missing.map((x) => {
        const note = noteOf(x);
        return Object.freeze({ ref: x.id, issuer: x.issuer, label: x.label, ...(note ? { note } : {}) });
      }),
    ),
  });
  plans.set(found, { entries: new Map(missing.map((x) => [x.id, x])), sameVault: o.vault.vaultId === vault.vaultId });
  return found;
}

/**
 * The accounts the user ticked (`refs`, of `found`), brought back in one local edit (SyncFlows.recoverAccounts); returns
 * how many came back. A handle used or dropped is refused (stale). The plan is dropped either way.
 */
export async function recoverFound(e: SyncEngine, found: Found, refs: readonly string[]): Promise<number> {
  const p = plans.get(found);
  if (!p) throw new KeyOpError("stale");
  const chosen = refs.map((r) => p.entries.get(r)).filter((x): x is Entry => x !== undefined);
  try {
    return await e.deps.flows.recoverAccounts(chosen, { sameVault: p.sameVault });
  } catch (err) {
    if (err instanceof ServiceError && err.code === "locked") throw new KeyOpError("locked");
    throw err;
  } finally {
    plans.delete(found);
  }
}

/** The flow is over (closed, a lock, another source chosen): the source's entries are dropped from memory. */
export function dropFound(found: Found | null): void {
  if (found) plans.delete(found);
}
