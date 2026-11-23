<div align="center">

# VidGrab

**A YouTube downloader with exactly one job.**

One link field. One button. Paste a link, pick a quality, get a file that plays in QuickTime.

[Download](#install) · [How it works](#how-it-works) · [Build from source](#build-from-source) · [Troubleshooting](#troubleshooting)

![Platform](https://img.shields.io/badge/platform-macOS%2011%2B%20%7C%20Windows%20%7C%20Linux-blue)
![Version](https://img.shields.io/badge/version-1.0.0-informational)
![License](https://img.shields.io/badge/license-MIT-green)
![Telemetry](https://img.shields.io/badge/telemetry-none-brightgreen)
![Size](https://img.shields.io/badge/installer-~94%20MB-lightgrey)

</div>

![VidGrab with a link read and its qualities listed](docs/screenshots/2-ready.png)

---

There are a hundred YouTube downloaders. Most of them are a search box for a video
site, a wall of ads, and a bundled toolbar. A few are honest but ugly, and the
command-line ones are honest and ugly in a different way.

VidGrab is the small one: an Electron app whose entire interface is a link field and a
Download button, with a quality row and a progress bar that appear when there is
something to show. No account, no browser extension, no "recommended for you", nothing
phoning home.

It exists because the useful parts of downloading a video — knowing which qualities
actually exist, getting the bytes down fast, and ending up with a file that opens in the
player you already use — are fiddly, and everything wrapping them tends to be noise.

## Screens

| Ready | Downloading | Done |
|:-----:|:-----------:|:----:|
| ![Qualities listed](docs/screenshots/2-ready.png) | ![Progress with speed and ETA](docs/screenshots/3-progress.png) | ![Saved, with Show in Finder](docs/screenshots/4-done.png) |
| Link read → real qualities listed | Bytes, speed, time left | File on disk, revealed in Finder |

The idle state is just the field and the button:

![Idle](docs/screenshots/1-idle.png)

## What it does

- **Paste a link → it reads the video.** Title, channel, duration, thumbnail, and the
  qualities that genuinely exist for that video. Typing stops for ~0.8 s and the read
  starts on its own, so by the time you press Download the answer is usually already there
  (first byte 0.2–0.8 s after the press).
- **Only downloadable qualities are offered.** The planner resolves each chip against the
  actual format list — a progressive pass first, then an HLS/DASH pass — and a quality it
  cannot deliver never appears as a button. If a video tops out at 240p, 240p is what you
  get; no greyed-out 1080p that fails when pressed.
- **One paste, many files.** The read is cached per video, so grabbing 720p *and* 480p and
  the MP3 doesn't re-extract anything. Each quality saves to its own filename, so the
  second one doesn't overwrite the first.
- **Fast, because it asks for the file in slices.** YouTube serves an open-ended `GET`
  slowly — measured on one 13 MB stream: **24 KiB/s**. The same URL with
  `Range: bytes=0-3299999` served at **1.1–2.4 MB/s**. VidGrab splits the stream into four
  ranged requests and runs them in parallel; that 13 MB arrives in about 6 s. A 176 MB
  1080p video that took over an hour the old way lands in **8.4 minutes**.
- **Speed and time left never disappear.** They hold through pauses, retries and the final
  merge/encode, and clear only when a new job starts. Progress is driven by bytes actually
  received, so four slices landing out of order can't inflate the bar.
- **Cancel means cancel.** `⌘.` / `Ctrl+.` stops every slice in flight, kills the helper,
  and removes the scratch folder — no half-file left in Downloads. Verified with four
  slices mid-download.
- **A chime when it finishes**, played from the main process rather than the page, so it
  still sounds when VidGrab is behind other windows — the moment you'd otherwise miss it.
- **QuickTime-friendly output by default.** Video is delivered as **H.264 + AAC in an MP4
  container**; audio-only converts to **MP3**. Both verified with `ffprobe`.
- **YouTube only**, deliberately. It does one thing.

## Install

### From a release (macOS)

1. Grab the DMG for your Mac from
   [the latest release](https://github.com/arifbuildsai/vidgrab/releases/latest):
   `VidGrab-1.0.0-arm64-mac.dmg` for Apple Silicon, `VidGrab-1.0.0-x64-mac.dmg` for Intel.
2. Open it and drag **VidGrab** into **Applications**.
3. Launch it. Because the build is unsigned, macOS will complain on the very first open —
   see [Unsigned builds](#unsigned-builds-and-gatekeeper) below for the 5-second way past it.

### With Homebrew, from source

```sh
git clone https://github.com/arifbuildsai/vidgrab.git
cd vidgrab
npm install
npm start          # run it
npm run dist:mac   # build the DMG into release/
```

Windows (`npm run dist:win`, an NSIS installer) and Linux
(`npm run dist:linux`, AppImage + deb) build from the same tree; the macOS
installer is the one that has been run end-to-end and shipped.

### Runtime requirements

Everything the app needs is inside it, except three optional helpers it will use if
they're on the machine:

| Thing | Needed? | What it's for |
|---|---|---|
| **yt-dlp** | fetched automatically on first run | reads the link and resolves formats |
| **Python 3.11+** | optional | runs the yt-dlp tarball — much faster to start than the standalone binary |
| **ffmpeg** | optional | muxing video+audio into MP4, and MP3 conversion. Without it, VidGrab offers qualities that need no merging, and audio as M4A instead of MP3 |

If Python is missing or too old, VidGrab falls back to the standalone `yt-dlp` binary.
That path costs about 30 s the first time (self-extraction) instead of under a second, and
it's cached, so only the first run pays.

## Using it

1. Paste a YouTube link — regular video, Shorts, or YouTube Music. `⌘V` works; so does the
   **Paste** button in the field.
2. Pick a quality chip, or leave **Best** selected. The button tells you what it will do:
   it reads as **Download** with nothing in the field, **Reading the video…** while it
   resolves the link, then **Save video**, **Save 720p**, **Save as MP3** or **Save audio**
   to match the chip you chose.
3. Press it. Watch the bar, or don't — speed and time remaining stay there if you come back.
4. When it chimes, the file is in your **Downloads** folder. **Show in Finder** opens it,
   and **Download another** clears the card for the next link.

The footer button changes the save folder; the choice persists in
`~/Library/Application Support/vidgrab-desktop/settings.json`.

### Keyboard shortcuts

| macOS | Windows / Linux | Action |
|---|---|---|
| `⌘⇧V` | `Ctrl+Shift+V` | Paste the clipboard's link and start the download |
| `⌘L` | `Ctrl+L` | Focus the link field |
| `⌘.` | `Ctrl+.` | Cancel the current download |
| `⌘⇧D` | `Ctrl+Shift+D` | Open the Downloads folder |

Standard Edit-menu roles (cut, copy, paste, select all, undo, redo) are wired up too, so
`⌘C` / `⌘X` behave in the field.

## How it works

Two processes, one window, no network in the page.

```
ui/index.html + ui/js/main.js      renderer — state machine, chips, progress, no connect-src
src/preload.js                     the only bridge: a handful of invoke/send wrappers
src/main.js                        engine, planner, ranged fetch, cancel, chime, errors
```

**Reading a link.** `src/main.js` runs yt-dlp as a child process with `--dump-single-json`
and reads the format list. The engine preference is decided by *actually running* a
candidate, not by guessing from `PATH` or a version floor: the yt-dlp release tarball under
`python3 -E` starts in 0.15–0.95 s, where the standalone binary takes 28–31 s. Python is
launched with `-E` (ignore the user's environment) and never with a reinjected
`PYTHONPATH`, which is how the tarball's self-contained zipapp launcher stays intact.

**Choosing qualities.** `planFrom()` builds the chip list from what the extraction really
offers — progressive formats first, then adaptive HLS/DASH. A plan with no deliverable chip
returns `null` rather than a half-empty row, which is what closed the "why did it show a
quality it then refused" hole. `filesize` is absent for many streams, so a chip shows a
size only when the number is real; it never prints an audio-only size as if it were the
video's.

**Moving bytes.** `fetchStream()` issues one probing request, and the moment the response
headers announce a length it launches the remaining ranged slices in parallel — it does not
wait for the probe to drain, because draining first was a 13–70 s cold-start tax at
single-connection speed. Each slice writes into a per-job scratch folder and is folded into
the final file at the end. Progress counts bytes received, not bytes on disk.

**Finishing.** A video-plus-audio pair is muxed with `--merge-output-format mp4` (never
`--no-merge`, which doesn't exist in this yt-dlp release and used to kill every MP3 on the
fallback path). MP3 is encoded with `libmp3lame -qscale:a 0`. Speed and ETA stay on screen
through this part. Every success path ends with the chime; cancel and error stay silent.

**Cleanup.** Scratch folders are named `.vidgrab-*-tmp`, removed with retry, and swept for
stale survivors at startup. A poisoned-URL test seam (`VG_POISON_URLS=1`) exists precisely
to prove the recovery path — expired stream signatures fall back through the engine and
still land a real file.

**Safety.** The renderer's CSP is `connect-src 'none'`, so the page cannot make network
requests at all; every fetch goes through the main process. Errors are sanitised before
they reach the screen — no engine internals, no file paths, no stack frames, just plain
English ("That link doesn't look like a YouTube video.").

## Build from source

Needs Node 18+ and npm.

```sh
npm install
npm run lint        # node --check over main.js, preload.js, ui/js/main.js
npm start           # dev run, with a visible Electron window
```

Installers, unsigned:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac    # release/*.dmg + *.zip, arm64 + x64
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win    # release/VidGrab-Setup-*-win.exe
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:linux  # release/*.AppImage, *.deb
```

`CSC_IDENTITY_AUTO_DISCOVERY=false` stops electron-builder from grabbing whatever signing
identity happens to be in your keychain. Bundle identity is `net.vidgrab.desktop`, product
name `VidGrab`, config in `electron-builder.yml`.

### Layout

```
src/main.js            everything the app does: engine, planner, ranged fetch, cancel, chime
src/preload.js         the renderer's narrow bridge
ui/index.html          the whole interface — one card
ui/css/style.css       styling, incl. locked/saved chip states
ui/js/main.js          renderer state machine, chip persistence, prefetch scheduling
ui/assets/fonts/       Neucha + Roboto subsets (woff2)
build/                 icon.png, icon.icns, icon.svg, iconset
tools/verify/          the acceptance harness (see below)
docs/screenshots/      the images in this README
release/               build output — gitignored, published as Release assets
```

## Verification

`tools/verify/` is the harness every claim above came from. It drives the running app over
the Chrome DevTools Protocol and checks the results on disk, rather than trusting the UI.

```sh
tools/verify/accept.sh                      # full acceptance suite: 3 boots, 6 checks
tools/verify/pkgsmoke.sh                    # same, against the packaged .app in release/
node tools/verify/stallcheck.js             # offline: speed/ETA across stalls, with a fake clock
node tools/verify/multiquality.js <ws> <url>  # two qualities from one paste
node tools/verify/canceltest.js <ws>        # cancel with 4 slices in flight, then disk audit
node tools/verify/prefetchtest.js <ws> <url>  # read-after-typing timing
node tools/verify/slowwatch.js <ws> <url>   # live watch of a genuinely slow video
node tools/verify/shots.js                  # regenerate docs/screenshots/
```

The suite's six checks: stall proof (speed/ETA never blank), two-quality flow, prefetch
timing, cancel cleanliness, poisoned-URL recovery, and a live watch of a slow video. Last
run: **6/6 green**. It reaches the app through `--remote-debugging-port=9223`, so run it
against a dev build, not the copy in `/Applications`.

## Troubleshooting

### Unsigned builds and Gatekeeper

VidGrab is built without a Developer ID certificate and is not notarised, so a downloaded
copy carries the quarantine flag and macOS blocks it on first open: *"VidGrab can't be
opened because the developer cannot be verified."*

The one-time way past it:

```sh
sudo xattr -dr com.apple.quarantine /Applications/VidGrab.app
```

Or in Finder: **Control-click → Open → Open**, or **System Settings → Privacy & Security →
Open Anyway** right after the blocked attempt.

If you built or copied the app locally rather than downloading it, there is no quarantine
flag and it opens normally — which is why a freshly built DMG seems to work with no fuss on
the machine that made it.

### "Something went wrong reading that video"

- The link is dead or private — `BaW_jenozKc` is a known-gone video and fails exactly this
  way, which is what the error path is tested against.
- First run downloads the yt-dlp engine from GitHub; a network that blocks that will fail
  here. The engine caches under
  `~/Library/Application Support/vidgrab-desktop/bin/`, so once it lands, later runs are
  offline-capable up to the point of reading a link.
- Deleting that `bin/` folder forces a fresh engine fetch.

### MP3 missing, or offered as M4A

No ffmpeg on the machine. MP3 needs `libmp3lame`; without a muxer VidGrab deliberately
narrows the offer to what it can actually produce. Install ffmpeg (`brew install ffmpeg`)
and restart.

### Slow start, then fast

The standalone-binary fallback unpacks itself once (~30 s). Install a Python 3.11+ —
Homebrew's `/opt/homebrew/bin/python3` or `/usr/local/bin/python3` — and the tarball path
takes under a second. Apple's `/usr/bin/python3` is 3.9 and yt-dlp refuses it with
`ImportError: You are using an unsupported version of Python`; VidGrab skips past that one
rather than surfacing the error.

### Certificate errors on a python.org Python

`SSL: CERTIFICATE_VERIFY_FAILED` means that Python build never ran "Install Certificates".
Point the app at the system trust store rather than disabling verification.

### Quality I expected isn't listed

It isn't available for that video, and VidGrab won't invent a button for it. `jNQXAC9IVRw`
("Me at the zoo") tops out at 240p H.264 and gets exactly that.

## Notes

- **YouTube only.** Other sites aren't supported, by design.
- **Respect the terms.** Download what you have the right to download — your own uploads,
  Creative Commons, and material your local law allows. VidGrab is a tool for legitimate
  offline use; it is not an endorsement of redistributing other people's work.
- **No telemetry, no accounts, no update ping.** The renderer cannot reach the network at
  all (`connect-src 'none'`); the only outbound traffic is the yt-dlp fetch on first run and
  the video requests themselves.
- **Files stay on your disk.** Nothing is uploaded, staged on a server, or cached anywhere
  but your own machine.

## Credits

**[Arif Shah](https://github.com/arifbuildsai)** (`arifbuildsai`) — author, maintainer, and
product owner: the design brief, the acceptance bar ("speed and time left should stay on
screen until it's done", "a small sound when it finishes"), and every bug report in this
repo's history came from that side of the screen.

Built on the shoulders of:

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — link extraction and format resolution
- [Electron](https://www.electronjs.org/) — the window, and the `net` module that does the
  ranged fetching
- [ffmpeg](https://ffmpeg.org/) — muxing and MP3 encoding, when present
- [Neucha](https://fonts.google.com/specimen/Neucha) (OFL-1.1) and
  [Roboto](https://fonts.google.com/specimen/Roboto) (Apache-2.0)

## License

[MIT](LICENSE) © 2026 [Arif Shah](https://github.com/arifbuildsai).
