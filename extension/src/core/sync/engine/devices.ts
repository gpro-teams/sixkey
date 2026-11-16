// The device list as the Sync section shows it (SYNC-DESIGN §3.10, §6 O8): GET /v1/devices, signed by this device, and
// each device's name opened here with the vault key (K_name, §2.4), or with a previous key the keyring really unwraps
// (the server restored to before a rotation keeps the names under the older key). Names need the key: while this
// context is locked (or a name is under a key this device does not hold) a row has no name and the page shows a
// placeholder. What the
// server says is untrusted: the ids, flags and times are shown as they are checked here, and nothing of a row is kept.
import { unwrapPreviousVks } from "../../crypto/keyring";
import type { Vk } from "../../crypto/vk";
import { ServiceError } from "../../service/service-error";
import { openDeviceName } from "../crypto/device-name";
import { DEVICE_ID_RE } from "../crypto/encoding";
import { ApiError, type DeviceInfo } from "./api";
import type { SyncEngine } from "./engine";
import { KeyOpError } from "./keys";
import { undoneRevocations } from "./state";
import { NetworkError } from "./transport";

/** One device as the list shows it. Times are milliseconds (the server's, at most to the hour or the day, C14). */
export type DeviceRow = {
  id: string;
  /** The device's name, or null when it cannot be opened here (locked, or under another key). */
  name: string | null;
  /** This profile's own device. */
  current: boolean;
  joinedVia: "first" | "approval" | "recovery" | "fork" | "other";
  approvedBy: string | null;
  createdAt: number | null;
  lastSeenAt: number | null;
  revokedAt: number | null;
  /** Wrong master passwords sent with this device's signature since its last right one (§3.14 S2). */
  authFailures: number;
};

const time = (x: unknown): number | null => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null);
const VIA: ReadonlySet<string> = new Set(["first", "approval", "recovery", "fork"]);

/** The rows, this device first, then the others by when they joined; a row whose id is not a device id is left out. */
export async function listDevices(e: SyncEngine): Promise<DeviceRow[]> {
  const st = await e.deps.local.status();
  if (st.kind !== "on") throw new KeyOpError("not_enrolled");
  const signer = { kind: "device" as const, deviceId: st.identity.deviceId, key: st.identity.keyPair.privateKey };
  let r;
  try {
    r = await e.api.devices(signer);
  } catch (err) {
    if (err instanceof ApiError) throw new KeyOpError(err.code);
    if (err instanceof NetworkError) throw new KeyOpError("offline");
    throw err;
  }
  let key: { vks: Vk[]; vaultId: string } | null = null;
  try {
    const cur = await e.deps.flows.current();
    key = { vks: [cur.vk, ...(await unwrapPreviousVks(cur.gen.keyring, cur.vk))], vaultId: cur.gen.keyring.vaultId };
  } catch (err) {
    if (!(err instanceof ServiceError)) throw err; // locked, or no vault: the names stay closed
  }
  const rows: DeviceRow[] = [];
  for (const d of r.devices as DeviceInfo[]) {
    if (typeof d?.device_id !== "string" || !DEVICE_ID_RE.test(d.device_id)) continue;
    let name: string | null = null;
    const vk = key && d.name_ct ? key.vks.find((k) => k.id === d.name_ct!.vkId) : undefined;
    if (key && vk && d.name_ct)
      name = await openDeviceName(vk, { vaultId: key.vaultId, deviceId: d.device_id }, d.name_ct).catch(() => null);
    rows.push({
      id: d.device_id,
      name,
      current: d.device_id === st.identity.deviceId,
      joinedVia: VIA.has(d.joined_via) ? (d.joined_via as DeviceRow["joinedVia"]) : "other",
      approvedBy: typeof d.approved_by === "string" && DEVICE_ID_RE.test(d.approved_by) ? d.approved_by : null,
      createdAt: time(d.created_at),
      lastSeenAt: time(d.last_seen_at),
      revokedAt: time(d.revoked_at),
      authFailures: Number.isSafeInteger(d.auth_failures) && d.auth_failures > 0 ? d.auth_failures : 0,
    });
  }
  return rows.sort((a, b) =>
    a.current !== b.current ? (a.current ? -1 : 1) : (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );
}

/**
 * §4.2's repair after a restore of the server: the devices it will revoke again before it sends its keys (the revocations
 * the restore undid, state.ts undoneRevocations, the rule the repair itself applies), as the list shows them, for the
 * repair's form to name before the click. None without a revocation on this device's list (no request then).
 */
export async function revokedBeforeRestore(e: SyncEngine): Promise<DeviceRow[]> {
  const stored = (await e.state.read()).state.devices;
  if (!stored?.some((d) => d.revoked)) return [];
  const rows = await listDevices(e);
  const self = rows.find((r) => r.current)?.id ?? "";
  const again = new Set(
    undoneRevocations(
      stored,
      rows.map((r) => ({ id: r.id, revoked: r.revokedAt !== null })),
      self,
    ),
  );
  return rows.filter((r) => again.has(r.id));
}
