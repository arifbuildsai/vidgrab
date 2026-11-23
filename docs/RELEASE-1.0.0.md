> **Unsigned build.** VidGrab is not signed with a Developer ID and is not notarised, so
> macOS Gatekeeper will block the first open of a downloaded copy. This is a certificate
> gap, not a tampered download — verify the SHA256 below, then read
> [Unsigned builds and Gatekeeper](https://github.com/arifbuildsai/vidgrab#unsigned-builds-and-gatekeeper)
> for the 5-second way past it.

## Which file do I want?

| File | For | SHA256 |
|---|---|---|
| `VidGrab-1.0.0-arm64-mac.dmg` | Apple Silicon (M1 and later) — almost certainly this one | `d29be02c26244ed96a579a1d0c0dc73092a2709fbdbee31c2e12d63a3d221ca8` |
| `VidGrab-1.0.0-x64-mac.dmg` | Intel Mac | `fee54fb61ff430c04ae4661f02879a42f93cc48bb3e46ab2c67a7227085fb9c1` |
| `VidGrab-1.0.0-arm64-mac.zip` | same app, unzipped instead of mounted | `834654c15192e8c9b9f3ae81085a6fa126357e24a686cdbcb3b95cf65b7938ec` |
| `VidGrab-1.0.0-x64-mac.zip` | same app, unzipped instead of mounted | `ca9a9b3d16ba132d5a4e26df14e2e20857c2f9b0623d24ffd847d63db75483cf` |

`SHA256SUMS` covers all four. Check your copy with:

```sh
shasum -a 256 -c SHA256SUMS
```

If you're unsure of your chip:  **  → About This Mac → "Chip"** says *Apple M…* or *Intel*.

## Install

1. Open the DMG and drag **VidGrab** into **Applications**.
2. First launch only — clear the quarantine flag once:
   ```sh
   sudo xattr -dr com.apple.quarantine /Applications/VidGrab.app
   ```
   Or in Finder: **Control-click → Open → Open**. After that it launches normally.

## What this is

One link field, one button, and nothing else. Paste a YouTube link, pick a quality that
genuinely exists for that video, get a file that plays in QuickTime. No account, no
extension, no telemetry — the renderer's CSP is `connect-src 'none'`, so the page cannot
reach the network at all.

## The headline change in 1.0.0

**Downloads are roughly 8× faster, and it was the app's fault, not the network.**

YouTube serves an open-ended `GET` slowly. Measured on one machine, same minute, same
13 MB stream:

| Request | Throughput |
|---|---|
| plain `GET` | **24 KiB/s** |
| `GET` with `Range: bytes=0-3299999` | **1.1–2.4 MB/s** |

VidGrab now splits every stream into four ranged requests and runs them in parallel,
launching them the moment the probe's response headers announce a length — it does not
wait for the probe to drain, which was costing 13–70 s of cold start at single-connection
speed. That 13 MB stream arrives in about 6 s. A 176 MB 1080p video that took over an hour
now lands in **8.4 minutes**.

## Everything else

- **Only downloadable qualities are offered.** Each chip is resolved against the real
  format list (progressive pass, then HLS/DASH); a quality the app can't deliver never
  appears as a button. A 240p-max video gets 240p, not a 1080p that fails when pressed.
- **One paste, many files.** The extraction is cached per video, so 720p *and* 480p *and*
  the MP3 don't re-read the link. Each quality saves to its own filename.
- **Prefetch.** ~0.8 s after you stop typing, the read starts on its own — first byte
  arrives 0.2–0.8 s after you press.
- **Speed and time left never blank**, through pauses, retries and the final merge/encode.
  Progress counts bytes received, not bytes on disk, so out-of-order slices can't inflate it.
- **Cancel is clean.** `⌘.` kills every slice in flight and removes the scratch folder —
  verified mid-download with four slices running.
- **A chime when it finishes**, played from the main process, so it still sounds with the
  window backgrounded — the exact moment you'd otherwise miss it.
- **H.264 + AAC in MP4** for video, **MP3** for audio-only, both verified with `ffprobe`.

## Shortcuts

`⌘⇧V` paste link and start · `⌘L` focus field · `⌘.` cancel · `⌘⇧D` open Downloads

## Verified, not assumed

Every claim above came from `tools/verify/` — an acceptance harness that drives the running
app over the Chrome DevTools Protocol and audits the disk rather than trusting the UI. Six
checks over three boots (normal, deliberately poisoned stream URLs to prove signature
recovery, and a genuinely slow video watched live). **Last run: 6/6 green.**

## Requirements

macOS 11+. yt-dlp is fetched on first run and cached; Python 3.11+ and ffmpeg are optional
but recommended — without Python the engine takes ~30 s to start instead of under a second,
and without ffmpeg audio saves as M4A rather than MP3.

Windows and Linux build from the same tree (`npm run dist:win` / `dist:linux`) but aren't
attached here; the macOS installers are the ones run end-to-end.

**Source:** [README](https://github.com/arifbuildsai/vidgrab#readme) · [MIT](https://github.com/arifbuildsai/vidgrab/blob/main/LICENSE) © [Arif Shah](https://github.com/arifbuildsai)
