// Synthetic export files for the file import tests (IMPORT-FILE-NOTES.md). Every secret here is made up: test bytes
// written in base32, never a real account's key. The shapes follow each app's public format (the notes cite them).
import { encodeBase32 } from "../../src/core/totp/base32";

/** A made-up key of `n` bytes, distinct per `seed`. */
export const key = (seed: number, n = 20): string =>
  encodeBase32(Uint8Array.from({ length: n }, (_, i) => (seed * 31 + i * 7 + 3) & 0xff));

export const K1 = key(1);
export const K2 = key(2);
export const K3 = key(3);
export const K4 = key(4);

export const link = (issuer: string, account: string, secret: string, extra = "") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30${extra}`;

/** Ten lines shaped like the owner's file (authenticator-uris-<date>.txt): one otpauth:// link per line, LF, a final newline. */
export const SAMPLE_LIST =
  Array.from({ length: 10 }, (_, i) => link(`Service ${i + 1}`, `user${i + 1}@example.com`, key(100 + i))).join("\n") +
  "\n";

// --- a tiny protobuf writer for Google Authenticator export codes ----------------------------------------------------
const varint = (n: bigint): number[] => {
  const out: number[] = [];
  let v = BigInt.asUintN(64, n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};
const fkey = (no: number, wire: number) => varint(BigInt((no << 3) | wire));
const vf = (no: number, n: number | bigint) => [...fkey(no, 0), ...varint(BigInt(n))];
const lf = (no: number, bytes: ArrayLike<number>) => [
  ...fkey(no, 2),
  ...varint(BigInt(bytes.length)),
  ...Array.from(bytes),
];
const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));

export type MigEntry = { seed: number; name: string; issuer: string; type?: number; alg?: number; dig?: number };
/** One QR code of a Google Authenticator export: `index` of `size`, export `id`. */
export function migration(entries: MigEntry[], meta: { size: number; index: number; id: number }): string {
  const bytes = [
    ...entries.flatMap((e) =>
      lf(1, [
        ...lf(
          1,
          Array.from({ length: 10 }, (_, i) => (e.seed * 17 + i) & 0xff),
        ),
        ...lf(2, utf8(e.name)),
        ...lf(3, utf8(e.issuer)),
        ...vf(4, e.alg ?? 1),
        ...vf(5, e.dig ?? 1),
        ...vf(6, e.type ?? 2),
      ]),
    ),
    ...vf(2, 1),
    ...vf(3, meta.size),
    ...vf(4, meta.index),
    ...vf(5, BigInt(meta.id)),
  ];
  return `otpauth-migration://offline?data=${encodeURIComponent(btoa(String.fromCharCode(...bytes)))}`;
}

// --- JSON exports --------------------------------------------------------------------------------------------------------
export const aegisPlain = (entries: object[]) =>
  JSON.stringify({ version: 1, header: { slots: null, params: null }, db: { version: 3, entries, groups: [] } });
export const aegisEntry = (o: { type?: string; name: string; issuer: string; secret: string; info?: object }) => ({
  type: o.type ?? "totp",
  uuid: "01234567-89ab-cdef-0123-456789abcdef",
  name: o.name,
  issuer: o.issuer,
  note: "a note that is never imported",
  favorite: false,
  icon: null,
  info: { secret: o.secret, algo: "SHA1", digits: 6, period: 30, ...o.info },
  groups: [],
});
export const AEGIS_ENCRYPTED = JSON.stringify({
  version: 1,
  header: {
    slots: [
      { type: 1, uuid: "x", key: "00", key_params: { nonce: "00", tag: "00" }, n: 32768, r: 8, p: 1, salt: "00" },
    ],
    params: { nonce: "000000000000000000000000", tag: "00000000000000000000000000000000" },
  },
  db: "QUJDREVGR0g=",
});

export const twofas = (services: object[], extra: object = {}) =>
  JSON.stringify({
    services,
    groups: [],
    updatedAt: 1,
    schemaVersion: 4,
    appVersionCode: 5000,
    appOrigin: "android",
    ...extra,
  });
export const twofasService = (o: { name: string; account: string; secret: string; otp?: object }) => ({
  name: o.name,
  secret: o.secret,
  updatedAt: 1,
  otp: {
    label: `${o.name}:${o.account}`,
    account: o.account,
    issuer: o.name,
    digits: 6,
    period: 30,
    algorithm: "SHA1",
    tokenType: "TOTP",
    source: "Link",
    ...o.otp,
  },
  order: { position: 0 },
  icon: { selected: "Label", label: { text: "XX", backgroundColor: "Orange" } },
});
export const TWOFAS_ENCRYPTED = twofas([], { servicesEncrypted: "QUJD:REVG:R0hJ", reference: "QUJD:REVG:R0hJ" });

export const andotp = (entries: object[]) => JSON.stringify(entries);
export const andotpEntry = (o: { issuer: string; label: string; secret: string; type?: string; extra?: object }) => ({
  secret: o.secret,
  issuer: o.issuer,
  label: o.label,
  digits: 6,
  type: o.type ?? "TOTP",
  algorithm: "SHA1",
  thumbnail: "Default",
  last_used: 0,
  used_frequency: 0,
  period: 30,
  tags: ["work"],
  ...o.extra,
});

export const raivoEntry = (o: { issuer: string; account: string; secret: string; kind?: string; digits?: string }) => ({
  issuer: o.issuer,
  account: o.account,
  secret: o.secret,
  algorithm: "SHA1",
  digits: o.digits ?? "6",
  kind: o.kind ?? "TOTP",
  timer: "30",
  counter: "0",
  pinned: "false",
  iconType: "",
  iconValue: "",
});

export const bitwarden = (items: object[]) => JSON.stringify({ encrypted: false, folders: [], items });
export const bitwardenItem = (
  name: string,
  username: string,
  totp: string | null,
  password = "Hunter2-Correct!Horse",
) => ({
  id: "id",
  organizationId: null,
  folderId: null,
  type: 1,
  name,
  notes: null,
  favorite: false,
  login: { uris: [], username, password, totp },
  collectionIds: null,
});
export const BITWARDEN_ENCRYPTED = JSON.stringify({
  encrypted: true,
  encKeyValidation_DO_NOT_EDIT: "2.AAA|BBB|CCC",
  folders: [],
  items: [],
});
export const BITWARDEN_PASSWORD = JSON.stringify({
  encrypted: true,
  passwordProtected: true,
  salt: "c2FsdA==",
  kdfType: 0,
  kdfIterations: 600000,
  encKeyValidation_DO_NOT_EDIT: "2.AAA|BBB|CCC",
  data: "2.AAA|BBB|CCC",
});

/** FreeOTP+: the key as Java's signed bytes. */
export const freeotpPlus = (tokens: object[]) => JSON.stringify({ tokenOrder: tokens.map((_, i) => `t${i}`), tokens });
export const freeotpToken = (o: {
  issuer: string;
  label: string;
  bytes: number[];
  type?: string;
  counter?: number;
}) => ({
  algo: "SHA1",
  counter: o.counter ?? 0,
  digits: 6,
  issuerExt: o.issuer,
  label: o.label,
  period: 30,
  secret: o.bytes.map((b) => (b > 127 ? b - 256 : b)),
  type: o.type ?? "TOTP",
});

export const proton = (entries: { uri: string; name: string; type?: string }[]) =>
  JSON.stringify({
    version: 1,
    entries: entries.map((e, i) => ({
      id: `id-${i}`,
      content: { uri: e.uri, entry_type: e.type ?? "Totp", name: e.name },
      note: null,
    })),
  });
export const PROTON_ENCRYPTED = JSON.stringify({ version: 1, salt: "c2FsdA==", content: "Y29udGVudA==" });
export const ENTE_ENCRYPTED = JSON.stringify({
  version: 1,
  kdfParams: { memLimit: 4096, opsLimit: 3, salt: "c2FsdA==" },
  encryptedData: "ZGF0YQ==",
  encryptionNonce: "bm9uY2U=",
});
