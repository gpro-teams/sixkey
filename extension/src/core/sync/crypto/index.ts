// core/sync/crypto (M1 of docs/SYNC-DESIGN.md §9): the sync wire formats and protocol crypto. Pure over its inputs:
// WebCrypto only, no I/O, no network, no chrome.* APIs, nothing logged. Storage (M2), the engine (M3) and the platform
// bridge (M5) build on this surface; the modules behind it also hold test seams that are deliberately not exported here.
import { ApproverEnrollment, type ApproverView } from "./enroll-approver";
import { NewDeviceEnrollment } from "./enroll-new-device";
import type { VerifiedServerBundle } from "./presend";

export { SYNC_CONSTANTS } from "./constants";
export { SyncCryptoError, type SyncCryptoErrorCode } from "./errors";
export {
  canonicalJsonStrict,
  floorToHour,
  fromB64u,
  integerTokensOnly,
  isHourAligned,
  parseIntegerJson,
  toB64u,
} from "./encoding";
export {
  envelopeHead,
  envelopeSizeBytes,
  envelopeText,
  fitsEnvelopeLimit,
  padPlaintext,
  paddedLength,
} from "./padding";
export { writeKey, writeProof, type WriteTarget } from "./subkeys";
export {
  passwordProof,
  recoveryProof,
  recoveryProofFromSecret,
  type PasswordProof,
  type RecoveryProof,
} from "./auth-proofs";
export {
  adoptedRecord,
  bundleHasUnknownFields,
  capPrevious,
  checkBundleShape,
  newBundleAuth,
  parseBundleText,
  publishKver,
  requiredVerifiers,
  sameKeyring,
  sealBundle,
  truncateKeyringTimes,
  verifyBundleMac,
  verifyReceivedBundle,
  type AdoptedRecord,
  type BundleAuth,
  type BundleCheckMode,
  type BundleFields,
  type KeyBundle,
  type RequiredVerifiers,
} from "./keybundle";
// classifyKver is deliberately not exported: only bundles that passed R0 (vaultId, MAC) may be classified (F-08).
export {
  allowedWhileKeysBehind,
  classifyServerVk,
  publishesBundle,
  type BundleRejection,
  type KverClass,
  type LocalUnlockNote,
  type SensitiveOp,
} from "./adoption";
export {
  evaluateSameVkBundle,
  unlockWithSync,
  type Adoption,
  type SameVkInput,
  type SameVkVerdict,
  type UnlockInput,
  type UnlockResult,
  type UnlockSecret,
} from "./bundle-eval";
export {
  isVerifiedServerBundle,
  preSendCheck,
  published,
  type PreSendInput,
  type PreSendRefusal,
  type PreSendResult,
  type Published,
  type VerifiedServerBundle,
} from "./presend";
export type { CommitBasis } from "./capability";
export {
  reconcileKeyOp,
  recoveryWrapFingerprint,
  recoveryWrapInEffect,
  type ServerKeys,
  type SubmittedKeyOp,
} from "./reconcile";
export {
  checkDeviceName,
  openDeviceName,
  sealDeviceName,
  type DeviceNameCheck,
  type DeviceNameProblem,
  type NameCt,
  type NameOwner,
} from "./device-name";
export {
  openDeviceBackup,
  sealDeviceBackup,
  type BackupOwner,
  type DeviceBackup,
  type DeviceBackupPlain,
} from "./device-backup";
export { generateDeviceKey, importDeviceKey, newDeviceId, type DeviceKey } from "./device-key";
export {
  apiHost,
  bodyHash,
  signForkRequest,
  signRequest,
  signingInput,
  verifyInput,
  type RequestToSign,
  type SignatureHeaders,
  type Signer,
  type SigningParams,
} from "./signature";
export type {
  EnrolledKeys,
  EnrollRequestBody,
  NewDeviceFailure,
  NewDevicePhase,
  NewDeviceStep,
  NewDeviceView,
  PairingCodeResult,
  RevealBody,
} from "./enroll-new-device";
export type {
  ApproveBody,
  ApproveResult,
  Approved,
  ApproverFailure,
  ApproverPhase,
  ApproverStep,
  ApproverView,
  RespondBody,
  SasResult,
} from "./enroll-approver";
export type { NewDeviceEnrollment, ApproverEnrollment };

/** §3.2 N1: a new device's enrollment request (fresh ephemeral key, nonce and commitment). */
export function startNewDeviceEnrollment(input: {
  deviceId: string;
  dpk: Uint8Array;
  name: string;
}): ReturnType<typeof NewDeviceEnrollment.start> {
  return NewDeviceEnrollment.start(input);
}

/** §3.2 M2: approve the request the user picked, from the pre-send check for respond; pins it and returns the respond body. */
export function startApproval(input: {
  approverId: string;
  rid: string;
  request: ApproverView;
  verified: VerifiedServerBundle;
}): ReturnType<typeof ApproverEnrollment.start> {
  return ApproverEnrollment.start(input);
}
