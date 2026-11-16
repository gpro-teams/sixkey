// "A change needs your OK" (SYNC-DESIGN §4.4, §6 O12): the accounts the other side would erase for good, or whose secret
// it would change, named from this device's vault, and the two answers. Apply takes the other side's change; Keep mine
// keeps this device's version, which then wins on every device. Nothing is applied until one is chosen.
import { useLayoutEffect, useRef } from "preact/hooks";
import { Avatar } from "../../ui/art";
import { t } from "../../ui/i18n";
import { Icon } from "../icons";
import type { Vault } from "../../core/vault/model";
import type { MergeAnswer } from "./gateway";
import { answerOf, reviewRows, type Blocked } from "./review";
import { st } from "./text";

export function ReviewView({
  blocked,
  vault,
  onAnswer,
  onClose,
  busy,
}: {
  blocked: Blocked;
  vault: Vault | null;
  onAnswer: (a: MergeAnswer) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const rows = reviewRows(blocked, vault);
  const lead = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => lead.current?.focus(), []); // the screen starts here, for keyboard and screen reader users
  return (
    <div class="box warn" id="sync-review" role="group" aria-labelledby="sync-review-t">
      <h3 class="bt" id="sync-review-t">
        <Icon name="alert" size={17} />
        <span>{st("syncReviewTitle")}</span>
      </h3>
      <p ref={lead} tabIndex={-1} class="step-focus">
        {st("syncReviewLead", rows.length)}
      </p>
      <ul class="review-list">
        {rows.map((r) => (
          <li key={r.id}>
            <Avatar name={r.name || "?"} size={28} />
            <span>
              <b>{r.name || st("syncReviewUnnamed")}</b>
              {r.account && <span class="muted"> · {r.account}</span>}
            </span>
            <em class={`chip ${r.why === "erased" ? "bad" : "warn"}`}>
              {st(r.why === "erased" ? "syncReviewErased" : "syncReviewSecret")}
            </em>
          </li>
        ))}
      </ul>
      <p class="muted">{st("syncReviewHow")}</p>
      <div class="row2">
        <button class="btn" id="sync-review-keep" disabled={busy} onClick={() => onAnswer(answerOf(blocked, "keep"))}>
          <Icon name="shieldCheck" size={15} />
          {st("syncReviewKeep")}
        </button>
        <button
          class="btn ghost danger-text"
          id="sync-review-apply"
          disabled={busy}
          onClick={() => onAnswer(answerOf(blocked, "apply"))}
        >
          {st("syncReviewApply")}
        </button>
        <button class="btn sm quiet" type="button" disabled={busy} onClick={onClose}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}
