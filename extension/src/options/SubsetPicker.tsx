// Settings page > Backup > Export selected accounts (PHASE0X-PLAN C6; SYNC-DESIGN H2, Z3): which accounts go in the file.
// The choice is a set of entry ids, nothing else. Ticking a group ticks the accounts in it now: one added to that group
// later, from another page, is not in the file unless it is ticked too. The preview shows everything of each account that
// goes in the file except its key: name, account, group and remembered sites (C6-REVIEW C6-7). No secret, no code.
// The file never holds more than the preview shows: Backup.tsx exports only these accounts, and nothing if any of them
// changed meanwhile (C6-2).
import type { Entry } from "../core/vault/model";
import { t } from "../ui/i18n";

/** Groups in the order they first appear in the list (as the popup shows them); "" holds the accounts in no group. */
function groupsOf(entries: Entry[]): [string, Entry[]][] {
  const out = new Map<string, Entry[]>();
  for (const e of entries) {
    const g = e.group ?? "";
    out.set(g, [...(out.get(g) ?? []), e]);
  }
  return [...out];
}

const name = (e: Entry) => (
  <span class="sub-name">
    <b>{e.issuer || e.label}</b>
    {e.issuer && e.label && <small>{e.label}</small>}
  </span>
);

/** `entries`: the live accounts in list order. `picked` may name ids that are gone; they count for nothing. */
export function SubsetPicker({
  entries,
  picked,
  onPick,
  disabled,
}: {
  entries: Entry[];
  picked: ReadonlySet<string>;
  onPick: (next: Set<string>) => void;
  disabled: boolean;
}) {
  const groups = groupsOf(entries);
  const chosen = entries.filter((e) => picked.has(e.id));
  const set = (ids: string[], on: boolean) => {
    const next = new Set(chosen.map((e) => e.id)); // drops ids that are no longer listed
    for (const id of ids)
      if (on) next.add(id);
      else next.delete(id);
    onPick(next);
  };
  const tick = (ids: string[]) => (ev: Event) => set(ids, (ev.target as HTMLInputElement).checked);
  return (
    <>
      <div class="row2 sub-tools">
        <button
          type="button"
          class="btn sm ghost"
          id="sub-all"
          disabled={disabled || chosen.length === entries.length}
          onClick={() =>
            set(
              entries.map((e) => e.id),
              true,
            )
          }
        >
          {t("expSubAll")}
        </button>
        <button
          type="button"
          class="btn sm ghost"
          id="sub-none"
          disabled={disabled || chosen.length === 0}
          onClick={() =>
            set(
              entries.map((e) => e.id),
              false,
            )
          }
        >
          {t("expSubNone")}
        </button>
        <span class="muted" id="sub-count" aria-live="polite">
          {t("expSubCount", chosen.length, entries.length)}
        </span>
      </div>
      <div class="sub-list" id="sub-list">
        {groups.map(([g, list]) => {
          const on = list.filter((e) => picked.has(e.id)).length;
          const titled = g !== "" || groups.length > 1;
          return (
            <fieldset key={g} class={`sub-group${titled ? " titled" : ""}`}>
              {titled && (
                <legend>
                  <label class="check sub-g">
                    <input
                      type="checkbox"
                      checked={on === list.length}
                      disabled={disabled}
                      onChange={tick(list.map((e) => e.id))}
                      ref={(el) => {
                        if (el) el.indeterminate = on > 0 && on < list.length;
                      }}
                    />
                    <b>{g || t("ungrouped")}</b>
                    <small>{list.length}</small>
                  </label>
                </legend>
              )}
              {list.map((e) => (
                <label key={e.id} class="check sub-item">
                  <input type="checkbox" checked={picked.has(e.id)} disabled={disabled} onChange={tick([e.id])} />
                  {name(e)}
                </label>
              ))}
            </fieldset>
          );
        })}
      </div>
      {chosen.length > 0 && (
        <div class="callout sub-preview" id="sub-preview">
          <div>
            <p>{t("expSubOnly", chosen.length)}</p>
            <ul>
              {chosen.map((e) => (
                <li key={e.id}>
                  {name(e)}
                  {e.group || e.domains?.length ? (
                    <span class="sub-meta">
                      {e.group ? (
                        <small>
                          {t("fieldGroup")}: {e.group}
                        </small>
                      ) : null}
                      {e.domains?.length ? (
                        <small>
                          {t("siteField")}: {e.domains.join(", ")}
                        </small>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
