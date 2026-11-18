// Settings › Accounts › Groups (the owner's report of 2026-11-18: 57 accounts, many old or hard to keep apart, and a group
// set one account at a time, in the popup's Edit). Accounts ticked (a search narrows the list; ticks outside it stay),
// then moved into a group in one write, or out of their groups. A new group's accounts go to the end of the list, so its
// section comes last in the popup (an old-accounts group out of the way).
import { useState } from "preact/hooks";
import { aliveEntries, type Entry } from "../core/vault/model";
import { LIMITS } from "../core/vault/validate";
import { moveEntry, setGroup } from "../core/vault/ops";
import { t } from "../ui/i18n";
import { Icon } from "./icons";
import { errText, Panel, type Ctx } from "./shared";
import { SubsetPicker } from "./SubsetPicker";
import "./export.css";

const says = (e: Entry, q: string) => `${e.issuer} ${e.label} ${e.group ?? ""}`.toLowerCase().includes(q);

export function Groups({ rt, vault, status, reload }: Ctx) {
  const unlocked = status.state === "unlocked" && vault !== null;
  const live = vault ? aliveEntries(vault) : [];
  const groups = [...new Set(live.map((e) => e.group ?? "").filter((g) => g !== ""))];
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = q.trim().toLowerCase();
  const shown = query ? live.filter((e) => says(e, query)) : live;
  const ids = live.filter((e) => picked.has(e.id)).map((e) => e.id); // ticks of accounts that are gone count for nothing
  // the picker's ticks are those of the accounts it shows: the ones it does not show keep theirs
  const pick = (next: Set<string>) => {
    const seen = new Set(shown.map((e) => e.id));
    setPicked(new Set([...[...picked].filter((id) => !seen.has(id)), ...next]));
    setDone(null);
  };

  async function moveTo(group: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    const moving = new Set(ids);
    try {
      await rt.service.mutate((v, c) => {
        const all = aliveEntries(v);
        const fresh = group !== "" && !all.some((e) => e.group === group && !moving.has(e.id));
        let next = v;
        for (const e of all) {
          if (!moving.has(e.id)) continue;
          if ((e.group ?? "") !== group) next = setGroup(next, e.id, group || undefined, c);
          if (fresh) next = moveEntry(next, e.id, all.length, c); // to the end, in their order
        }
        return next;
      });
      await reload();
      setPicked(new Set());
      setDone(group ? t("groupsMoved", moving.size, group) : t("groupsCleared", moving.size));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const target = name.trim();
  return (
    <Panel id="groups" icon="archive" title={t("groupsTitle")} lead={t("groupsLead")}>
      <div class="box">
        <div class="field">
          <input
            id="groups-q"
            type="search"
            value={q}
            placeholder={t("groupsSearch")}
            aria-label={t("groupsSearch")}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          />
        </div>
        <SubsetPicker entries={shown} picked={picked} onPick={pick} disabled={!unlocked || busy} preview={false} />
        <div class="field">
          <label for="groups-name">{t("fieldGroup")}</label>
          <input
            id="groups-name"
            list="groups-list"
            value={name}
            maxLength={LIMITS.group}
            disabled={!unlocked || busy}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <datalist id="groups-list">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
        <div class="row2">
          <button
            type="button"
            class="btn sm"
            id="groups-move"
            disabled={!unlocked || busy || ids.length === 0 || target === ""}
            onClick={() => void moveTo(target)}
          >
            {t("groupsMove", ids.length)}
          </button>
          <button
            type="button"
            class="btn sm ghost"
            id="groups-clear"
            disabled={!unlocked || busy || ids.length === 0}
            onClick={() => void moveTo("")}
          >
            {t("groupsClear")}
          </button>
        </div>
        {done && (
          <div class="ok-msg" role="status" id="groups-done">
            <Icon name="check" size={15} />
            {done}
          </div>
        )}
        {error && (
          <div class="err" role="alert">
            <Icon name="alert" size={15} />
            {error}
          </div>
        )}
      </div>
    </Panel>
  );
}
