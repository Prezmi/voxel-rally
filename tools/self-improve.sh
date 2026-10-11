#!/usr/bin/env bash
# Hourly self-improvement trigger for Voxel Rally.
#
#   0 * * * *  bash "<repo>/tools/self-improve.sh"
#
# Runs in an isolated git worktree on a `loop` branch so it can never touch, reset or
# clean the working tree the orchestrator is using. It measures, fixes exactly ONE item
# from docs/QUALITY-QUEUE.md, verifies, and only then publishes to main with a fast
# forward push. A failed run is discarded inside its own worktree and nothing is pushed,
# so the branch never carries a broken build and no one else's work is ever reverted.
#
# Pause:  touch ".self-improve.paused" in the repo root (checked in both trees)
# Dry run of the plumbing without the model: PLUMBING_ONLY=1
# Metrics trend (slower, needs Chrome): METRICS=1
set -uo pipefail

REPO="/home/patryk/Desktop/New Folder/Minecraft-Rally"
WT="/home/patryk/vr-loop-wt"
BRANCH="loop"
MODEL="strata/UD_Qwen3.8"
LIMIT="${LIMIT:-1500}"                      # wall clock cap for the agent leg, seconds

if [ -f "$REPO/.self-improve.paused" ] || [ -f "$WT/.self-improve.paused" ]; then
  echo "self-improve: paused, skipping"
  exit 0
fi
exec 9>/tmp/vr-self-improve.lock
if ! flock -n 9; then
  echo "self-improve: another run still going, skipping"
  exit 0
fi

# ---- isolated workspace -----------------------------------------------------
if [ ! -d "$WT" ]; then
  git -C "$REPO" fetch -q origin || true
  git -C "$REPO" worktree add -B "$BRANCH" "$WT" origin/main >/dev/null 2>&1 || {
    echo "self-improve: cannot create the loop worktree"; exit 1; }
fi
git -C "$WT" fetch -q origin || true
git -C "$WT" checkout -qB "$BRANCH" origin/main 2>/dev/null || git -C "$WT" reset -q --hard origin/main
git -C "$WT" clean -qfd
BASE="$(git -C "$WT" rev-parse HEAD)"

cd "$WT" || exit 1
mkdir -p logs/self-improve
ts="$(date +%Y-%m-%dT%H%M%S)"
log="logs/self-improve/$ts.log"
counts() { node src/debug/tests.js 2>&1 | tail -1 | grep -oE '[0-9]+/[0-9]+ ?passed' | head -1; }
before="$(counts)"
before_n="${before%%/*}"; before_n="${before_n//[^0-9]/}"
[ -n "$before_n" ] || before_n=0

PROMPT="Voxel Rally hourly quality loop. Your current working directory is an isolated copy of the repository on a loop branch; work only here, and quote every path because the folder name contains a space. Read docs/QUALITY-QUEUE.md and pick the single highest priority OPEN item, the lowest P number. Fix that one item and nothing else. Hard rules: do not edit PLAN.md; do not add any external library, package or downloaded asset; do not delete or weaken an existing test; keep the whole test suite green and never reduce the number of checks; keep the rendered frame under about 220 thousand triangles; you may run at most one headless Chrome screenshot pass for a visual item and must OPEN the resulting png with your read tool and judge your own work; never run git push or any git command that changes history, the driver publishes. Steps: read the relevant source first, make the change, run node src/debug/tests.js, then append the completed item to the Done section of docs/QUALITY-QUEUE.md as done with the text of the item and a one line note of what you changed as path:line, adding at most three new defects you discovered to the Open section with sensible priorities. Commit everything locally with a message beginning 'quality loop: '. Keep the whole run inside twenty minutes and always finish with a final text answer stating the item you chose, the changes as path:line and the verbatim test line."

echo "self-improve $ts · base ${BASE:0:7} · before ${before:-unknown}"
if [ "${PLUMBING_ONLY:-0}" = "1" ]; then
  echo "self-improve: PLUMBING_ONLY, skipping the model leg" | tee -a "$log"
  rc=0
else
  timeout "$LIMIT" pi -p --no-session --model "$MODEL" --tools read,bash,edit,write "$PROMPT" >"$log" 2>&1
  rc=$?
fi

after="$(counts)"
after_n="${after%%/*}"; after_n="${after_n//[^0-9]/}"
[ -n "$after_n" ] || after_n=0
green=0
if [ "$after_n" -ge "$before_n" ] && [ "$after" = "${after_n}/${after_n} passed" ]; then green=1; fi
[ "${PLUMBING_ONLY:-0}" = "1" ] && green=0

if [ "$rc" -eq 124 ]; then
  echo "self-improve: agent leg timed out after ${LIMIT}s" | tee -a "$log"
fi

if [ "$green" -eq 1 ]; then
  if [ "$(git rev-parse HEAD)" = "$BASE" ]; then
    verdict="NO CHANGE"
  else
    timeout 180 git push -q -f origin "HEAD:refs/heads/$BRANCH" >>"$log" 2>&1
    # publish only as a fast forward onto main, never rewriting anyone else's work
    if timeout 180 git push -q origin "HEAD:refs/heads/main" >>"$log" 2>&1; then
      verdict="PUBLISHED $(git rev-parse --short HEAD)"
    else
      timeout 180 git push -q origin "HEAD:refs/heads/$BRANCH" >>"$log" 2>&1
      verdict="GREEN, main moved on, left on $BRANCH for the next run"
    fi
  fi
else
  git reset -q --hard "$BASE"
  git clean -qfd
  verdict="DISCARDED in worktree (before=${before:-?} after=${after:-?})"
fi

if [ ! -f "$REPO/docs/QUALITY-LOG.md" ]; then
  mkdir -p docs && [ -f docs/QUALITY-LOG.md ] || printf '# Quality log\n\nhourly self-improvement runs\n\n' >docs/QUALITY-LOG.md
fi
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
