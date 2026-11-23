/* Two qualities, one paste — the behaviour the user was owed. Also probes both
   files with ffmpeg (H.264+AAC for the MP4, real MP3 for the MP3), checks the
   saved chip is marked, the already-saved case admits it did not re-fetch, and
   that editing the field drops the stale plan. */
'use strict';
const H = require('./cdp');
const cp = require('child_process');
const fs = require('fs');
const [,, wsUrl, url] = process.argv;
const VID = (/v=([\w-]{6,})/.exec(url) || [])[1] || '';
const FF = process.env.HOME + '/.local/bin/ffmpeg';
const problems = [];
const fails = [];
const check = (cond, msg) => { fails.push(...cond ? [] : [msg]); console.log((cond ? '  ok   ' : '  FAIL ') + msg); };

(async () => {
  const c = H.connect(wsUrl, problems);
  await c.ready;
  await H.sleep(300);
  H.rmVideo(VID);
  check(await H.resetCard(c), 'card starts cold');

  const r = await H.paste(c, url);
  check(r.ok, 'paste reached ready' + (r.ok ? '' : ' (state=' + r.state + ')'));
  if (!r.ok) { console.log('ABORT: no ready card'); process.exit(1); }
  console.log('chips: ' + JSON.stringify(r.chips.map((x) => x.id + ':' + x.label)));

  /* Best */
  let run = await H.pressRun(c);
  console.log('BEST -> state=' + run.state + ' in ' + run.secs + 's, first byte ' + (run.firstByte === null ? 'n/a' : run.firstByte + 'ms'));
  check(run.state === 'done', 'Best finished');
  await c.shot(__dirname + '/shot-done.png');

  /* the fix: chips survive, saved chip marked, no second paste */
  check(await c.ev('!document.getElementById("quals").hidden'), 'quality row still on screen after the save');
  const saved = JSON.parse(await c.ev('JSON.stringify([...document.querySelectorAll(".qual.saved")].map(function(b){return b.dataset.id}))'));
  check(saved.length === 1 && saved[0] === 'best', 'the saved chip carries the tick: ' + JSON.stringify(saved));

  /* already-saved: same chip again must not re-fetch */
  run = await H.pressRun(c);
  check(run.state === 'done' && Number(run.secs) < 3, 're-press of a saved chip answers instantly (' + run.secs + 's)');
  const word = await c.ev('document.getElementById("doneword").textContent');
  console.log('re-press panel word: "' + word + '"');
  check(word === 'Already saved', 'the panel admits it did not re-fetch: ' + word);

  /* MP3 from the same plan */
  await c.ev('(function(){var b=[...document.querySelectorAll(".qual")].find(function(x){return x.dataset.id==="mp3"});if(b)b.click()})()');
  await H.sleep(150);
  const chosen = await c.ev('(function(){var c=[...document.querySelectorAll(".qual")].find(function(x){return x.getAttribute("aria-checked")==="true"});return c?c.dataset.id:""})()');
  check(chosen === 'mp3', 'clicking the MP3 chip selects it');
  console.log('button reads: ' + await c.ev('document.getElementById("go-label").textContent'));
  run = await H.pressRun(c);
  console.log('MP3 -> state=' + run.state + ' in ' + run.secs + 's, first byte ' + (run.firstByte === null ? 'n/a' : run.firstByte + 'ms'));
  check(run.state === 'done', 'MP3 finished');

  /* files and codecs */
  const files = H.dlFiles(VID);
  console.log('files from ONE paste: ' + JSON.stringify(files));
  check(files.some((f) => /\.mp4$/i.test(f)), 'an mp4 landed');
  check(files.some((f) => /\.mp3$/i.test(f)), 'an mp3 landed');
  for (const f of files) {
    const out = cp.execSync('"' + FF + '" -i "' + H.DL + '/' + f + '" 2>&1 || true', { encoding: 'utf8' });
    const streams = out.split('\n').filter((l) => /Stream #0/.test(l));
    console.log('  probe ' + f + ': ' + JSON.stringify(streams.map((s) => (s.match(/(?:Video|Audio): [^,(]+/) || [''])[0].trim())));
    if (/\.mp4$/i.test(f)) {
      check(streams.some((s) => /h264/.test(s)), 'mp4 is H.264 (QuickTime)');
      check(streams.some((s) => /aac/.test(s)), 'mp4 is AAC (QuickTime)');
    } else if (/\.mp3$/i.test(f)) {
      check(streams.some((s) => /Audio: mp3/.test(s)), 'mp3 file is really MP3');
    }
    check(fs.statSync(H.DL + '/' + f).size > 20000, 'file is not a stub: ' + f);
  }

  /* typing a different link must drop this plan */
  await c.ev("document.getElementById('sf_url').value='https://www.youtube.com/watch?v=ZZZZZZZZZZ';document.getElementById('sf_url').dispatchEvent(new Event('input',{bubbles:true}))");
  await H.sleep(400);
  check(await H.state(c) === 'idle', 'a new link drops the old plan (state=' + (await H.state(c)) + ')');
  check(await c.ev('document.getElementById("quals").hidden'), 'the old video chips are gone with it');

  check(problems.length === 0, 'no console errors: ' + JSON.stringify(problems));
  await H.resetCard(c);
  c.close();
  console.log('\n' + (fails.length ? 'FAILURES:\n  - ' + fails.join('\n  - ') : 'MULTI-QUALITY PASSED'));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.log('HARNESS FAIL: ' + e.message + ' | problems: ' + JSON.stringify(problems)); process.exit(1); });
