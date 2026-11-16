import type { KV } from "../core/storage/kv";

/**
 * IndexedDB as a KV, used for the mirror. It lives in the extension's own origin, apart from chrome.storage.local,
 * so damage to one does not take the other with it (they are not fully independent engines, but they are separate stores).
 */
export class IdbKV implements KV {
  private dbp: Promise<IDBDatabase> | null = null;
  constructor(
    private readonly name = "sixkey-mirror",
    private readonly idb: IDBFactory = indexedDB,
  ) {}

  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const req = this.idb.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbp;
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest | void,
    read?: (tx: IDBTransaction) => T,
  ): Promise<T> {
    const db = await this.db();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction("kv", mode);
      const store = tx.objectStore("kv");
      let result: T;
      const req = fn(store);
      if (req)
        req.onsuccess = () => {
          result = req.result as T;
        };
      tx.oncomplete = () => resolve(read ? read(tx) : result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const store = tx.objectStore("kv");
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        const r = store.get(k);
        r.onsuccess = () => {
          if (r.result !== undefined) out[k] = r.result;
        };
      }
      tx.oncomplete = () => resolve(out);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  async set(items: Record<string, unknown>): Promise<void> {
    await this.tx("readwrite", (s) => {
      for (const [k, v] of Object.entries(items)) s.put(v, k);
    });
  }

  async remove(keys: string[]): Promise<void> {
    await this.tx("readwrite", (s) => {
      for (const k of keys) s.delete(k);
    });
  }

  async keys(): Promise<string[]> {
    const r = await this.tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
    return r.map(String);
  }
}
