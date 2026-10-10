#!/usr/bin/env bash
# Hourly self-improvement trigger for Voxel Rally.
#
#   0 * * * *  bash "<repo>/tools/self-improve.sh"
#
# Each run: measure the current state, ask the local model to fix exactly ONE item
# from docs/QUALITY-QUEUE.md, verify with the test suite, keep the commit only if the
# suite is still green and has not shrunk, otherwise reset to the pre-run commit, then
# push. Nothing is pushed on a failed run, so the branch never carries a broken build.
#
# Pause:  touch ".self-improve.paused" in the repo root
# Resume: rm ".self-improve.paused"
# Metrics trend (slower, needs Chrome): METRICS=1
set -uo pipefail

REPO="/home/patryk/Desktop/New Folder/Minecraft-Rally"
cd "$REPO" || exit 1
MODEL="strata/UD_Qwen3.8"
LIMIT="${LIMIT:-1500}"                      # wall clock cap for the agent leg, seconds

if [ -f "$REPO/.self-improve.paused" ]; then
  echo "self-improve: paused, skipping"
  exit 0
fi
exec 9>/tmp/vr-self-improve.lock
if ! flock -n 9; then
  echo "self-improve: another run still going, skipping"
  exit 0
fi

mkdir -p logs/self-improve
ts="$(date +%Y-%m-%dT%H%M%S)"
log="logs/self-improve/$ts.log"
head0="$(git rev-parse HEAD)"
counts() { node src/debug/tests.js 2>&1 | tail -1 | grep -oE '[0-9]+/[0-9]+ ?passed' | head -1; }
before="$(counts)"
before_n="${before%%/*}"; before_n="${before_n//[^0-9]/}"
[ -n "$before_n" ] || before_n=0

PROMPT="Voxel Rally hourly quality loop. Work only inside the current directory, which is the repository root, and quote every path because the folder name contains a space. Read docs/QUALITY-QUEUE.md and pick the single highest priority OPEN item, the lowest P number. Fix that one item and nothing else. Hard rules: do not edit PLAN.md; do not add any external library, package or downloaded asset; do not delete or weaken an existing test; keep the whole test suite green and never reduce the number of checks; keep the rendered frame under about 220 thousand triangles; you may run at most one headless Chrome screenshot pass for a visual item and must OPEN the resulting png with your read tool and judge your own work; do not run git push, the driver pushes after verifying. Steps: read the relevant source first, make the change, run node src/debug/tests.js, then append the completed item to the Done section of docs/QUALITY-QUEUE.md as done with the text of the item and a one line note of what you changed as path:line, adding at most three new defects you discovered to the Open section with sensible priorities. Commit everything locally with a message beginning 'quality loop: '. Keep the whole run inside twenty minutes and always finish with a final text answer stating the item you chose, the changes as path:line and the verbatim test line."

echo "self-improve $ts · before ${before:-unknown} · head ${head0:0:7}"
timeout "$LIMIT" pi -p --no-session --model "$MODEL" --tools read,bash,edit,write "$PROMPT" >"$log" 2>&1
rc=$?

after="$(counts)"
after_n="${after%%/*}"; after_n="${after_n//[^0-9]/}"
[ -n "$after_n" ] || after_n=0
green=0
if [ "$after_n" -ge "$before_n" ] && [ "$after" = "${after_n}/${after_n} passed" ]; then green=1; fi

if [ "$rc" -eq 124 ]; then
  echo "self-improve: agent leg timed out after ${LIMIT}s" | tee -a "$log"
fi

if [ "$green" -eq 1 ]; then
  if git diff --quiet && git diff --cached --quiet && [ "$(git rev-parse HEAD)" = "$head0" ]; then
    verdict="NO CHANGE"
  else
    [ "$(git rev-parse HEAD)" = "$head0" ] && git add -A && git commit -q -m "quality loop: $(date +%H:%M)"
    timeout 180 git push origin main >>"$log" 2>&1 && verdict="PUSHED $(git rev-parse --short HEAD)" || verdict="COMMITTED, push failed"
  fi
else
  git reset --hard "$head0" >/dev/null 2>&1
  git clean -fd -- assets src tools docs >>"$log" 2>&1
  verdict="REVERTED to ${head0:0:7} (before=${before:-?} after=${after:-?})"
fi

mkdir -p docs && [ -f docs/QUALITY-LOG.md ] || printf '# Quality log\n\nhourly self-improvement runs\n\n' >docs/QUALITY-LOG.md
printf -- '- %s · %s · tests %s -> %s · log `logs/self-improve/%s.log`\n' "$ts" "$verdict" "${before:-?}" "${after:-?}" "$ts" >>docs/QUALITY-LOG.md
echo "self-improve: $verdict"

if [ "${METRICS:-0}" = "1" ]; then
  (nohup python3 -m http.server 8123 --bind 127.0.0.1 >>"$log" 2>&1 &)
  sleep 1
  (nohup google-chrome --headless=new --use-gl=angle --use-angle=swiftshader \
     --enable-unsafe-swiftshader --enable-webgl --no-sandbox --remote-debugging-port=9223 \
     --remote-allow-origins='*' --window-size=1280,720 about:blank >>"$log" 2>&1 &)
  sleep 3
  node tools/perf-run.mjs 60 9223 "http://127.0.0.1:8123/index.html?perftest=1&menu=off" 2>&1 |
    grep -E "PERF_SUMMARY" | tail -2 >>"$log"
  pkill -f "remote-debugging-port=9223" 2>/dev/null
  pkill -f "http.server 8123" 2>/dev/null
fi
