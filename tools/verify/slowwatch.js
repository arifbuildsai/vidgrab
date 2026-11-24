/* The user's requirement, on a video long enough to still be transferring when
   the watch window closes: Blender Foundation's Big Buck Bunny (10.5 min,
   open-license, animated — no person's likeness or channel in this repo's test
   scripts). The highest chip is picked so the transfer runs past WATCH instead
   of finishing inside it. Actual stalls are proven deterministically offline by
   stallcheck.js with a fake clock; what this boot adds is that the same
   invariant holds against live YouTube traffic. Watches the live caption for up
   to WATCH seconds; if the video is still going then, cancels (cancel is proven
   clean by canceltest) and still passes, because what is under test is the
   caption, not the file. */
'use strict';
const H = require('./cdp');
const [,, wsUrl, url] = process.argv;
const VID = (/v=([\w-]{6,})/.exec(url) || [])[1] || '';
/* 75s, not 150s. The best chip on the target video is a 268 MB video+audio pair,
   so a longer window lets the transfer FINISH and the job walk into its ffmpeg
   merge — a 10-minute re-encode of 1080p60 VP9, which is neither the caption
   under test nor a fast boot. Cancelling inside 75s lands while bytes are still
   moving at ~2 MiB/s, which is exactly the state whose numbers must hold. */
const WATCH = 75000;
/* A harness that overruns should FAIL, not hang: every CDP call here is an
   unbounded await, so one that never returns used to keep the whole acceptance
   suite attached to a live app until its own caller timed out (13 minutes of
   silence, output lost down a pipe). This is the backstop. */
const watchdog = setTimeout(() => {
  console.log('HARNESS FAIL: exceeded ' + ((WATCH + 90000) / 1000) + 's wall clock — a CDP call never returned');
  process.exit(1);
}, WATCH + 90000);
watchdog.unref?.();
const problems = [];
const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); console.log((cond ? '  ok   ' : '  FAIL ') + msg); };

(async () => {
  const c = H.connect(wsUrl, problems);
  await c.ready;
  await H.sleep(300);
  H.rmVideo(VID);
  await H.resetCard(c);

  const r = await H.paste(c, url);
  check(r.ok, 'paste reached ready');
  if (!r.ok) process.exit(1);
  /* Biggest chip first: a small file finishes inside the watch window and the
     stall path never gets observed. chips[0] is 'best' — renderQuals leads the
     row with it, and the planner only lists a height it can actually deliver. */
  const pick = r.chips[0];
  console.log('pressing chip: ' + pick.id + ' (' + pick.label + ')');
  await c.ev(`(function(){var b=[...document.querySelectorAll(".qual")].find(function(x){return x.dataset.id===${JSON.stringify(pick.id)}});if(b)b.click()})()`);

  await c.ev('document.getElementById("dl-form").requestSubmit()');
  const t0 = Date.now();
  let firstRate = null;
  let blanks = 0, frames = 0, stalls = 0, lastCaption = '';
  const stallWindows = [];
  let quietSince = null;
  while (Date.now() - t0 < WATCH) {
    const row = JSON.parse(await c.ev('JSON.stringify([document.getElementById("pct").textContent,document.getElementById("pmeta").textContent,document.body.dataset.state,document.getElementById("bar").classList.contains("stalled")])'));
    if (row[2] !== 'working') {
      console.log('job left working at +' + Math.round((Date.now() - t0) / 1000) + 's, state=' + row[2]);
      if (row[2] === 'error') fails.push('the slow video errored: ' + row[1]);
      break;
    }
    frames++;
    if (row[1] !== lastCaption) { lastCaption = row[1]; if (frames % 12 === 1) console.log('  t+' + Math.round((Date.now() - t0) / 1000) + 's ' + row[0] + ' | ' + row[1]); }
    const hasRate = /KiB\/s|B\/s|MiB\/s/.test(row[1]);
    if (hasRate && firstRate === null) firstRate = Date.now() - t0;
    if (firstRate !== null && !hasRate) blanks++;
    if (row[3]) { stalls++; if (quietSince === null) quietSince = Date.now() - t0; }
    else if (quietSince !== null) { stallWindows.push(Math.round((Date.now() - t0 - quietSince) / 1000) + 's'); quietSince = null; }
    await H.sleep(250);
  }
  if (quietSince !== null) stallWindows.push(Math.round((Date.now() - t0 - quietSince) / 1000) + 's');
  await c.shot(__dirname + '/shot-slow.png');

  console.log('watched ' + Math.round((Date.now() - t0) / 1000) + 's: ' + frames + ' frames, stalled ' + stalls + ' of them, pauses: ' + JSON.stringify(stallWindows));
  check(firstRate !== null, 'a speed appeared on screen (at +' + firstRate + 'ms)');
  check(blanks === 0, 'the speed/ETA never blanked after appearing (blanks: ' + blanks + ')');

  /* stop cleanly if still running */
  if ((await H.state(c)) === 'working') {
    await c.ev("document.getElementById('btn-cancel').click()");
    await H.waitState(c, ['ready', 'idle', 'error'], 30000);
    await H.sleep(2000);
    check(H.tmpDirs().length === 0, 'cancel left no scratch folder: ' + JSON.stringify(H.tmpDirs()));
    check(H.dlFiles(VID).length === 0, 'cancel left no partial file: ' + JSON.stringify(H.dlFiles(VID)));
  }
  check(problems.length === 0, 'no console errors: ' + JSON.stringify(problems));
  c.close();
  console.log('\n' + (fails.length ? 'FAILURES:\n  - ' + fails.join('\n  - ') : 'SLOW VIDEO PASSED'));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.log('HARNESS FAIL: ' + e.message); process.exit(1); });
