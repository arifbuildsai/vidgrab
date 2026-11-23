/* The read must start on its own while the link is being typed, and pressing
   Download after it lands must reach the first byte almost immediately. */
'use strict';
const H = require('./cdp');
const [,, wsUrl, url] = process.argv;
const VID = (/v=([\w-]{6,})/.exec(url) || [])[1] || '';
const problems = [];
const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); console.log((cond ? '  ok   ' : '  FAIL ') + msg); };

(async () => {
  const c = H.connect(wsUrl, problems);
  await c.ready;
  await H.sleep(300);
  H.rmVideo(VID);
  await H.resetCard(c);

  /* type it character by character, press nothing */
  const t0 = Date.now();
  await c.ev("(function(){var i=document.getElementById('sf_url');i.readOnly=false;i.focus();})()");
  for (const ch of url) {
    await c.ev(`(function(){var i=document.getElementById('sf_url');i.value+=${JSON.stringify(ch)};i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await H.sleep(25);
  }
  const typedAt = Date.now() - t0;
  console.log('typed in +' + typedAt + 'ms  value=' + await c.ev('document.getElementById("sf_url").value'));

  /* the read should self-start ~700ms after the field looks like a link */
  let readAt = null;
  for (let i = 0; i < 40; i++) {
    if ((await H.state(c)) === 'reading') { readAt = Date.now() - t0; break; }
    await H.sleep(100);
  }
  check(readAt !== null, 'the read started by itself, +' + readAt + 'ms after typing began');
  check(readAt !== null && readAt - typedAt < 3000, 'it started within 3s of the last keystroke (gap ' + (readAt - typedAt) + 'ms)');

  const readyAt = (await H.waitState(c, ['ready', 'error'], 120000)) === 'ready' ? Date.now() - t0 : null;
  check(readyAt !== null, 'READY before any press, +' + readyAt + 'ms');
  if (readyAt === null) { console.log('ABORT'); process.exit(1); }

  /* now press: the plan is warm, bytes should start at once */
  const run = await H.pressRun(c);
  console.log('press -> state=' + run.state + ' in ' + run.secs + 's | first byte ' + (run.firstByte === null ? 'NEVER' : run.firstByte + 'ms'));
  check(run.firstByte !== null && run.firstByte < 3000, 'press reached the first byte in under 3s (was ' + run.firstByte + 'ms)');
  check(run.state === 'done', 'download completed: ' + run.state);
  console.log('captions: ' + JSON.stringify(run.captions.slice(0, 6)) + ' ... ' + JSON.stringify(run.captions.slice(-3)));

  check(problems.length === 0, 'no console errors: ' + JSON.stringify(problems));
  c.close();
  console.log('\n' + (fails.length ? 'FAILURES:\n  - ' + fails.join('\n  - ') : 'PREFETCH PASSED'));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.log('HARNESS FAIL: ' + e.message); process.exit(1); });
