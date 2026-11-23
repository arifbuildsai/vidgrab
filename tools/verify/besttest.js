/* The screenshot scenario: the heaviest chip (Best, 176 MiB) on the slow
   video. Two things under test: (1) the ramp — parallel slices must be flying
   from the first second, not after a serial megabyte, so the opening rate must
   not sit at single-connection speed; (2) cancel mid a PARALLEL download, the
   newest risk area: four slices in flight, none may leave a byte behind. */
'use strict';
const H = require('./cdp');
const cp = require('child_process');
const fs = require('fs');
const [,, wsUrl, url] = process.argv;
const VID = (/v=([\w-]{6,})/.exec(url) || [])[1] || '';
const problems = [];
const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); console.log((cond ? '  ok   ' : '  FAIL ') + msg); };
const rateOf = (s) => { const m = /([\d.]+) (KiB|MiB|B)\/s/.exec(s || ''); if (!m) return 0; return parseFloat(m[1]) * ({ B: 1, KiB: 1024, MiB: 1048576 }[m[2]]); };

(async () => {
  const c = H.connect(wsUrl, problems);
  await c.ready;
  await H.sleep(300);
  H.rmVideo(VID);
  await H.resetCard(c);
  const r = await H.paste(c, url);
  check(r.ok, 'paste reached ready');
  if (!r.ok) process.exit(1);
  await c.ev("(function(){var b=[...document.querySelectorAll('.qual')].find(function(x){return x.dataset.id==='best'});if(b)b.click()})()");
  await H.sleep(150);

  /* press and sample the rate every second for the first 15s */
  await c.ev('document.getElementById("dl-form").requestSubmit()');
  const t0 = Date.now(); const rates = [];
  let firstRate = null;
  for (let i = 0; i < 15; i++) {
    await H.sleep(1000);
    const row = JSON.parse(await c.ev('JSON.stringify([document.getElementById("pct").textContent,document.getElementById("pmeta").textContent,document.body.dataset.state])'));
    const kbps = rateOf(row[1]);
    if (kbps > 0 && firstRate === null) firstRate = Date.now() - t0;
    rates.push(kbps);
    console.log('  t+' + (i + 1) + 's ' + row[0] + ' | ' + row[1]);
    if (row[2] !== 'working') break;
  }
  const avg15 = rates.filter((x) => x > 0).reduce((a, b, _, arr) => a + b / arr.length, 0);
  console.log('first rate shown at +' + firstRate + 'ms | mean of first 15s: ' + Math.round(avg15 / 1024) + ' KiB/s');
  check(firstRate !== null && firstRate < 8000, 'a real rate is on screen within 8s of pressing');
  check(avg15 > 150 * 1024, 'the opening 15s averages over 150 KiB/s (serial probe sat at ~79)');

  /* let it finish (176 MiB should be a few minutes at parallel rates) */
  const st = await H.waitState(c, ['done', 'error'], 600000);
  const total = Math.round((Date.now() - t0) / 1000);
  check(st === 'done', 'Best (176 MiB) finished in ' + total + 's, state=' + st);
  if (st === 'done') {
    const f = H.dlFiles(VID).find((x) => /\.mp4$/i.test(x));
    check(!!f, 'mp4 landed: ' + f);
    if (f) {
      const out = cp.execSync('"' + process.env.HOME + '/.local/bin/ffmpeg" -i "' + H.DL + '/' + f + '" 2>&1 || true', { encoding: 'utf8' });
      const streams = out.split('\n').filter((l) => /Stream #0/.test(l));
      check(streams.some((s) => /h264/.test(s)) && streams.some((s) => /aac/.test(s)), 'H.264 + AAC verified');
      check(/Duration: 00:16:3/.test(out), 'full 16:31 duration intact (no silent corruption)');
      console.log('  size: ' + Math.round(fs.statSync(H.DL + '/' + f).size / 1048576) + ' MiB in ' + total + 's -> ' + Math.round(fs.statSync(H.DL + '/' + f).size / 1024 / total) + ' KiB/s end to end');
    }
  }

  /* cancel under parallel load: same video, MP3 chip is serial-ish, so use
     Best again after removing the file — four slices WILL be in flight */
  H.rmVideo(VID);
  await H.resetCard(c);
  await H.paste(c, url);
  await c.ev("(function(){var b=[...document.querySelectorAll('.qual')].find(function(x){return x.dataset.id==='best'});if(b)b.click()})()");
  await c.ev('document.getElementById("dl-form").requestSubmit()');
  for (let i = 0; i < 60; i++) {
    const p = parseFloat(await c.ev('parseFloat(document.getElementById("pct").textContent)||0'));
    if (p >= 3) break;
    await H.sleep(300);
  }
  console.log('pressing Cancel with slices in flight (' + await c.ev('document.getElementById("pct").textContent') + ')');
  await c.ev("document.getElementById('btn-cancel').click()");
  const s2 = await H.waitState(c, ['ready', 'idle', 'error'], 30000);
  check(s2 === 'ready', 'card returned to ready after parallel cancel: ' + s2);
  await H.sleep(4000);
  check(H.tmpDirs().length === 0, 'no scratch folder survived: ' + JSON.stringify(H.tmpDirs()));
  check(H.dlFiles(VID).length === 0, 'no partial file survived: ' + JSON.stringify(H.dlFiles(VID)));

  check(problems.length === 0, 'no console errors: ' + JSON.stringify(problems));
  c.close();
  console.log('\n' + (fails.length ? 'FAILURES:\n  - ' + fails.join('\n  - ') : 'BEST + PARALLEL CANCEL PASSED'));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.log('HARNESS FAIL: ' + e.message); process.exit(1); });
