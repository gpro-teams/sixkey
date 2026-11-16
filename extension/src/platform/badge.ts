// The toolbar icon's own badge and title, the ones every tab shows unless it has its own (fill-command.ts sets a tab's
// for a few seconds): sync's status (sync-worker.ts: the devices waiting to join) draws them. In the worker's memory: a
// worker that starts again draws nothing until sync says so again (sync settles at its start).
type Paint = { setBadgeText(o: { text: string }): Promise<void>; setTitle(o: { title: string }): Promise<void> };

const sync = { text: "", title: "" };
let shown: string | null = null;

/** What is drawn: sync's badge text and title (the extension's name when it has none). */
const drawn = (): { text: string; title: string } => ({ text: sync.text, title: sync.title || "Sixkey" });

async function paint(api: Paint | undefined = globalThis.chrome?.action): Promise<void> {
  if (!api) return;
  const { text, title } = drawn();
  const now = `${text}\u0000${title}`;
  if (now === shown) return;
  shown = now;
  await Promise.allSettled([api.setBadgeText({ text }), api.setTitle({ title })]);
}

export const badge = {
  /** sync-worker.ts's badge text ("" for none). */
  syncText(text: string, api?: Paint): Promise<void> {
    sync.text = text;
    return paint(api);
  },
  /** sync-worker.ts's title. */
  syncTitle(title: string, api?: Paint): Promise<void> {
    sync.title = title;
    return paint(api);
  },
  /** For tests: what is drawn now, and a fresh start. */
  now: drawn,
  reset(): void {
    sync.text = "";
    sync.title = "";
    shown = null;
  },
};
