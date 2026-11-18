import { useRef, useState } from "preact/hooks";
import type { Entry } from "../../core/vault/model";
import { Avatar, EmptyArt, Ring } from "../../ui/art";
import { Icon } from "../../ui/icons";
import { t } from "../../ui/i18n";
import { canGenerate, remaining } from "../../ui/otp";
import { nameKey, type Row, type Section } from "./model";

/** How long a press must last to count as "hold to show" rather than a click that copies. */
const HOLD_MS = 450;

/**
 * The account list: sections, rows, and drag-to-reorder. Selection, copying, revealing and editing belong to Main.
 *
 * Each section is a list and each row a list item holding two separate buttons, copy and edit, so nothing interactive
 * is nested inside anything else interactive; a row under "Possibly related" has a third, "Remember", beside them, and
 * so does every row while the user chooses the page's account (`ask`, `picking`: AFMATCH-NOTES.md).
 * Only the selected row's buttons are in the tab order (roving tabindex); the arrow keys (in Main) move the selection
 * and the focus together. Only the "site" section, the accounts registered for this page, says "This site".
 */
export function List(p: {
  sections: Section[];
  /** Whether the vault has any account at all (an empty list then means "no matches", not "nothing yet"). */
  hasEntries: boolean;
  selectedId: string | null;
  codes: Map<string, string>;
  now: number;
  flash: string | null;
  canDrag: boolean;
  /** One-line rows, except for the current site's accounts, which keep the full size. */
  compact: boolean;
  /** Keep codes out of the page; only `shownId`'s code is shown, while it is revealed. */
  hide: boolean;
  shownId: string | null;
  /** The accounts that share their name with another, with their number among them (model.ts sameNames). */
  dups: Map<string, number>;
  /**
   * Another period's code (the owner's request of 2026-11-18): the account shown `n` periods before (< 0) or after the
   * current one, and its code once worked out; the selected row offers the arrows, and the offset resets it.
   */
  shift: { id: string; n: number; code?: string } | null;
  onShift: (id: string, by: -1 | 1 | 0) => void;
  onHover: (id: string) => void;
  onCopy: (e: Entry) => Promise<void>;
  onEdit: (id: string) => void;
  onMove: (fromId: string | null, toId: string) => Promise<void>;
  /** Show this row's code for a while (press and hold, when codes are hidden). */
  onReveal: (id: string) => void;
  /**
   * The current page's host, when it could be registered: rows in the "related" section (every row, while `picking`)
   * then offer to remember it.
   */
  rememberHost: string | null;
  onRemember: (id: string) => void;
  /**
   * The page no account is registered for (model.ts askHost), or null: one line above the sections asks which account
   * it is, and its button starts (and ends) `picking`, in which every row offers to remember it, as related rows do.
   */
  ask: string | null;
  picking: boolean;
  onPick: () => void;
  /** The empty vault's two ways to add a first account (PHASE0X-PLAN B3): the paste zone, and scanning this page. */
  onPaste: () => void;
  onScan: () => void;
  /** Extra content under a card of the "This site" section: the Fill button (Fill.tsx, loaded on first use). */
  rowExtra?: ((e: Entry, i: number) => preact.ComponentChildren) | null;
  /** How this computer spells the paste shortcut, for the empty list's text. */
  pasteKey: string;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  // A press held long enough to reveal must not also copy when it is released.
  const hold = useRef<{ id: string; timer: number; fired: boolean } | null>(null);
  const empty = p.sections.every((s) => s.rows.length === 0);
  let n = 0; // row index across sections, for the staggered entrance

  const endHold = () => {
    if (hold.current && !hold.current.fired) clearTimeout(hold.current.timer);
    hold.current = null;
  };
  const startHold = (id: string) => {
    endHold();
    if (!p.hide) return;
    const h = { id, fired: false, timer: 0 };
    h.timer = window.setTimeout(() => {
      h.fired = true;
      p.onReveal(id);
    }, HOLD_MS);
    hold.current = h;
  };

  return (
    <div class={`list${p.compact ? " compact" : ""}`} id="list">
      {p.ask && (
        <div class="glabel ask">
          <b id="ask-q">{t("siteAsk", p.ask)}</b>
          <button type="button" class="btn sm quiet" id="ask-pick" aria-describedby="ask-q" onClick={p.onPick}>
            {p.picking ? t("cancel") : t("sitePick")}
          </button>
        </div>
      )}
      {empty &&
        (!p.hasEntries ? (
          <div class="empty">
            <EmptyArt />
            <b>{t("emptyTitle")}</b>
            <span>{t("emptyList", p.pasteKey)}</span>
            <div class="empty-acts">
              <button type="button" class="btn sm ghost" id="empty-paste" onClick={p.onPaste}>
                <Icon name="clipboard" size={15} />
                {t("paPaste")}
              </button>
              <button type="button" class="btn sm" id="empty-scan" onClick={p.onScan}>
                <Icon name="scan" size={15} />
                {t("paScan")}
              </button>
            </div>
          </div>
        ) : (
          <div class="empty slim">
            <Icon name="search" size={22} />
            <b>{t("noMatches")}</b>
          </div>
        ))}
      {p.sections.map((s) => (
        <div
          key={s.key}
          class={`sect${s.key === "site" ? " site" : s.key === "related" ? " related" : ""}`}
          role={s.rows.length ? "list" : undefined}
          aria-label={
            s.rows.length ? (s.key === "site" ? `${s.label}, ${t("thisSite")}` : s.label || t("ungrouped")) : undefined
          }
        >
          {s.label && s.rows.length > 0 && (
            <div class="glabel" aria-hidden="true">
              {s.key === "site" ? (
                <>
                  <Icon name="globe" size={13} />
                  <b>{s.label}</b>
                  <em>{t("thisSite")}</em>
                </>
              ) : (
                <b>{s.label}</b>
              )}
              <span class="n">{s.rows.length}</span>
            </div>
          )}
          {(() => {
            // one row (its body as it was): `ri` is its place in the section, which the site's extras go by
            const rowOf = (r: Row, ri: number) => {
              const e = r.entry;
              const name = e.issuer || e.label;
              const gen = canGenerate(e);
              const rem = gen ? remaining(e, p.now) : 0;
              const isSel = p.selectedId === e.id;
              const hidden = p.hide && p.shownId !== e.id;
              const small = p.compact && s.key !== "site";
              return (
                <div
                  key={e.id}
                  data-id={e.id}
                  role="listitem"
                  style={`--n:${Math.min(n++, 12)}`}
                  class={`row${r.tier === "registered" ? " match" : ""}${isSel ? " sel" : ""}${rem <= 5 && gen ? " low" : ""}${p.flash === e.id ? " flash" : ""}${dropId === e.id && dragId !== e.id ? " drop" : ""}${dragId === e.id ? " dragging" : ""}`}
                  draggable={p.canDrag}
                  onDragStart={() => {
                    endHold();
                    setDragId(e.id);
                  }}
                  onDragOver={(ev) => {
                    if (dragId) {
                      ev.preventDefault();
                      setDropId(e.id);
                    }
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropId(null);
                  }}
                  onDrop={(ev) => {
                    ev.preventDefault();
                    setDropId(null);
                    void p.onMove(dragId, e.id);
                    setDragId(null);
                  }}
                  onMouseMove={() => !isSel && p.onHover(e.id)}
                >
                  <button
                    type="button"
                    class="copy"
                    tabIndex={isSel ? 0 : -1}
                    aria-disabled={gen ? undefined : "true"}
                    title={gen && p.hide ? t("listRevealHint") : undefined}
                    onPointerDown={(ev) => ev.button === 0 && startHold(e.id)}
                    onPointerUp={() => {
                      if (!hold.current?.fired) endHold();
                    }}
                    onPointerLeave={endHold}
                    onPointerCancel={endHold}
                    onClick={() => {
                      const held = hold.current?.fired && hold.current.id === e.id;
                      endHold();
                      if (!held) void p.onCopy(e);
                    }}
                  >
                    <Avatar name={name} size={small ? 22 : 30} />
                    <span class="who">
                      <b>{name}</b>
                      <i>
                        {e.issuer ? e.label : ""}
                        {e.note && <span class="memo">{e.note}</span>}
                        {p.dups.has(e.id) && <em class="dup">{t("sameName", p.dups.get(e.id)!)}</em>}
                      </i>
                      {r.note && <i>{r.note}</i>}
                    </span>
                    {gen ? (
                      <span class="otp">
                        {(() => {
                          // the arrows: on the selected row, or the one shown at another period; inside the copy button
                          // as spans, so a click on them never copies (the keyboard copies, the arrows are the mouse's)
                          const sh = p.shift?.id === e.id ? p.shift : null;
                          if (hidden || e.type !== "totp" || !(isSel || sh)) return null;
                          const go = (by: -1 | 1 | 0) => (ev: Event) => {
                            ev.stopPropagation();
                            ev.preventDefault();
                            p.onShift(e.id, by);
                          };
                          const stop = (ev: Event) => ev.stopPropagation();
                          return (
                            <span class={`shift${sh ? " on" : ""}`} onPointerDown={stop}>
                              <span
                                role="button"
                                class="sb"
                                title={t("shiftBack")}
                                aria-label={t("shiftBack")}
                                onClick={go(-1)}
                              >
                                <Icon name="back" size={13} />
                              </span>
                              {sh && (
                                <span role="button" class="sb n" title={t("shiftReset")} onClick={go(0)}>
                                  {t("shiftBy", `${sh.n < 0 ? "−" : "+"}${Math.abs(sh.n) * e.period}`)}
                                </span>
                              )}
                              <span
                                role="button"
                                class="sb"
                                title={t("shiftNext")}
                                aria-label={t("shiftNext")}
                                onClick={go(1)}
                              >
                                <Icon name="next" size={13} />
                              </span>
                            </span>
                          );
                        })()}
                        {hidden ? (
                          <Mask digits={e.digits} />
                        ) : (
                          <Code code={p.shift?.id === e.id ? p.shift.code : p.codes.get(e.id)} />
                        )}
                        <Ring rem={rem} period={e.period} />
                        <span class="vh">
                          {hidden ? `${t("listCodeHidden")}, ` : ""}
                          {t("listSecondsLeft", Math.ceil(rem))}
                        </span>
                      </span>
                    ) : (
                      <span class="otp hotp" title={t("hotpTitle")}>
                        {e.type === "hotp" ? (
                          <>
                            <Icon name="hash" size={13} />
                            {t("hotpShort")}
                          </>
                        ) : (
                          ""
                        )}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    class="more"
                    tabIndex={isSel ? 0 : -1}
                    aria-label={`${t("edit")} ${name}`}
                    title={t("edit")}
                    onClick={() => p.onEdit(e.id)}
                  >
                    <Icon name="more" />
                  </button>
                  {s.key === "site" && p.rowExtra?.(e, ri)}
                  {(s.key === "related" || p.picking) && p.rememberHost && (
                    <button
                      type="button"
                      class="remember"
                      tabIndex={isSel ? 0 : -1}
                      aria-label={`${t("siteRemember", p.rememberHost)} (${name})`}
                      onClick={() => p.onRemember(e.id)}
                    >
                      <Icon name="plus" size={12} />
                      <span>{t("siteRemember", p.rememberHost)}</span>
                    </button>
                  )}
                </div>
              );
            };
            // the accounts of one name, side by side (Main: model.ts sameTogether), drawn in one frame
            const out: preact.JSX.Element[] = [];
            for (let i = 0; i < s.rows.length;) {
              const k = p.dups.has(s.rows[i]!.entry.id) ? nameKey(s.rows[i]!.entry) : null;
              let j = i + 1;
              while (k !== null && j < s.rows.length && nameKey(s.rows[j]!.entry) === k) j++;
              if (j - i > 1)
                out.push(
                  <div key={`same-${s.rows[i]!.entry.id}`} class="dupset" role="none">
                    <span class="dupcap" aria-hidden="true">
                      {t("sameNameSet", j - i)}
                    </span>
                    {s.rows.slice(i, j).map((r, x) => rowOf(r, i + x))}
                  </div>,
                );
              else out.push(rowOf(s.rows[i]!, i));
              i = j;
            }
            return out;
          })()}
        </div>
      ))}
    </div>
  );
}

/** The code, one span per digit, keyed by the code so a new period rolls the digits in. Text content stays "123 456". */
export function Code({ code }: { code: string | undefined }) {
  if (!code) return <span class="code wait">••• •••</span>;
  const half = code.length / 2;
  const out: preact.JSX.Element[] = [];
  [...code].forEach((c, i) => {
    if (i === half)
      out.push(
        <span key="gap" class="gap">
          {" "}
        </span>,
      );
    out.push(
      <span key={`${code}:${i}`} class="dg" style={`--i:${i}`}>
        {c}
      </span>,
    );
  });
  return <span class="code">{out}</span>;
}

/** A hidden code: one dot per digit, drawn by CSS, with no text at all, so nothing in the page holds the code. */
function Mask({ digits }: { digits: number }) {
  const half = digits / 2;
  const out: preact.JSX.Element[] = [];
  for (let i = 0; i < digits; i++) {
    if (i === half) out.push(<span key="gap" class="gap" />);
    out.push(<i key={i} />);
  }
  return (
    <span class="code hid" aria-hidden="true">
      {out}
    </span>
  );
}
