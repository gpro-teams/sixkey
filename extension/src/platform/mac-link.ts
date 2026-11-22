// The link with Sixkey for Mac (OWNER-DECISIONS/23 and 25: one vault, the app follows this extension on its Mac). Chrome
// starts the app's own executable as a native messaging host ("app.sixkey.mac"). After each save this worker sends it
// the vault as a cloud backup file holds it (makeCloudBackup, opens "both": the envelope with the password and recovery
// wraps, never a device key, never earlier keys), which only the master password or the recovery key opens; the app
// keeps it and merges it once unlocked. The host answers with the Mac's own copy in the same container, and a pull once a
// minute (only while linked and unlocked) asks for it too: merged here as an earlier copy of this vault is
// (openOwnGenerations, importBackup), and only when it brings something new, so the two sides stop sending each other
// the same vault.
//
// The PIN set up here goes to the app too (platform/mac-pin.ts decides what: the PIN's record while it opens Sixkey
// here, null otherwise), when it changed, so the same PIN opens Sixkey for Mac (OWNER-DECISIONS/23, 2026-11-19).
//
// While this extension is locked, its fill shortcut asks the app for the code of the one account registered for the page
// (fillFromMac): the app asks for Touch ID every time and answers with that code (now and next) and what the page is
// checked against (the account's sites, digits, period), never a name or a key; only the page's host goes to the app.
//
// Off unless the person turned it on in Settings: the optional `nativeMessaging` permission, asked in that click
// (Chrome's prompt says "Communicate with cooperating native applications"). No Port is kept: one message per send.
// The only file that talks to a native host.
import { makeCloudBackup, parseCloudBackup } from "../core/cloud/format";
import type { MacFill } from "./mac-fill";
import type { MacPin } from "./mac-pin";
import type { Generation } from "../core/storage/format";
import type { LoadResult } from "../core/storage/store";
import { canonicalJson, mergeVaults } from "../core/vault/merge";
import type { Vault } from "../core/vault/model";
import { clampVault } from "../core/vault/ops";

/** The host's name, as the app's host manifest names it. */
export const MAC_HOST = "app.sixkey.mac";
/** The pull's alarm, once a minute while the link is on (sw.ts hands it here). */
export const MAC_PULL_ALARM = "sk-mac-pull";
const PERMISSION: chrome.permissions.Permissions = { permissions: ["nativeMessaging"] };

/** The ids of the vault on the Mac, as the app's host reads them without a key. */
export type MacVault = { vaultId: string; vkId: string; seq: number; rev: number };
export type MacHello = { found: false } | { found: true; app: string; vault: MacVault | null };

export const macLinkOn = (): Promise<boolean> => chrome.permissions.contains(PERMISSION);
/** In the click that turns it on: nothing awaited before it, so Chrome shows its prompt. */
export const askMacLink = (): Promise<boolean> => chrome.permissions.request(PERMISSION);
export const stopMacLink = (): Promise<boolean> => chrome.permissions.remove(PERMISSION);

let next = 1;
/** One message and its answer; null when no host answers (the app is not installed, or Chrome refused). */
function ask(message: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(MAC_HOST, { v: 1, id: next++, ...message }, (reply: unknown) => {
        const failed = chrome.runtime.lastError !== undefined;
        resolve(!failed && typeof reply === "object" && reply !== null ? (reply as Record<string, unknown>) : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Whether the app answers on this Mac, its version, and its vault's ids. */
export async function macHello(version: string): Promise<MacHello> {
  const r = await ask({ type: "hello", ext: { version } });
  if (!r || r.type !== "hello") return { found: false };
  const app =
    typeof (r.app as { version?: unknown } | null)?.version === "string" ? (r.app as { version: string }).version : "";
  const v = r.vault as Partial<MacVault> | null;
  const vault =
    v &&
    typeof v.vaultId === "string" &&
    typeof v.vkId === "string" &&
    typeof v.seq === "number" &&
    typeof v.rev === "number"
      ? { vaultId: v.vaultId, vkId: v.vkId, seq: v.seq, rev: v.rev }
      : null;
  return { found: true, app, vault };
}

/** What a send did. */
export type MacSend = "kept" | "off" | "no_vault" | "not_sendable" | "no_app";

/**
 * Sends the vault as it is stored now, when the link is on; `mac` is the Mac's own copy the host answered with (the raw
 * container, checked where it is merged). "not_sendable": a keyring a device key opens, or one with no master password
 * (the app opens only what a secret opens).
 */
export async function sendVaultToMac(
  load: () => Promise<LoadResult>,
  app: string,
): Promise<{ sent: MacSend; mac: unknown }> {
  if (!(await macLinkOn())) return { sent: "off", mac: null };
  const loaded = await load();
  if (loaded.status !== "ok") return { sent: "no_vault", mac: null };
  let backup;
  try {
    backup = await makeCloudBackup(loaded.gen, "both", app);
  } catch {
    return { sent: "not_sendable", mac: null };
  }
  const r = await ask({ type: "gen", gen: backup });
  return r?.type === "kept" ? { sent: "kept", mac: r.mac ?? null } : { sent: "no_app", mac: null };
}

/** The Mac's own copy, asked for (null when the app does not answer or has none). */
export async function pullFromMac(): Promise<unknown> {
  const r = await ask({ type: "pull" });
  return r?.type === "mac" ? (r.gen ?? null) : null;
}

/** The PIN for the app (or null, which takes the app's copy away); true when the app kept it. */
export async function sendPinToMac(pin: MacPin | null): Promise<boolean> {
  if (!(await macLinkOn())) return false;
  const r = await ask({ type: "pin", pin });
  return r?.type === "pin-kept";
}

/** What the vault service gives the merge: the parts it needs, so the worker and the settings page both pass theirs. */
export type MacService = {
  status(): Promise<{ state: string }>;
  openOwnGenerations(gens: readonly Generation[]): Promise<(Vault | null)[]>;
  read(): Promise<{ vault: Vault }>;
  importBackup(backup: Vault): Promise<unknown>;
};

/** The same accounts, whatever the order of the entries (a merge sorts them by id; an edit leaves them in place). */
const content = (v: Vault): string =>
  canonicalJson({ ...v, entries: [...v.entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) });

/**
 * The Mac's copy merged into this vault while it is unlocked: "same" when it brings nothing new (nothing is saved, so no
 * commit sends the vault again), "other" for another vault or one under a key not held here, "locked", "bad" for
 * anything that is not a cloud backup container.
 */
export async function mergeFromMac(
  service: MacService,
  raw: unknown,
): Promise<"merged" | "same" | "other" | "locked" | "bad" | "none"> {
  if (raw === null || raw === undefined) return "none";
  let gen: Generation;
  try {
    gen = (await parseCloudBackup(raw)).generation;
  } catch {
    return "bad";
  }
  if ((await service.status()).state !== "unlocked") return "locked";
  const [theirs] = await service.openOwnGenerations([gen]).catch(() => [null]);
  if (!theirs) return "other";
  const { vault } = await service.read();
  if (content(mergeVaults(vault, clampVault(theirs, Date.now()))) === content(vault)) return "same";
  await service.importBackup(theirs);
  return "merged";
}

/**
 * The worker's side: after a commit (watchVault), one send a moment later, so a burst of saves sends once, and the
 * Mac's copy it answers with merged; and the pull's alarm, kept while the link is on. The PIN (`pin`, mac-pin.ts) goes
 * with each of them, locked or not, once it changed since this worker last sent it.
 */
export function createMacLink(d: {
  load: () => Promise<LoadResult>;
  app: string;
  service: MacService;
  alarms: Pick<typeof chrome.alarms, "create" | "clear" | "get">;
  delayMs?: number;
  pin?: () => Promise<MacPin | null>;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pinSent: string | undefined;
  const syncPin = async (): Promise<void> => {
    if (!d.pin || !(await macLinkOn())) return;
    const pin = await d.pin().catch(() => undefined);
    if (pin === undefined) return;
    const said = pin === null ? "null" : JSON.stringify(pin);
    if (said !== pinSent && (await sendPinToMac(pin))) pinSent = said;
  };
  let running: Promise<unknown> = Promise.resolve();
  const queue = (job: () => Promise<unknown>) => {
    running = running.then(job).catch(() => undefined);
    return running;
  };
  const start = async (): Promise<void> => {
    if (!(await macLinkOn())) return void (await d.alarms.clear(MAC_PULL_ALARM));
    if (!(await d.alarms.get(MAC_PULL_ALARM))) await d.alarms.create(MAC_PULL_ALARM, { periodInMinutes: 1 });
    await syncPin();
  };
  return {
    /** The worker's start: the pull's alarm made when the link is on (and cleared when it was turned off). */
    start: () => queue(start),
    changed(): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void queue(async () => {
          const r = await sendVaultToMac(d.load, d.app);
          if (r.sent === "kept") await mergeFromMac(d.service, r.mac);
          await start();
        });
      }, d.delayMs ?? 2_000);
    },
    /** The pull, on its alarm: only while unlocked; false for any other alarm. */
    alarm(name: string): boolean {
      if (name !== MAC_PULL_ALARM) return false;
      void queue(async () => {
        if (!(await macLinkOn())) return void (await d.alarms.clear(MAC_PULL_ALARM));
        await syncPin();
        if ((await d.service.status()).state !== "unlocked") return;
        await mergeFromMac(d.service, await pullFromMac());
      });
      return true;
    },
  };
}

/** The app's code for `host` (after its Touch ID), or null: not linked, no app, refused, or an answer that does not read. */
export async function fillFromMac(host: string): Promise<MacFill | null> {
  if (!(await macLinkOn())) return null;
  const r = await ask({ type: "fill", host });
  if (!r || r.type !== "code") return null;
  const codes = Array.isArray(r.codes)
    ? r.codes.filter(
        (c): c is { code: string; until: number } =>
          typeof c?.code === "string" && /^\d{6,8}$/.test(c.code) && typeof c?.until === "number",
      )
    : [];
  const digits = r.digits === 6 || r.digits === 8 ? r.digits : null;
  const period = typeof r.period === "number" && Number.isInteger(r.period) && r.period >= 1 ? r.period : null;
  const domains = Array.isArray(r.domains) ? r.domains.filter((d): d is string => typeof d === "string") : [];
  if (codes.length === 0 || digits === null || period === null || domains.length === 0) return null;
  return { codes, digits, period, domains };
}
