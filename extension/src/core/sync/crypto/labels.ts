// HKDF info strings and hash/MAC/AAD domain tags added by sync (§2.2). The Phase 0 labels (vk-id, vault-enc,
// kek-recovery, kek-previous) and tags (sixkey-vault, sixkey-wrap, sixkey-prev) stay next to the code that uses them in
// core/crypto, and the approval join's in enroll-labels.ts (only the enrolment code carries them, so a build whose
// release gate keeps the Sync section out ships none, and the popup's shared code holds none). Tests assert that the
// three sets together are exactly the doc's 11 labels and 16 tags, that every label is distinct (WebCrypto gives the
// same bytes for deriveKey(AES-256) and deriveBits(256) under one label, so a shared label would hand K_enc to the
// server as K_write), and that the tags are distinct and prefix-free.
export const LABEL = {
  keybundleMac: "sixkey/v1/keybundle-mac",
  deviceName: "sixkey/v1/device-name",
  vaultWrite: "sixkey/v1/vault-write",
  deviceBackup: "sixkey/v1/device-backup",
  recoveryAuth: "sixkey/v1/recovery-auth",
  passwordAuth: "sixkey/v1/password-auth",
} as const;

export const TAG = {
  keybundle: "sixkey-keybundle|1|",
  devname: "sixkey-devname|1|",
  write: "sixkey-write|1|",
  devkey: "sixkey-devkey|1|",
  recoveryVerifier: "sixkey-recovery-verifier|1|",
  passwordVerifier: "sixkey-password-verifier|1|",
  req: "sixkey-req|1|",
} as const;
