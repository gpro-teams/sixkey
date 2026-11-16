// The site rules' origin for the browser tests of the updater (TOTP autofill Stage 3, AF3-U2; test/e2e/rules-update.spec.ts):
// https at rules.fix.test, the dev and e2e builds' rules origin (scripts/rules-update.mjs RULES_ORIGINS), played by a server
// on a free port of the loopback address with a throw-away self-signed certificate (made with openssl, as servePages'
// TLS host; the browser is started with --ignore-certificate-errors and maps the name to this port). It serves what the
// test puts in `files` (by path: /v1/manifest.json, /v1/bundle-<version>.json), with `Access-Control-Allow-Origin: *`
// unless the test turns it off (no host permission covers the origin, so the browser refuses such an answer), or a
// redirect when the test asks for one; and it records each request's method, path and headers.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RulesServer = {
  port: number;
  /** What each path answers: its bytes (200), or a redirect to another path. */
  files: Map<string, Uint8Array | string | { redirect: string }>;
  /** Whether answers carry `Access-Control-Allow-Origin: *` (true unless turned off). */
  cors: { on: boolean };
  /** Every request, in order. */
  asked: { method: string; path: string; headers: IncomingHttpHeaders }[];
  close(): Promise<void>;
};

export async function serveRules(): Promise<RulesServer> {
  const dir = mkdtempSync(join(tmpdir(), "sixkey-rules-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "k.pem"),
      "-out",
      join(dir, "c.pem"),
      "-days",
      "2",
      "-subj",
      "/CN=rules.fix.test",
      "-addext",
      "subjectAltName=DNS:rules.fix.test",
    ],
    { stdio: "ignore" },
  );
  const files: RulesServer["files"] = new Map();
  const cors = { on: true };
  const asked: RulesServer["asked"] = [];
  const server: Server = createServer(
    { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) },
    (req, res) => {
      const path = new URL(req.url ?? "/", "https://rules.fix.test").pathname;
      asked.push({ method: req.method ?? "", path, headers: req.headers });
      if (cors.on) res.setHeader("access-control-allow-origin", "*");
      const f = files.get(path);
      if (f === undefined) {
        res.statusCode = 404;
        return void res.end("not found");
      }
      if (typeof f === "object" && "redirect" in f) {
        res.statusCode = 302;
        res.setHeader("location", f.redirect);
        return void res.end();
      }
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(typeof f === "string" ? f : Buffer.from(f));
    },
  );
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  return {
    port: (server.address() as { port: number }).port,
    files,
    cors,
    asked,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
