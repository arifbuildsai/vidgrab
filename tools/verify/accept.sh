#!/bin/zsh
# Full acceptance. Three boots:
#   1. normal: fast path, two qualities, prefetch, cancel cleanup.
#   2. VG_POISON_URLS=1: stream URLs are dead by design — proves the
#      expired-signature recovery through the engine still lands real files.
#   3. the user's slow test video: speed/ETA never blank; cancel is clean.
# Nothing here rebuilds installers.
setopt NO_NOMATCH
H="$(cd "$(dirname "$0")" && pwd)"          # tools/verify
APP="$(cd "$H/../.." && pwd)"               # repo root
rm -rf ~/Downloads/*AiwzmmTG39U* ~/Downloads/*jNQXAC9IVRw* ~/Downloads/.vidgrab-* 2>/dev/null
FAST="https://www.youtube.com/watch?v=jNQXAC9IVRw"
SLOW="https://www.youtube.com/watch?v=AiwzmmTG39U"
say() { print -r -- "\n########## $1 ##########"; }

boot() {
  pkill -f "remote-debugging-port=9223" 2>/dev/null
  pkill -f yt-dlp 2>/dev/null
  sleep 1
  print -r -- "== booting ($1) =="
  ( cd "$APP" && env VG_DEBUG=1 ${2:+$2} npx electron . --remote-debugging-port=9223 > "$H/$3" 2>&1 & )
  sleep 8
  WS=""
  for i in {1..12}; do
    WS=$(curl -s http://127.0.0.1:9223/json/list | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s).find(x=>x.type==='page'&&x.webSocketDebuggerUrl);console.log(t?t.webSocketDebuggerUrl:'')})" 2>/dev/null)
    [[ -n "$WS" ]] && break
    sleep 2
  done
  [[ -n "$WS" ]] || { print "NO CDP ENDPOINT"; exit 1; }
}

cd "$APP" && npm run lint >/dev/null 2>&1 || { print "LINT FAILED"; exit 1; }
print "LINT OK"
say "offline: stall/speed/ETA proof (real report closure, fake clock)"
node "$H/stallcheck.js" 2>&1 | tail -6

say "BOOT 1 — normal path"
boot "normal" "" acc1.log
node "$H/multiquality.js" "$WS" "$FAST" 2>&1 | tail -24
node "$H/prefetchtest.js" "$WS" "$FAST" 2>&1 | tail -9
node "$H/canceltest.js" "$WS" 2>&1 | tail -14

say "BOOT 2 — poisoned stream URLs (recovery through the engine)"
boot "poisoned URLs" "VG_POISON_URLS=1" acc2.log
node "$H/multiquality.js" "$WS" "$FAST" 2>&1 | tail -24
print -r -- "-- main log --"; grep "\[vg\]" "$H/acc2.log" | head -8

say "BOOT 3 — the genuinely slow video (stall requirement, live)"
boot "slow video" "" acc3.log
node "$H/slowwatch.js" "$WS" "$SLOW" 2>&1 | tail -22

pkill -f "remote-debugging-port=9223" 2>/dev/null
pkill -f yt-dlp 2>/dev/null
print -r -- "\n=== ACCEPTANCE COMPLETE ==="
