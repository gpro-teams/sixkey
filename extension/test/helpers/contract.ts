// Loader and checks for the Phase 1 M0 sync contract (docs/SYNC-DESIGN.md §5, §8.1).
// Reads the same files as contract/py/sixkey_contract.py: the shared vectors, their JSON Schema and api/openapi.yaml
// (written in JSON syntax, which is valid YAML 1.2, so no YAML parser is needed on either side).
// The JSON Schema validator implements one small keyword subset and throws on anything else, exactly like the Python one.
import { readFileSync } from "node:fs";

// Parsed JSON is open-ended; the checks below inspect it structurally.
export type J = any;

const ROOT = new URL("../../../", import.meta.url);
export const CONTRACT_FILES = {
  vectors: new URL("contract/vectors/sync-v1.json", ROOT),
  vectorSchema: new URL("contract/vectors/sync-v1.schema.json", ROOT),
  openapi: new URL("api/openapi.yaml", ROOT),
};

export function loadJson(u: URL): J {
  return JSON.parse(readFileSync(u, "utf8"));
}

export function loadContract(): { vectors: J; vectorSchema: J; openapi: J } {
  return {
    vectors: loadJson(CONTRACT_FILES.vectors),
    vectorSchema: loadJson(CONTRACT_FILES.vectorSchema),
    openapi: loadJson(CONTRACT_FILES.openapi),
  };
}

// ---------------------------------------------------------------------------------------------- encodings

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function fromHex(h: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(h)) throw new Error("bad hex");
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}
export const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
/** Strict base64url (M0-NOTES N19): no padding, alphabet [A-Za-z0-9_-], length % 4 != 1, canonical trailing bits. */
export function fromB64u(s: string): Uint8Array {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("bad base64url");
  const b = new Uint8Array(Buffer.from(s, "base64url"));
  if (b64u(b) !== s) throw new Error("non-canonical base64url");
  return b;
}

// ---------------------------------------------------------------------------------------------- JSON Schema subset

const ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "$defs",
  "format",
  "examples",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "contentMediaType",
]);
const ASSERTIONS = new Set([
  "$ref",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "enum",
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "contains",
  "contentSchema",
  "if",
  "then",
  "else", // revision 7: the enrollment views require fields by state (§0.0f F-10)
]);

export function jsonEqual(a: J, b: J): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x: J, i: number) => jsonEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}

function isType(v: J, t: string): boolean {
  switch (t) {
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "integer":
      return Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    default:
      throw new Error(`unknown type ${t}`);
  }
}

export function resolvePointer(root: J, ref: string): J {
  if (typeof ref !== "string" || !ref.startsWith("#")) throw new Error(`only local $ref is supported: ${ref}`);
  if (ref === "#" || ref === "#/") return root;
  let node = root;
  for (const raw of ref.slice(2).split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node !== null && typeof node === "object" && Object.hasOwn(node, part)) node = node[part];
    else throw new Error(`$ref does not resolve: ${ref}`);
  }
  return node;
}

/** Throws on any keyword the two validators do not implement, so a schema never silently relies on one. */
export function lintSchema(schema: J, where: string): void {
  if (typeof schema === "boolean") return;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema))
    throw new Error(`${where}: a schema must be an object or a boolean`);
  for (const [k, v] of Object.entries(schema)) {
    if (k.startsWith("x-")) continue;
    if (!ANNOTATIONS.has(k) && !ASSERTIONS.has(k))
      throw new Error(`${where}: unsupported schema keyword ${JSON.stringify(k)}`);
    if (k === "properties" || k === "$defs")
      for (const [n, sub] of Object.entries(v as object)) lintSchema(sub, `${where}/${k}/${n}`);
    else if (["items", "additionalProperties", "not", "contains", "contentSchema", "if", "then", "else"].includes(k))
      lintSchema(v, `${where}/${k}`);
    else if (["oneOf", "anyOf", "allOf"].includes(k))
      (v as J[]).forEach((sub, i) => lintSchema(sub, `${where}/${k}/${i}`));
  }
}

export class StrictJsonError extends Error {}

const MAX_SAFE = 2n ** 53n - 1n;
const NUMBER_TOKEN = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * The JSON every party agrees on (§2.3 N20, §5.4, §0.0o A18): JSON.parse's grammar (ECMA-404: no NaN, Infinity,
 * comments, trailing commas or BOM), every number token an integer literal with |n| <= 2^53 - 1, no duplicate object
 * key (compared after unescaping), and no NUL or lone surrogate in any key or string. JSON.parse cannot see duplicate
 * keys or number spellings, so this is a small recursive-descent parser. Throws StrictJsonError.
 */
export function parseStrictJson(text: string): J {
  let i = 0;
  const fail = (why: string): never => {
    throw new StrictJsonError(`${why} (offset ${i})`);
  };
  const ws = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const string = (): string => {
    i++; // the opening quote
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const c = text[i]!;
      if (c === '"') break;
      if (c < " ") fail("control character in a string");
      if (c !== "\\") {
        out += c;
        i++;
        continue;
      }
      const e = text[i + 1];
      if (e === "u") {
        const hex4 = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex4)) fail("bad \\u escape");
        out += String.fromCharCode(parseInt(hex4, 16));
        i += 6;
      } else if (e !== undefined && e in ESCAPES) {
        out += ESCAPES[e];
        i += 2;
      } else fail("bad escape");
    }
    i++; // the closing quote
    if (out.includes("\u0000")) fail("NUL character in a string");
    if (/[\uD800-\uDFFF]/u.test(out)) fail("lone surrogate in a string"); // with /u a pair is one code point outside the class
    return out;
  };
  const value = (): J => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj: Record<string, J> = {};
      const seen = new Set<string>();
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("expected a key");
        const k = string();
        if (seen.has(k)) fail(`duplicate object key ${JSON.stringify(k)}`);
        seen.add(k);
        ws();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        Object.defineProperty(obj, k, { value: value(), enumerable: true, writable: true, configurable: true }); // __proto__ stays an own member, as in JSON.parse
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") {
          i++;
          return obj;
        } else fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr: J[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") {
          i++;
          return arr;
        } else fail("expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    for (const [lit, v] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return v;
      }
    }
    NUMBER_TOKEN.lastIndex = i;
    const m = NUMBER_TOKEN.exec(text);
    if (!m) return fail("unexpected token");
    if (m[1] !== undefined || m[2] !== undefined) fail(`non-integer number token ${m[0]}`);
    const big = BigInt(m[0]);
    if (big > MAX_SAFE || big < -MAX_SAFE) fail("integer outside the safe range");
    i += m[0].length;
    return Number(m[0]);
  };
  let v: J;
  try {
    v = value();
  } catch (e) {
    if (e instanceof RangeError) throw new StrictJsonError("nesting too deep");
    throw e;
  }
  ws();
  if (i !== text.length) fail("text after the JSON value");
  return v;
}

/** How validate() parses a contentSchema text. Tests swap in JSON.parse to show a counterexample fails only by strictness. */
export const nestedJson: { parse: (text: string) => J } = { parse: parseStrictJson };

export function validate(schema: J, inst: J, root: J, path = "$"): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: not allowed`];
  const s = schema;
  const errs: string[] = [];
  if ("$ref" in s) errs.push(...validate(resolvePointer(root, s.$ref), inst, root, path));
  if ("type" in s) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => isType(inst, t))) return [...errs, `${path}: expected ${types.join("|")}`];
  }
  if ("enum" in s && !s.enum.some((e: J) => jsonEqual(inst, e)))
    errs.push(`${path}: not one of ${JSON.stringify(s.enum)}`);
  if ("const" in s && !jsonEqual(inst, s.const)) errs.push(`${path}: must equal ${JSON.stringify(s.const)}`);
  if (typeof inst === "string") {
    const n = [...inst].length; // code points, as in JSON Schema
    if ("minLength" in s && n < s.minLength) errs.push(`${path}: shorter than ${s.minLength}`);
    if ("maxLength" in s && n > s.maxLength) errs.push(`${path}: longer than ${s.maxLength}`);
    if ("pattern" in s && !new RegExp(s.pattern, "u").test(inst)) errs.push(`${path}: does not match ${s.pattern}`);
    if ("contentSchema" in s && s.contentMediaType === "application/json") {
      let parsed: J;
      try {
        parsed = nestedJson.parse(inst); // §0.0o A18 and M4 review S14: nested texts are parsed strictly
      } catch (e) {
        errs.push(`${path}: not strict JSON text (${(e as Error).message})`);
        parsed = undefined;
      }
      if (parsed !== undefined) errs.push(...validate(s.contentSchema, parsed, root, `${path}<json>`));
    }
  }
  if (isType(inst, "number")) {
    if ("minimum" in s && inst < s.minimum) errs.push(`${path}: below ${s.minimum}`);
    if ("maximum" in s && inst > s.maximum) errs.push(`${path}: above ${s.maximum}`);
    if ("multipleOf" in s && inst % s.multipleOf !== 0) errs.push(`${path}: not a multiple of ${s.multipleOf}`);
  }
  if (Array.isArray(inst)) {
    if ("minItems" in s && inst.length < s.minItems) errs.push(`${path}: fewer than ${s.minItems} items`);
    if ("maxItems" in s && inst.length > s.maxItems) errs.push(`${path}: more than ${s.maxItems} items`);
    if (s.uniqueItems)
      for (let i = 0; i < inst.length; i++)
        for (let j = i + 1; j < inst.length; j++)
          if (jsonEqual(inst[i], inst[j])) errs.push(`${path}: items ${i} and ${j} are equal`);
    if ("items" in s)
      inst.forEach((item: J, i: number) => errs.push(...validate(s.items, item, root, `${path}[${i}]`)));
    if ("contains" in s && !inst.some((item: J) => validate(s.contains, item, root, path).length === 0))
      errs.push(`${path}: no item matches 'contains'`);
  }
  if (isType(inst, "object")) {
    for (const r of s.required ?? []) if (!Object.hasOwn(inst, r)) errs.push(`${path}: missing ${JSON.stringify(r)}`);
    const props = s.properties ?? {};
    for (const [k, v] of Object.entries(inst)) {
      if (Object.hasOwn(props, k)) errs.push(...validate(props[k], v, root, `${path}.${k}`));
      else if ("additionalProperties" in s) errs.push(...validate(s.additionalProperties, v, root, `${path}.${k}`));
    }
  }
  for (const sub of s.allOf ?? []) errs.push(...validate(sub, inst, root, path));
  if ("anyOf" in s && !s.anyOf.some((sub: J) => validate(sub, inst, root, path).length === 0))
    errs.push(`${path}: matches no anyOf branch`);
  if ("oneOf" in s) {
    const ok = s.oneOf.filter((sub: J) => validate(sub, inst, root, path).length === 0).length;
    if (ok !== 1) errs.push(`${path}: matches ${ok} oneOf branches, expected exactly 1`);
  }
  if ("not" in s && validate(s.not, inst, root, path).length === 0) errs.push(`${path}: matches 'not'`);
  if ("if" in s) {
    const branch = validate(s.if, inst, root, path).length === 0 ? s.then : s.else;
    if (branch !== undefined) errs.push(...validate(branch, inst, root, path));
  }
  return errs;
}

// ---------------------------------------------------------------------------------------------- OpenAPI checks

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

export function operations(o: J): { method: string; path: string; op: J }[] {
  const out: { method: string; path: string; op: J }[] = [];
  for (const [p, item] of Object.entries<J>(o.paths))
    for (const [m, op] of Object.entries<J>(item))
      if (HTTP_METHODS.includes(m)) out.push({ method: m.toUpperCase(), path: p, op });
  return out;
}

function walk(node: J, fn: (n: J, path: string) => void, path = "#"): void {
  fn(node, path);
  if (Array.isArray(node)) node.forEach((v, i) => walk(v, fn, `${path}/${i}`));
  else if (node !== null && typeof node === "object")
    for (const [k, v] of Object.entries(node)) walk(v, fn, `${path}/${k}`);
}

export function deref(o: J, node: J): J {
  let n = node;
  while (n !== null && typeof n === "object" && "$ref" in n && Object.keys(n).length === 1)
    n = resolvePointer(o, n.$ref);
  return n;
}

function schemaProps(o: J, schema: J): { props: Set<string>; req: Set<string> } {
  const s = deref(o, schema);
  const props = new Set<string>(Object.keys(s.properties ?? {}));
  const req = new Set<string>(s.required ?? []);
  for (const sub of s.allOf ?? []) {
    const r = schemaProps(o, sub);
    r.props.forEach((x) => props.add(x));
    r.req.forEach((x) => req.add(x));
  }
  return { props, req };
}

function requiresServerTime(o: J, schema: J): boolean {
  const s = deref(o, schema);
  if (s.oneOf) return s.oneOf.every((b: J) => requiresServerTime(o, b));
  return (s.required ?? []).includes("server_time") && Object.hasOwn(s.properties ?? {}, "server_time");
}

export const requestSchema = (op: J): J => op.requestBody?.content?.["application/json"]?.schema;

const REQUIRED_CONSTANTS = [
  "MAX_ENVELOPE_BYTES",
  "MAX_BODY_BYTES_VAULT",
  "MAX_BODY_BYTES_OTHER",
  "PAD_BUCKET_BYTES",
  "DEVICE_NAME_MAX_CODE_POINTS",
  "DEVICE_NAME_PADDED_BYTES",
  "KEYRING_PREVIOUS_MAX",
  "KVER_MAX_JUMP",
  "PBKDF2_MIN_ITERATIONS",
  "PBKDF2_MAX_ITERATIONS",
  "SIG_WINDOW_S",
  "ENROLL_TTL_S",
];

const AUTH_TO_SECURITY: Record<string, string[][]> = {
  "none/none": [],
  "none/required": [["accountSession"]],
  "registration/required": [["accountSession", "registrationSignature"]],
  "device/none": [["deviceSignature"]],
  "device/step_up": [["accountSession", "deviceSignature"]],
  "enroll/none": [["enrollSignature"]],
  "device_or_enroll/none": [["deviceSignature"], ["enrollSignature"]],
};

const RATE_LIMIT_MEMBERS = new Set(["id", "key", "limit", "window_s", "unit", "applies_to", "section", "source"]);
const REQUEST_RULE_MEMBERS = ["applies_to", "code", "id", "rule", "section", "source", "status"];
const posInt = (v: J): boolean => Number.isInteger(v) && v > 0;
const text = (v: J): boolean => typeof v === "string" && v.length > 0;

/**
 * x-sixkey-rate-limits (§5.5): rules are sentences; each limit has a unique id, a positive integer limit, a window in
 * seconds or null, a key, what it applies to, a section, source doc or m4 (§0.0p), and unit bytes for a byte budget
 * (absent: it counts requests); a byte budget always has a window.
 */
function checkRateLimits(rl: J, need: (c: boolean, m: string) => void): void {
  need(Array.isArray(rl.rules) && rl.rules.length > 0 && rl.rules.every(text), "rate-limit rules: a list of sentences");
  const ids = new Set<string>();
  for (const lim of rl.limits ?? []) {
    const id = lim.id;
    need(text(id) && !ids.has(id), `rate limit ${id}: id missing or duplicate`);
    ids.add(id);
    const extra = Object.keys(lim).filter((k) => !RATE_LIMIT_MEMBERS.has(k));
    need(extra.length === 0, `rate limit ${id}: unknown members ${extra.join(", ")}`);
    need(posInt(lim.limit), `rate limit ${id}: limit must be a positive integer`);
    need(
      "window_s" in lim && (lim.window_s === null || posInt(lim.window_s)),
      `rate limit ${id}: window_s must be a positive integer or null`,
    );
    need(text(lim.key) && text(lim.applies_to) && text(lim.section), `rate limit ${id}: key/applies_to/section`);
    need(["doc", "m4"].includes(lim.source), `rate limit ${id}: source must be doc or m4`);
    need(!("unit" in lim) || lim.unit === "bytes", `rate limit ${id}: unit must be bytes when present`);
    need(lim.unit !== "bytes" || lim.window_s !== null, `rate limit ${id}: a byte budget needs a window`);
  }
}

/**
 * Every snake_case name in the rate-limit rules is a limit id, an error code or a schema property (such as
 * password_auth), so a rule can never name a bucket the table does not have (§0.0r).
 */
function checkRateLimitNames(o: J, need: (c: boolean, m: string) => void): void {
  const rl = o["x-sixkey-rate-limits"];
  const known = new Set<string>([...(rl.limits ?? []).map((l: J) => l.id), ...Object.keys(o["x-sixkey-error-codes"])]);
  for (const sch of Object.values<J>(o.components.schemas))
    for (const k of Object.keys(sch?.properties ?? {})) known.add(k);
  for (const rule of rl.rules ?? []) {
    for (const [name] of String(rule).matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g))
      need(known.has(name), `rate-limit rule names ${name}, which is no limit id, error code or schema property`);
  }
}

/**
 * x-sixkey-request-rules (§5.4, §0.0p): each rule names the error it answers with, which must be a code of that
 * status, and every operation it applies to must list that code. The JSON Content-Type rule must be there, and every
 * request body must be application/json only.
 */
function checkRequestRules(o: J, table: J, need: (c: boolean, m: string) => void): void {
  const rr: J[] = Array.isArray(o["x-sixkey-request-rules"]) ? o["x-sixkey-request-rules"] : [];
  need(rr.length > 0, "x-sixkey-request-rules: a non-empty list");
  need(
    rr.some((r) => r.id === "json_content_type"),
    "x-sixkey-request-rules: json_content_type is missing",
  );
  const seen = new Set<string>();
  for (const r of rr) {
    need(text(r.id) && !seen.has(r.id), `request rule ${r.id}: id missing or duplicate`);
    seen.add(r.id);
    need(
      JSON.stringify(Object.keys(r).sort()) === JSON.stringify(REQUEST_RULE_MEMBERS),
      `request rule ${r.id}: members must be ${REQUEST_RULE_MEMBERS.join(", ")}`,
    );
    need(["with_request_body", "all"].includes(r.applies_to), `request rule ${r.id}: applies_to`);
    need(
      ["doc", "m0", "m4"].includes(r.source) && text(r.section) && text(r.rule),
      `request rule ${r.id}: source/section/rule`,
    );
    need(
      r.code in table && table[r.code].status === r.status,
      `request rule ${r.id}: ${r.code} is not a ${r.status} code`,
    );
    for (const { method, path, op } of operations(o)) {
      if (r.applies_to === "all" || op.requestBody)
        need(
          (op["x-sixkey-errors"]?.[String(r.status)] ?? []).includes(r.code),
          `${method} ${path}: request rule ${r.id} needs ${r.status} ${r.code} in x-sixkey-errors`,
        );
    }
  }
  for (const { method, path, op } of operations(o)) {
    if (op.requestBody)
      need(
        JSON.stringify(Object.keys(op.requestBody.content ?? {})) === JSON.stringify(["application/json"]),
        `${method} ${path}: a request body must be application/json only`,
      );
  }
}

/** Structural checks of the OpenAPI document. Returns a list of problems (empty = fine). */
export function checkOpenapi(o: J): string[] {
  const errs: string[] = [];
  const need = (c: boolean, m: string) => {
    if (!c) errs.push(m);
  };
  need(typeof o.openapi === "string" && /^3\.1\.\d+$/.test(o.openapi), "openapi must be 3.1.x");
  need(Boolean(o.info?.title && o.info?.version), "info.title and info.version");
  walk(o, (n, p) => {
    if (n !== null && typeof n === "object" && !Array.isArray(n) && "$ref" in n) {
      try {
        resolvePointer(o, n.$ref);
      } catch (e) {
        errs.push(`${p}: ${(e as Error).message}`);
      }
    }
  });
  const comps = o.components;
  try {
    for (const [n, s] of Object.entries(comps.schemas)) lintSchema(s, `#/components/schemas/${n}`);
    for (const [n, p] of Object.entries<J>(comps.parameters ?? {}))
      lintSchema(p.schema, `#/components/parameters/${n}/schema`);
    for (const [n, h] of Object.entries<J>(comps.headers ?? {}))
      lintSchema(h.schema, `#/components/headers/${n}/schema`);
  } catch (e) {
    errs.push((e as Error).message);
  }
  const codes: string[] = comps.schemas.ErrorCode.enum;
  const table: J = o["x-sixkey-error-codes"];
  need(new Set(codes).size === codes.length, "ErrorCode enum has duplicates");
  const sym = [...codes.filter((c) => !(c in table)), ...Object.keys(table).filter((c) => !codes.includes(c))];
  need(sym.length === 0, `ErrorCode enum vs x-sixkey-error-codes: ${sym.join(", ")}`);
  for (const [c, e] of Object.entries<J>(table)) {
    need(Number.isInteger(e.status) && e.status >= 400 && e.status <= 599, `${c}: status`);
    need(Boolean(e.meaning && e.section) && ["doc", "m0"].includes(e.source), `${c}: meaning/section/source`);
    need(["listed", "any"].includes(e.applies_to ?? "listed"), `${c}: applies_to`);
  }
  const consts: J = o["x-sixkey-constants"];
  for (const k of REQUIRED_CONSTANTS) need(k in consts, `missing constant ${k}`);
  for (const [k, c] of Object.entries<J>(consts)) {
    need(Number.isInteger(c.value), `constant ${k}: integer value`);
    need(
      ["doc", "m0"].includes(c.source) && ["client", "server", "both"].includes(c.enforced_by) && Boolean(c.section),
      `constant ${k}: source/enforced_by/section`,
    );
  }
  const vaultLimit = consts.MAX_BODY_BYTES_VAULT.value;
  const otherLimit = consts.MAX_BODY_BYTES_OTHER.value;
  need(vaultLimit > consts.MAX_ENVELOPE_BYTES.value, "vault body limit must exceed MAX_ENVELOPE_BYTES");
  checkRateLimits(o["x-sixkey-rate-limits"], need);
  checkRateLimitNames(o, need);
  checkRequestRules(o, table, need);

  const used = new Set<string>();
  const ids = new Set<string>();
  for (const { method, path, op } of operations(o)) {
    const where = `${method} ${path}`;
    try {
      need(Boolean(op.operationId) && !ids.has(op.operationId), `${where}: operationId missing or duplicate`);
      ids.add(op.operationId);
      const params: J[] = (op.parameters ?? []).map((p: J) => deref(o, p));
      const has = (where_: string, name: string) => params.some((p) => p.in === where_ && p.name === name);
      for (const m of path.matchAll(/\{([^}]+)\}/g))
        need(
          params.some((p) => p.in === "path" && p.name === m[1] && p.required),
          `${where}: path parameter ${m[1]} not declared`,
        );
      for (const req of op.security ?? [])
        for (const s of Object.keys(req)) need(s in comps.securitySchemes, `${where}: unknown security scheme ${s}`);
      const auth = op["x-sixkey-auth"];
      if (!auth) {
        errs.push(`${where}: x-sixkey-auth missing`);
        continue;
      }
      const sec = (op.security ?? []).map((r: J) => Object.keys(r).sort().join("+")).sort();
      const want = AUTH_TO_SECURITY[`${auth.signer}/${auth.account_session}`];
      need(
        want !== undefined && JSON.stringify(sec) === JSON.stringify(want.map((r) => r.join("+")).sort()),
        `${where}: security does not match x-sixkey-auth`,
      );
      if (auth.signer !== "none") {
        need(has("header", "Sixkey-Ts") && has("header", "Sixkey-Sig"), `${where}: signed but no Sixkey-Ts/Sixkey-Sig`);
        if (["device", "registration"].includes(auth.signer))
          need(has("header", "Sixkey-Device"), `${where}: needs Sixkey-Device`);
        if (auth.signer === "enroll") need(has("header", "Sixkey-Enroll"), `${where}: needs Sixkey-Enroll`);
        if (auth.signer === "device_or_enroll")
          need(has("header", "Sixkey-Device") && has("header", "Sixkey-Enroll"), `${where}: needs both signer headers`);
      }
      const rs = requestSchema(op);
      const { props, req } = rs ? schemaProps(o, rs) : { props: new Set<string>(), req: new Set<string>() };
      if (auth.pw_auth === "required")
        need(req.has("password_auth"), `${where}: pw_auth required but password_auth not required`);
      if (auth.pw_auth === "none")
        need(!props.has("password_auth"), `${where}: password_auth present but pw_auth none`);
      if (auth.pw_auth === "device_only")
        need(props.has("password_auth") && !req.has("password_auth"), `${where}: password_auth must be optional`);
      if (auth.pw_auth === "password_or_recovery")
        need(
          props.has("password_auth") && props.has("recovery_auth") && Boolean(deref(o, rs).oneOf),
          `${where}: needs password_auth | recovery_auth (oneOf)`,
        );
      need(req.has("write_proof") === Boolean(auth.write_proof), `${where}: write_proof flag vs request schema`);
      const hasNewSig = params.some((p) => p.in === "header" && p.name === "Sixkey-New-Sig" && p.required);
      need(
        hasNewSig === Boolean(auth.new_key_proof),
        `${where}: new_key_proof flag vs the required Sixkey-New-Sig header`,
      );
      need(!props.has("new_sig"), `${where}: new_sig must not be a body member (it is the Sixkey-New-Sig header)`);
      if (rs)
        need(
          op["x-sixkey-max-body-bytes"] === (props.has("envelope") ? vaultLimit : otherLimit),
          `${where}: x-sixkey-max-body-bytes`,
        );
      const responses: J = op.responses ?? {};
      need(!("423" in responses), `${where}: 423 is removed`);
      const errmap: J = op["x-sixkey-errors"];
      if (!errmap || typeof errmap !== "object") {
        errs.push(`${where}: x-sixkey-errors missing`);
        continue;
      }
      need(
        (errmap["413"] ?? []).includes("too_large"),
        `${where}: every operation lists 413 too_large, bodyless ones too (§5.4, §0.0o A9)`,
      );
      for (const [status, list] of Object.entries<J>(errmap)) {
        need(status in responses, `${where}: x-sixkey-errors status ${status} has no response`);
        for (const c of list) {
          need(c in table, `${where}: unknown error code ${c}`);
          if (c in table) {
            need(String(table[c].status) === status, `${where}: ${c} is ${table[c].status}, listed under ${status}`);
            used.add(c);
          }
        }
      }
      for (const [status, resp] of Object.entries<J>(responses)) {
        if (/^[45]/.test(status))
          need((errmap[status] ?? []).length > 0, `${where}: error response ${status} lists no codes`);
        else if (status.startsWith("2")) {
          const content = deref(o, resp).content;
          if (status === "204") need(content === undefined, `${where}: 204 must have no body`);
          else
            need(
              content !== undefined && requiresServerTime(o, content["application/json"].schema),
              `${where}: ${status} body must require server_time`,
            );
        } else if (status === "304") need(deref(o, resp).content === undefined, `${where}: 304 must have no body`);
      }
    } catch (e) {
      errs.push(`${where}: ${(e as Error).message}`);
    }
  }
  for (const [c, e] of Object.entries<J>(table))
    if (e.applies_to !== "any") need(used.has(c), `error code ${c} is not used by any operation`);

  const removed: J = o["x-sixkey-removed"];
  const present = new Set(operations(o).map(({ method, path }) => `${method} ${path}`));
  for (const r of removed.operations) need(!present.has(r), `removed operation present: ${r}`);
  for (const p of Object.keys(o.paths))
    for (const sub of removed.path_substrings) need(!p.includes(sub), `removed path fragment ${sub} in ${p}`);
  for (const c of removed.error_codes) need(!codes.includes(c) && !(c in table), `removed error code present: ${c}`);
  walk(o, (n, p) => {
    if (p.startsWith("#/x-sixkey-removed") || n === null || typeof n !== "object" || Array.isArray(n)) return;
    if (n.in === "header" && removed.headers.includes(n.name)) errs.push(`${p}: removed header ${n.name}`);
    if (p.endsWith("/responses"))
      for (const k of Object.keys(n)) if (removed.statuses.includes(k)) errs.push(`${p}: removed status ${k}`);
    if (p.endsWith("/headers"))
      for (const k of Object.keys(n)) if (removed.headers.includes(k)) errs.push(`${p}: removed header ${k}`);
    if (n.properties && typeof n.properties === "object")
      for (const f of removed.fields) if (Object.hasOwn(n.properties, f)) errs.push(`${p}: removed field ${f}`);
  });
  return errs;
}

export function findOperation(o: J, operation: string): J {
  const [method, path] = operation.split(" ", 2) as [string, string];
  return o.paths[path][method.toLowerCase()];
}

export function wireExampleErrors(o: J, ex: J): string[] {
  const op = findOperation(o, ex.operation);
  const schema =
    ex.kind === "request" ? requestSchema(op) : deref(o, op.responses[ex.status]).content["application/json"].schema;
  return validate(schema, ex.body, o, `${ex.operation} ${ex.kind}`);
}

/** The vectors and the OpenAPI contract must agree: constants, schemas of the wire values, and the examples. */
export function crossFileErrors(V: J, o: J): string[] {
  const errs: string[] = [];
  const c = Object.fromEntries(Object.entries<J>(o["x-sixkey-constants"]).map(([k, v]) => [k, v.value]));
  const g = V.groups;
  const accept: J[] = g.password_auth.kdf_params.accept;
  const pairs: [number, number, string][] = [
    [g.padding.bucket_bytes, c.PAD_BUCKET_BYTES, "PAD_BUCKET_BYTES"],
    [g.device_name.padded_bytes, c.DEVICE_NAME_PADDED_BYTES, "DEVICE_NAME_PADDED_BYTES"],
    [g.device_name.max_code_points, c.DEVICE_NAME_MAX_CODE_POINTS, "DEVICE_NAME_MAX_CODE_POINTS"],
    [Math.min(...accept.map((p) => p.iterations)), c.PBKDF2_MIN_ITERATIONS, "PBKDF2_MIN_ITERATIONS"],
    [Math.max(...accept.map((p) => p.iterations)), c.PBKDF2_MAX_ITERATIONS, "PBKDF2_MAX_ITERATIONS"],
    [
      Buffer.from(g.device_name.encrypt.cases[0].name_ct.ct, "base64").length,
      c.DEVICE_NAME_CT_BYTES,
      "DEVICE_NAME_CT_BYTES",
    ],
    [g.kver_rules.kver_max_jump, c.KVER_MAX_JUMP, "KVER_MAX_JUMP"],
  ];
  for (const [got, want, name] of pairs) if (got !== want) errs.push(`vectors vs ${name}: ${got} != ${want}`);
  const S = o.components.schemas;
  const expect = (schemaName: string, value: J, valid: boolean, what: string) => {
    const e = validate(S[schemaName], value, o, what);
    if ((e.length === 0) !== valid)
      errs.push(`${what}: expected ${valid ? "valid" : "invalid"} for ${schemaName}: ${e.slice(0, 3).join("; ")}`);
  };
  for (const k of g.public_keys.keys) {
    expect("SpkiP256", k.spki_b64, true, `public key ${k.name}`);
    expect("EcPointP256", k.point_b64, true, `point ${k.name}`);
  }
  for (const r of g.public_keys.epk_reject.slice(0, 3)) expect("EcPointP256", r.b64, false, `epk reject ${r.name}`);
  expect("EnvelopeText", g.envelope.envelope_text, true, "envelope text");
  expect("BundleText", g.keybundle.raw, true, "bundle raw");
  for (const m of g.keybundle.mac_cases) expect("BundleText", m.raw, true, `MAC case ${m.name}`);
  for (const s of g.keybundle.shape_cases)
    expect("BundleText", s.raw, s.schema_expressible ? s.shape_valid : true, `shape case ${s.name}`);
  for (const d of g.device_name.encrypt.cases) expect("NameCt", d.name_ct, true, `name_ct ${d.device_id}`);
  expect("EnrollNameCiphertext", g.enrollment.reveal_name.wire_b64, true, "reveal name_ct");
  expect("EnrollPayloadCiphertext", g.enrollment.payload.wire_b64, true, "payload");
  expect("RequestId", g.enrollment.inputs.rid, true, "rid");
  for (const n of ["dev_n", "dev_a", "dev_s"]) expect("DeviceId", V.fixed_inputs[n], true, n);
  for (const ex of g.wire_examples.examples) {
    const e = wireExampleErrors(o, ex);
    if ((ex.expect_valid ?? true) && e.length) errs.push(...e);
    if (!(ex.expect_valid ?? true) && e.length === 0)
      errs.push(`${ex.operation} ${ex.kind}: the counterexample was accepted (${ex.why ?? ""})`);
  }
  const sigParam = o.components.parameters.SixkeySig.schema;
  for (const rc of g.request_signature.cases)
    if (validate(sigParam, rc.sig_p1363_b64u, o).length)
      errs.push(`Sixkey-Sig value does not match the header schema: ${rc.name}`);
  return errs;
}
