// The extension in Chromium against the real API server (npm run e2e:sync; docs/design/notes/M5-NOTES.md): the server from
// test/live/server.ts on a free loopback port, configured with the e2e build's API origin, and in front of it, on that
// origin (127.0.0.1:8787), a forwarding proxy that records what arrives (test/e2e/sync-helpers.ts serveApi) and can be
// taken down to make the network fail. The server verifies the signatures against its configured host, never the Host
// header, so the proxy changes nothing that is signed.
import type { Page } from "@playwright/test";
import type { HttpRequest, HttpResponse } from "../../src/core/sync/engine/transport";
import { startLiveServer, type LiveServer } from "../live/server";
import { API_ORIGIN, serveApi, type ApiServer } from "../e2e/sync-helpers";
import type { Profile } from "../e2e/harness";

const HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "accept-encoding",
  "content-encoding",
]);

export type SyncBackend = { server: LiveServer; api: ApiServer; down(on: boolean): void; stop(): Promise<void> };

/** The real server behind a recording proxy on the e2e origin. */
export async function startSyncBackend(): Promise<SyncBackend> {
  const server = await startLiveServer({ origin: API_ORIGIN });
  let isDown = false;
  const forward = async (req: HttpRequest): Promise<HttpResponse> => {
    if (isDown) throw new Error("down"); // the proxy drops the connection: the client sees a network error
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    const r = await fetch(server.base + req.target, {
      method: req.method,
      headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      redirect: "manual",
    });
    const out: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      if (!HOP.has(k)) out[k] = v;
    });
    return { status: r.status, headers: out, body: await r.text() };
  };
  let api: ApiServer;
  try {
    api = await serveApi(forward);
  } catch (e) {
    await server.stop();
    throw e;
  }
  return {
    server,
    api,
    down: (on) => {
      isDown = on;
    },
    async stop() {
      await api.close();
      await server.stop();
    },
  };
}

/** sk_sync_state as stored in a profile (numbers and codes only), read from one of its pages. */
export async function syncState(page: Page): Promise<Record<string, unknown> | undefined> {
  return page.evaluate(
    async () => (await chrome.storage.local.get("sk_sync_state")).sk_sync_state as Record<string, unknown> | undefined,
  );
}

/** Any extension page of the profile that does not open the vault by itself (for reading or writing storage directly). */
export async function storagePage(p: Profile): Promise<Page> {
  const page = await p.ctx.newPage();
  await page.goto(`chrome-extension://${p.id}/devsync/index.html`);
  return page;
}
