/* The synthetic video behind docs/screenshots.
 *
 * Reached only through the VG_DEMO_SHOTS seam in src/main.js, and only from a dev
 * checkout: electron-builder bundles `src/**` and `ui/**`, never `tools/`, so a
 * released installer cannot load this file at all. Nothing here touches the
 * network — the poster is read from disk and handed over as a data: URL, and the
 * "download" is a timer.
 *
 * The shape of every response is the real one, field for field, and the strings
 * are built by the app's own helpers (passed in as `ctx` from the seam) rather
 * than copied here. So a chip size, a rate or an ETA in a screenshot is formatted
 * exactly the way a live job formats it: binary units, `ETA 38s` under a minute,
 * `ETA 1:04` over it.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MiB = 1024 * 1024;

/* Obviously not a real channel, so no reader mistakes the demo for a video they
   should go find, and no real creator's work sits in the repo's screenshots. */
const TITLE = 'Sunrise Over the Pines — 4K Ambient Walk';
const CHANNEL = 'VidGrab Demo';
const VIDEO_ID = 'VGDEMO00001';
const SECONDS = 624;

/* What the planner would build for a ten-minute 4K video: one entry per height,
   `sub` repeating the height for the non-best chips exactly as chipFor does, and
   the audio-only chip last. Best is first because renderQuals selects
   formats[0] — the row must lead with the quality the button offers. */
const QUALS = [
  { id: 'best', kind: 'mp4', label: 'Best', sub: '4K · 412 MiB', bytes: 412 * MiB },
  { id: 'h1440', kind: 'mp4', label: '1440p', sub: '1440p · 198 MiB', bytes: 198 * MiB },
  { id: 'h1080', kind: 'mp4', label: '1080p', sub: '1080p · 105 MiB', bytes: 105 * MiB },
  { id: 'h720', kind: 'mp4', label: '720p', sub: '720p · 58 MiB', bytes: 58 * MiB },
  { id: 'mp3', kind: 'mp3', label: 'MP3', sub: 'OPUS · 9.6 MiB', bytes: 10 * MiB },
];

const demoDir = () => path.join(os.tmpdir(), 'vidgrab-demo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The poster travels inline as a data: URL, which is the one thumbnail source
   that makes no outbound request — see the safeThumb note in ui/js/main.js.
   VG_DEMO_POSTER swaps it, so the shot can be re-cut with a different image
   without touching a line of code. */
function poster() {
  const want = String(process.env.VG_DEMO_POSTER || '').trim();
  const file = want && fs.existsSync(want) ? want : path.join(__dirname, 'fixtures', 'poster-forest.jpg');
  const buf = fs.readFileSync(file);
  const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

function info(ctx) {
  return {
    ok: true,
    id: VIDEO_ID,
    title: TITLE,
    uploader: CHANNEL,
    duration: ctx.humanDuration(SECONDS),
    seconds: SECONDS,
    thumbnail: poster(),
    size: ctx.humanSize(QUALS[0].bytes),
    formats: QUALS.map(({ id, kind, label, sub }) => ({ id, kind, label, sub })),
    needsFfmpeg: false,
  };
}

/* Sixteen ticks over about nine seconds, so the harness has time to catch a rate
   on screen. The wall clock is compressed; the NUMBERS are not — each frame's
   remaining-bytes divided by its own printed rate gives its printed ETA, and the
   percentage matches the bytes, which is the relationship a real mid-download
   frame shows. Jitter comes from sin(tick), never Math.random, so the same
   screenshots come out every run. */
function start(ctx, fmtId) {
  const chosen = QUALS.find((q) => q.id === fmtId) || QUALS[0];
  const total = chosen.bytes;
  const dir = demoDir();
  const ext = chosen.kind === 'mp3' ? '.mp3' : '.mp4';
  /* The real filename rule, applied to the demo title, so the done panel shows
     the name this download would actually have produced. */
  const file = path.join(dir, ctx.safeName(TITLE, VIDEO_ID, ext));
  const send = (p) => ctx.send('vg:progress', p);

  return new Promise((resolve) => {
    send({ pct: 0, size: ctx.humanSize(total), done: 0, left: total, speed: '', eta: '', stalled: false, note: '', phase: 'starting' });

    setTimeout(async () => {
      const TICKS = 16;
      let lastSpeed = '';
      for (let i = 1; i <= TICKS; i++) {
        const pct = Math.min(99.4, (i / TICKS) * 100 - 0.5 + Math.sin(i * 2.1) * 0.4);
        const done = Math.round((total * pct) / 100);
        const left = total - done;
        const bps = Math.round((2.35 + Math.sin(i * 1.7) * 0.22) * MiB);
        const secs = Math.round(left / bps);
        lastSpeed = ctx.humanSize(bps) + '/s';
        send({
          pct,
          size: ctx.humanSize(total),
          done,
          left,
          speed: lastSpeed,
          eta: secs < 60 ? secs + 's' : ctx.humanDuration(secs),
          stalled: false,
          note: '',
          phase: 'downloading',
        });
        await sleep(520);
      }
      /* The assemble phase keeps the rate and ETA on screen by design — the
         renderer holds them until the job is over, which is the behaviour the
         screenshots exist to show. */
      send({ pct: 100, size: ctx.humanSize(total), done: total, left: 0, speed: lastSpeed, eta: '', stalled: false, note: '', phase: 'done' });
      await sleep(900);
      try {
        fs.mkdirSync(dir, { recursive: true });
        /* A placeholder with the real name: no media was fetched, and nothing in
           the UI reads the file's contents — only its name and its folder. */
        fs.writeFileSync(file, 'VidGrab demo placeholder — no media was fetched for this file.\n');
      } catch (_) {}
      resolve({ ok: true, file, dir });
    }, 900);
  });
}

module.exports = { info, start, TITLE, CHANNEL, VIDEO_ID, QUALS };
