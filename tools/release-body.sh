#!/usr/bin/env bash
# Build a GitHub release body from the files that are actually attached.
#
#   tools/release-body.sh --tag v1.1.0 --repo arifbuildsai/vidgrab [-o body.md] < inventory.tsv
#
# Inventory on stdin: TAB-separated  name \t size_bytes \t sha256 , one line per asset.
# SHA256SUMS is skipped — it is uploaded beside the body, not described inside it.
#
# The point is the layout the release page needs: one page, three groups — macOS,
# Windows, Linux — so a visitor clicks Download, finds their system, and every file
# name is itself the download link. Rows come out in the order below rather than
# alphabetically, because "which file is mine" is an OS question first and an
# architecture question second.
#
# Nothing is invented. A row appears only if the file is in the inventory; a missing
# expected file, or an inventory file this script cannot classify, is reported and
# exits non-zero, so a renamed artifact surfaces instead of quietly vanishing from the
# page.
#
# Portable to the bash 3.2 that ships with macOS as well as Ubuntu's bash 5: indexed
# arrays only, no associative arrays (zsh stores a quoted subscript literally, which is
# the trap this replaced), and USED kept as a space-separated string because bash 3.2
# trips over empty arrays under `set -u`. Backticks in prose are escaped — an unescaped
# `foo` inside an echo "..." line is a command substitution, not text.
set -eu

TAG=''; REPO=''; OUT=''
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG=$2; shift 2 ;;
    --repo) REPO=$2; shift 2 ;;
    --output|-o) OUT=$2; shift 2 ;;
    *) echo "release-body: unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$TAG" ] || [ -z "$REPO" ]; then
  echo "usage: release-body.sh --tag v1.2.3 --repo owner/name < inventory" >&2
  exit 2
fi
V=${TAG#v}
DL="https://github.com/$REPO/releases/download/$TAG"

NAMEA=(); SIZEA=(); SUMA=()
while IFS=$'\t' read -r n s h; do
  [ -n "$n" ] || continue
  [ "$n" = "SHA256SUMS" ] && continue
  NAMEA+=("$n"); SIZEA+=("$s"); SUMA+=("$h")
done
if [ ${#NAMEA[@]} -eq 0 ]; then
  echo "release-body: empty inventory" >&2
  exit 1
fi

# The "For" column, keyed on the filename suffix that identifies the build.
describe() {
  case "$1" in
    arm64-mac.dmg)         echo '**Apple Silicon** — M1 and later. Unsure?  → About This Mac → "Chip" says *Apple M…*' ;;
    x64-mac.dmg)           echo '**Intel** Macs' ;;
    arm64-mac.zip)         echo 'Apple Silicon — the same app, unzipped instead of mounted' ;;
    x64-mac.zip)           echo 'Intel — the same app, unzipped instead of mounted' ;;
    x64-win.exe)           echo '**x64** — the overwhelming majority of PCs' ;;
    arm64-win.exe)         echo '**ARM64** — Snapdragon X laptops, Surface Pro 11' ;;
    x86_64-linux.AppImage) echo '**x64**, any distro — nothing to install, run it directly' ;;
    arm64-linux.AppImage)  echo '**ARM64**, any distro — Raspberry Pi 5, Graviton, ARM laptops' ;;
    amd64-linux.deb)       echo '**x64** Debian / Ubuntu / Mint / Pop\_OS — adds a menu entry and icon' ;;
    *)                     return 1 ;;
  esac
}

MISS=0
USED=' '
emit() {
  local k=$1 i idx=-1
  for i in "${!NAMEA[@]}"; do
    case "${NAMEA[$i]}" in
      *"$k") idx=$i; break ;;
    esac
  done
  if [ "$idx" -lt 0 ]; then
    echo "  !! expected installer missing from the inventory: $k" >&2
    MISS=1
    return
  fi
  USED="$USED$idx "
  local mb=$(( (SIZEA[idx] + 524288) / 1048576 ))   # whole MB, rounded
  local f="${NAMEA[$idx]}"
  echo "| [\`$f\`]($DL/$f) | $(describe "$k") | ${mb} MB | \`${SUMA[$idx]}\` |"
}

table_head() {
  echo
  echo '| Download | For | Size | SHA256 |'
  echo '|---|---|---:|---|'
}

{
  echo "> **Unsigned builds.** No Developer ID certificate and no notarisation, so macOS"
  echo "> Gatekeeper and Windows SmartScreen each block the first open of a downloaded copy,"
  echo "> and a Linux AppImage needs its executable bit set. That is a certificate gap, not a"
  echo "> tampered download — every file's SHA256 is listed below, and"
  echo "> [Troubleshooting](https://github.com/$REPO#troubleshooting) is the one-time way past it."
  echo
  echo "## Pick your system"
  echo
  echo "Nine installer files from six CI builds — one per platform and architecture, and"
  echo "every binary inside is the native one for the machine its name says. Find your"
  echo "operating system below and click the file name — **the name is the download link**."
  echo
  echo '| | macOS | Windows | Linux |'
  echo '|---|---|---|---|'
  echo '| **Chips** | Apple Silicon · Intel | x64 · ARM64 | x64 · ARM64 |'
  echo '| **Format** | `.dmg` (or `.zip`) | `.exe` installer | `.AppImage`, or `.deb` on x64 Debian/Ubuntu |'

  echo
  echo "###  macOS"
  table_head
  emit "arm64-mac.dmg"; emit "x64-mac.dmg"; emit "arm64-mac.zip"; emit "x64-mac.zip"
  echo
  echo "**After it downloads:** open the DMG and drag **VidGrab** into **Applications**"
  echo "(the zip holds the same app, unzipped). The first launch is blocked once by"
  echo "Gatekeeper — Control-click the app → **Open** → **Open**, or clear the quarantine"
  echo "flag once from a terminal:"
  echo
  echo '```sh'
  echo 'sudo xattr -dr com.apple.quarantine /Applications/VidGrab.app'
  echo '```'

  echo
  echo "### 🪟 Windows"
  table_head
  emit "x64-win.exe"; emit "arm64-win.exe"
  echo
  echo "**After it downloads:** run the installer. It installs into your user profile —"
  echo "no administrator rights needed. SmartScreen shows *“Windows protected your PC”*"
  echo "because the build is unsigned: click **More info → Run anyway**. One-time, per"
  echo "installer version."

  echo
  echo "### 🐧 Linux"
  table_head
  emit "x86_64-linux.AppImage"; emit "arm64-linux.AppImage"; emit "amd64-linux.deb"
  echo
  echo "**After it downloads:** the AppImage needs its executable bit once, then runs with"
  echo "no install at all, on any distro and either chip:"
  echo
  echo '```sh'
  echo "chmod +x VidGrab-$V-x86_64-linux.AppImage"
  echo "./VidGrab-$V-x86_64-linux.AppImage"
  echo '```'
  echo
  echo "On Debian, Ubuntu, Mint or Pop!\_OS (x64) the \`.deb\` is the nicer option — it"
  echo "registers an application-menu entry and an icon:"
  echo
  echo '```sh'
  echo "sudo dpkg -i VidGrab-$V-amd64-linux.deb"
  echo '```'
  echo
  echo "Fedora, RHEL, openSUSE and Arch take the AppImage — no RPM is published because"
  echo "\`rpmbuild\` is absent from the Ubuntu runners that build these files. There is no"
  echo "ARM64 \`.deb\` either: electron-builder's bundled \`fpm\` is an x86_64 Ruby program"
  echo "that cannot execute on an ARM64 runner. Both are the same app; only the menu entry"
  echo "and icon come from the \`.deb\`."
  echo
  echo "If the AppImage aborts with \`libfuse.so.2\` not found (Ubuntu 22.04+, Fedora),"
  echo "install \`libfuse2\` / \`fuse-libs\`, or run it already extracted:"
  echo
  echo '```sh'
  echo "./VidGrab-$V-x86_64-linux.AppImage --appimage-extract-and-run"
  echo '```'

  echo
  echo "## Verify your copy"
  echo
  echo "Every file above carries its SHA256, and \`SHA256SUMS\` is attached beside them:"
  echo
  echo '```sh'
  echo 'shasum -a 256 -c SHA256SUMS                                          # macOS / Linux'
  echo "Get-FileHash .\VidGrab-Setup-$V-x64-win.exe -Algorithm SHA256      # Windows PowerShell"
  echo '```'

  echo
  echo "## What VidGrab does"
  echo
  echo "One link field, one button. Paste a YouTube link, pick a quality that genuinely exists"
  echo "for that video, get an H.264 + AAC MP4 that opens in QuickTime — or an MP3. No account,"
  echo "no extension, no telemetry: the renderer's CSP is \`connect-src 'none'\`, so the page"
  echo "cannot reach the network at all."
  echo
  echo "- **Ranged parallel fetch.** YouTube serves an open-ended GET at ~24 KiB/s and the same"
  echo "  URL with a \`Range\` header at 1.1–2.4 MB/s. VidGrab splits every stream into four"
  echo "  ranged requests and launches them the moment the probe announces a length: a 176 MB"
  echo "  1080p video drops from over an hour to **8.4 minutes**."
  echo "- **Only downloadable qualities are offered.** Each chip is resolved against the real"
  echo "  format list, so a quality the app cannot deliver never appears as a button."
  echo "- **Speed and time left never blank**, through pauses, retries and the final merge."
  echo "- **Cancel is clean** (\`⌘.\` / \`Ctrl+.\`): every slice killed, scratch folder removed."
  echo "- **A completion chime** from the main process, so it sounds with the window backgrounded."
  echo
  echo "Full detail, per-platform notes and the acceptance harness:"
  echo "[README](https://github.com/$REPO#readme)."
  echo
  echo "Six CI builds, one per platform and architecture: macOS (Apple Silicon + Intel),"
  echo "Windows (x64 + ARM64) and Linux (x64 + ARM64). [MIT](https://github.com/$REPO/blob/main/LICENSE) ©"
  echo "[Arif Shah](https://github.com/arifbuildsai)."
} > "${OUT:-/dev/stdout}"

# Any inventory file nobody claimed means the page omits something really attached.
LEFT=''
for i in "${!NAMEA[@]}"; do
  case "$USED" in
    *" $i "*) ;;
    *) LEFT="$LEFT ${NAMEA[$i]}" ;;
  esac
done
if [ -n "$LEFT" ] || [ "$MISS" = 1 ]; then
  echo "release-body: inventory does not match the expected nine — unclaimed:$LEFT" >&2
  exit 1
fi
echo "release-body: all nine installers classified for $TAG" >&2
