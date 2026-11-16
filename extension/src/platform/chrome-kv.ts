import type { KV } from "../core/storage/kv";

/** chrome.storage.local as a KV. With the unlimitedStorage permission the 10 MB quota does not apply. */
export class ChromeLocalKV implements KV {
  constructor(private readonly area: chrome.storage.StorageArea = chrome.storage.local) {}
  async get(keys: string[]): Promise<Record<string, unknown>> {
    return (await this.area.get(keys)) as Record<string, unknown>;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    await this.area.set(items);
  }
  async remove(keys: string[]): Promise<void> {
    await this.area.remove(keys);
  }
  async keys(): Promise<string[]> {
    return Object.keys(await this.area.get(null));
  }
}
