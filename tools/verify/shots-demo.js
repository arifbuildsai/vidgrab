#!/usr/bin/env node
/* Shoot the four README screenshots against the synthetic demo video.
 *
 *   node tools/verify/shots-demo.js [path/to/poster.jpg]
 *
 * Boots the app the way tools/verify/accept.sh does — VG_DEBUG=1 and a remote
 * debugging port — with the VG_DEMO_SHOTS seam switched on, then drives the
 * interface exactly as a person would: clear the card, paste a link, read the
 * chips, press Download, watch the bar, land on the done panel. The renderer, its
 * event handlers and the CSS are untouched; only the traffic reaching them is
 * synthetic. So each frame shows the real interface in a real state, with a
 * locally generated poster and no real channel behind it.
 *
 * Frames land in tools/verify/shots-demo/, NOT over docs/screenshots/: a shot
 * should be looked at before it is published, and the point of these images is
 * that nobody's face is in them. Copy them across by hand once all four read
 * well.
 */
'use strict';
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const H = require('./cdp');

const APP = path.join(__dirname, '..', '..');
const PORT = 9224; // accept.sh owns 9223; never two harnesses on one port
const OUT = process.env.VG_SHOT_OUT ? path.resolve(process.env.VG_SHOT_OUT) : path.join(__dirname, 'shots-demo');
const DEMO_URL = 'https://www.youtube.com/watch?v=VGDEMO00001';

const die = (msg) => { console.log('FAIL: ' + msg); process.exit(1); };
const text = (c, id) => c.ev(`(function(){var e=document.getElementById(${JSON.stringify(id)});return e ? e.textContent.trim() : ''})()`);
/* PNG header: width at byte 16, height at byte 20, big-endian. */
const dims = (f) => { const b = fs.readFileSync(f); return b.readUInt32BE(16) + '×' + b.readUInt32BE(20); };

async function pageTarget(tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      const p = list.find((t) => t.type === 'page' && !/^devtools:/.test(t.url));
      if (p) return p;
    } catch (_) {}
    await H.sleep(400);
  }
  return null;
}

(async () => {
  const poster = process.argv[2] ? path.resolve(process.argv[2]) : '';
  if (poster && !fs.existsSync(poster)) die('no such poster: ' + poster);
  fs.mkdirSync(OUT, { recursive: true });

  /* The app takes a single-instance lock (src/main.js: requestSingleInstanceLock).
     If any instance of THIS repo's electron is still alive, the new process hands
     its argv to that one and quits — silently, with nothing in boot.log but the
     DevTools line — so the harness would wait 30s for a page that never comes.
     The pattern is the repo's own electron dist path, so it cannot touch an
     unrelated Electron or the user's browser. */
  execSync(`pkill -f "${path.join(APP, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')}" 2>/dev/null || true`);
  execSync(`pkill -f "remote-debugging-port=${PORT}" 2>/dev/null || true`);
  await H.sleep(1200);

  const log = fs.openSync(path.join(OUT, 'boot.log'), 'w');
  const env = Object.assign({}, process.env, {
    VG_DEBUG: '1',
    VG_DEMO_SHOTS: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  });
  if (poster) env.VG_DEMO_POSTER = poster;
  const child = spawn('npx', ['electron', '.', '--remote-debugging-port=' + PORT], {
    cwd: APP, env, detached: true, stdio: ['ignore', log, log],
  });
  child.unref();
  console.log('  booted pid ' + child.pid + (poster ? '  poster ' + path.basename(poster) : '  poster fixture default'));

  const target = await pageTarget(75);
  if (!target) die('the app never exposed a page target — see ' + path.join(OUT, 'boot.log'));

  const problems = [];
  const c = H.connect(target.webSocketDebuggerUrl, problems);
  await c.ready;
  await H.sleep(400);

  /* ---- 1. idle: a cold card, nothing read yet ---- */
  if (!(await H.resetCard(c))) die('card would not settle back to idle');
  await c.shot(OUT + '/1-idle.png');
  console.log('  1-idle      state=' + (await H.state(c)) + '  folder=' + (await text(c, 'dirname')));

  /* ---- 2. ready: the video card, the chips, the button ---- */
  const pasted = await H.paste(c, DEMO_URL);
  if (!pasted.ok) die('link did not reach ready (state=' + pasted.state + '): ' + (await text(c, 'oops')));
  /* The poster fades in over .3s once the image decodes. If it never reports
     loaded, the card is transparent and the screenshot would show an empty box
     while every text field looked fine — so this is checked, not hoped for. */
  for (let i = 0; i < 40; i++) {
    if ((await c.ev('document.getElementById("thumb").dataset.loaded')) === '1') break;
    await H.sleep(150);
  }
  const loaded = await c.ev('document.getElementById("thumb").dataset.loaded');
  const broken = await c.ev('document.getElementById("thumb").dataset.broken');
  if (loaded !== '1') die('poster did not load (broken=' + broken + ') — the card would shoot an invisible thumbnail');
  await H.sleep(500);
  await c.shot(OUT + '/2-ready.png');
  const chips = await c.ev('JSON.stringify([...document.querySelectorAll(".qual")].map(function(b){return b.querySelector("b").textContent + " " + (b.querySelector("span") ? b.querySelector("span").textContent : "")}))');
  console.log('  2-ready     "' + (await text(c, 'vtitle')) + '"  / ' + (await text(c, 'vchan')) + '  / ' + (await text(c, 'vdur')));
  console.log('              chips: ' + JSON.parse(chips).join('  |  '));
  console.log('              button: ' + (await text(c, 'go-label')) + '   thumb ' + (await c.ev('document.getElementById("thumb").naturalWidth')) + '×' + (await c.ev('document.getElementById("thumb").naturalHeight')) + ' native');

  /* Press Download and run until the bar is worth photographing: the first tick
     shows a rate almost immediately, but a 6% sliver reads as "barely started".
     Wait for a mid-download percentage so the shot shows the bar doing its job. */
  await c.ev('document.getElementById("dl-form").requestSubmit()');
  for (let i = 0; i < 80; i++) {
    const w = parseFloat(await c.ev('document.getElementById("fill").style.width')) || 0;
    if (w >= 38) break;
    await H.sleep(200);
  }
  const bar = await c.ev('document.getElementById("fill").style.width');
  if (!bar || bar === '0%') die('no rate on screen — pmeta reads: ' + (await text(c, 'pmeta')));
  await c.shot(OUT + '/3-progress.png');
  console.log('  3-progress  ' + (await text(c, 'pct')) + '  bar=' + bar + '  ' + (await text(c, 'pmeta')));

  /* ---- 4. done: the saved panel, with the real filename rule ---- */
  const landed = await H.waitState(c, ['done', 'error'], 90000);
  if (landed !== 'done') die('job ended in ' + landed + ': ' + (await text(c, 'oops')));
  await H.sleep(600);
  await c.shot(OUT + '/4-done.png');
  console.log('  4-done      ' + (await text(c, 'doneword')) + ' — ' + (await text(c, 'donefile')) + '  [' + (await text(c, 'btn-reveal')) + ']');

  console.log('  problems:   ' + (problems.length ? problems.join(' ; ') : 'none'));
  ['1-idle', '2-ready', '3-progress', '4-done'].forEach((n) => console.log('    ' + n.padEnd(12) + dims(OUT + '/' + n + '.png') + '  ' + fs.statSync(OUT + '/' + n + '.png').size + ' bytes'));

  c.close();
  execSync(`pkill -f "remote-debugging-port=${PORT}" 2>/dev/null || true`);
  console.log('  wrote ' + OUT);
})().catch((e) => {
  try { execSync(`pkill -f "remote-debugging-port=${PORT}" 2>/dev/null || true`); } catch (_) {}
  die(e.stack || e.message);
});
