// The welcome's look into Chrome sync (no vault here yet): a copy of Sixkey's backup there, made on another computer or
// on this one before, is offered first, "从 Chrome 同步恢复", which opens first run's restore from it (#setup-csb). A lazy
// chunk of the welcome's, with the popup's text of the backup (src/ui/csb-popup-text.ts), so the lock screen, which
// shares the welcome's chunk, loads none of it. Read only and keyless: the pages' reader
// (src/platform/csb-read.ts) lists the copies as they are, each checked whole, and lists them again when Chrome delivers
// one while the welcome is open; nothing is opened, written or sent. A copy still arriving is not offered (the restore
// waits for one); none, or an area that cannot be read: nothing is said, and the welcome is as it was.
import { useEffect, useState } from "preact/hooks";
import { ago } from "../../ui/ago";
import { watchSlots } from "../../platform/csb-read";
import { cb } from "../../ui/csb-popup-text";
import { getLang } from "../../ui/i18n";
import { Icon } from "../../ui/icons";
import { openOptions } from "../chrome";

/**
 * The line and its button, while an intact copy is there: the first of the welcome's buttons, in its stack (so the
 * welcome stays within the popup's 600 px). `onFound` hears whether they are shown (the welcome's own "start" is then
 * not the main button). `first`: the copy was there when the welcome opened ("找到了"), not one that arrived since
 * ("刚到了").
 */
export function CsbFound({ onFound }: { onFound: (found: boolean) => void }) {
  const [ready, setReady] = useState(false);
  const [latest, setLatest] = useState<{ at: number; first: boolean } | null>(null);
  useEffect(() => {
    void cb.loaded.then(() => setReady(cb.words() != null));
    let first: boolean | null = null;
    try {
      return watchSlots(
        (list) => {
          first ??= list.latest !== null;
          setLatest(list.latest === null ? null : { at: list.latest, first });
        },
        // unreadable: nothing offered, and read again at the next change; a copy found then has arrived since
        {
          onError: () => {
            first ??= false;
          },
        },
      );
    } catch {
      return undefined; // no storage.sync here
    }
  }, []);
  const found = ready && latest !== null;
  useEffect(() => onFound(found), [found]);
  if (!found) return null;
  return (
    <>
      <p class="hint" id="csb-found" role="status">
        <Icon name="info" />
        <span>{latest.first ? cb("cbFoundAt", ago(latest.at, Date.now(), getLang())) : cb("cbArrived")}</span>
      </p>
      <button class="btn" id="csb-restore" onClick={() => openOptions("#setup-csb")}>
        <Icon name="restore" />
        {cb("cbRestore")}
      </button>
    </>
  );
}
