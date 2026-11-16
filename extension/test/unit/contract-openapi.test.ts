// M0 API contract (docs/SYNC-DESIGN.md §5.4): api/openapi.yaml parses, every $ref resolves, every error code an
// operation lists exists with the right status, removed mechanisms stay removed, and the vectors agree with it.
import { describe, expect, it } from "vitest";
import {
  checkOpenapi,
  crossFileErrors,
  loadContract,
  nestedJson,
  operations,
  parseStrictJson,
  StrictJsonError,
  validate,
  wireExampleErrors,
  type J,
} from "../helpers/contract";

const { vectors, openapi } = loadContract();

describe("contract: api/openapi.yaml", () => {
  it("is OpenAPI 3.1 with every $ref resolving and every listed error code in the enum", () => {
    expect(checkOpenapi(openapi)).toEqual([]);
  });
  it("fork requires the Sixkey-New-Sig header and has no new_sig body member; GET /v1/vault is unconditional", () => {
    const fork = openapi.paths["/v1/devices/fork"].post;
    const params = fork.parameters.map((p: J) => (p.$ref ? openapi.components.parameters[p.$ref.split("/").pop()] : p));
    expect(params.find((p: J) => p.name === "Sixkey-New-Sig")).toMatchObject({ in: "header", required: true });
    expect(openapi.components.schemas.ForkRequest.properties.new_sig).toBeUndefined();
    const getVault = openapi.paths["/v1/vault"].get;
    expect(Object.keys(getVault.responses)).not.toContain("304");
    expect(JSON.stringify(getVault.parameters)).not.toMatch(/IfNoneMatch|If-None-Match/);
    for (const r of Object.values<J>(getVault.responses)) expect(r.headers?.ETag).toBeUndefined();
    expect(openapi.components.headers.ETag).toBeUndefined();
    expect(openapi.components.schemas.StatusResponse.required).toContain("devices_rev");
  });
  it("covers the 29 operations of §5.4, including DELETE /v1/vault/versions with pw_auth", () => {
    const ops = operations(openapi);
    expect(ops.length).toBe(29);
    const del = ops.find((x) => x.method === "DELETE" && x.path === "/v1/vault/versions");
    expect(del?.op["x-sixkey-auth"].pw_auth).toBe("required");
  });
  it("the checker catches broken references, unknown codes and removed endpoints", () => {
    const bad: J = structuredClone(openapi);
    bad.paths["/v1/vault"].put["x-sixkey-errors"]["409"].push("no_such_code");
    bad.paths["/v1/keys"].get.responses["200"].content["application/json"].schema.$ref = "#/components/schemas/Nope";
    bad.paths["/v1/time"] = { get: { ...openapi.paths["/healthz"].get, operationId: "time" } };
    bad.components.schemas.ErrorCode.enum.push("sensitive_locked");
    // revision 5 regressions: conditional GET, devices_changed_at, new_sig in the fork body
    const getVault = bad.paths["/v1/vault"].get;
    getVault.parameters.push({ name: "If-None-Match", in: "header", required: false, schema: { type: "string" } });
    getVault.responses["304"] = { description: "not modified" };
    getVault.responses["200"].headers = { ETag: { schema: { type: "string" } } };
    const status = bad.components.schemas.StatusResponse.properties;
    status.devices_changed_at = status.devices_rev;
    delete status.devices_rev;
    const fork = bad.paths["/v1/devices/fork"].post;
    fork.parameters = fork.parameters.filter((p: J) => p.$ref !== "#/components/parameters/SixkeyNewSig");
    bad.components.schemas.ForkRequest.properties.new_sig = { type: "string" };
    const errs = checkOpenapi(bad).join("\n");
    for (const needle of [
      "no_such_code",
      "Nope",
      "/v1/time",
      "sensitive_locked",
      "If-None-Match",
      "removed status 304",
      "removed header ETag",
      "devices_changed_at",
      "Sixkey-New-Sig",
      "new_sig must not",
    ])
      expect(errs).toContain(needle);
  });
  it("constants are readable as plain integers", () => {
    const c = openapi["x-sixkey-constants"];
    expect(c.MAX_ENVELOPE_BYTES.value).toBe(8_388_608);
    expect(c.PAD_BUCKET_BYTES.value).toBe(16_384);
  });
  it("vectors and contract agree (constants, wire formats, example bodies)", () => {
    expect(crossFileErrors(vectors, openapi)).toEqual([]);
  });
});

// ---- revision 15 (§0.0o, the M4 backend review) ---------------------------------------------------------------

// The same table as contract/py/test_contract.py. Escapes such as \\u0000 are written into the JSON text; the two
// cases built with String.fromCharCode put a raw lone surrogate into the text itself.
const STRICT_CASES: [string, string, boolean][] = [
  ["objects, arrays and literals", '{"a":1,"b":[1,2,{"c":null}],"d":true,"e":false}', true],
  ["an escaped surrogate pair and other escapes", '{"s":"\\ud83d\\ude00 \\u00e9 \\" \\\\ \\/ \\b\\f\\n\\r\\t"}', true],
  ["the safe-integer bounds and zero", '{"m":9007199254740991,"n":-9007199254740991,"z":0}', true],
  ["whitespace around the value", ' \t\n\r{"a":[ 1 , 2 ]}\r\n ', true],
  ["top-level scalars", '"plain"', true],
  ["keys that differ only in case", '{"a":1,"A":2}', true],
  ["__proto__ is an ordinary member", '{"__proto__":{"x":1}}', true],
  ["number-like text inside a string", '{"s":"1.5e3 NaN"}', true],
  ["duplicate key", '{"a":1,"a":1}', false],
  ["duplicate key after unescaping", '{"a":1,"\\u0061":2}', false],
  ["nested duplicate key", '{"x":[{"k":1,"k":2}]}', false],
  ["NaN", '{"n":NaN}', false],
  ["Infinity", '{"n":Infinity}', false],
  ["-Infinity", '{"n":-Infinity}', false],
  ["fraction", '{"n":1.0}', false],
  ["exponent", '{"n":1e3}', false],
  ["signed exponent", '{"n":1E+3}', false],
  ["negative fraction", '{"n":-0.5}', false],
  ["above 2^53 - 1", '{"n":9007199254740992}', false],
  ["below -(2^53 - 1)", '{"n":-9007199254740992}', false],
  ["escaped NUL in a value", '{"s":"a\\u0000b"}', false],
  ["escaped NUL in a key", '{"a\\u0000":1}', false],
  ["escaped lone high surrogate", '{"s":"\\ud800"}', false],
  ["escaped lone low surrogate", '{"s":"\\udc00x"}', false],
  ["escaped reversed pair", '{"s":"\\ude00\\ud83d"}', false],
  ["escaped lone surrogate in a key", '{"\\ud800":1}', false],
  ["raw lone surrogate in a value", '{"s":"' + String.fromCharCode(0xd800) + '"}', false],
  ["raw lone surrogate in a key", '{"' + String.fromCharCode(0xdfff) + '":1}', false],
  ["trailing comma", "[1,]", false],
  ["single quotes", "{'a':1}", false],
  ["text after the value", '{"a":1}x', false],
  ["empty text", "", false],
  ["leading zero", '{"a":01}', false],
  ["bad escape", '"\\x"', false],
  ["raw control character in a string", '"a\tb"', false],
  ["byte order mark", "\uFEFF{}", false],
];

describe("contract: revision 15 (§0.0o)", () => {
  it("strict JSON (A18, S14): JSON.parse's grammar plus integer tokens, no duplicate keys, NUL or lone surrogates", () => {
    for (const [name, text, ok] of STRICT_CASES) {
      let parsed: J;
      let threw: unknown;
      try {
        parsed = parseStrictJson(text);
      } catch (e) {
        threw = e;
      }
      if (ok) {
        expect(threw, name).toBeUndefined();
        expect(parsed, name).toEqual(JSON.parse(text));
        expect(Object.hasOwn(parsed, "__proto__") || name !== "__proto__ is an ordinary member", name).toBe(true);
      } else expect(threw, name).toBeInstanceOf(StrictJsonError);
    }
  });
  it("the four A18 counterexamples are rejected, and only because of the strict parse of the nested text", () => {
    const strict = vectors.groups.wire_examples.examples.filter((ex: J) => /A18\)$/.test(ex.why ?? ""));
    expect(strict.map((ex: J) => ex.why.split(":")[0])).toEqual([
      "duplicate object key inside the bundle text",
      "NUL character in a string of the envelope text",
      "lone surrogate in a string of the bundle text",
      "non-integer number token inside the envelope text",
    ]);
    for (const ex of strict) {
      expect(ex.expect_valid).toBe(false);
      expect(wireExampleErrors(openapi, ex).join("\n")).toContain("not strict JSON text");
      nestedJson.parse = JSON.parse;
      try {
        expect(wireExampleErrors(openapi, ex), ex.why).toEqual([]);
      } finally {
        nestedJson.parse = parseStrictJson;
      }
    }
  });
  it("enrollment times are minute precision: created_at floored, expires_at rounded up (A13)", () => {
    const S = openapi.components.schemas;
    const created = {
      request_id: "6c9f2a3e-1b4d-4c8e-9a7f-2d5b8e1c0f3a",
      expires_at: 1792052220000,
      server_time: 1792051594787,
    };
    expect(validate(S.EnrollCreateResponse, created, openapi)).toEqual([]);
    expect(
      validate(S.EnrollCreateResponse, { ...created, expires_at: 1792051594787 + 600_000 }, openapi).join(),
    ).toContain("multiple of 60000");
    const item = {
      request_id: created.request_id,
      created_at: 1792051560000,
      expires_at: 1792052220000,
      state: "pending",
    };
    expect(validate(S.EnrollListItem, item, openapi)).toEqual([]);
    expect(validate(S.EnrollListItem, { ...item, expires_at: item.expires_at + 1 }, openapi).join()).toContain(
      "multiple of 60000",
    );
    expect(validate(S.EnrollListItem, { ...item, created_at: item.created_at + 1 }, openapi).join()).toContain(
      "multiple of 60000",
    );
  });
  it("every operation lists 413 too_large, bodyless ones too (A9), and the checker notices a missing one", () => {
    for (const { op } of operations(openapi)) {
      expect(op["x-sixkey-errors"]["413"], op.operationId).toEqual(["too_large"]);
      expect(op.responses["413"], op.operationId).toEqual({ $ref: "#/components/responses/Error" });
    }
    const bad: J = structuredClone(openapi);
    delete bad.paths["/healthz"].get["x-sixkey-errors"]["413"];
    delete bad.paths["/v1/keys"].get["x-sixkey-errors"]["413"];
    const errs = checkOpenapi(bad);
    expect(errs.filter((e) => e.includes("every operation lists 413 too_large"))).toEqual([
      "GET /healthz: every operation lists 413 too_large, bodyless ones too (§5.4, §0.0o A9)",
      "GET /v1/keys: every operation lists 413 too_large, bodyless ones too (§5.4, §0.0o A9)",
    ]);
    expect(errs).toContain("GET /healthz: error response 413 lists no codes"); // the 413 response left without a code
  });
  it("rate limits (A10, A21, A22): per-session buckets, the OTP verify key, the invalid-proof answer, enrolling devices", () => {
    const rl = openapi["x-sixkey-rate-limits"];
    const byId = Object.fromEntries(rl.limits.map((l: J) => [l.id, l]));
    expect(byId.session_writes).toMatchObject({ key: "account session", limit: 30, window_s: 60 });
    expect(byId.session_reads).toMatchObject({ key: "account session", limit: 60, window_s: 60 });
    expect(byId.session_writes.applies_to).toMatch(/POST \/v1\/vault\/init.*POST \/v1\/enroll\/requests/);
    expect(byId.session_reads.applies_to).toContain("GET /v1/account");
    expect(byId.otp_verify_code).toMatchObject({ key: "email (HMAC), reset by a new code", limit: 5, window_s: null });
    expect(byId.otp_verify_code.applies_to).toContain("malformed email is 401 otp_invalid");
    expect(rl.rules.join("\n")).toMatch(
      /invalid_proof_per_device; past the limit the request gets 429 rate_limited with Retry-After and never touches the database/,
    );
    expect(rl.rules.join("\n")).toContain("keyed enroll:{rid}");
  });
});

// ---- revision 16 (§0.0p, the M4 fix pass) ----------------------------------------------------------------------

describe("contract: revision 16 (§0.0p)", () => {
  it("rate limits: the three M4 limits, two of them byte budgets, and the reworded and new rules", () => {
    const rl = openapi["x-sixkey-rate-limits"];
    const byId = Object.fromEntries(rl.limits.map((l: J) => [l.id, l]));
    expect(byId.proof_valid_account).toMatchObject({ key: "account", limit: 60, window_s: 60, source: "m4" });
    expect(byId.proof_valid_account.unit).toBeUndefined();
    expect(byId.proof_valid_account.applies_to).toMatch(
      /valid password_auth or recovery_auth.*revoke and rotate included.*invalid proof never enters it/,
    );
    expect(byId.device_envelope_bytes).toMatchObject({
      key: "device",
      limit: 268_435_456,
      window_s: 3600,
      unit: "bytes",
      source: "m4",
    });
    expect(byId.device_envelope_bytes.applies_to).toMatch(/without a valid proof.*never refunded/); // exact text: revision 18 below
    expect(byId.account_envelope_bytes).toMatchObject({
      key: "account",
      limit: 1_073_741_824,
      window_s: 3600,
      unit: "bytes",
      source: "m4",
    });
    expect(byId.account_envelope_bytes.applies_to).toMatch(/every .*refunded when the request ends in 401 or 403/);
    expect(rl.limits.filter((l: J) => l.unit !== undefined).map((l: J) => l.id)).toEqual([
      "device_envelope_bytes",
      "account_envelope_bytes",
      "session_envelope_bytes",
    ]); // + revision 18
    expect(rl.limits.filter((l: J) => l.source === "m4").map((l: J) => l.id)).toEqual([
      "proof_valid_account",
      "device_envelope_bytes",
      "account_envelope_bytes",
      "session_envelope_bytes",
    ]);
    const rules = rl.rules.join("\n");
    expect(rules).not.toContain("never subject to the account-level ceiling");
    expect(rules).toContain(
      "Revocation and rotation are not subject to account_writes (F8), but they are subject to proof_valid_account and account_envelope_bytes; an invalid proof never enters proof_valid_account",
    );
    expect(rules).toContain("with one exception: device_envelope_bytes keeps what");
    expect(rules).toContain(
      "An IP key counts an IPv4 address, or the /64 of an IPv6 address; an IPv4-mapped IPv6 address counts as its IPv4 address",
    );
    expect(rules).toContain(
      "Each limiter table holds at most 200000 keys; a request that needs a new key once a table is full gets 429 rate_limited",
    );
  });
  it("the checker rejects malformed rate limits", () => {
    const bad: J = structuredClone(openapi);
    const lims = bad["x-sixkey-rate-limits"].limits;
    const byId = (id: string) => lims.find((l: J) => l.id === id);
    byId("device_envelope_bytes").unit = "kib";
    byId("account_envelope_bytes").window_s = null;
    byId("proof_valid_account").source = "m5";
    byId("otp_send_ip").limit = 0;
    byId("device_writes").burst = 5;
    lims.push({ ...byId("device_reads") });
    const errs = checkOpenapi(bad);
    for (const needle of [
      "rate limit device_envelope_bytes: unit must be bytes when present",
      "rate limit account_envelope_bytes: a byte budget needs a window",
      "rate limit proof_valid_account: source must be doc or m4",
      "rate limit otp_send_ip: limit must be a positive integer",
      "rate limit device_writes: unknown members burst",
      "rate limit device_reads: id missing or duplicate",
    ])
      expect(errs).toContain(needle);
  });
  it("request rules: the JSON Content-Type rule, and every body operation lists its 422", () => {
    const rr = openapi["x-sixkey-request-rules"];
    expect(rr.map((r: J) => r.id)).toEqual(["json_content_type"]);
    expect(rr[0]).toMatchObject({
      applies_to: "with_request_body",
      status: 422,
      code: "invalid_request",
      source: "doc",
    });
    expect(rr[0].rule).toMatch(
      /the media type is application\/json, case-insensitive, optionally followed by one parameter charset=utf-8 .*before reading the body; otherwise 422 invalid_request/,
    ); // revision 18 wording
    const bodied = operations(openapi).filter(({ op }) => op.requestBody);
    expect(bodied.length).toBe(19);
    for (const { op } of bodied) expect(op["x-sixkey-errors"]["422"], op.operationId).toContain("invalid_request");
    const bad: J = structuredClone(openapi);
    const approve = bad.paths["/v1/enroll/requests/{rid}/approve"].post;
    approve["x-sixkey-errors"]["422"] = ["key_mismatch"];
    bad.paths["/v1/auth/otp"].post.requestBody.content["text/plain"] = { schema: { type: "string" } };
    let errs = checkOpenapi(bad);
    expect(errs).toContain(
      "POST /v1/enroll/requests/{rid}/approve: request rule json_content_type needs 422 invalid_request in x-sixkey-errors",
    );
    expect(errs).toContain("POST /v1/auth/otp: a request body must be application/json only");
    const bad2: J = structuredClone(openapi);
    bad2["x-sixkey-request-rules"][0].status = 400;
    errs = checkOpenapi(bad2);
    expect(errs).toContain("request rule json_content_type: invalid_request is not a 400 code");
    const bad3: J = structuredClone(openapi);
    delete bad3["x-sixkey-request-rules"];
    expect(checkOpenapi(bad3)).toContain("x-sixkey-request-rules: json_content_type is missing");
  });
  it("account session aud and role, the sources of 503, and the reject-all bound", () => {
    expect(openapi.components.securitySchemes.accountSession.description).toContain(
      "aud must be exactly the string authenticated (not a list) and role must be authenticated",
    );
    expect(openapi.components.securitySchemes.accountSession.description).not.toContain("aud = authenticated");
    const u = openapi["x-sixkey-error-codes"].unavailable;
    expect(u).toMatchObject({ status: 503, applies_to: "any", details: ["retry_after"] });
    for (const source of [
      "waiting longer than 5 s for a database connection",
      "waiting longer than 10 s for one of the slots of the three 9 MiB endpoints",
      "a request body not read within 60 s",
      "a retryable database conflict (deadlock or serialization failure)",
    ])
      expect(u.meaning).toContain(source);
    expect(u.meaning).toContain(
      "Past uvicorn's limit_concurrency the server process itself answers 503 without a JSON error body",
    );
    expect(u.meaning).toContain("clients treat any 503 as unavailable");
    const rejectAll = openapi.paths["/v1/enroll/reject-all"].post.description;
    expect(rejectAll).toContain("created_at <= minute_floor(Sixkey-Ts)");
    expect(rejectAll).toContain(
      "The bound is the client-signed Sixkey-Ts, not the server's clock, so clients must sign with the server-corrected time (§4.14)",
    );
  });
});

// ---- revision 18 (§0.0r, the M4 cleanup round) -----------------------------------------------------------------

const R18_TEXTS: Record<string, string> = {
  device_envelope_bytes:
    "PUT /v1/vault and POST /v1/keys/rotate requests without a valid proof, counted by the whole request body including bodies that fail to parse (422/413); never refunded",
  account_envelope_bytes:
    "every PUT /v1/vault and POST /v1/keys/rotate request, valid proof or not, counted by the whole request body including bodies that fail to parse; refunded when the request ends in 401 or 403",
  session_envelope_bytes:
    "POST /v1/vault/init only, parsed or not, counted by the whole request body; refunded when the request ends in 401 or 403",
};
const R18_RULES = [
  "Requests rejected with 401 or 403 never count against any quota, with one exception: device_envelope_bytes keeps what the PUT /v1/vault and POST /v1/keys/rotate requests it applies to used (§5.5, §0.0p, §0.0r).",
  "A limit with unit bytes counts the whole request body's bytes, including a body that does not parse (422 or 413); every other limit counts requests.",
  "A request whose body does not parse carries no valid proof and pays every bucket that applies to it (device_writes, the account ceiling, device_envelope_bytes and account_envelope_bytes; for init, session_writes and session_envelope_bytes).",
  "An enrolling device (Sixkey-Enroll) is limited like a device keyed enroll:{rid} (device_writes, device_reads); it does not count toward account_reads or account_writes (§5.5, §0.0r A21).",
  "Each limiter table holds at most 200000 keys; a request that needs a new key once a table is full gets 429 rate_limited with Retry-After 60 (§5.5, §0.0p, §0.0r, M4 S5).",
];
const R18_CONTENT_TYPE =
  "the media type is application/json, case-insensitive, optionally followed by one parameter charset=utf-8 (case-insensitive), with optional whitespace around the ';'. charset=utf8, a quoted value, any other parameter, a trailing ';' and 'charset = utf-8' are 422.";

describe("contract: revision 18 (§0.0r)", () => {
  it("byte budgets: init only in session_envelope_bytes, whole bodies counted; the reworded and new rules; full tables", () => {
    const rl = openapi["x-sixkey-rate-limits"];
    const byId = Object.fromEntries(rl.limits.map((l: J) => [l.id, l]));
    for (const [id, text] of Object.entries(R18_TEXTS)) expect(byId[id].applies_to, id).toBe(text);
    expect(byId.session_envelope_bytes).toEqual({
      id: "session_envelope_bytes",
      key: "account session",
      limit: 1_073_741_824,
      window_s: 3600,
      unit: "bytes",
      applies_to: R18_TEXTS.session_envelope_bytes,
      section: "§5.5 (§0.0r, M4 RR1)",
      source: "m4",
    });
    for (const id of ["device_envelope_bytes", "account_envelope_bytes"])
      expect(byId[id].applies_to, id).not.toContain("init");
    for (const rule of R18_RULES) expect(rl.rules).toContain(rule);
    const rules = rl.rules.join("\n");
    expect(rules).not.toContain("counts toward the account ceiling");
    expect(rules).not.toContain("counts request bytes;");
    expect(
      byId.otp_verify_code.applies_to.endsWith(
        "; if the counter table is full and this email has no counter yet, 429 rate_limited with Retry-After 60, and the provider is not asked",
      ),
    ).toBe(true);
    expect(openapi.paths["/v1/auth/verify"].post["x-sixkey-errors"]["429"]).toContain("rate_limited");
    expect(openapi["x-sixkey-request-rules"][0].rule).toContain(R18_CONTENT_TYPE);
  });
  it("the checker rejects a rate-limit rule that names a bucket the table does not have", () => {
    const bad: J = structuredClone(openapi);
    bad["x-sixkey-rate-limits"].limits = bad["x-sixkey-rate-limits"].limits.filter(
      (l: J) => l.id !== "session_envelope_bytes",
    );
    bad["x-sixkey-rate-limits"].rules.push("Rotation also pays rotate_bytes.");
    const errs = checkOpenapi(bad);
    for (const name of ["session_envelope_bytes", "rotate_bytes"])
      expect(errs).toContain(`rate-limit rule names ${name}, which is no limit id, error code or schema property`);
  });
});
