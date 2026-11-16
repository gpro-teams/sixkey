// RFC 8785, the JSON Canonicalization Scheme (JCS), for what the plugin platform signs and hashes: the grant store's
// tag (the record of autofill's switch), a listed plugin's contributionsHash and the descriptor
// comparison (§4.2 item 2). The values are objects, arrays, strings, booleans, null and finite numbers. For those, JCS is
// ECMAScript's own JSON.stringify of each primitive (RFC 8785 §3.2.2 is written so: strings with the same escapes,
// numbers as Number.prototype.toString) with every object's members sorted by their names' UTF-16 code units (§3.2.3:
// what Array.prototype.sort compares by default). An object member whose value is undefined is left out, as JSON and
// chrome.storage leave it out; anything else JSON cannot hold (undefined in an array, a function, a bigint, NaN, an
// infinity, a lone surrogate, which I-JSON forbids) throws, so a value cannot be signed in a form that reads back
// differently. No text, no browser calls.

/** The canonical text of `v`. Throws a TypeError for a value JCS cannot hold. */
export function jcs(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new TypeError("jcs: a number that is not finite");
      return JSON.stringify(v);
    case "string":
      // a lone surrogate (I-JSON, RFC 7493 §2.1): JSON.stringify would escape it, which JCS does not allow
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v))
        throw new TypeError("jcs: a lone surrogate");
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) {
        return `[${v
          .map((x) => {
            if (x === undefined) throw new TypeError("jcs: undefined in an array");
            return jcs(x);
          })
          .join(",")}]`;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("jcs: not a plain object");
      const o = v as Record<string, unknown>;
      const names = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort();
      return `{${names.map((k) => `${jcs(k)}:${jcs(o[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`jcs: a ${typeof v} cannot be canonicalised`);
  }
}

/** Lowercase hex of SHA-256 over the UTF-8 of `text`. */
export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
