// The key bound to one of the manifest's commands (manifest.base.json `commands`): "_execute_action" opens the popup,
// "lock" locks Sixkey (QUICK-UNLOCK §5.12 item 2). Reading it needs no permission; changing it is Chrome's own page,
// chrome://extensions/shortcuts, where the user can pick another key or none.
import { useEffect, useState } from "preact/hooks";

export const SHORTCUTS_PAGE = "chrome://extensions/shortcuts";

/** The command's key as Chrome shows it ("Alt+Shift+L", "⌥⇧L"); null when none is set; undefined until read. */
export function useShortcut(name: "_execute_action" | "lock" | "fill"): string | null | undefined {
  const [key, setKey] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    chrome.commands.getAll().then(
      (all) => live && setKey(all.find((c) => c.name === name)?.shortcut || null),
      () => live && setKey(null),
    );
    return () => {
      live = false;
    };
  }, [name]);
  return key;
}
