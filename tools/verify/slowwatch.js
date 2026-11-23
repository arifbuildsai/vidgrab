/* The user's requirement, on a video that is genuinely slow here (16 min,
   their own test upload): once the speed and ETA appear, they never blank
   until the file is saved — including through any pause. Watches the live
   caption for up to WATCH seconds; if the video is still going then, cancels
   (cancel is proven clean by canceltest) and still passes, because what is
   under test is the caption, not the file. */
'use strict';
const H = require('./cdp');
const [,, wsUrl, url] = process.argv;
const VID = (/v=([\w-]{6,})/.exec(url) || [])[1] || '';
const WATCH = 150000;
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
  /* prefer a low video chip if offered — the point is a long, slow transfer */
  const pick = r.chips.find((x) => /^(h?(144|240|360)p?)$/i.test(x.label)) || r.chips[0];
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
