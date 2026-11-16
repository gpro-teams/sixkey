#!/bin/bash
# Benchmark one build at 10, 100 and 500 accounts (PHASE0X-PLAN A2; docs/research/ux-study.md appendix A). Manual, not CI.
#
#   bash scripts/bench/run-set.sh <label> <extension build> [scenario ...]     (default scenarios: warm restart idlecpu)
#
# Every build is copied to one fixed path first, so all of them get the same extension id and can share the seeded
# profiles. The profiles are seeded once (with whatever build is passed first) and copied fresh for every run.
# Everything lives in $SIXKEY_BENCH_DIR (default: <system temp>/sixkey-bench), never in the repository.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
LABEL=$1; SRC=$2; shift 2
SCENARIOS=${*:-warm restart idlecpu}
B=${SIXKEY_BENCH_DIR:-${TMPDIR:-/tmp}/sixkey-bench}
mkdir -p "$B/ext" "$B/profiles-seed" "$B/profiles"
# --checksum: two builds from the same sources share file sizes and timestamps, and a plain rsync would keep the old
# popup/index.html next to the new build's assets.
rsync -a --delete --checksum "$SRC/" "$B/ext/dist/"
for n in 10 100 500; do
  [ -d "$B/profiles-seed/pw-$n" ] || node "$here/seed.mjs" "$B/ext/dist" "$B/profiles-seed/pw-$n" "$n"
done
for n in 10 100 500; do
  for s in $SCENARIOS; do
    rm -rf "$B/profiles/pw-$n" && cp -R "$B/profiles-seed/pw-$n" "$B/profiles/pw-$n"
    case $s in idlecpu) runs=3 ;; proccold) runs=4 ;; *) runs=15 ;; esac
    node "$here/bench.mjs" "$s" "$B/profiles/pw-$n" "$runs" --dist="$B/ext/dist" --label="$LABEL" --out="$B/results.jsonl" | tee -a "$B/run-$LABEL.log"
  done
done
