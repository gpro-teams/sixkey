import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { usableDomain } from "../../core/match";
import type { Entry } from "../../core/vault/model";
import { LIMITS } from "../../core/vault/validate";
import { Avatar } from "../../ui/art";
import { Icon } from "../../ui/icons";
import { getLang, t } from "../../ui/i18n";
import { appendDomain } from "./model";
import "./site.css";

/**
 * "Remember this site" (PHASE0X-PLAN B2): register the current page's host, or one of its parents, for an account the
 * popup only guessed was related. An ordinary edit of the account's `domains`. `choices` and `pick` come from
 * site-domains.ts (domainChoices, preferredChoice), which the caller loads on demand. They are spelled out, so on a
 * look-alike such as github.com.attacker.io the user is shown "attacker.io".
 *
 * An account the user picked from the list's "Which account for <host>?" line can already have sites of its own (a
 * related one never has: match.ts stops guessing for it), on any page, a look-alike's too. Then one line above Save
 * names them (at most two), so "github.com" stands beside the page's names (AFMATCH-NOTES.md, AF-01). It warns; Save
 * stays as it is.
 */
export function RememberSheet(p: {
  entry: Entry;
  host: string;
  choices: string[];
  pick: string;
  onClose: () => void;
  onSave: (domains: string[], chosen: string) => Promise<void>;
}) {
  const { choices } = p;
  const [pick, setPick] = useState(p.pick);
  const [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => form.current?.querySelector<HTMLElement>("input:checked, .btn")?.focus(), []);
  const name = p.entry.issuer || p.entry.label;
  const bound = [...new Set((p.entry.domains ?? []).map(usableDomain).filter((d) => d !== null))];
  const sep = getLang() === "zh_CN" ? "、" : ", ";
  const warn = choices.length > 0 && bound.length > 0;
  return (
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rm-title"
      aria-describedby={warn ? "rm-warn" : undefined}
      onKeyDown={(ev) => ev.key === "Escape" && (ev.stopPropagation(), p.onClose())}
      onClick={(ev) => ev.target === ev.currentTarget && p.onClose()}
    >
      <form
        ref={form}
        class="sheet rm"
        onSubmit={(ev) => {
          ev.preventDefault();
          const next = appendDomain(p.entry.domains, pick);
          if (next === "too_many") setError(t("siteTooMany", LIMITS.domains));
          else void p.onSave(next, pick);
        }}
      >
        <div class="sheet-h">
          <Avatar name={name} size={36} />
          <span class="who">
            <b id="rm-title">{t("siteRememberTitle")}</b>
            <i>{p.entry.issuer && p.entry.label ? `${name} · ${p.entry.label}` : name}</i>
          </span>
        </div>
        {choices.length > 0 ? (
          <>
            <fieldset class="rm-opts">
              <legend class="vh">{t("siteRememberTitle")}</legend>
              {choices.map((c) => (
                <label key={c} class="rm-opt">
                  <input type="radio" name="rm-domain" value={c} checked={pick === c} onChange={() => setPick(c)} />
                  <span>{c}</span>
                </label>
              ))}
            </fieldset>
            <p class="rm-note">{t("siteRememberHelp")}</p>
          </>
        ) : (
          <p class="rm-note">{t("siteNone", p.host)}</p>
        )}
        {warn && (
          <p class="rm-warn" id="rm-warn">
            <Icon name="alert" size={14} />
            <span>{t("siteBound", bound.length > 2 ? `${bound.slice(0, 2).join(sep)}${sep}…` : bound.join(sep))}</span>
          </p>
        )}
        {error && (
          <span class="err" role="status">
            <Icon name="alert" size={14} />
            {error}
          </span>
        )}
        <div class="acts">
          <span class="sp" />
          <button type="button" class="btn sm quiet" onClick={p.onClose}>
            {t("cancel")}
          </button>
          {choices.length > 0 && (
            <button type="submit" class="btn sm">
              {t("siteRememberBtn")}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
