// The settings page's text, in parts (docs/design/notes/BUDGET-NOTES.md). Each part's text is a catalog of its own,
// catalogs/settings-<part>-<lang>.json (scripts/messages.py writes it; which key is in which part is the fragments'
// PARTS data, held to the code by test/unit/budget-split.test.ts), and its own chunk (assets/settings-locale-<part>-
// <lang>-*.js, scripts/build.mjs), each with its own budget (scripts/check-dist.mjs). Nothing of it is drawn before its
// text is in:
//   - "core" (the page's frame, the rail, the words every part shares) before anything: main.tsx;
//   - the parts of the view the page opens on before that view: App's reload() waits for partsFor(state) before it
//     shows the new state, so the sections are drawn whole, the rail's highlight finds them, and links into them work.
//     A page with a vault has the lock's part from the start, so a lock elsewhere waits for nothing (partsFor);
//   - and every component of a part is drawn only through its wrapper below, which draws nothing of it (a section: its
//     empty frame, with its id) until that part's text is in, loading it then: the views the page reaches later (the
//     first-run wizard from a vault's page) are lazy.
// The parts a view loads together are also held, as one gzip stream, to the 12 KB the whole text had when it was one
// catalog (scripts/check-dist.mjs SETTINGS_VIEWS, scripts/messages.py AGGREGATES; the same lists as partsFor).
// Only this module imports the parts' entry modules (scripts/catalog-keys.mjs SETTINGS_PARTS lists them); no part imports
// another's. The popup loads none of this (scripts/check-dist.mjs).
import type { ComponentType, FunctionComponent } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ServiceStatus } from "../core/service/service";
import { getLang, loadCatalog, type Catalog, type CatalogSource } from "../ui/i18n";
import { AddAccounts as AddAccountsPart, PendingDeletes as PendingDeletesPart } from "./AddAccounts";
import { Appearance as AppearancePart } from "./Appearance";
import { Backup as BackupPart } from "./Backup";
import { Groups as GroupsPart } from "./Groups";
import { FirstRun as FirstRunPart, SetupReady as SetupReadyPart } from "./FirstRun";
import {
  Advanced as AdvancedPart,
  Autofill as AutofillPart,
  Clipboard as ClipboardPart,
  Trash as TrashPart,
} from "./Misc";
import { ResetPassword as ResetPasswordPart } from "./Reset";
import {
  Security as SecurityPart,
  SecurityKeys as SecurityKeysPart,
  SecurityRecord as SecurityRecordPart,
} from "./Security";
import { UnlockBar as UnlockBarPart } from "./UnlockBar";

export type Part = "core" | "security" | "accounts" | "backup" | "misc" | "general" | "firstrun" | "unlock";

// Two literal imports per part, one per language, so the bundler makes one chunk of each; only `.default` is taken
// (see src/ui/catalog-full.ts).
const SOURCES: Record<Part, CatalogSource> = {
  core: async (lang) =>
    lang === "zh_CN"
      ? (await import("../../catalogs/settings-core-zh_CN.json")).default
      : (await import("../../catalogs/settings-core-en.json")).default,
  security: async (lang) =>
    lang === "zh_CN"
      ? (await import("../../catalogs/settings-security-zh_CN.json")).default
      : (await import("../../catalogs/settings-security-en.json")).default,
  accounts: async (lang) =>
    lang === "zh_CN"
      ? (await import("../../catalogs/settings-accounts-zh_CN.json")).default
      : (await import("../../catalogs/settings-accounts-en.json")).default,
  backup: async (lang) =>
    lang === "zh_CN"
      ? (await import("../../catalogs/settings-backup-zh_CN.json")).default
      : (await import("../../catalogs/settings-backup-en.json")).default,
  misc: async (lang) =>
    lang === "zh_CN"
      ? (await import("../../catalogs/settings-misc-zh_CN.json")).default
      : (await import("../../catalogs/settings-misc-en.json")).default,
  general: async (lang) =>
    lang === "zh_CN"
      ? (await import("../../catalogs/settings-general-zh_CN.json")).default
      : (await import("../../catalogs/settings-general-en.json")).default,
  firstrun: async (lang) =>
    lang === "zh_CN"
      ? (await import("../../catalogs/settings-firstrun-zh_CN.json")).default
      : (await import("../../catalogs/settings-firstrun-en.json")).default,
  unlock: async (lang) =>
    lang === "zh_CN"
      ? (await import("../../catalogs/settings-unlock-zh_CN.json")).default
      : (await import("../../catalogs/settings-unlock-en.json")).default,
};

/** The page as it opens on a vault (App's main view): the sections, and the lock's part (the unlock bar, the reset). */
const VAULT: readonly Part[] = ["security", "accounts", "backup", "misc", "general", "unlock"];

/**
 * The parts the page draws first for a vault in `state`: the first-run wizard with no vault yet; else the sections and
 * the lock's part, whatever the state, so that when Sixkey locks the page shows it at once, waiting for no text: it drops
 * the vault it shows straight away (QUICK-UNLOCK §5.12 item 3). Other views load their part when they are drawn.
 */
export function partsFor(state: ServiceStatus["state"]): readonly Part[] {
  return state === "empty" ? ["firstrun"] : VAULT;
}

const texts = new Map<Part, Promise<Catalog>>();
const ready = new Set<Part>();
let merged: Catalog = {};
let applied: Promise<void> = Promise.resolve();

/**
 * A part's text in the page's language, fetched once. Never rejects, as loadCatalog: if that chunk cannot be loaded the
 * English one is used, and if that fails too the part has no text (t() shows key names; the page still works).
 */
function textOf(p: Part): Promise<Catalog> {
  let text = texts.get(p);
  if (!text) {
    const source = SOURCES[p];
    text = source(getLang())
      .catch(() => source("en"))
      .catch(() => ({}));
    texts.set(p, text);
  }
  return text;
}

/**
 * Load these parts' text (side by side) into the page's catalog. Resolves once t() has all of it; never rejects. The
 * parts' keys are disjoint, so the catalog only grows; additions are applied one after another, each over the last.
 */
export function loadParts(parts: readonly Part[]): Promise<void> {
  const missing = parts.filter((p) => !ready.has(p));
  if (!missing.length) return Promise.resolve();
  const fetched = missing.map(textOf);
  applied = applied.then(async () => {
    const got = await Promise.all(fetched);
    merged = Object.assign({}, merged, ...got);
    await loadCatalog(async () => merged);
    for (const p of missing) ready.add(p);
  });
  return applied;
}

/** Whether all of these parts' text is in t()'s catalog (then loadParts has nothing to wait for). */
export const partsReady = (parts: readonly Part[]): boolean => parts.every((p) => ready.has(p));

/** Whether a part's text is in; loads it (and draws again) when it is not. */
function usePart(p: Part): boolean {
  const [, drawn] = useState(0);
  const isReady = ready.has(p);
  useEffect(() => {
    if (isReady) return;
    let live = true;
    void loadParts([p]).then(() => {
      if (live) drawn((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [p, isReady]);
  return isReady;
}

/**
 * A part's component, drawn once its part's text is in. Until then: nothing, or for a section of the page its empty
 * frame with the section's id.
 */
function gated<P extends object>(part: Part, Component: ComponentType<P>, section?: string): FunctionComponent<P> {
  return function Gated(props: P) {
    if (usePart(part)) return <Component {...props} />;
    return section ? <section id={section} class="panel" aria-busy="true" /> : null;
  };
}

export const Security = gated("security", SecurityPart, "security");
export const SecurityKeys = gated("security", SecurityKeysPart, "security-keys");
export const SecurityRecord = gated("security", SecurityRecordPart, "security-log");
export const AddAccounts = gated("accounts", AddAccountsPart, "add");
export const PendingDeletes = gated("accounts", PendingDeletesPart);
export const Backup = gated("backup", BackupPart, "backup");
// Settings › Groups: in the backup part, whose account picker (SubsetPicker.tsx) and its text it shares
export const Groups = gated("backup", GroupsPart, "groups");
export const Trash = gated("misc", TrashPart, "trash");
export const Clipboard = gated("misc", ClipboardPart, "clipboard");
export const Autofill = gated("misc", AutofillPart, "autofill");
export const Advanced = gated("misc", AdvancedPart, "advanced");
export const Appearance = gated("general", AppearancePart, "appearance");
export const FirstRun = gated("firstrun", FirstRunPart);
export const SetupReady = gated("firstrun", SetupReadyPart);
export const UnlockBar = gated("unlock", UnlockBarPart);
export const ResetPassword = gated("unlock", ResetPasswordPart);
