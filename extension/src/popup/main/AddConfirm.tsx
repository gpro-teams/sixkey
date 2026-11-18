// The popup's confirm page for "paste anything" and "scan this page" (PHASE0X-PLAN B3, ux-study §2.9). Main loads this
// module on first use, so it, the importer and the parsers stay out of the popup's counted bundle. Its imports are the
// importer, the dedupe rules, the site rules and what the settings page shares with the popup anyway (Preact, the
// vault edits, the art and the text); nothing that only the popup has, which would pull popup modules into a chunk of
// their own. Copying, saving, the current site and the way to the settings page come from Main as props.
//
// Nothing pasted is ever shown back: the page shows the name, the account and the code's settings, never the key, and
// a multi-column paste (which can hold passwords) is not read here at all.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { addOrReplace, keyBytes, verdictOf, verdicts, type Verdict } from "../../core/import/dedupe";
import { planImport, type ImportPlan } from "../../core/import/importer";
import { domainChoices, preferredChoice } from "../../core/site-domains";
import type { OtpParams } from "../../core/totp/otpauth";
import type { Clock } from "../../core/vault/hlc";
import { aliveEntries, type Entry, type Vault } from "../../core/vault/model";
import type { NewEntry } from "../../core/vault/ops";
import { Avatar } from "../../ui/art";
import { errorLine, logError } from "../../ui/errors";
import { Icon } from "../../ui/icons";
import { t } from "../../ui/i18n";
import type { AddInput } from "./add-input";
import "./confirm.css";

export type ConfirmProps = {
  /** Everything pasted or scanned since the page opened, oldest first. */
  inputs: AddInput[];
  /** The vault's live accounts. */
  entries: Entry[];
  /** The current page's host, when it could be registered for an account. */
  host: string | null;
  /** Whether "Show first on <host>" starts ticked for an account of this name (core/match.ts firmGuess). */
  tickSite: (issuer: string) => boolean;
  mutate: (fn: (vault: Vault, clock: Clock) => Vault) => Promise<void>;
  openSettings: (hash: string) => void;
  onBack: () => void;
  /** Saved: `added` accounts (0 when it was there already); `copyId` is the account whose code to copy now. */
  onDone: (r: { added: number; name: string; copyId: string | null }) => void;
};

type Read = { texts: string[]; images: number; found: number };
type Item = { c: OtpParams; v: Verdict; fromText: boolean };

// Why a line was skipped, as the settings page says it (src/options/AddAccounts.tsx).
const REASONS: Record<string, string> = {
  not_otpauth: "rNotOtpauth",
  malformed: "rMalformed",
  unsupported_type: "rType",
  missing_secret: "rNoSecret",
  invalid_secret: "rBadSecret",
  unsupported_algorithm: "rAlg",
  unsupported_digits: "rDigits",
  invalid_period: "rPeriod",
  missing_counter: "rCounter",
  migration_uri: "rMalformed",
  not_migration: "rMalformed",
  too_large: "rTooLarge",
  too_long: "rTooLarge",
  empty_secret: "rNoSecret",
  invalid_counter: "rCounter",
  invalid_text: "rMalformed",
  not_key: "rNotKey",
};
const reason = (r: string) => t(REASONS[r] ?? "rMalformed");
const nameOf = (e: { issuer: string; label: string }) => e.issuer || e.label;
const newEntry = (c: OtpParams, issuer: string, label: string, domains?: string[]): NewEntry => ({
  type: c.type,
  issuer,
  label,
  secret: c.secret,
  algorithm: c.algorithm,
  digits: c.digits,
  period: c.period,
  ...(c.counter !== undefined ? { counter: c.counter } : {}),
  ...(domains ? { domains } : {}),
});

async function readImages(images: Blob[]): Promise<Read> {
  const { decodeAllQrFromBlob } = await import("../../lib/qr");
  const texts: string[] = [];
  let found = 0;
  for (const img of images) {
    const got = await decodeAllQrFromBlob(img);
    if (got.length) found++;
    texts.push(...got);
  }
  return { texts, images: images.length, found };
}

export function AddConfirm(p: ConfirmProps) {
  const [reads, setReads] = useState<(Read | null)[]>([]);
  const started = useRef(0);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  // Each input is read once, in order; images are decoded in memory and never kept.
  useEffect(() => {
    const put = (i: number, r: Read | null) =>
      alive.current &&
      setReads((prev) => {
        const next = [...prev];
        next[i] = r;
        return next;
      });
    for (let i = started.current; i < p.inputs.length; i++) {
      const input = p.inputs[i]!;
      if ("text" in input) put(i, { texts: [input.text], images: 0, found: 0 });
      else {
        put(i, null);
        readImages(input.images).then(
          (r) => put(i, r),
          () => put(i, { texts: [], images: input.images.length, found: 0 }),
        );
      }
    }
    started.current = p.inputs.length;
  }, [p.inputs]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && p.onBack();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [p.onBack]);

  const reading = p.inputs.some((_, i) => !reads[i]);
  const text = reads
    .map((r) => r?.texts.join("\n") ?? "")
    .filter(Boolean)
    .join("\n");
  // Compared with the vault by key bytes below, not by planImport's text comparison: so no entries go in here.
  const plan = useMemo(() => planImport(text, [], []).plan, [text]);
  const items = useMemo(() => {
    const fromText = new Set(plan.fromText);
    const vs = verdicts(plan.add, p.entries);
    return plan.add.map((c, i) => ({ c, v: vs[i]!, fromText: fromText.has(i) })).filter((x) => x.v.k !== "repeat");
  }, [plan, p.entries]);
  const noQr = reads.reduce((n, r) => n + (r ? r.images - r.found : 0), 0);
  const choice = useMemo(() => (p.host ? (preferredChoice(domainChoices(p.host)) ?? null) : null), [p.host]);

  let body: preact.ComponentChildren;
  if (plan.table)
    body = <Columns p={p} />; // name|key|... lines: the columns are chosen in Settings, never guessed here
  else if (!items.length)
    body = reading ? <Reading /> : <Nothing plan={plan} noQr={noQr} single={p.inputs.length === 1} p={p} />;
  else if (items.length === 1 && !plan.incomplete.length)
    body = (
      <One
        key={keyBytes(items[0]!.c.secret) ?? ""}
        item={items[0]!}
        p={p}
        choice={choice}
        notes={<Notes plan={plan} noQr={noQr} reading={reading} />}
      />
    );
  else
    body = (
      <Many
        items={items}
        p={p}
        more={plan.incomplete.length > 0}
        notes={<Notes plan={plan} noQr={noQr} reading={reading} />}
      />
    );

  return (
    <>
      <div class="ph">
        <button class="tb back" onClick={p.onBack}>
          <Icon name="back" />
          {t("back")}
        </button>
        <span class="title">{t("paTitle")}</span>
        <span class="sp" />
      </div>
      {body}
    </>
  );
}

function Reading() {
  return (
    <div class="cf">
      <div class="cf-body">
        <p class="cf-line muted" role="status">
          <Icon name="image" size={15} />
          {t("paReading")}
        </p>
      </div>
    </div>
  );
}

/** What could not be used, next to what could: skipped lines, images without a code, a Google export still incomplete. */
function Notes({ plan, noQr, reading }: { plan: ImportPlan; noQr: number; reading: boolean }) {
  return (
    <>
      {reading && (
        <p class="cf-line muted" role="status">
          <Icon name="image" size={15} />
          {t("paReading")}
        </p>
      )}
      {noQr > 0 && (
        <p class="cf-line err">
          <Icon name="alert" size={15} />
          {t("paNoQr")}
        </p>
      )}
      {plan.failed.slice(0, 3).map((f, i) => (
        <p key={i} class="cf-line err">
          <Icon name="alert" size={15} />
          {t("previewFailed", f.index + 1, reason(f.reason))}
        </p>
      ))}
      {plan.incomplete.map((b) => (
        <p key={b.batchId} class="cf-line err">
          <Icon name="alert" size={15} />
          {t("previewIncomplete", b.received.length, b.batchSize, b.missing.map((m) => m + 1).join(", "))}
        </p>
      ))}
    </>
  );
}

function Nothing({ plan, noQr, single, p }: { plan: ImportPlan; noQr: number; single: boolean; p: ConfirmProps }) {
  // One thing pasted, with one reason: said in the box itself. Otherwise each reason on its own line below it.
  const only =
    !single || plan.incomplete.length
      ? null
      : !noQr && plan.failed.length === 1
        ? t("paBadOne", reason(plan.failed[0]!.reason))
        : noQr && !plan.failed.length
          ? t("paNoQr")
          : null;
  return (
    <div class="cf">
      <div class="cf-body">
        <div class="cf-alert bad" role="alert">
          <Icon name="alert" size={16} />
          <span>
            <b>{t("paNothing")}</b>
            {only && <span>{only}</span>}
          </span>
        </div>
        {!only && <Notes plan={plan} noQr={noQr} reading={false} />}
        {plan.incomplete.length > 0 && <More p={p} />}
      </div>
      <div class="cf-acts">
        <span class="sp" />
        <button class="btn sm" id="pa-back" onClick={p.onBack}>
          {t("back")}
        </button>
      </div>
    </div>
  );
}

function Columns({ p }: { p: ConfirmProps }) {
  return (
    <div class="cf">
      <div class="cf-body">
        <div class="cf-alert" role="status">
          <Icon name="info" size={16} />
          <span>{t("paColumns")}</span>
        </div>
      </div>
      <div class="cf-acts">
        <button class="btn sm quiet" onClick={p.onBack}>
          {t("cancel")}
        </button>
        <span class="sp" />
        <button class="btn sm" id="pa-settings" onClick={() => p.openSettings("#add-paste")}>
          {t("paSettings")}
          <Icon name="next" size={14} />
        </button>
      </div>
    </div>
  );
}

/** A Google export with QR codes still missing: the next screenshot can be pasted here, or the rest done in Settings. */
function More({ p }: { p: ConfirmProps }) {
  return (
    <div class="cf-more">
      <span>{t("paMore")}</span>
      <button class="btn sm ghost" id="pa-settings" onClick={() => p.openSettings("#add-paste")}>
        {t("paSettings")}
      </button>
    </div>
  );
}

/** One account: its name (which can be changed), what it is, how it relates to what is already saved, and Add. */
function One({
  item,
  p,
  choice,
  notes,
}: {
  item: Item;
  p: ConfirmProps;
  choice: string | null;
  notes: preact.ComponentChildren;
}) {
  const { c } = item;
  const [issuer, setIssuer] = useState(c.issuer);
  const [label, setLabel] = useState(c.label);
  // the same name with another key: replaced or kept beside it, as the user says; no answer until then (the owner's
  // report of 2026-11-18: ask, every time), and nothing is added before one
  const [replace, setReplace] = useState<boolean | null>(null);
  const [siteSet, setSiteSet] = useState<boolean | null>(null); // null: follows the name, until the box is clicked
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const goRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => (c.issuer || c.label ? goRef.current : nameRef.current)?.focus(), []);

  const v = verdictOf({ secret: c.secret, issuer, label }, p.entries);
  const hotp = c.type === "hotp";
  const site = !!choice && (siteSet ?? p.tickSite(issuer));
  const name = issuer.trim() || label.trim();

  async function add(andCopy: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    const id = crypto.randomUUID();
    const input = newEntry(c, issuer.trim(), label.trim(), site && choice ? [choice] : undefined);
    if (v.k === "rebind" && replace === null) return; // not answered yet (the buttons wait for it)
    const swap = v.k === "rebind" && replace ? v.entry.id : undefined; // only ever on the user's explicit choice
    let there: Entry | undefined;
    try {
      await p.mutate((vault, clock) => {
        // Checked again on the vault as it is now: a second click, or another page adding the same account meanwhile.
        const now = verdictOf(input, aliveEntries(vault));
        there = now.k === "exists" ? now.entry : undefined;
        return there ? vault : addOrReplace(vault, input, clock, { id, replace: swap });
      });
    } catch (e) {
      logError("popup-add", e);
      setError(errorLine(e));
      setBusy(false);
      return;
    }
    p.onDone({ added: there ? 0 : 1, name, copyId: andCopy ? (there?.id ?? id) : null });
  }

  const other = v.k === "exists" || v.k === "same_key" || v.k === "rebind" ? nameOf(v.entry) : "";
  const undecided = v.k === "rebind" && replace === null;
  return (
    <div class="cf">
      <div class="cf-body">
        <div class="cf-card">
          <Avatar name={name} size={40} />
          <span class="who">
            <b>{name || "—"}</b>
            <i>{hotp ? t("hotpShort") : t("otpSpec", c.digits, c.period, c.algorithm)}</i>
          </span>
        </div>
        <div class="pair">
          <div class="field">
            <label for="pa-issuer">{t("fieldIssuer")}</label>
            <input
              id="pa-issuer"
              ref={nameRef}
              value={issuer}
              maxLength={256}
              autocomplete="off"
              onInput={(e) => setIssuer((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="field">
            <label for="pa-label">{t("fieldLabel")}</label>
            <input
              id="pa-label"
              value={label}
              maxLength={256}
              autocomplete="off"
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
            />
          </div>
        </div>
        {v.k === "exists" && (
          <div class="cf-alert" role="status" id="pa-verdict">
            <Icon name="check" size={16} />
            <span>{t("paExists", other)}</span>
          </div>
        )}
        {v.k === "same_key" && (
          <div class="cf-alert warn" role="status" id="pa-verdict">
            <Icon name="copy" size={16} />
            <span>{t("paSameKey", other)}</span>
          </div>
        )}
        {v.k === "rebind" && (
          <div class="cf-alert warn" role="status" id="pa-verdict">
            <Icon name="restore" size={16} />
            <span>
              {t("paRebind", other)}
              <span class="cf-choice">
                <label>
                  <input
                    type="radio"
                    name="pa-rebind"
                    id="pa-keep"
                    checked={replace === false}
                    onChange={() => setReplace(false)}
                  />
                  {t("paKeepBoth")}
                </label>
                <label>
                  <input
                    type="radio"
                    name="pa-rebind"
                    id="pa-replace"
                    checked={replace === true}
                    onChange={() => setReplace(true)}
                  />
                  {t("paReplace")}
                </label>
              </span>
            </span>
          </div>
        )}
        {v.k !== "exists" && choice && (
          <label class="cf-check">
            <input
              type="checkbox"
              id="pa-site"
              checked={site}
              onChange={(e) => setSiteSet((e.target as HTMLInputElement).checked)}
            />
            <span>{t("paSite", choice)}</span>
          </label>
        )}
        {item.fromText && (
          <p class="cf-line muted">
            <Icon name="info" size={15} />
            {t("paFromText")}
          </p>
        )}
        {hotp && (
          <p class="cf-line muted">
            <Icon name="hash" size={15} />
            {t("hotpTitle")}
          </p>
        )}
        {notes}
        {v.k !== "exists" && !hotp && (
          <p class="cf-next">
            <Icon name="info" size={15} />
            {t("paNext")}
          </p>
        )}
        {error && (
          <p class="cf-line err" role="alert">
            <Icon name="alert" size={15} />
            {error}
          </p>
        )}
      </div>
      <div class="cf-acts">
        {v.k === "exists" ? (
          <>
            <button class="btn sm quiet" id="pa-back" onClick={p.onBack}>
              {t("back")}
            </button>
            <span class="sp" />
            {v.entry.type === "totp" && (
              <button
                class="btn sm"
                id="pa-copy"
                ref={goRef}
                onClick={() => p.onDone({ added: 0, name: other, copyId: v.entry.id })}
              >
                <Icon name="copy" size={14} />
                {t("copy")}
              </button>
            )}
          </>
        ) : (
          <>
            {!hotp && (
              <button class="btn sm ghost" id="pa-add" disabled={busy || undecided} onClick={() => void add(false)}>
                {t("paAddOnly")}
              </button>
            )}
            <span class="sp" />
            {hotp ? (
              <button
                class="btn sm"
                id="pa-add"
                ref={goRef}
                disabled={busy || undecided}
                onClick={() => void add(false)}
              >
                <Icon name="plus" size={14} />
                {t("add")}
              </button>
            ) : (
              <button
                class="btn sm"
                id="pa-add-copy"
                ref={goRef}
                disabled={busy || undecided}
                onClick={() => void add(true)}
              >
                <Icon name="copy" size={14} />
                {t("paAddCopy")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Several accounts (a Google export, or more than one QR code on the page): pick which to add. No code is copied. */
function Many({
  items,
  p,
  more,
  notes,
}: {
  items: Item[];
  p: ConfirmProps;
  more: boolean;
  notes: preact.ComponentChildren;
}) {
  // Ticked by default only when new; the user's own ticks win. Keyed by key and name, so later pastes keep them.
  const [ticks, setTicks] = useState<Map<string, boolean>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keyOf = (x: Item) => `${keyBytes(x.c.secret)}\u0000${x.c.issuer}\u0000${x.c.label}`;
  const ticked = (x: Item) => x.v.k !== "exists" && (ticks.get(keyOf(x)) ?? x.v.k === "new");
  const chosen = items.filter(ticked);
  // a ticked account whose name is saved with another key: replaced or kept beside it, as the user says, row by row
  const [modes, setModes] = useState<Map<string, "keep" | "replace">>(() => new Map());
  const undecided = chosen.some((x) => x.v.k === "rebind" && !modes.has(keyOf(x)));

  async function add() {
    if (busy || !chosen.length || undecided) return;
    setBusy(true);
    setError("");
    let added = 0;
    try {
      await p.mutate((vault, clock) => {
        let v = vault;
        added = 0;
        for (const x of chosen) {
          const now = verdictOf(x.c, aliveEntries(v));
          if (now.k === "exists") continue; // saved meanwhile
          const swap = now.k === "rebind" && modes.get(keyOf(x)) === "replace" ? now.entry.id : undefined;
          v = addOrReplace(v, newEntry(x.c, x.c.issuer, x.c.label), clock, { id: crypto.randomUUID(), replace: swap });
          added++;
        }
        return v;
      });
    } catch (e) {
      logError("popup-add", e);
      setError(errorLine(e));
      setBusy(false);
      return;
    }
    p.onDone({ added, name: "", copyId: null });
  }

  const tag = (x: Item) => {
    if (x.v.k === "exists") return t("paTagExists");
    if (x.v.k === "same_key") return t("paTagSame", nameOf(x.v.entry));
    if (x.v.k === "rebind") return t("paTagRebind", nameOf(x.v.entry));
    return "";
  };
  return (
    <div class="cf">
      <div class="cf-body">
        <p class="cf-count">{t("previewAdd", chosen.length)}</p>
        <ul class="cf-list" id="pa-list">
          {items.map((x) => {
            const k = keyOf(x);
            return (
              <li key={k}>
                <label class={x.v.k === "exists" ? "off" : ""}>
                  <input
                    type="checkbox"
                    checked={ticked(x)}
                    disabled={x.v.k === "exists"}
                    onChange={(e) => setTicks(new Map(ticks).set(k, (e.target as HTMLInputElement).checked))}
                  />
                  <Avatar name={nameOf(x.c)} size={26} />
                  <span class="who">
                    <b>{nameOf(x.c) || "—"}</b>
                    <i>{x.c.issuer && x.c.label ? x.c.label : ""}</i>
                  </span>
                  {tag(x) && <em>{tag(x)}</em>}
                </label>
                {x.v.k === "rebind" && ticked(x) && (
                  <span class="cf-choice cf-row-choice">
                    {(["replace", "keep"] as const).map((m) => (
                      <label key={m}>
                        <input
                          type="radio"
                          name={`pa-m-${k}`}
                          class={`pa-m-${m}`}
                          checked={modes.get(k) === m}
                          onChange={() => setModes(new Map(modes).set(k, m))}
                        />
                        {t(m === "replace" ? "paReplace" : "paKeepBoth")}
                      </label>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {undecided && (
          <p class="cf-line warn" id="pa-choose">
            <Icon name="alert" size={15} />
            {t("paChoose")}
          </p>
        )}
        {notes}
        {more && <More p={p} />}
        {items.some((x) => x.c.type === "hotp") && (
          <p class="cf-line muted">
            <Icon name="hash" size={15} />
            {t("hotpTitle")}
          </p>
        )}
        {error && (
          <p class="cf-line err" role="alert">
            <Icon name="alert" size={15} />
            {error}
          </p>
        )}
      </div>
      <div class="cf-acts">
        <button class="btn sm quiet" onClick={p.onBack}>
          {t("cancel")}
        </button>
        <span class="sp" />
        <button class="btn sm" id="pa-add" disabled={busy || !chosen.length || undecided} onClick={() => void add()}>
          <Icon name="plus" size={14} />
          {t("addN", chosen.length)}
        </button>
      </div>
    </div>
  );
}
