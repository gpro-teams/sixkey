// Device names (§2.4, N5): normalized, checked, padded to a fixed 160 bytes so the server cannot see their length, and
// encrypted under K_name. Names read back are checked again: they come from another device or from the server.
import { bs, randomBytes, toB64, utf8, type Random } from "../../crypto/bytes";
import type { Vk } from "../../crypto/vk";
import { SYNC_CONSTANTS as C } from "./constants";
import { DEVICE_ID_RE, ID_RE, b64 } from "./encoding";
import { SyncCryptoError } from "./errors";
import { TAG } from "./labels";
import { deviceNameKey } from "./subkeys";

export type DeviceNameProblem =
  "not_well_formed" | "empty" | "too_long" | "control_char" | "bidi_control" | "zero_width";
export type DeviceNameCheck = { ok: true; name: string } | { ok: false; problem: DeviceNameProblem };

const LONE_SURROGATE = /\p{Cs}/u; // with /u a valid pair is one code point, so only an unpaired half matches
const CONTROL = /\p{Cc}/u;
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u; // reorder text in "claims to be: …"
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/u; // hide text; includes the emoji ZWJ (§6 O3, N28)

/** NFKC, trim U+0020 at both ends, then reject in this order (§2.4). The first problem found is reported. */
export function checkDeviceName(input: string): DeviceNameCheck {
  if (typeof input !== "string") return { ok: false, problem: "not_well_formed" };
  const name = input.normalize("NFKC").replace(/^ +| +$/g, "");
  const problem: DeviceNameProblem | null = LONE_SURROGATE.test(name)
    ? "not_well_formed"
    : name.length === 0
      ? "empty"
      : [...name].length > C.DEVICE_NAME_MAX_CODE_POINTS
        ? "too_long"
        : CONTROL.test(name)
          ? "control_char"
          : BIDI.test(name)
            ? "bidi_control"
            : ZERO_WIDTH.test(name)
              ? "zero_width"
              : null;
  return problem ? { ok: false, problem } : { ok: true, name };
}

function accepted(input: string): string {
  const c = checkDeviceName(input);
  if (!c.ok) throw new SyncCryptoError("invalid_device_name", c.problem);
  return c.name;
}

/** UTF-8, right-padded with spaces to exactly 160 bytes (40 code points x 4 bytes fit). */
export function padDeviceName(input: string): Uint8Array {
  const bytes = utf8(accepted(input));
  const out = new Uint8Array(C.DEVICE_NAME_PADDED_BYTES).fill(0x20);
  out.set(bytes);
  return out;
}

const fatal = new TextDecoder("utf-8", { fatal: true });

/** The inverse of padDeviceName. Anything that padDeviceName could not have produced is refused. */
export function unpadDeviceName(padded: Uint8Array): string {
  let s: string;
  try {
    if (padded.length !== C.DEVICE_NAME_PADDED_BYTES) throw new Error("length");
    s = fatal.decode(padded).replace(/ +$/, "");
  } catch {
    throw new SyncCryptoError("invalid_device_name", "not a padded name");
  }
  const c = checkDeviceName(s);
  if (!c.ok || c.name !== s) throw new SyncCryptoError("invalid_device_name", c.ok ? "not normalized" : c.problem);
  return s;
}

export type NameCt = { vkId: string; iv: string; ct: string }; // member name vkId (N6)
export type NameOwner = { vaultId: string; deviceId: string };

function nameAad(o: NameOwner, vkId: string): Uint8Array {
  if (!ID_RE.test(o.vaultId) || !DEVICE_ID_RE.test(o.deviceId))
    throw new SyncCryptoError("invalid_argument", "bad vaultId or deviceId");
  return utf8(`${TAG.devname}${o.vaultId}|${vkId}|${o.deviceId}`);
}

/** name_ct = {vkId, iv, AES-GCM(K_name, padded name, 'sixkey-devname|1|{vaultId}|{vkId}|{deviceId}')}: always 176 bytes of ct. */
export async function sealDeviceName(
  vk: Vk,
  owner: NameOwner,
  name: string,
  rng: Random = randomBytes,
): Promise<NameCt> {
  const padded = padDeviceName(name);
  const aad = nameAad(owner, vk.id);
  const iv = rng(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bs(iv), additionalData: bs(aad), tagLength: 128 },
      await deviceNameKey(vk),
      bs(padded),
    ),
  );
  return { vkId: vk.id, iv: toB64(iv), ct: toB64(ct) };
}

export async function openDeviceName(vk: Vk, owner: NameOwner, nameCt: NameCt): Promise<string> {
  if (nameCt?.vkId !== vk.id) throw new SyncCryptoError("decrypt_failed", "name encrypted under another key");
  const aad = nameAad(owner, vk.id);
  let padded: Uint8Array;
  try {
    padded = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bs(b64(nameCt.iv, 12)), additionalData: bs(aad), tagLength: 128 },
        await deviceNameKey(vk),
        bs(b64(nameCt.ct, C.DEVICE_NAME_CT_BYTES)),
      ),
    );
  } catch {
    throw new SyncCryptoError("decrypt_failed");
  }
  return unpadDeviceName(padded);
}
