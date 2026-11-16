// The approval join's HKDF label and domain tags (§2.2, §2.6; enrolment v2, revision 27). They live apart from
// labels.ts so that only the enrolment code carries them. The join is at version 2: its key mixes in the pairing secret,
// and every one of its domain separations says v2, so a version-1 peer fails closed (commitment, SAS or decryption)
// instead of joining; there is no negotiation and no confirmation code. The pairing code's check-bit tag is defined
// with the code (core/crypto/pairing-code.ts) and listed here. labels.ts says what the tests assert about all of them.
import { PAIRING_CODE_TAG } from "../../crypto/pairing-code";

export const ENROLL_LABEL = {
  enrollKey: "sixkey/v2/enroll-key", // K = HKDF(IKM = Z || S, salt = h, this)
} as const;

export const ENROLL_TAG = {
  enrollCommit: "sixkey-enroll-commit|2|",
  enroll: "sixkey-enroll|2|",
  sas: "sixkey/v2/enroll-sas|",
  pairingCode: PAIRING_CODE_TAG,
  enrollPayload: "sixkey-enroll-payload|2|",
  enrollName: "sixkey-enroll-name|2|",
} as const;
