// An account's edit sheet saved (popup/main/EditDialog.tsx, loaded with the sheet only: none of this is in the popup's
// counted bundle): only the fields the user changed are written (W2b r3, the r2 review's R2-02), so a change made to the
// account under the open sheet (a sync) is never undone by a field the sheet still showed as it was. Pure.
import type { Clock } from "../../core/vault/hlc";
import type { Vault } from "../../core/vault/model";
import { editEntry, setGroup } from "../../core/vault/ops";

/** Which of the sheet's fields the user changed from what the account held. */
export type EditChanged = { issuer: boolean; label: boolean; group: boolean; domains: boolean; note?: boolean };

/** The sheet's save as an edit of the vault: `v` itself when nothing changed. No sites is stored as no field at all. */
export function editSaved(
  v: Vault,
  id: string,
  f: { issuer: string; label: string; group: string; domains: string[]; note?: string },
  changed: EditChanged,
  clock: Clock,
): Vault {
  const patch = {
    ...(changed.issuer ? { issuer: f.issuer } : {}),
    ...(changed.label ? { label: f.label } : {}),
    ...(changed.domains ? { domains: f.domains.length ? f.domains : undefined } : {}),
    ...(changed.note ? { note: f.note || undefined } : {}), // no note is stored as no field at all
  };
  const next = Object.keys(patch).length ? editEntry(v, id, patch, clock) : v;
  return changed.group ? setGroup(next, id, f.group || undefined, clock) : next;
}
