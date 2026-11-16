"""Mutation check of the test suite:
    python tests/mutation/run_mutants.py [--only M01,R02] [--workdir DIR] [--check]

For each mutant in mutants.py: copy sixkey_server/, migrations/, tests/ and pytest.ini to a scratch
directory, apply its replacements (each old string must occur exactly once in its file), run the whole
suite with -x against the local Postgres, and record whether a test failed (killed) or not (survived).
A file path is relative to sixkey_server/, or to the server directory when it starts with "migrations/".
The repository is never modified. --check only verifies that every mutant applies. Prints a table and
exits 1 if any mutant survived or did not apply.

Mutants run one at a time: the suite shares the cluster's roles and the Postgres log (test_zz_logs reads
it), so parallel runs could kill each other's mutants. A mutant that makes a test wait forever is caught
by the suite's per-test watchdog (conftest, SIXKEY_TEST_TIMEOUT_S, 120 s here) and counts as killed.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.normpath(os.path.join(HERE, "..", ".."))
REPO = os.path.normpath(os.path.join(SERVER, "..", ".."))
sys.path.insert(0, HERE)
from mutants import MUTANTS  # noqa: E402


def normalise(m: tuple) -> tuple[str, str, list[tuple[str, str, str]]]:
    """(id, what, file, old, new) or (id, what, [(file, old, new), ...])."""
    if len(m) == 5:
        return m[0], m[1], [(m[2], m[3], m[4])]
    return m[0], m[1], list(m[2])


def target(root: str, rel: str) -> str:
    return os.path.join(root, rel) if rel.startswith("migrations/") else os.path.join(root, "sixkey_server", rel)


def copy_tree(dst: str) -> None:
    for name in ("sixkey_server", "migrations", "tests"):
        shutil.copytree(
            os.path.join(SERVER, name),
            os.path.join(dst, name),
            ignore=shutil.ignore_patterns("__pycache__", ".hypothesis", "mutation"),
        )
    shutil.copy(os.path.join(SERVER, "pytest.ini"), dst)


def apply(root: str, edits: list[tuple[str, str, str]], write: bool) -> str | None:
    """Apply in order; returns a reason when an edit does not apply exactly once."""
    for i, (rel, old, new) in enumerate(edits):
        path = target(root, rel)
        src = open(path, encoding="utf-8").read()
        n = src.count(old)
        if n != 1:
            return f"NOT APPLIED (edit {i + 1} in {rel}: {n} occurrences)"
        if write:
            open(path, "w", encoding="utf-8").write(src.replace(old, new, 1))
    return None


def check_all(mutants: list) -> int:
    bad = 0
    work = tempfile.mkdtemp(prefix="sixkey-mutants-check-")
    for mid, what, edits in mutants:
        dst = os.path.join(work, mid)
        copy_tree(dst)
        why = apply(dst, edits, write=True)
        shutil.rmtree(dst, ignore_errors=True)
        if why:
            bad += 1
            print(f"{mid} {why}  {what}")
    shutil.rmtree(work, ignore_errors=True)
    print(f"{len(mutants) - bad}/{len(mutants)} apply")
    return 1 if bad else 0


def run_one(work: str, env: dict, mid: str, what: str, edits: list) -> tuple[str, str, str, float, str]:
    dst = os.path.join(work, mid)
    shutil.rmtree(dst, ignore_errors=True)
    copy_tree(dst)
    why = apply(dst, edits, write=True)
    if why:
        shutil.rmtree(dst, ignore_errors=True)
        return mid, what, why, 0.0, ""
    t0 = time.time()
    try:
        p = subprocess.run(
            [sys.executable, "-m", "pytest", "-x", "-q", "-p", "no:cacheprovider"],
            cwd=dst,
            env=env,
            capture_output=True,
            text=True,
            timeout=1800,
        )
    except subprocess.TimeoutExpired:  # cannot happen with the suite's watchdog, but never stall the run
        shutil.rmtree(dst, ignore_errors=True)
        return mid, what, "killed (hang: runner timeout)", time.time() - t0, ""
    took = time.time() - t0
    killer = ""
    for line in p.stdout.splitlines():
        if line.startswith("FAILED") or line.startswith("ERROR"):
            killer = line.split(" ", 1)[1][:110]
            break
    if not killer and "Timeout (" in p.stderr:  # conftest's watchdog: a test hung and the run exited
        killer = "watchdog: a test exceeded SIXKEY_TEST_TIMEOUT_S"
    status = "killed" if p.returncode != 0 else "SURVIVED"
    print(f"{mid} {status:9} {took:6.1f}s  {what}  <- {killer}", flush=True)
    shutil.rmtree(dst, ignore_errors=True)
    return mid, what, status, took, killer


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--workdir", default=None)
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    only = {x for x in a.only.split(",") if x}
    mutants = [normalise(m) for m in MUTANTS]
    ids = [m[0] for m in mutants]
    assert len(ids) == len(set(ids)), "duplicate mutant id"
    mutants = [m for m in mutants if not only or m[0] in only]
    if a.check:
        return check_all(mutants)
    work = a.workdir or tempfile.mkdtemp(prefix="sixkey-mutants-")
    run_dir = os.path.join(SERVER, ".pg", "run")
    env = dict(
        os.environ,
        SIXKEY_REPO_ROOT=REPO,
        SIXKEY_OPENAPI_PATH=os.path.join(REPO, "api", "openapi.yaml"),
        SIXKEY_TEST_ADMIN_DSN=os.environ.get(
            "SIXKEY_TEST_ADMIN_DSN", f"postgresql://postgres@/postgres?host={run_dir}&port=55432"
        ),
        SIXKEY_PG_LOG=os.path.join(SERVER, ".pg", "postgres.log"),
        SIXKEY_TEST_TIMEOUT_S=os.environ.get("SIXKEY_TEST_TIMEOUT_S", "120"),
        PYTHONDONTWRITEBYTECODE="1",
    )
    results = [run_one(work, env, *m) for m in mutants]
    print()
    print("| # | mutant | result | killed by |")
    print("|---|---|---|---|")
    for mid, what, status, took, killer in results:
        print(f"| {mid} | {what} | {status} | {killer} |")
    survived = [r for r in results if not r[2].startswith("killed")]
    print(
        f"\n{len(results) - len(survived)}/{len(results)} killed"
        + (f"; not killed: {[r[0] for r in survived]}" if survived else "")
    )
    return 1 if survived else 0


if __name__ == "__main__":
    sys.exit(main())
