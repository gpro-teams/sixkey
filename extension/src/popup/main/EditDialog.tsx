import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { matchTier, parseSite } from "../../core/match";
import type { Clock } from "../../core/vault/hlc";
import type { Entry, Vault } from "../../core/vault/model";
import { LIMITS } from "../../core/vault/validate";
import { Avatar } from "../../ui/art";
import { Icon } from "../../ui/icons";
import { t } from "../../ui/i18n";
import { editSaved } from "./edit-save";
import { appendDomain } from "./model";
import { siteRules } from "./site-rules";
import "./site.css";

const fieldsOf = (e: Entry) => ({ issuer: e.issuer, label: e.label, group: e.group ?? "", domains: e.domains ?? [] });
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Edit an account: name, account, group, and the sites it belongs to (`domains`, PHASE0X-PLAN B2), the only thing that
 * makes it "This site" on a page. `host` is the current page's host when it could be registered; the dialog then
 * offers it, and its parents, as one-click additions. The account changed while the sheet is open (a sync): each field
 * the user has not touched shows the new value, each they have keeps theirs, and Save writes only those they changed, so
 * it never undoes the other change.
 */
export function EditDialog(p: {
  entry: Entry;
  groups: string[];
  host: string | null;
  onClose: () => void;
  /** The save, as the vault's edit to make (only the fields the user changed: edit-save.ts), or null: nothing changed. */
  onSave: (update: ((v: Vault, c: Clock) => Vault) | null) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [issuer, setIssuer] = useState(p.entry.issuer);
  const [label, setLabel] = useState(p.entry.label);
  const [group, setGroup] = useState(p.entry.group ?? "");
  const [domains, setDomains] = useState<string[]>(p.entry.domains ?? []);
  const [site, setSite] = useState("");
  const [siteError, setSiteError] = useState("");
  const [choices, setChoices] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  // The latest list, so an add that finishes after a newer render (the rules were still loading) builds on it.
  const list = useRef(domains);
  const setList = (next: string[]) => {
    list.current = next;
    setDomains(next);
  };
  // What the account held, field by field, as the sheet last took it: a field still equal to it is one the user has not
  // touched, and takes the account's new value when it changes under the sheet (W2b r3, the review's R2-02)
  const base = useRef(fieldsOf(p.entry));
  // (each against the field as it is now, not as this render saw it: a key typed meanwhile is the user's)
  useEffect(() => {
    const was = base.current;
    const now = fieldsOf(p.entry);
    base.current = now;
    if (now.issuer !== was.issuer) setIssuer((cur) => (cur === was.issuer ? now.issuer : cur));
    if (now.label !== was.label) setLabel((cur) => (cur === was.label ? now.label : cur));
    if (now.group !== was.group) setGroup((cur) => (cur === was.group ? now.group : cur));
    if (!sameList(now.domains, was.domains) && sameList(list.current, was.domains)) setList(now.domains);
  }, [p.entry]);
  // The rules for adding sites load when the dialog opens, so adding one is immediate.
  const rules = useRef<Awaited<ReturnType<typeof siteRules>> | null>(null);
  // Focus moves in as the dialog appears, so a key pressed straight after opening it (Escape) reaches the dialog.
  useLayoutEffect(() => first.current?.focus(), []);
  useEffect(() => {
    let live = true;
    siteRules().then(
      (m) => {
        rules.current = m;
        if (live && p.host) setChoices(m.domainChoices(p.host));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [p.host]);

  /** Add a typed or suggested site; the new list, or null (with the reason shown) when it cannot be added. */
  async function addSite(input: string): Promise<string[] | null> {
    const d = parseSite(input);
    if (!d) {
      setSiteError(t("siteInvalid"));
      return null;
    }
    if ((rules.current ?? (await siteRules())).isShared(d)) {
      setSiteError(t("siteShared", d));
      return null;
    }
    const next = appendDomain(list.current, d);
    if (next === "too_many") {
      setSiteError(t("siteTooMany", LIMITS.domains));
      return null;
    }
    setList(next);
    setSite((s) => (s === input ? "" : s)); // keep anything typed since
    setSiteError("");
    return next;
  }

  // The current page, offered while it is not already covered by one of the account's sites.
  const offered =
    p.host && matchTier({ issuer: "", domains }, p.host) !== "registered"
      ? choices.filter((c) => !domains.includes(c))
      : [];

  return (
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label={t("edit")}
      onKeyDown={(ev) => ev.key === "Escape" && (ev.stopPropagation(), p.onClose())}
      onClick={(ev) => ev.target === ev.currentTarget && p.onClose()}
    >
      <form
        class="sheet"
        onSubmit={async (ev) => {
          ev.preventDefault();
          let sites: string[] | null = list.current;
          if (site.trim()) sites = await addSite(site); // typed but not added yet: add it now, or stay open and say why not
          if (!sites) return;
          const was = base.current;
          const f = { issuer: issuer.trim(), label: label.trim(), group: group.trim(), domains: sites };
          const changed = {
            issuer: f.issuer !== was.issuer,
            label: f.label !== was.label,
            group: f.group !== was.group,
            domains: !sameList(sites, was.domains),
          };
          const id = p.entry.id;
          void p.onSave(Object.values(changed).some(Boolean) ? (v, c) => editSaved(v, id, f, changed, c) : null);
        }}
      >
        <div class="sheet-h">
          <Avatar name={issuer || label || p.entry.issuer || p.entry.label} size={36} />
          <span class="who">
            <b>{issuer || label || "—"}</b>
            <i>
              {p.entry.type === "hotp"
                ? t("hotpShort")
                : t("otpSpec", p.entry.digits, p.entry.period, p.entry.algorithm)}
            </i>
          </span>
        </div>
        <div class="field">
          <label for="e-issuer">{t("fieldIssuer")}</label>
          <input
            id="e-issuer"
            ref={first}
            value={issuer}
            maxLength={256}
            onInput={(e) => setIssuer((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="pair">
          <div class="field">
            <label for="e-label">{t("fieldLabel")}</label>
            <input
              id="e-label"
              value={label}
              maxLength={256}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="field">
            <label for="e-group">{t("fieldGroup")}</label>
            <input
              id="e-group"
              list="groups"
              value={group}
              maxLength={64}
              onInput={(e) => setGroup((e.target as HTMLInputElement).value)}
            />
            <datalist id="groups">
              {p.groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
        </div>
        <div class="field sites">
          <label for="e-site">{t("siteField")}</label>
          {domains.length > 0 && (
            <ul class="dchips">
              {domains.map((d) => (
                <li key={d} class="dchip">
                  <span>{d}</span>
                  <button
                    type="button"
                    aria-label={t("siteRemove", d)}
                    title={t("siteRemove", d)}
                    onClick={() => setList(list.current.filter((x) => x !== d))}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div class="dadd">
            <input
              id="e-site"
              value={site}
              placeholder="example.com"
              autocomplete="off"
              spellcheck={false}
              maxLength={2048}
              aria-describedby="e-site-note"
              aria-invalid={siteError ? "true" : undefined}
              onInput={(e) => {
                setSite((e.target as HTMLInputElement).value);
                setSiteError("");
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") {
                  ev.preventDefault();
                  if (site.trim()) void addSite(site);
                }
              }}
            />
            <button type="button" class="btn sm ghost" disabled={!site.trim()} onClick={() => void addSite(site)}>
              {t("add")}
            </button>
          </div>
          {offered.length > 0 && (
            <div class="dsugg">
              <span>{t("siteCurrent")}</span>
              {offered.map((c) => (
                <button
                  type="button"
                  key={c}
                  class="dsug"
                  aria-label={t("siteAddOne", c)}
                  onClick={() => void addSite(c)}
                >
                  <Icon name="plus" size={12} />
                  {c}
                </button>
              ))}
            </div>
          )}
          {siteError ? (
            <span id="e-site-note" class="err" role="status">
              <Icon name="alert" size={14} />
              {siteError}
            </span>
          ) : (
            <small id="e-site-note" class="dnote">
              {t("siteHelp")}
            </small>
          )}
        </div>
        <div class="acts">
          <button
            type="button"
            class={`btn sm ${confirm ? "danger" : "ghost danger-text"}`}
            onClick={() => (confirm ? void p.onDelete() : setConfirm(true))}
          >
            <Icon name="trash" size={14} />
            {confirm ? t("deleteConfirm") : t("delete")}
          </button>
          <span class="sp" />
          <button type="button" class="btn sm quiet" onClick={p.onClose}>
            {t("cancel")}
          </button>
          <button type="submit" class="btn sm">
            {t("save")}
          </button>
        </div>
      </form>
    </div>
  );
}
