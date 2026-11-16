// The real sync API server (api/server, milestone M4) for the live suites: test/live (the engine in Node) and test/sync
// (the extension in Chromium). Each call starts a private PostgreSQL cluster in a new temporary directory
// (api/server/scripts/pg.sh: a unix socket only, no TCP port), migrates a database in it, and runs exactly
// `python -m sixkey_server` with the FakeAuthProvider (SIXKEY_ENV=dev), bound to a loopback port; stop() removes it all.
//
// Needs Python 3.14 with the server's dependencies and the PostgreSQL 14+ binaries (api/server/README.md). The Python is
// SIXKEY_API_PYTHON if set, else api/server/.venv/bin/python (`make venv`). Nothing here is skipped quietly: without
// them, starting fails with what is missing.
//
// The server process is the unmodified one, with its default limits. Its per-IP limits on one-time codes (20 sends an
// hour) live in its memory, so each suite file starts its own server. No byte code is written (PYTHONDONTWRITEBYTECODE).
// The server's log (route, status and error code per request, never a body, a header value or an address) is kept in
// the temporary directory while it runs.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, closeSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const API_DIR = resolve(import.meta.dirname, "../../../api/server");

export type LiveServer = {
  /** Where the server listens (http://127.0.0.1:port). */
  readonly base: string;
  /** The API origin it is configured with: the host every request signature covers (§5.2). */
  readonly origin: string;
  /** The last one-time code the FakeAuthProvider mailed to `email`. */
  inbox(email: string): string;
  /** The database goes away (the server then answers 503 with Retry-After), and comes back. */
  stopDatabase(): void;
  startDatabase(): void;
  /** The server process stops and starts again over the same database (its in-memory limits start afresh). */
  restart(o?: { minClientVersion?: string }): Promise<void>;
  stop(): Promise<void>;
};

/** A free TCP port on 127.0.0.1. */
export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function python(): string {
  const p = process.env.SIXKEY_API_PYTHON ?? join(API_DIR, ".venv/bin/python");
  if (!existsSync(p))
    throw new Error(
      `the live suites need the API server's Python: ${p} does not exist (run \`make venv\` in api/server, or set SIXKEY_API_PYTHON)`,
    );
  return p;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, what: string): void {
  const r = spawnSync(cmd, args, { cwd: API_DIR, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
}

export async function startLiveServer(
  o: { origin?: string; port?: number; minClientVersion?: string } = {},
): Promise<LiveServer> {
  const py = python();
  const dir = mkdtempSync(join(tmpdir(), "sixkey-live-"));
  const pgPort = 50_000 + Math.floor(Math.random() * 9_000); // only the socket file's name: nothing listens on TCP
  const pgEnv = { ...process.env, SIXKEY_PGROOT: join(dir, "pg"), SIXKEY_PGPORT: String(pgPort) };
  const run_ = join(dir, "pg", "run");
  const pg = (verb: string) => run("bash", ["scripts/pg.sh", verb], pgEnv, `pg.sh ${verb}`);
  pg("start");
  const pyEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: API_DIR };
  run(
    py,
    [
      "-m",
      "sixkey_server.migrate",
      "--dsn",
      `postgresql://postgres@/postgres?host=${run_}&port=${pgPort}`,
      "--local-auth-stub",
      "--create-db",
      "sixkey_live",
    ],
    pyEnv,
    "migrate",
  );
  const port = o.port ?? (await freePort());
  const base = `http://127.0.0.1:${port}`;
  const origin = o.origin ?? base;
  const inboxFile = join(dir, "otp-inbox.jsonl");
  let child: ChildProcess | null = null;
  let minClientVersion = o.minClientVersion;

  async function launch(): Promise<void> {
    const log = openSync(join(dir, "server.log"), "a");
    child = spawn(py, ["-m", "sixkey_server"], {
      cwd: API_DIR,
      env: {
        ...pyEnv,
        SIXKEY_ENV: "dev",
        SIXKEY_BIND: `127.0.0.1:${port}`,
        SIXKEY_API_ORIGIN: origin,
        SIXKEY_FAKE_INBOX_FILE: inboxFile,
        SIXKEY_DATABASE_DSN: `postgresql://sixkey_api@/sixkey_live?host=${run_}&port=${pgPort}`,
        SIXKEY_FAKE_AUTH_DSN: `postgresql://sixkey_fake_auth@/sixkey_live?host=${run_}&port=${pgPort}`,
        ...(minClientVersion ? { SIXKEY_MIN_CLIENT_VERSION: minClientVersion } : {}),
      },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    const exited = new Promise<never>((_, rej) =>
      child!.once("exit", (c) =>
        rej(new Error(`the API server exited (${c}):\n${readFileSync(join(dir, "server.log"), "utf8").slice(-2000)}`)),
      ),
    );
    for (let i = 0; i < 150; i++) {
      const ok = await Promise.race([
        fetch(`${base}/healthz`).then(
          (r) => r.ok,
          () => false,
        ),
        exited,
      ]);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`the API server did not answer on ${base}`);
  }
  async function kill(): Promise<void> {
    const c = child;
    child = null;
    if (!c || c.exitCode !== null) return;
    const gone = new Promise<void>((r) => c.once("exit", () => r()));
    c.kill("SIGTERM");
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
    if (c.exitCode === null) c.kill("SIGKILL");
  }

  try {
    await launch();
  } catch (e) {
    await kill();
    pg("stop");
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return {
    base,
    origin,
    inbox(email: string): string {
      const lines = existsSync(inboxFile) ? readFileSync(inboxFile, "utf8").trim().split("\n").reverse() : [];
      for (const l of lines) {
        const x = JSON.parse(l) as { email: string; code: string };
        if (x.email === email.toLowerCase()) return x.code;
      }
      throw new Error("no one-time code for this address in the inbox");
    },
    stopDatabase: () => pg("stop"),
    startDatabase: () => pg("start"),
    async restart(r = {}) {
      await kill();
      if (r.minClientVersion !== undefined) minClientVersion = r.minClientVersion;
      await launch();
    },
    async stop() {
      await kill();
      pg("stop");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
