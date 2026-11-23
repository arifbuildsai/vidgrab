#!/bin/zsh
# Smoke-test the PACKAGED app: the real VidGrab.app, not `npx electron .`.
# Checks the bundle's identity (the menu-bar name question), the icon inside
# the asar, and runs the two-quality flow against it so the fast path, the
# codecs and the chime are all proven in packaged form.
setopt NO_NOMATCH
H="$(cd "$(dirname "$0")" && pwd)"          # tools/verify
APPDIR="$(cd "$H/../.." && pwd)/release"    # repo root /release
APP="$APPDIR/mac-arm64/VidGrab.app"
[[ -d "$APP" ]] || APP="$APPDIR/mac/VidGrab.app"
fails=0
say() { print -r -- "\n########## $1 ##########"; }
chk() { if [[ -n "$2" ]]; then print -r -- "  ok   $1"; else print -r -- "  FAIL $1"; fails=$((fails+1)); fi; }

say "bundle identity"
BN=$(/usr/libexec/PlistBuddy -c "Print :CFBundleName" "$APP/Contents/Info.plist" 2>/dev/null)
BP=$(/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "$APP/Contents/Info.plist" 2>/dev/null)
BI=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIconFile" "$APP/Contents/Info.plist" 2>/dev/null)
BA=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Contents/Info.plist" 2>/dev/null)
print -r -- "  CFBundleName=$BN  DisplayName=$BP  Icon=$BI  Id=$BA"
chk "menu bar will read VidGrab, not Electron" "${BN:+$([[ "$BN" != "Electron" ]] && echo yes)}"
chk "bundle id is net.vidgrab.desktop" "$([[ "$BA" == "net.vidgrab.desktop" ]] && echo yes)"
chk "icns shipped in Resources" "$([[ -f "$APP/Contents/Resources/icon.icns" ]] && echo yes)"
N=$(node -e "const a=require('$APPDIR/../node_modules/@electron/asar');console.log(a.listPackage('$APP/Contents/Resources/app.asar').filter(p=>/[\\\\/]build[\\\\/]icon.png$/.test(p)).length)" 2>/dev/null)
chk "icon.png reachable inside the asar" "$([[ "$N" == "1" ]] && echo yes)"

say "launch packaged app + CDP"
pkill -f "remote-debugging-port=9223" 2>/dev/null; pkill -f yt-dlp 2>/dev/null
pkill -f "VidGrab.app/Contents/MacOS/VidGrab" 2>/dev/null
sleep 1
rm -rf ~/Downloads/*jNQXAC9IVRw* ~/Downloads/.vidgrab-* 2>/dev/null
"$APP/Contents/MacOS/VidGrab" --remote-debugging-port=9223 > "$H/pkg-boot.log" 2>&1 &
PKG_PID=$!
WS=""
for i in {1..15}; do
  WS=$(curl -s http://127.0.0.1:9223/json/list 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const t=JSON.parse(s).find(x=>x.type==='page'&&x.webSocketDebuggerUrl);console.log(t?t.webSocketDebuggerUrl:'')}catch(e){console.log('')}})" 2>/dev/null)
  [[ -n "$WS" ]] && break
  sleep 2
done
chk "CDP endpoint up" "$WS"

say "two qualities, one paste — packaged"
OUT=$(node "$H/multiquality.js" "$WS" "https://www.youtube.com/watch?v=jNQXAC9IVRw" 2>&1)
print -r -- "$OUT" | tail -22
chk "multiquality passed" "$(grep -q 'MULTI-QUALITY PASSED' <<<"$OUT" && echo yes)"

say "process identity while running"
ps -p $PKG_PID -o pid,comm | tail -1
print -r -- "-- boot log (first lines) --"; grep -v "DevTools listening" "$H/pkg-boot.log" | head -4

kill $PKG_PID 2>/dev/null
pkill -f "VidGrab.app/Contents/MacOS/VidGrab" 2>/dev/null
print -r -- "\n=== PACKAGED SMOKE: $fails failure(s) ==="
exit $fails
