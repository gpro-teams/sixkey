// Where the Sync section sits in the settings page (SYNC-DESIGN §6: "侧栏新增'同步'一节（在'安全'之后）"), in the page's
// own bundle. The section itself, its flows and its text are a chunk of their own (src/options/sync/), loaded when the
// section is first shown: when it comes near the screen, when the page is opened at #sync, or at once when this profile
// has any sync record (sync is on, or a turn-off, a join or kept saves wait), because the rail's sync line and the
// page's own rounds need it then. A profile that never uses sync never loads it.
//
// The release gate (scripts/sync-ui.mjs, __SYNC_UI__): a build without the sync user interface renders
// nothing here, and the import below is dead code that the build removes before loading the module (scripts/build.mjs
// fails a store build whose graph reaches it).
import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import { SYNC_KEYS } from "../core/sync/local/keys";
import { t } from "../ui/i18n";
import { Icon } from "./icons";
import type { Ctx } from "./shared";

// Read here, as a constant of this module: only a local one is folded before the bundler loads the dynamic import, so
// that the build drops the section's import with the gate closed (the graph guard fails the store build otherwise).
declare const __SYNC_UI__: boolean;
/** Whether this build has the Sync section (the release gate). */
export const SYNC_UI = typeof __SYNC_UI__ === "boolean" && __SYNC_UI__;

/** The rail's sync line (undefined: sync off here; null: not known yet); `on`: sync is on for this profile. */
export type SyncRail = { text: string; tone: "none" | "good" | "warn" | "bad"; on?: boolean } | null | undefined;

type SectionProps = {
  ctx: Ctx;
  onRail: (r: { text: string; tone: "none" | "good" | "warn" | "bad"; on?: boolean }) => void;
  joinOnly?: boolean;
  onLeave?: () => void;
  onJoined?: () => void;
  onHold?: () => void;
  wiped?: number;
};
let loading: Promise<ComponentType<SectionProps>> | null = null;

function load(): Promise<ComponentType<SectionProps>> | null {
  if (SYNC_UI)
    loading ??= import("./sync/index").then(async (m) => {
      await m.prepare();
      return m.SyncSection;
    });
  return loading;
}

/** Whether this profile has any of sync's records (one read of their keys; their values are not looked at). */
async function hasRecords(): Promise<boolean> {
  try {
    return Object.keys(await chrome.storage.local.get(Object.values(SYNC_KEYS))).length > 0;
  } catch {
    return false;
  }
}

export function SyncHost(p: {
  ctx: Ctx;
  onRail: (r: SyncRail) => void;
  joinOnly?: boolean;
  onLeave?: () => void;
  onJoined?: () => void;
  onHold?: () => void;
  /** Whether this leaf of the page is the one shown (App.tsx keeps the section mounted, hidden, when it is not). */
  shown?: boolean;
}) {
  // what was typed in the section's views does not wait there while another leaf is shown: counted, and handed down
  const [wiped, setWiped] = useState(0);
  useEffect(() => {
    if (p.shown === false) setWiped((n) => n + 1);
  }, [p.shown]);
  const [Section, setSection] = useState<ComponentType<SectionProps> | null>(null);
  const shell = useRef<HTMLElement>(null);
  const hadFocus = useRef(false);

  useEffect(() => {
    if (!SYNC_UI) return;
    let live = true;
    const go = () => {
      const l = load();
      if (l)
        void l.then(
          (c) => {
            // the section replaces the empty frame, heading and all: a focus the frame's heading had (the rail's Sync
            // link, App.tsx) goes to the new heading
            hadFocus.current = !!shell.current?.contains(document.activeElement);
            if (live) setSection(() => c);
          },
          () => undefined,
        );
    };
    if (p.joinOnly || location.hash.startsWith("#sync")) go();
    else
      void hasRecords().then((yes) => {
        if (yes) {
          p.onRail(null);
          go();
        }
      });
    const onHash = () => {
      if (location.hash.startsWith("#sync")) go();
    };
    addEventListener("hashchange", onHash);
    let io: IntersectionObserver | null = null;
    if (shell.current && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (es) => {
          if (es.some((e) => e.isIntersecting)) {
            io?.disconnect();
            go();
          }
        },
        { rootMargin: "400px 0px" },
      );
      io.observe(shell.current);
    }
    return () => {
      live = false;
      removeEventListener("hashchange", onHash);
      io?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (Section && hadFocus.current) document.querySelector<HTMLElement>("#sync h2")?.focus({ preventScroll: true });
  }, [Section]);

  if (!SYNC_UI) return null;
  if (Section)
    return (
      <Section
        ctx={p.ctx}
        onRail={p.onRail}
        {...(p.joinOnly ? { joinOnly: true } : {})}
        {...(p.onLeave ? { onLeave: p.onLeave } : {})}
        {...(p.onJoined ? { onJoined: p.onJoined } : {})}
        {...(p.onHold ? { onHold: p.onHold } : {})}
        wiped={wiped}
      />
    );
  return (
    <section id="sync" class="panel" ref={shell}>
      <header>
        <span class="pi">
          <Icon name="sync" size={20} />
        </span>
        <div>
          <h2 tabIndex={-1}>{t("syncLabel")}</h2>
        </div>
      </header>
      <div class="panel-body" aria-busy="true" />
    </section>
  );
}
