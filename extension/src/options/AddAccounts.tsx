import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { offerDelete, planSettings } from "../core/import/file-plan";
import { applyImport, type ImportOptions, type ImportPlan, type LineColumn } from "../core/import/importer";
import { parseOtpauth, serializeOtpauth } from "../core/totp/otpauth";
import { aliveEntries } from "../core/vault/model";
import { decodeQrFromBlob } from "../lib/qr";
import {
  deletePicked,
  droppedFiles,
  hasPicker,
  pickFiles,
  type DeleteOutcome,
  type FileHandleLike,
  type Picked,
  type Seen,
} from "../platform/file-access";
import { Avatar } from "../ui/art";
import { t } from "../ui/i18n";
import { Icon } from "./icons";
import { AddCamera } from "./AddCamera";
import { setAsks, useAsks, type Ask } from "./import-asks";
import { dropHandoffs, takeHandoffs } from "./import-handoff";
import { readPicked, readScanned, type Source } from "./import-read";
import { BoxTitle, errText, Panel, type Ctx } from "./shared";
import "./lines.css";
import "./import.css";

/** Why a line, an entry or a code was not taken, in words (the importer's reasons and the file reader's). */
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

const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types ?? []).includes("Files");

/**
 * Whether Add deletes a file itself: a file of otpauth links only (file-formats.ts "links"), not an image, every entry of
 * which is added. Any other format may hold what Sixkey never reads (a password column, a password manager's logins).
 */
const deletesItself = (o: { source: Source; left: number }): boolean =>
  o.left === 0 && !o.source.image && o.source.out.kind === "accounts" && o.source.out.format === "links";

export function AddAccounts({ rt, vault, status, reload }: Ctx) {
  const [text, setText] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  // codes read by the camera: a row of their own, like a file's, never written into the paste box
  const [scanned, setScanned] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState<ImportOptions>({}); // which columns of name|key lines to read; {} = found automatically
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seedRef = useRef("");
  seedRef.current = [text, ...scanned].join("\n");
  const nextId = useRef(1);
  // bumped whenever what was read is dropped (Cancel, a lock, the accounts added): a file still being read is then left out
  const epoch = useRef(0);
  const unlocked = status.state === "unlocked" && vault !== null;
  // Files and the camera are taken while Sixkey is unlocked (the vault itself may still be on its way: Add waits for it)
  const open = status.state === "unlocked";
  const openRef = useRef(open);
  openRef.current = open;

  /** Drops everything read so far, secrets included: the paste box, the files' accounts, the column choice. */
  const clearInput = () => {
    epoch.current++;
    setText("");
    setSources([]);
    setScanned([]);
    setColumns({});
    setNotes([]);
    setReading(false);
  };

  // A locked page holds no secrets of an import: what was pasted, read or scanned is dropped (the camera stops too, in
  // AddCamera). The delete prompts stay: they hold file handles, no secrets.
  useEffect(() => {
    if (!open) clearInput();
  }, [open]);

  // A code read from the page behind the popup arrives through memory-only session storage.
  useEffect(() => {
    if (location.hash !== "#add-scanned") return;
    void chrome.storage.session.get("sk_scan_text").then(async (r) => {
      const v = r.sk_scan_text;
      await chrome.storage.session.remove("sk_scan_text");
      if (typeof v === "string") setText((cur) => (cur ? cur + "\n" : "") + v);
    });
  }, []);

  async function load(files: Picked[]) {
    if (!openRef.current || !files.length) return;
    const at = epoch.current;
    setDone(null);
    setError(null);
    setReading(true);
    for (const p of files) {
      const s = await readPicked(p, nextId.current++);
      if (at !== epoch.current || !openRef.current) return; // dropped (Cancel, a lock) while it was read
      // the same file chosen again replaces its first reading
      setSources((cur) => [
        ...cur.filter(
          (c) => !(c.name === s.name && c.seen.size === s.seen.size && c.seen.lastModified === s.seen.lastModified),
        ),
        s,
      ]);
    }
    setReading(false);
  }

  // Files chosen under Backup that are other apps' exports come here (import-handoff.ts), while Sixkey is unlocked.
  useEffect(() => {
    if (!open) return dropHandoffs();
    return takeHandoffs((files) => void load(files));
  }, [open]);

  /**
   * "Choose file": the browser's picker where it gives handles (so the file can be deleted later), else the input.
   * A picker that fails (not allowed on this page, say) is not tried again: the next click opens the input at once,
   * while the click still counts as the user's (the input opened after a failed picker may be refused for want of it).
   */
  const pickerFailed = useRef(false);
  async function choose() {
    if (!hasPicker() || pickerFailed.current) return fileRef.current?.click();
    const picked = await pickFiles();
    if (picked !== null) return void load(picked);
    pickerFailed.current = true;
    fileRef.current?.click();
  }

  const existing = vault?.entries ?? [];
  // The camera's codes are read as a QR image's are (import-read.ts readScanned: the one check every link goes through:
  // Steam, `&amp;`, a word run into the key): only what it takes joins the import, and its row says what it refused.
  const camRead = useMemo(() => readScanned(scanned), [scanned]);
  const camLines = useMemo(() => (camRead.kind === "accounts" ? camRead.lines : []), [camRead]);
  const lines = useMemo(() => [...camLines, ...sources.flatMap((s) => s.lines)], [camLines, sources]);
  // Every scanned or pasted code stays in the box as a line, so a multi-code Google export is reassembled from the text
  // itself; the files' accounts follow the box's lines, in the order the files were chosen.
  const plan = useMemo(() => planSettings(text, lines, existing, columns), [text, lines, existing, columns]);
  const hasInput = text.trim().length > 0 || lines.length > 0;
  // the files Add will delete (add() above): every entry of theirs is added, and the browser gave their handle
  const autoDelete = useMemo(
    () =>
      offerDelete(sources, plan.add, columns)
        .filter((o) => deletesItself(o) && o.source.handle?.requestPermission)
        .map((o) => o.source.name),
    [sources, plan, columns],
  );

  async function readImages(files: File[]) {
    setError(null);
    const found: string[] = [];
    const missed: string[] = [];
    for (const f of files) {
      const decoded = await decodeQrFromBlob(f);
      if (decoded) found.push(decoded);
      else missed.push(f.name);
    }
    if (found.length) setText((cur) => (cur.trim() ? cur.trimEnd() + "\n" : "") + found.join("\n"));
    setNotes(missed.length ? [t("noQrIn", missed.join(", "))] : []);
  }

  async function add() {
    if (!vault) return;
    const adding = plan.add;
    const from = sources;
    const cols = columns;
    // A file of links only, every one of which is added now, is deleted once they are written (the owner's report of
    // 2026-11-18: the file of keys was left behind). Chrome lets Sixkey change a file only after its own prompt, in a
    // click: asked here, first thing, for those files only. Any other file keeps its question (Keep, then Delete): one
    // with entries not added, and every other format, whose other columns or fields (a password) Sixkey never read.
    const offer = offerDelete(from, adding, cols);
    const asked = new Map<Source["id"], Promise<string>>();
    for (const o of offer) {
      const h = o.source.handle;
      if (!deletesItself(o) || !h?.requestPermission) continue;
      asked.set(
        o.source.id,
        h.requestPermission({ mode: "readwrite" }).catch(() => "denied"),
      );
    }
    setBusy(true);
    setError(null);
    try {
      await rt.service.mutate((v, clock) => applyImport(v, adding, clock));
      setDone(t("addedN", adding.length));
      // Only a file that brought in at least one of the accounts just added is offered for deletion, saying what
      // deleting it would lose (its entries not imported) and which of its accounts cannot make codes yet (HOTP).
      setAsks((cur) => [
        ...cur.filter((a) => a.state === "ask" || a.state === "busy"),
        ...offer.map(({ source: s, left, hotp }) => ({
          id: s.id,
          name: s.name,
          handle: s.handle,
          seen: s.seen,
          left,
          hotp,
          state: asked.has(s.id) ? ("busy" as const) : ("ask" as const),
        })),
      ]);
      // the files asked for above: deleted once allowed, as Delete file does (unchanged since read, that file only)
      for (const [id, allowed] of asked) {
        const o = offer.find((x) => x.source.id === id)!;
        const outcome = (await allowed) === "granted" ? await deletePicked(o.source.handle, o.source.seen) : "denied";
        setAsks((cur) => cur.map((x) => (x.id === id ? { ...x, state: outcome } : x)));
      }
      clearInput();
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel id="add" icon="plus" title={t("addTitle")} lead={t("addLead")}>
      {!unlocked && (
        <p class="callout">
          <Icon name="lock" size={16} />
          <span>{t("unlockToManage")}</span>
        </p>
      )}
      <div
        id="add-paste"
        class={`box${over ? " over" : ""}`}
        onDragOver={(e) => {
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!hasFiles(e.dataTransfer)) return; // dropped text goes into the box as the browser does it
          e.preventDefault();
          setOver(false);
          if (open) void droppedFiles(e.dataTransfer).then(load); // handles are asked for inside the event
        }}
      >
        <BoxTitle icon="link">{t("optPaste")}</BoxTitle>
        <p class="muted">{t("pasteHelp")}</p>
        <textarea
          id="paste-box"
          ref={areaRef}
          disabled={!open}
          spellcheck={false}
          autocomplete="off"
          placeholder="otpauth://totp/Example:alice?secret=…&#10;otpauth-migration://offline?data=…"
          value={text}
          onInput={(e) => {
            const v = (e.target as HTMLTextAreaElement).value;
            setText(v);
            setDone(null);
            if (!v.trim()) setColumns({});
          }}
          onPaste={(e) => {
            const imgs = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
            if (imgs.length) {
              e.preventDefault();
              void readImages(imgs);
            }
          }}
        />
        <div class="dropzone" id="add-upload">
          <span class="dz-ic">
            <Icon name="upload" size={18} />
          </span>
          <button type="button" class="btn ghost sm" id="choose-file" disabled={!open} onClick={() => void choose()}>
            <Icon name="file" size={15} />
            {t("chooseFile")}
          </button>
          <input
            id="qr-file"
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const el = e.target as HTMLInputElement;
              const files = [...(el.files ?? [])].map((file) => ({ file, handle: null }));
              el.value = "";
              void load(files);
            }}
          />
          <AddCamera
            enabled={open}
            boxText={() => seedRef.current}
            onLine={(line) => {
              if (!openRef.current) return;
              setDone(null);
              setScanned((cur) => [...cur, line]);
            }}
            onChoose={() => void choose()}
          />
          <span class="muted dz-help">{t("dropOrPasteImage")}</span>
        </div>
        {(sources.length > 0 || scanned.length > 0 || reading) && (
          <Sources
            sources={sources}
            scanned={scanned.length}
            scannedOut={camRead}
            reading={reading}
            onRemove={(id) => setSources((c) => c.filter((s) => s.id !== id))}
            onRemoveScanned={() => setScanned([])}
          />
        )}
      </div>
      {notes.map((n) => (
        <div key={n} class="err">
          <Icon name="alert" size={15} />
          {n}
        </div>
      ))}
      {hasInput && <Preview plan={plan} onColumns={(c) => setColumns({ ...columns, ...c })} />}
      {error && (
        <div class="err" role="alert">
          <Icon name="alert" size={15} />
          {error}
        </div>
      )}
      {done && (
        <div class="ok-msg" role="status" id="add-done">
          <Icon name="check" size={15} />
          {done}
        </div>
      )}
      {autoDelete.length > 0 && (
        <p class="muted" id="add-del-note">
          <Icon name="trash" size={14} />
          {t("delAuto", autoDelete.join(", "))}
        </p>
      )}
      <div class="row2">
        <button
          id="add-confirm"
          class="btn"
          disabled={busy || !unlocked || plan.add.length === 0 || (plan.table?.pending ?? 0) > 0}
          onClick={() => void add()}
        >
          <Icon name="plus" size={16} />
          {plan.add.length ? t("addN", plan.add.length) : t("add")}
        </button>
        {(hasInput || sources.length > 0 || scanned.length > 0) && (
          <button id="add-cancel" class="btn ghost" disabled={busy} onClick={clearInput}>
            {t("cancel")}
          </button>
        )}
        {plan.incomplete.length > 0 && <span class="muted">{t("incompleteHint")}</span>}
        {!hasInput && unlocked && !reading && (
          <span class="muted" id="add-hint">
            {t("addNothing")}
          </span>
        )}
      </div>

      <div class="cards">
        <ManualForm rt={rt} unlocked={unlocked} reload={reload} vaultCount={vault ? aliveEntries(vault).length : 0} />
        <div id="add-google" class="box">
          <BoxTitle icon="transfer">{t("googleTitle")}</BoxTitle>
          <ol class="gsteps">
            <li>
              <i>1</i>
              <span>{t("googleStep1")}</span>
            </li>
            <li>
              <i>2</i>
              <span>{t("googleStep2")}</span>
            </li>
            <li>
              <i>3</i>
              <span>{t("googleStep3")}</span>
            </li>
          </ol>
        </div>
      </div>
    </Panel>
  );
}

/**
 * The files read so far, and the codes the camera read: each row by its name, with what was found in it or why nothing
 * was. Never a secret.
 */
function Sources({
  sources,
  scanned,
  scannedOut,
  reading,
  onRemove,
  onRemoveScanned,
}: {
  sources: Source[];
  scanned: number;
  scannedOut: Source["out"];
  reading: boolean;
  onRemove: (id: number) => void;
  onRemoveScanned: () => void;
}) {
  return (
    <ul class="src-list" id="add-files" aria-live="polite">
      {scanned > 0 && (
        <li class="src" id="add-scanned-row">
          <div class="src-head">
            <Icon name="scan" size={15} />
            <b>
              {t("camSource")} · {scanned}
            </b>
            <button type="button" class="src-x" aria-label={t("siteRemove", t("camSource"))} onClick={onRemoveScanned}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <SourceNotes out={scannedOut} name={t("camSource")} />
        </li>
      )}
      {sources.map((s) => (
        <li key={s.id} class="src">
          <div class="src-head">
            <Icon name={s.image ? "image" : "file"} size={15} />
            <b>{s.name}</b>
            <button type="button" class="src-x" aria-label={t("siteRemove", s.name)} onClick={() => onRemove(s.id)}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <SourceNotes out={s.out} name={s.name} />
        </li>
      ))}
      {reading && <li class="src muted">…</li>}
    </ul>
  );
}

function SourceNotes({ out: o, name }: { out: Source["out"]; name: string }) {
  const bad = (msg: preact.ComponentChildren) => (
    <p class="pv-line err src-msg">
      <Icon name="alert" size={14} />
      <span>{msg}</span>
    </p>
  );
  if (o.kind === "encrypted") return bad(t("fileEncrypted", o.app));
  if (o.kind === "sixkey_backup") return bad(<a href="#backup">{t("fileIsBackup")}</a>);
  if (o.kind === "html") return bad(t("fileHtml"));
  if (o.kind === "too_large") return bad(t("fileTooBig"));
  if (o.kind === "nothing") return bad(t("fileNothing"));
  if (o.kind === "noqr") return bad(t("noQrIn", name));
  if (o.kind === "zip") return bad(t("fileZip"));
  if (o.kind === "binary") return bad(t("fileNotText"));
  if (!o.skipped.length && !o.types.length) return null;
  return (
    <>
      {o.types.map((k) => (
        <p key={k.type} class="pv-line muted src-msg">
          <Icon name="info" size={14} />
          <span>{t("fileSkipType", k.n, k.type)}</span>
        </p>
      ))}
      {o.skipped.slice(0, 8).map((k, i) => (
        <p key={i} class="pv-line err src-msg">
          <Icon name="alert" size={14} />
          <span>{k.name ? t("skipNamed", k.name, reason(k.reason)) : t("previewFailed", k.at, reason(k.reason))}</span>
        </p>
      ))}
      {o.skipped.length > 8 && <p class="pv-line muted src-msg">+{o.skipped.length - 8}</p>}
    </>
  );
}

/** "Delete file": exactly the file the user picked, once they clicked, and only as Sixkey read it (file-access.ts). */
async function remove(a: Ask) {
  setAsks((cur) => cur.map((x) => (x.id === a.id ? { ...x, state: "busy" } : x)));
  const outcome = await deletePicked(a.handle, a.seen);
  setAsks((cur) => cur.map((x) => (x.id === a.id ? { ...x, state: outcome } : x)));
}
const dismiss = (a: Ask) => setAsks((cur) => cur.filter((x) => x.id !== a.id));

/**
 * The questions still open (import-asks.ts), drawn by App above every section: they outlive the section, since what
 * they hold is files' names and handles, and a plain-text file of keys left behind is what they exist to prevent.
 */
export function PendingDeletes() {
  const asks = useAsks();
  return asks.length > 0 ? <DeleteAsk asks={asks} onDelete={(a) => void remove(a)} onDismiss={dismiss} /> : null;
}

/**
 * After accounts were added from a file: "it holds your keys in plain text; delete it now?" Delete file deletes that
 * file only (its handle), after Chrome's own permission prompt; Keep it closes the question. A file some of whose
 * entries were not imported says so, and Keep is then the first choice. Without a handle, or when deleting did not
 * work, the page says how to delete it by hand, and asks no question. Nothing is deleted without the click.
 */
function DeleteAsk({
  asks,
  onDelete,
  onDismiss,
}: {
  asks: Ask[];
  onDelete: (a: Ask) => void;
  onDismiss: (a: Ask) => void;
}) {
  return (
    <div class="box warn del-ask" id="del-ask">
      {asks.map((a) => {
        const asking = a.handle !== null && (a.state === "ask" || a.state === "busy");
        return (
          <div key={a.id} class="del-row" data-state={a.state}>
            {a.state === "deleted" ? (
              <p class="pv-line">
                <Icon name="check" size={15} />
                {t("delDone", a.name)}
              </p>
            ) : (
              <>
                <p>
                  {asking
                    ? t("delAsk", a.name)
                    : a.state === "ask"
                      ? t("delPlain", a.name)
                      : a.state === "changed"
                        ? t("delChanged", a.name)
                        : t("delNot", a.name)}
                </p>
                {a.left > 0 && (
                  <p class="del-left">
                    <b>{t("delLeft", a.left)}</b>
                  </p>
                )}
                {a.hotp > 0 && <p class="muted">{t("delHotp", a.hotp)}</p>}
                {!asking && <p class="muted">{t("delManual")}</p>}
                <p class="muted">{t("delNote")}</p>
              </>
            )}
            <div class="row2">
              {asking ? (
                a.left > 0 ? (
                  <>
                    <button class="btn del-keep" disabled={a.state === "busy"} onClick={() => onDismiss(a)}>
                      {t("delKeep")}
                    </button>
                    <button class="btn ghost del-yes" disabled={a.state === "busy"} onClick={() => onDelete(a)}>
                      <Icon name="trash" size={15} />
                      {t("delYes")}
                    </button>
                  </>
                ) : (
                  <>
                    <button class="btn del-yes" disabled={a.state === "busy"} onClick={() => onDelete(a)}>
                      <Icon name="trash" size={15} />
                      {t("delYes")}
                    </button>
                    <button class="btn ghost del-keep" disabled={a.state === "busy"} onClick={() => onDismiss(a)}>
                      {t("delKeep")}
                    </button>
                  </>
                )
              ) : (
                <button class="btn ghost del-ok" onClick={() => onDismiss(a)}>
                  {t("gotIt")}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Preview({ plan, onColumns }: { plan: ImportPlan; onColumns: (c: ImportOptions) => void }) {
  const fromText = new Set(plan.fromText);
  const unnamed = plan.add.filter((p, i) => fromText.has(i) && !p.issuer && !p.label).length;
  return (
    <div class={`preview${plan.add.length ? " has" : ""}`} id="preview" aria-live="polite">
      <div class="pv-head">
        <span class="pv-n">{plan.add.length}</span>
        <b>{t("previewAdd", plan.add.length)}</b>
      </div>
      {plan.table && <LineColumns table={plan.table} onColumns={onColumns} />}
      {plan.add.length > 0 && (
        <ul class="pv-list">
          {plan.add.slice(0, 8).map((p, i) => (
            <li key={i}>
              <Avatar name={p.issuer || p.label} size={22} />
              <span>
                <b>{p.issuer || p.label || "—"}</b>
                {p.issuer && p.label ? <i>{p.label}</i> : null}
                {fromText.has(i) && <em class="pv-tag">{t("linesTag")}</em>}
              </span>
            </li>
          ))}
          {plan.add.length > 8 && <li class="more-n">+{plan.add.length - 8}</li>}
        </ul>
      )}
      {plan.fromText.length > 0 && (
        <div class="pv-line muted" id="lines-note">
          <Icon name="info" size={14} />
          {t("linesFromText", plan.fromText.length)}
        </div>
      )}
      {unnamed > 0 && (
        <div class="pv-line muted">
          <Icon name="info" size={14} />
          {t("linesUnnamed", unnamed)}
        </div>
      )}
      {plan.duplicates.length > 0 && (
        <div class="pv-line muted" id="pv-dup">
          <Icon name="copy" size={14} />
          {t("previewDup", plan.duplicates.length)}
        </div>
      )}
      {plan.failed.map((f, i) => (
        <div key={i} class="pv-line err">
          <Icon name="alert" size={14} />
          {t("previewFailed", f.index + 1, reason(f.reason))}
        </div>
      ))}
      {plan.incomplete.map((b) => (
        <div key={b.batchId} class="pv-line err">
          <Icon name="alert" size={14} />
          {t("previewIncomplete", b.received.length, b.batchSize, b.missing.map((m) => m + 1).join(", "))}
        </div>
      ))}
      {plan.warnings.hotp > 0 && (
        <div class="pv-line muted">
          <Icon name="hash" size={14} />
          {t("previewHotp", plan.warnings.hotp)}
        </div>
      )}
      {plan.warnings.short_secret > 0 && (
        <div class="pv-line muted">
          <Icon name="info" size={14} />
          {t("previewShort", plan.warnings.short_secret)}
        </div>
      )}
    </div>
  );
}

/** For name|key|... lines: which column is the key and which the name. Columns are described by position and length only, never by content. */
function LineColumns({
  table,
  onColumns,
}: {
  table: NonNullable<ImportPlan["table"]>;
  onColumns: (c: ImportOptions) => void;
}) {
  const describe = (c: LineColumn) =>
    t(
      "linesColumn",
      c.index + 1,
      c.minLength === c.maxLength ? c.minLength : `${c.minLength}–${c.maxLength}`,
      c.keyLike,
      table.lines,
    );
  return (
    <div class="lines-cols" id="lines">
      <p>{t("linesHelp", table.lines)}</p>
      <div class="grid2">
        <div class="field">
          <label for="lines-key">{t("linesKey")}</label>
          <select
            id="lines-key"
            value={table.keyColumn === null ? "" : String(table.keyColumn)}
            onChange={(e) => onColumns({ keyColumn: Number((e.target as HTMLSelectElement).value) })}
          >
            {table.keyColumn === null && (
              <option value="" disabled>
                {t("linesChoose")}
              </option>
            )}
            {table.columns.map((c) => (
              <option key={c.index} value={String(c.index)}>
                {describe(c)}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="lines-name">{t("linesName")}</label>
          <select
            id="lines-name"
            value={table.nameColumn === null ? "none" : String(table.nameColumn)}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              onColumns({ nameColumn: v === "none" ? null : Number(v) });
            }}
          >
            <option value="none">{t("linesNoName")}</option>
            {table.columns
              .filter((c) => c.index !== table.keyColumn)
              .map((c) => (
                <option key={c.index} value={String(c.index)}>
                  {describe(c)}
                </option>
              ))}
          </select>
        </div>
      </div>
      {table.pending > 0 && (
        <div class="pv-line err" role="status">
          <Icon name="alert" size={14} />
          {t("linesPending", table.pending)}
        </div>
      )}
    </div>
  );
}

function ManualForm({
  rt,
  unlocked,
  reload,
}: {
  rt: Ctx["rt"];
  unlocked: boolean;
  reload: () => Promise<void>;
  vaultCount: number;
}) {
  const [f, setF] = useState({ issuer: "", label: "", secret: "", algorithm: "SHA1", digits: "6", period: "30" });
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const set = (k: keyof typeof f) => (e: Event) => {
    setF({ ...f, [k]: (e.target as HTMLInputElement).value });
    setOk(false);
  };

  async function submit(ev: Event) {
    ev.preventDefault();
    setError(null);
    let r: ReturnType<typeof parseOtpauth>;
    try {
      const uri = serializeOtpauth({
        type: "totp",
        issuer: f.issuer.trim(),
        label: f.label.trim(),
        secret: f.secret,
        algorithm: f.algorithm as "SHA1",
        digits: Number(f.digits) as 6,
        period: Number(f.period),
      });
      r = parseOtpauth(uri);
    } catch {
      return setError(t("rBadSecret")); // the key has characters that are not base32
    }
    if (!r.ok || f.secret.trim() === "")
      return setError(r.ok ? t("rBadSecret") : t(r.error === "invalid_period" ? "rPeriod" : "rBadSecret"));
    try {
      await rt.service.mutate((v, clock) => applyImport(v, [r.value], clock));
      setF({ issuer: "", label: "", secret: "", algorithm: "SHA1", digits: "6", period: "30" });
      setOk(true);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  }
  return (
    <form id="add-manual" class="box" onSubmit={submit}>
      <BoxTitle icon="keyboard">{t("optManual")}</BoxTitle>
      <div class="grid2">
        <div class="field">
          <label for="m-issuer">{t("fieldIssuer")}</label>
          <input id="m-issuer" type="text" maxLength={256} value={f.issuer} onInput={set("issuer")} />
        </div>
        <div class="field">
          <label for="m-label">{t("fieldLabel")}</label>
          <input id="m-label" type="text" maxLength={256} value={f.label} onInput={set("label")} />
        </div>
      </div>
      <div class="field">
        <label for="m-secret">{t("fieldSecret")}</label>
        <input
          id="m-secret"
          class="mono"
          type="text"
          maxLength={512}
          autocomplete="off"
          spellcheck={false}
          value={f.secret}
          onInput={set("secret")}
        />
      </div>
      <div class="grid3">
        <div class="field">
          <label for="m-alg">{t("fieldAlgorithm")}</label>
          <select id="m-alg" value={f.algorithm} onChange={set("algorithm")}>
            <option>SHA1</option>
            <option>SHA256</option>
            <option>SHA512</option>
          </select>
        </div>
        <div class="field">
          <label for="m-digits">{t("fieldDigits")}</label>
          <select id="m-digits" value={f.digits} onChange={set("digits")}>
            <option>6</option>
            <option>8</option>
          </select>
        </div>
        <div class="field">
          <label for="m-period">{t("fieldPeriod")}</label>
          <input id="m-period" type="number" min={1} max={3600} value={f.period} onInput={set("period")} />
        </div>
      </div>
      {error && (
        <div class="err" role="alert">
          <Icon name="alert" size={15} />
          {error}
        </div>
      )}
      {ok && (
        <div class="ok-msg" role="status">
          <Icon name="check" size={15} />
          {t("addedN", 1)}
        </div>
      )}
      <div class="row2">
        <button id="manual-add" class="btn" type="submit" disabled={!unlocked || !f.secret.trim()}>
          <Icon name="plus" size={16} />
          {t("add")}
        </button>
      </div>
    </form>
  );
}
