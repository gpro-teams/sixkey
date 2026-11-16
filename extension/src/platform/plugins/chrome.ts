// The grant store's browser side, shared by the worker and the pages: the catalog (the built-in autofill alone) and the
// two stores over chrome.storage. Since the plugin platform was removed (2026-11-12), no other extension is served and
// no build bundles a plugin catalog: the built-in autofill (core/plugins/builtin.ts) is the one entry left.
import { BUILTIN_CATALOG } from "../../core/plugins/builtin";
import { GrantStore } from "../../core/plugins/store";
import { PluginSession } from "../../core/plugins/session";
import type { Catalog } from "../../core/plugins/policy";
import { ChromeLocalKV } from "../chrome-kv";
import { webLock } from "../locks";

const CATALOG: Catalog = { v: 1, plugins: [...BUILTIN_CATALOG] };
/** The catalog of every build: the built-in autofill's entry, nothing else. */
export const catalog = (): Catalog => CATALOG;

export const grantStore = (): GrantStore =>
  new GrantStore({
    local: new ChromeLocalKV(chrome.storage.local),
    session: new ChromeLocalKV(chrome.storage.session),
    lock: webLock("sixkey-vault"),
  });

/** The request log autofill's fills are written to (Settings › Security › Autofill shows its last lines). */
export const pluginSession = (): PluginSession =>
  new PluginSession(new ChromeLocalKV(chrome.storage.session), webLock("sixkey-plugin-session"));
