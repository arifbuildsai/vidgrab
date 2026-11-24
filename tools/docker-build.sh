#!/bin/zsh
# Build a Linux (and optionally Windows) installer in Docker, from a CLEAN copy
# of the source tree.
#
# Why the copy matters: mounting the repo read-write and running `npm ci` inside
# the container would replace node_modules with Linux-platform Electron binaries,
# destroying the macOS install this machine runs `npm start` and the mac build
# from. So the sources are staged into a scratch dir, the container builds there,
# and only the artifacts come back.
#
# Usage: tools/docker-build.sh <target...>
#   tools/docker-build.sh --linux AppImage --x64     # the safe local linux build
#   tools/docker-build.sh --win --x64
#
# For Linux, ask for AppImage explicitly. electron-builder.yml also lists .deb,
# and .deb is built with fpm — a Ruby program that is NOT installed in this
# image (and that GitHub's ARM64 runners cannot execute either, since the
# bundled fpm is an x86_64 build). The AppImage half needs no external packager
# and builds cleanly here.
set -e
IMG=docker.io/electronuserland/builder:wine-mono
ROOT="$(cd "$(dirname "$0")/.." && pwd)"          # repo root
STAGE="${TMPDIR:-/tmp}vidgrab-xbuild"
TARGETS=("$@")
[[ ${#TARGETS} -gt 0 ]] || { echo "usage: $0 --linux --x64"; exit 1; }

echo "== staging sources (no node_modules, no release) =="
rm -rf "$STAGE"; mkdir -p "$STAGE"
rsync -a --exclude node_modules --exclude release --exclude .git \
      --exclude 'tools/verify/shot-*.png' --exclude '*.log' \
      "$ROOT/" "$STAGE/"
du -sh "$STAGE" | sed 's/^/  stage: /'

echo "== building in container: ${TARGETS[*]} =="
# No USE_SYSTEM_FPM here: the image has no system fpm, so setting it makes the
# deb step fail with "executable file not found in $PATH" instead of using the
# fpm electron-builder ships and downloads itself.
docker run --rm --platform linux/amd64 \
  -v "$STAGE":/project -w /project \
  -e CSC_IDENTITY_AUTO_DISCOVERY=false \
  "$IMG" \
  bash -lc "node -v && npm ci --no-audit --no-fund && npx electron-builder ${TARGETS[*]}" \
  2>&1 | tail -40

setopt NO_NOMATCH          # absent artifact types are normal, not an error
echo "== artifacts produced =="
find "$STAGE/release" -maxdepth 1 -type f \( -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' -o -name '*.exe' -o -name '*.yml' -o -name '*.blockmap' \) -printf '  %10s  %f\n' 2>/dev/null \
  || ls -l "$STAGE/release" | sed 's/^/  /'

OUT="$ROOT/release-xbuild"
mkdir -p "$OUT"; rm -rf "$OUT"/*
cp -a "$STAGE/release"/*.AppImage "$STAGE/release"/*.deb "$STAGE/release"/*.rpm \
      "$STAGE/release"/*.exe "$STAGE/release"/*.blockmap "$OUT/" 2>/dev/null || true
echo "== copied to $OUT =="
ls -l "$OUT" 2>/dev/null | sed 's/^/  /'

echo "== does the unpacked bundle carry chime.wav OUTSIDE the asar? =="
UNP="$(find "$STAGE/release" -maxdepth 1 -type d -name 'linux*' -o -maxdepth 1 -type d -name 'win*' | head -1)"
if [[ -n "$UNP" ]]; then
  find "$UNP" -name 'chime.wav' -printf '  found: %p\n' 2>/dev/null | head -3
  find "$UNP" -maxdepth 1 -type f -printf '  %10s  %f\n' 2>/dev/null | head -12
else
  echo "  (no unpacked dir found under release/)"
  ls -la "$STAGE/release" | sed 's/^/  /'
fi
