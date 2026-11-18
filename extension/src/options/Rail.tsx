import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ServiceStatus } from "../core/service/service";
import { aliveEntries, type Vault } from "../core/vault/model";
import { backupRuns, type CsbConfig, type CsbState } from "../platform/csb-config";
import { ago } from "../ui/ago";
import { Mark } from "../ui/art";
import { branded, isChrome } from "../ui/csb-brand";
import { getChoice, getLang, setLangChoice, t, type LangChoice } from "../ui/i18n";
import { cardView, type CardView } from "./csb/model";
import { Icon, type IconName } from "./icons";
import { GROUPS } from "./route";

/** [group id, title key, icon]. App owns the list; the rail links to each group (route.ts) and marks the one shown. */
export type RailSection = readonly [string, string, IconName];

const DAY = 86_400_000;
/** How often the backup in Chrome sync's line is drawn again while that backup is on ("3 分钟前"), as its card is. */
const TICK_MS = 30_000;

type Tone = "none" | "good" | "warn" | "bad";
/** The backup in Chrome sync's two records (platform/csb-config.ts), as App read them; null until read. */
export type RailCsb = { cfg: CsbConfig; st: CsbState } | null;

function daysAgo(at: number | null): string {
  if (at === null) return t("backupNever");
  const d = Math.floor((Date.now() - at) / DAY);
  return d <= 0 ? t("backupToday") : t("backupDaysAgo", d);
}

/**
 * The rail's line for the backup in Chrome sync: the state of Settings › Backup's card (csb/model.ts cardView) in a few
 * of its words. Off; on with no account to hand over yet; a copy due (the
 * card's "正在交给…"); changes waiting; handed over, with when (the act, never "backed up": Sixkey cannot see what
 * Chrome uploads); a passing failure, retried (amber); and what only the person can fix, or changes waiting for three
 * days, or this browser's refusal to close the area to web pages (the popup's "备份已停", amber too, as the card and the
 * pill are).
 */
function csbLine(v: CardView, now: number): { text: string; tone: Tone } {
  switch (v.kind) {
    case "off":
      return { text: t("railCsbOff"), tone: "none" };
    case "empty":
      return { text: t("railCsbOn"), tone: "none" };
    case "saving":
      return { text: t("railCsbSaving"), tone: "none" };
    case "waiting":
      return { text: t("railCsbSoon"), tone: "none" };
    case "ok":
      return { text: t("railCsbOk", ago(v.at, now, getLang())), tone: "good" };
    case "failed":
      return { text: t("railCsbFailed"), tone: "warn" };
    default: // stale, stopped, unsafe
      return { text: t("railCsbStopped"), tone: "warn" };
  }
}

/**
 * A line's parts between its " · ", each kept whole: where the line is longer than the room beside its label, it goes
 * on after a " ·", never inside a part ("Handed over ·" over "3 minutes ago").
 */
function apart(line: string) {
  const parts = line.split(" · ");
  return parts.map((part, i) => (
    <Fragment key={i}>
      {i > 0 && " "}
      <span>{i < parts.length - 1 ? `${part} ·` : part}</span>
    </Fragment>
  ));
}

/** The side rail: logo, the protection card, the section menu, and the language menu. */
/** `current`: the group shown (App's). Its link is "true" when the group has leaves of its own, "page" when it is one page. */
/** `langLocked`: the first-run wizard holds keys whose code is on screen; switching language reloads the page and drops them. */
export function Rail({
  sections,
  current,
  status,
  vault,
  lastBackup,
  csb = null,
  langLocked = false,
}: {
  sections: readonly RailSection[];
  current: string;
  status: ServiceStatus;
  vault: Vault | null;
  lastBackup: number | null;
  /**
   * The backup in Chrome sync's records. While that backup runs (on and not stopped: csb-config.ts backupRuns, as
   * the popup's footer reads it), the last backup's line is no reminder: no date, or an old one, is drawn neutral, not
   * amber or red. Its date is still sk_last_backup's: a file saved (service.markBackedUp) or a copy the worker handed
   * to Chrome sync (platform/csb-worker.ts), which a vault unchanged for a week does not get again.
   */
  csb?: RailCsb;
  langLocked?: boolean;
}) {
  // the backup in Chrome sync's line says how long ago, and its state can turn with the time alone (stale after three
  // days): drawn again now and then while that backup is on
  const [, tick] = useState(0);
  const ticking = csb?.cfg.on === true;
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [ticking]);
  const now = Date.now();
  const count = vault ? aliveEntries(vault).length : null; // as the popup counts them: the trash has its own number
  // Protection level: 0 nothing yet, 1 a key stored next to the data, 3 a master password (locked or not).
  const [level, protKey, protIcon]: [number, string, IconName] =
    status.state === "unlocked"
      ? status.passwordProtected
        ? [3, "passwordLabel", "shieldCheck"]
        : [1, "protDevice", "shieldAlert"]
      : status.state === "locked"
        ? [3, "protLocked", "lock"]
        : [0, "protNone", "shield"];
  const tone = level === 3 ? "good" : level === 1 ? "warn" : "none";
  const age = lastBackup === null ? null : Math.max(0, (now - lastBackup) / DAY);
  const runs = csb !== null && backupRuns(csb.cfg, csb.st, now);
  const fresh = !count ? "none" : age !== null && age <= 7 ? "good" : runs ? "none" : age === null ? "bad" : "warn";
  const backup = csb !== null ? csbLine(cardView(csb.cfg, csb.st, now), now) : null;

  return (
    <aside class="rail">
      <div class="logo">
        <Mark size={34} />
        <span>
          <b>Sixkey</b>
          <small>{t("localOnly")} · v0.1</small>
        </span>
      </div>
      <section class={`status ${tone}`} aria-label={t("protectionLabel")}>
        <div class="st-top">
          <span class="st-ic">
            <Icon name={protIcon} size={20} />
          </span>
          <span class="st-tx">
            <small>{t("protectionLabel")}</small>
            <b>{t(protKey)}</b>
          </span>
        </div>
        {level === 1 && (
          <a class="st-fix" id="rail-set-password" href="#security">
            {t("frRailLink")}
          </a>
        )}
        <div class={`lvl l${level}`} aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <dl>
          <div>
            <dt>
              <Icon name="key" size={14} />
              {t("accountsLabel")}
            </dt>
            <dd class="num">{count ?? "—"}</dd>
          </div>
          <div class={`fresh ${fresh}`}>
            <dt>
              <Icon name="archive" size={14} />
              {t("backupLabel")}
            </dt>
            <dd>{daysAgo(lastBackup)}</dd>
            <span class="bar" aria-hidden="true">
              <i style={`--p:${age === null ? 0 : Math.max(0.06, 1 - age / 30)}`} />
            </span>
          </div>
          <div class={`csb ${backup?.tone ?? "none"}`}>
            <dt>
              <Icon name="sync" size={14} />
              {branded(t("railCsb"), isChrome(), t("railCsbBrowser"))}
            </dt>
            <dd id="rail-csb">{backup ? apart(backup.text) : "…"}</dd>
          </div>
        </dl>
      </section>
      <nav aria-label={t("navMenu")}>
        {sections.map(([id, key, icon]) => (
          <a
            key={id}
            href={`#${id}`}
            class={current === id ? "on" : ""}
            aria-current={
              current === id ? ((GROUPS.find((g) => g.id === id)?.leaves.length ?? 1) > 1 ? "true" : "page") : undefined
            }
          >
            <Icon name={icon} size={16} />
            <span>{t(key)}</span>
          </a>
        ))}
      </nav>
      <div class="lang">
        <label for="lang-select">{t("languageLabel")}</label>
        <select
          id="lang-select"
          value={getChoice()}
          disabled={langLocked}
          onChange={(e) => {
            setLangChoice((e.target as HTMLSelectElement).value as LangChoice);
            location.reload();
          }}
        >
          <option value="auto">{t("langAuto")}</option>
          <option value="en">English</option>
          <option value="zh_CN">简体中文</option>
        </select>
      </div>
    </aside>
  );
}

/**
 * The leaves of the group shown, as a row of links under the page's title: plain anchors (the hash is the choice), the
 * shown one marked `aria-current="page"`. It wraps in a narrow window and never scrolls sideways. The Trash's number is
 * its count of accounts.
 */
export function SubNav({
  label,
  leaves,
  current,
  trashCount,
}: {
  label: string;
  leaves: readonly (readonly [id: string, titleKey: string])[];
  current: string;
  trashCount: number;
}) {
  return (
    <nav class="subnav" aria-label={label}>
      {leaves.map(([id, key]) => (
        <a
          key={id}
          href={`#${id}`}
          class={current === id ? "on" : ""}
          aria-current={current === id ? "page" : undefined}
        >
          <span>{t(key)}</span>
          {id === "trash" && trashCount > 0 && <em>{trashCount}</em>}
        </a>
      ))}
    </nav>
  );
}
