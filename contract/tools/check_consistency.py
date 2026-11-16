"""Cross-check docs/SYNC-DESIGN.md against api/openapi.yaml (M0). Python standard library only.

    python3 -I contract/tools/check_consistency.py          exit 1 on any hard mismatch
    python3 -I contract/tools/check_consistency.py --quiet  print only problems and the summary
    --openapi=PATH                                           check another copy (used to test the checker)

Hard checks (fail):
  H1  the §5.4 table and the contract list exactly the same operations;
  H2  every endpoint named anywhere in the doc (protocol steps, prose, tests, milestones) is in the contract,
      unless the doc says it was removed or it is a Supabase endpoint the API calls;
  H3  removed endpoints and error codes are absent from the contract;
  H4  every error code the doc attaches to an HTTP status exists in the contract with that status;
  H5  each §5.4 row's request and response fields match the contract schemas (optional '?' included);
  H6  each §5.4 row's auth column matches the operation's x-sixkey-auth;
  H7  each §5.4 row's listed error codes are in the operation's x-sixkey-errors;
  H8  the HKDF labels and hash/MAC/AAD domain tags in the doc, of any version (sixkey/vN/..., sixkey-...|N|),
      are exactly those of the vector file (so a typo copied into the generator cannot pass every verifier
      unnoticed); every one api/openapi.yaml names is in the vector file too, and the contract does not name the
      confirmation code that revision 27 retired;
  H9  everything the §5.4 "已删除" line removes is absent from the contract: operations, request and response
      headers (the conditional GET: If-None-Match, ETag), statuses (304, 423), error codes and fields
      (devices_changed_at);
  H10 every request header the doc names (Sixkey-*) exists in the contract, and POST /v1/devices/fork requires
      the Sixkey-New-Sig header that its §5.4 row names (and has no new_sig body member).
Reported, not failing:
  S1  contract operations that no protocol step (§2–§4, §5 prose) names; the doc only has them in the §5.4 table.
Known, documented deviations are listed in ACCEPTED with the contract/M0-NOTES.md entry that explains them.
"""

from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
DOC = os.path.join(ROOT, "docs", "SYNC-DESIGN.md")
OPENAPI = os.path.join(ROOT, "api", "openapi.yaml")
VECTORS = os.path.join(ROOT, "contract", "vectors", "sync-v1.json")
PHASE0_ONLY_LABELS = {"sixkey/v1/kek-device"}  # Phase 0 device wrap; listed in the vectors, never used by sync
ENROLL_PREFIX = "/v1/enroll/requests/{rid}"
ENROLL_ACTIONS = ("respond", "reveal", "approve", "complete", "reject")
METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")

# Deliberate differences between the §5.4 field lists and the contract, each explained in contract/M0-NOTES.md.
# Empty since revision 5: N17 (cursor.cur) is now written as `cur?` in §5.4 itself.
ACCEPTED: dict[tuple[str, str, str, str], str] = {}


def section_id(title: str) -> str | None:
    m = re.match(r"(\d+(?:\.\d+)*[a-z]?)\.?\s", title + " ")
    return m.group(1) if m else None


def classify(sec: str | None) -> str:
    if sec is None:
        return "other"
    if sec in ("0.0", "0.0b", "0.0c"):
        return "changelog"
    if sec == "5.4":
        return "table"
    top = sec.split(".")[0]
    if top in ("2", "3", "4") or (top == "5" and sec != "5"):
        return "protocol"
    return "other"


def doc_lines() -> list[tuple[str, str, str]]:
    """(section id, class, line) for every line of the design doc."""
    out, sec = [], None
    with open(DOC, encoding="utf-8") as f:
        for line in f.read().split("\n"):
            h = re.match(r"(#{2,4})\s+(.*)", line)
            if h:
                sec = section_id(h.group(2)) or sec
            out.append((sec or "", classify(sec), line))
    return out


def norm_path(p: str) -> str | None:
    p = p.strip().rstrip("`.,;:)）】」、。，；")
    p = p.split("?")[0]
    if p.startswith("…/"):
        rest = p[2:]
        if rest.startswith("{rid}/"):
            rest = rest[len("{rid}/") :]
        if rest in ENROLL_ACTIONS:
            return f"{ENROLL_PREFIX}/{rest}"
        return None
    if p == "/rotate":
        return "/v1/keys/rotate"
    return p


def key(path: str) -> str:
    """Compare paths with parameter names erased."""
    return re.sub(r"\{[^}]*\}", "{}", path)


ENDPOINT_WITH_METHOD = re.compile(r"\b(GET|POST|PUT|PATCH|DELETE)\s+((?:…|/)[A-Za-z0-9_{}\-/.?=&…]*)")
ENDPOINT_PATH_ONLY = re.compile(r"`((?:/v1/|/auth/v1/|…/|/healthz|/rotate)[A-Za-z0-9_{}\-/.?=&]*)`")


def mentions(line: str) -> list[tuple[str | None, str]]:
    found: list[tuple[str | None, str]] = []
    spans = []
    for m in ENDPOINT_WITH_METHOD.finditer(line):
        p = norm_path(m.group(2))
        if p:
            found.append((m.group(1), p))
            spans.append((m.start(), m.end()))
    for m in ENDPOINT_PATH_ONLY.finditer(line):
        if any(a <= m.start(1) < b for a, b in spans):
            continue
        p = norm_path(m.group(1))
        if p:
            found.append((None, p))
    return found


def split_row(line: str) -> list[str]:
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", line)[1:-1]]


def parse_fields(text: str) -> list | None:
    """Parse the doc's '{a, b?, c: {x, y}, d: [{p}], e | f}' notation into a list of (name, optional, children)."""
    i = text.find("{")
    if i < 0:
        return None
    depth, j = 0, i
    for j in range(i, len(text)):
        if text[j] in "{[":
            depth += 1
        elif text[j] in "}]":
            depth -= 1
            if depth == 0:
                break
    return parse_object(text[i + 1 : j])


def split_top(s: str) -> list[str]:
    parts, depth, cur = [], 0, ""
    for ch in s:
        if ch in "{[":
            depth += 1
        elif ch in "}]":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return parts


def parse_object(inner: str) -> list:
    fields = []
    for part in split_top(inner):
        part = part.strip()
        if not part:
            continue
        if "|" in part and ":" not in part:
            for alt in part.split("|"):
                fields.append((alt.strip().rstrip("?"), True, None))
            continue
        name, _, value = part.partition(":")
        name = name.strip()
        optional = name.endswith("?")
        name = name.rstrip("?")
        value = value.strip()
        children = None
        if value.startswith("{"):
            children = parse_object(value[1:-1])
        elif value.startswith("[{"):
            children = parse_object(value[2:-2])
        fields.append((name, optional, children))
    return fields


def deref(o: dict, node: dict) -> dict:
    while isinstance(node, dict) and "$ref" in node:
        ref = node["$ref"]
        n = o
        for part in ref[2:].split("/"):
            n = n[part]
        extra = {k: v for k, v in node.items() if k != "$ref"}
        node = dict(n, **{k: v for k, v in extra.items() if k not in n}) if extra else n
    return node


def contract_fields(o: dict, schema: dict) -> dict:
    """name -> (required, children) for an object schema, following $ref, allOf and arrays of objects."""
    s = deref(o, schema)
    out = {}
    req = set(s.get("required", []))
    for name, sub in s.get("properties", {}).items():
        sub = deref(o, sub)
        children = None
        if sub.get("type") == "object" and "properties" in sub:
            children = contract_fields(o, sub)
        elif sub.get("type") == "array" and isinstance(sub.get("items"), dict):
            it = deref(o, sub["items"])
            if "properties" in it:
                children = contract_fields(o, it)
        out[name] = (name in req, children)
    return out


def compare_fields(op_name: str, kind: str, doc: list, con: dict, prefix: str, problems: list, accepted: list) -> None:
    doc_names = {n for n, _, _ in doc}
    con_names = set(con) - {"server_time"}
    for n in sorted(doc_names - con_names):
        problems.append(f"H5 {op_name} {kind}: field {prefix}{n} is in §5.4 but not in the contract")
    for n in sorted(con_names - doc_names):
        problems.append(f"H5 {op_name} {kind}: field {prefix}{n} is in the contract but not in §5.4")
    for n, optional, children in doc:
        if n not in con:
            continue
        required, con_children = con[n]
        if optional == required:
            tag = (op_name, kind, prefix + n, "optional" if not required else "required")
            if tag in ACCEPTED:
                accepted.append(f"{op_name} {kind} {prefix}{n}: {ACCEPTED[tag]}")
            else:
                problems.append(
                    f"H5 {op_name} {kind}: {prefix}{n} is {'optional' if optional else 'required'} in §5.4 but {'required' if required else 'optional'} in the contract"
                )
        if children is not None:
            if con_children is None:
                problems.append(
                    f"H5 {op_name} {kind}: {prefix}{n} has fields in §5.4 but no object schema in the contract"
                )
            else:
                compare_fields(op_name, kind, children, con_children, f"{prefix}{n}.", problems, accepted)


def auth_from_cell(cell: str) -> dict:
    c = cell
    if c.startswith("无"):
        signer, account = "none", "none"
    elif "入网中" in c and "设备" in c.replace("新设备", "") and "或" in c:
        signer, account = "device_or_enroll", "none"
    elif "入网中" in c:
        signer, account = "enroll", "none"
    elif c.startswith("账户"):
        signer, account = ("registration" if "持钥证明" in c else "none"), "required"
    elif c.startswith("设备"):
        signer = "device"
        account = "step_up" if "账户" in c and "iat" in c else "none"
    else:
        signer, account = "?", "?"
    if "recovery_auth" in c:
        pw = "password_or_recovery"
    elif "pw_auth" in c:
        pw = "device_only" if "或入网中" in c else "required"
    else:
        pw = "none"
    return {
        "signer": signer,
        "account_session": account,
        "pw_auth": pw,
        "write_proof": "写入证明" in c,
        "new_key_proof": "新公钥的持钥证明" in c,
    }


STATUS_CODE_IN_TICKS = re.compile(r"`([45]\d\d)\s+([a-z][a-z_]+)[^`]*`")
STATUS_THEN_CODE = re.compile(r"\b([45]\d\d)\s+`([a-z][a-z_]+)(?:\s*\{[^`]*\})?`")


def codes_in_error_cell(cell: str) -> list[tuple[str, str | None]]:
    """[(status, code or None)] from a §5.4 error cell: '403 `a` / `b`、409 `c {x}`、422'."""
    out = []
    cell = re.sub(r"（[^）]*）|\([^)]*\)", "", cell)  # '（附 `handled_by`）' names a detail field, not a code
    for group in re.split(r"[、，,]", cell):
        st = re.search(r"\b([45]\d\d)\b", group)
        if not st:
            continue
        codes = re.findall(r"`([a-z][a-z_]+)(?:\s*\{[^`]*\})?`", group)
        if codes:
            out += [(st.group(1), c) for c in codes]
        else:
            out.append((st.group(1), None))
    return out


def main() -> int:
    quiet = "--quiet" in sys.argv
    path = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--openapi=")), OPENAPI)
    with open(path, encoding="utf-8") as f:
        o = json.load(f)
    lines = doc_lines()
    contract = {}
    for p, item in o["paths"].items():
        for m, op in item.items():
            if m.upper() in METHODS:
                contract[(m.upper(), p)] = op
    contract_keys = {(m, key(p)): (m, p) for m, p in contract}
    table_codes = o["x-sixkey-error-codes"]
    removed_ops = set(o["x-sixkey-removed"]["operations"])
    removed_codes = set(o["x-sixkey-removed"]["error_codes"])
    problems: list[str] = []
    accepted: list[str] = []
    info: list[str] = []

    # Removed operations as the doc states them (the §5.4 "已删除" line), merged with the contract's tombstones.
    for sec, cls, line in lines:
        if sec == "5.4" and line.startswith("已删除"):
            for m, p in mentions(line):
                if m:
                    removed_ops.add(f"{m} {p}")
    removed_keys = {(r.split(" ", 1)[0], key(r.split(" ", 1)[1])) for r in removed_ops}

    # H1: the §5.4 table versus the contract.
    rows = []
    for sec, cls, line in lines:
        if cls == "table" and line.startswith("| `"):
            cells = split_row(line)
            mp = re.match(r"`(GET|POST|PUT|PATCH|DELETE)\s+([^`]+)`", cells[0])
            if mp:
                rows.append((mp.group(1), norm_path(mp.group(2)), cells))
    table_ops = {(m, key(p)) for m, p, _ in rows}
    for m, p, _ in rows:
        if (m, key(p)) not in contract_keys:
            problems.append(f"H1 §5.4 lists {m} {p}, the contract does not")
    for (m, k), (_, p) in contract_keys.items():
        if (m, k) not in table_ops:
            problems.append(f"H1 the contract has {m} {p}, §5.4 does not")
    info.append(f"§5.4 table: {len(rows)} operations; contract: {len(contract)} operations")

    # H2 and S1: every endpoint mentioned outside the table.
    named_in_protocol: dict[tuple[str, str], set[str]] = {}
    path_only_protocol: dict[str, set[str]] = {}
    external, removed_mentions = set(), set()
    for sec, cls, line in lines:
        if cls == "table" and line.startswith("| `"):
            continue
        for m, p in mentions(line):
            if p.startswith("/auth/v1/"):
                external.add(f"{m or ''} {p}".strip())
                continue
            if m and (m, key(p)) in removed_keys:
                removed_mentions.add(f"{m} {p}")
                continue
            if m:
                if (m, key(p)) not in contract_keys:
                    problems.append(f"H2 §{sec}: {m} {p} is named in the doc but not in the contract")
                elif cls == "protocol":
                    named_in_protocol.setdefault((m, key(p)), set()).add(sec)
            else:
                if not any(k == key(p) for _, k in contract_keys):
                    if not any(key(p) == k for _, k in removed_keys):
                        problems.append(f"H2 §{sec}: {p} is named in the doc but no contract operation has that path")
                    continue
                if cls == "protocol":
                    path_only_protocol.setdefault(key(p), set()).add(sec)
    info.append(f"endpoints named with a method in protocol sections: {len(named_in_protocol)}")
    info.append(f"Supabase endpoints the API calls (not part of the contract): {', '.join(sorted(external))}")
    info.append(f"removed endpoints the doc mentions as removed: {', '.join(sorted(removed_mentions))}")

    # H3: removed things are absent.
    for r in removed_ops:
        m, p = r.split(" ", 1)
        if (m, key(p)) in contract_keys:
            problems.append(f"H3 removed endpoint {r} is in the contract")
    for c in removed_codes:
        if c in table_codes or c in o["components"]["schemas"]["ErrorCode"]["enum"]:
            problems.append(f"H3 removed error code {c} is in the contract")
    for (m, p), op in contract.items():
        if "423" in op.get("responses", {}):
            problems.append(f"H3 {m} {p} still has a 423 response")

    # H4: every status + code the doc names.
    doc_codes: dict[str, set[str]] = {}
    for sec, cls, line in lines:
        if cls == "table" and line.startswith("| `"):
            for st, c in codes_in_error_cell(split_row(line)[4]):
                if c:
                    doc_codes.setdefault(c, set()).add(st)
            continue
        for rx in (STATUS_CODE_IN_TICKS, STATUS_THEN_CODE):
            for st, c in rx.findall(re.sub(r"（附[^）]*）", "", line)):
                doc_codes.setdefault(c, set()).add(st)
    for c, statuses in sorted(doc_codes.items()):
        if c in removed_codes:
            continue
        if c not in table_codes:
            problems.append(f"H4 the doc names error code {c} ({'/'.join(sorted(statuses))}), the contract does not")
            continue
        for st in statuses:
            if str(table_codes[c]["status"]) != st:
                problems.append(f"H4 the doc gives {c} status {st}, the contract {table_codes[c]['status']}")
    info.append(
        f"error codes the doc names with a status: {len([c for c in doc_codes if c not in removed_codes])} (+ removed: {', '.join(sorted(c for c in doc_codes if c in removed_codes))})"
    )
    proposed = sorted(c for c, e in table_codes.items() if e["source"] == "m0")
    info.append(f"error codes the contract adds beyond the doc (source m0): {', '.join(proposed) or 'none'}")

    # H5, H6, H7: each §5.4 row against its operation.
    for m, p, cells in rows:
        k = (m, key(p))
        if k not in contract_keys:
            continue
        op_name = f"{m} {p}"
        op = contract[contract_keys[k]]
        req_doc = parse_fields(cells[2]) if cells[2].startswith("`{") else []  # 'If-None-Match: "v{n}"' is a header
        rb = op.get("requestBody")
        req_con = contract_fields(o, rb["content"]["application/json"]["schema"]) if rb else {}
        compare_fields(op_name, "request", req_doc or [], req_con, "", problems, accepted)
        objs = [parse_object(x) for x in re.findall(r"`\{([^`]*)\}`", cells[3])]
        ok_status = next(s for s in op["responses"] if s.startswith("2"))
        resp = deref(o, op["responses"][ok_status])
        content = resp.get("content")
        if content is None:
            if objs:
                problems.append(f"H5 {op_name} response: §5.4 has a body, the contract's {ok_status} has none")
        else:
            sch = deref(o, content["application/json"]["schema"])
            branches = sch["oneOf"] if "oneOf" in sch else [sch]
            if len(objs) not in (0, len(branches)) or (
                not objs and any(set(contract_fields(o, b)) - {"server_time"} for b in branches)
            ):
                problems.append(
                    f"H5 {op_name} response: {len(objs)} body shape(s) in §5.4, {len(branches)} in the contract"
                )
            for d, b in zip(objs, branches):
                compare_fields(op_name, "response", d, contract_fields(o, b), "", problems, accepted)
        want = auth_from_cell(cells[1])
        got = {kk: op.get("x-sixkey-auth", {}).get(kk) for kk in want}
        if want != got:
            problems.append(f"H6 {op_name}: §5.4 auth '{cells[1]}' reads as {want}, contract x-sixkey-auth is {got}")
        errmap = op.get("x-sixkey-errors", {})
        for st, c in codes_in_error_cell(cells[4]):
            if st not in op.get("responses", {}):
                problems.append(f"H7 {op_name}: §5.4 lists status {st}, the contract has no {st} response")
            if c and c not in errmap.get(st, []):
                problems.append(f"H7 {op_name}: §5.4 lists {st} {c}, the operation's x-sixkey-errors does not")

    # H8: labels and domain tags, doc versus vectors.
    with open(VECTORS, encoding="utf-8") as f:
        lab = json.load(f)["groups"]["labels"]
    vec_labels = {x["label"] for x in lab["hkdf_info"]}
    vec_tags = {x["tag"] for x in lab["domain_tags"]}
    doc_labels, doc_tags = set(), set()
    for _, _, line in lines:
        text = line.replace("\\|", "|")
        # any version (revision 27 put the enrolment at v2: sixkey/v2/..., sixkey-enroll|2|), not only v1
        for m in re.finditer(r"sixkey/v\d+/[a-z]+(?:-[a-z]+)*(\|?)", text):
            (doc_tags if m.group(1) else doc_labels).add(m.group(0))
        doc_tags.update(re.findall(r"sixkey-[a-z]+(?:-[a-z]+)*\|\d+\|", text))
    for x in sorted(doc_labels - vec_labels):
        problems.append(f"H8 the doc uses HKDF label {x}, the vector file does not list it")
    for x in sorted(vec_labels - doc_labels - PHASE0_ONLY_LABELS):
        problems.append(f"H8 the vector file lists HKDF label {x}, the doc never uses it")
    for x in sorted(doc_tags ^ vec_tags):
        problems.append(f"H8 domain tag {x} is in {'the doc' if x in doc_tags else 'the vector file'} only")
    # The contract's own text too (revision 27): every label or tag api/openapi.yaml names, in any description, is one
    # the vector file lists, and it no longer names the retired confirmation code; else a reader of the contract alone
    # would build enrolment v1.
    with open(OPENAPI, encoding="utf-8") as f:
        api_lines = f.read().split("\n")
    for n, line in enumerate(api_lines, 1):
        for m in re.finditer(r"sixkey/v\d+/[a-z]+(?:-[a-z]+)*\|?|sixkey-[a-z]+(?:-[a-z]+)*\|\d+\|", line):
            if m.group(0) not in vec_labels | vec_tags:
                problems.append(f"H8 api/openapi.yaml line {n} names {m.group(0)}, the vector file does not list it")
        if re.search(r"\bCC(_ATTEMPTS)?\b", line):
            problems.append(f"H8 api/openapi.yaml line {n} names the retired confirmation code (CC)")
    info.append(
        f"labels: {len(doc_labels)} HKDF labels and {len(doc_tags)} domain tags in the doc, identical to the vector file (plus Phase 0-only {', '.join(sorted(PHASE0_ONLY_LABELS))})"
    )

    # H9: everything the "已删除" line of §5.4 removes is absent from the contract.
    removed_line = next((line for sec, _, line in lines if sec == "5.4" and line.startswith("已删除")), "")
    if not removed_line:
        problems.append("H9 §5.4 has no '已删除' line")
    # "由 `devices_rev` 取代" names the replacement, not something removed.
    ticks = re.findall(r"`([^`]+)`", re.sub(r"由\s*`[^`]+`\s*取代", "", removed_line))
    gone_headers = {
        x
        for x in ticks
        if re.fullmatch(r"[A-Z][A-Za-z]*(?:-[A-Z][A-Za-z]*)*", x) and not re.match(r"(GET|POST|PUT|PATCH|DELETE)\b", x)
    }
    gone_fields = {x for x in ticks if re.fullmatch(r"[a-z]+(?:_[a-z]+)+", x)}
    gone_statuses = set(re.findall(r"\b([1-5]\d\d)\b", removed_line))
    gone_codes = {c for st, c in re.findall(r"`([45]\d\d) ([a-z_]+)`", removed_line)}
    gone_fields -= gone_codes
    seen_headers, seen_statuses, seen_fields = set(), set(), set()

    def scan(node, path):
        if isinstance(node, dict):
            if node.get("in") == "header" and isinstance(node.get("name"), str):
                seen_headers.add(node["name"])
            if path.endswith("/headers"):
                seen_headers.update(node)
            if path.endswith("/responses"):
                seen_statuses.update(node)
            if isinstance(node.get("properties"), dict):
                seen_fields.update(node["properties"])
            for k, v in node.items():
                if not (path == "#" and k == "x-sixkey-removed"):
                    scan(v, f"{path}/{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                scan(v, f"{path}/{i}")

    scan(o, "#")
    for h in sorted(gone_headers & seen_headers):
        problems.append(f"H9 header {h} is removed by §5.4 but still in the contract")
    for s in sorted(gone_statuses & seen_statuses):
        problems.append(f"H9 status {s} is removed by §5.4 but still a response in the contract")
    for f in sorted(gone_fields & seen_fields):
        problems.append(f"H9 field {f} is removed by §5.4 but still in a contract schema")
    for c in sorted(gone_codes & set(table_codes)):
        problems.append(f"H9 error code {c} is removed by §5.4 but still in the contract")
    for need_gone in ("If-None-Match", "ETag"):
        if need_gone not in gone_headers:
            problems.append(f"H9 expected §5.4 to remove {need_gone} (revision 5, N2)")
    if "304" not in gone_statuses:
        problems.append("H9 expected §5.4 to remove 304 (revision 5, N2)")
    info.append(
        f"removed by the §5.4 '已删除' line and absent from the contract: headers {', '.join(sorted(gone_headers))}; statuses {', '.join(sorted(gone_statuses))}; fields {', '.join(sorted(gone_fields))}; codes {', '.join(sorted(gone_codes))}"
    )

    # H10: every Sixkey-* request header the doc names exists; fork needs Sixkey-New-Sig.
    doc_headers = set()
    for sec, cls, line in lines:
        if cls == "changelog" or line is removed_line:
            continue
        doc_headers.update(re.findall(r"\bSixkey-[A-Z][A-Za-z]*(?:-[A-Z][A-Za-z]*)*", line))
    for h in sorted(doc_headers - seen_headers - gone_headers):
        problems.append(f"H10 the doc names header {h}, the contract has no such parameter")
    fork = contract.get(("POST", "/v1/devices/fork"))
    if fork is None:
        problems.append("H10 POST /v1/devices/fork is missing")
    else:
        prm = []
        for x in fork.get("parameters", []):
            while "$ref" in x:
                n = o
                for part in x["$ref"][2:].split("/"):
                    n = n[part]
                x = n
            prm.append(x)
        if not any(x.get("in") == "header" and x.get("name") == "Sixkey-New-Sig" and x.get("required") for x in prm):
            problems.append("H10 POST /v1/devices/fork does not require the Sixkey-New-Sig header")
        body = contract_fields(o, fork["requestBody"]["content"]["application/json"]["schema"])
        if "new_sig" in body:
            problems.append("H10 POST /v1/devices/fork still has a new_sig body member")
        row = next((cells for m, pth, cells in rows if m == "POST" and pth == "/v1/devices/fork"), None)
        if row is None or "Sixkey-New-Sig" not in row[1]:
            problems.append("H10 the §5.4 fork row no longer names Sixkey-New-Sig")
    info.append(f"request headers the doc names: {', '.join(sorted(doc_headers))}; all in the contract")

    # S1: contract operations no protocol step names.
    unreferenced = []
    for (m, kk), (_, p) in sorted(contract_keys.items(), key=lambda x: x[1][1]):
        if (m, kk) in named_in_protocol:
            continue
        hint = (
            " (path named without a method in §" + ", §".join(sorted(path_only_protocol[kk])) + ")"
            if kk in path_only_protocol
            else ""
        )
        unreferenced.append(f"{m} {p}{hint}")

    print("Sixkey M0 consistency check: docs/SYNC-DESIGN.md <-> api/openapi.yaml")
    if not quiet:
        for line in info:
            print(f"  info  {line}")
        for line in accepted:
            print(f"  accepted deviation  {line}")
    for line in unreferenced:
        print(f"  S1 not named by any protocol step (§2-§4, §5 prose): {line}")
    for line in problems:
        print(f"  FAIL  {line}")
    print(
        f"{len(problems)} hard mismatch(es), {len(unreferenced)} operation(s) only in the §5.4 table, {len(accepted)} accepted deviation(s)."
    )
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
