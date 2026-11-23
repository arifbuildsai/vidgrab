/* Capture the four states the user sees: idle, ready (chips), progress, done. */
'use strict';
const H = require('./cdp');
const [,, wsUrl, url] = process.argv;
const VID = (/v=([\w-]{6,})/.exec(url) || [])[1] || '';
const out = __dirname + '/shots';
require('fs').mkdirSync(out, { recursive: true });

(async () => {
  const c = H.connect(wsUrl, []);
  await c.ready;
  await H.sleep(300);
  H.rmVideo(VID);
  await H.resetCard(c);
  await c.shot(out + '/1-idle.png');

  await H.paste(c, url);
  await H.sleep(600);
  await c.shot(out + '/2-ready.png');

  await c.ev('document.getElementById("dl-form").requestSubmit()');
  /* wait for a rate to be on screen, then shoot the bar mid-download */
  for (let i = 0; i < 60; i++) {
    const t = await c.ev('document.getElementById("pmeta").textContent');
    if (/KiB\/s|MiB\/s/.test(t)) break;
    await H.sleep(200);
  }
  await c.shot(out + '/3-progress.png');

  await H.waitState(c, ['done', 'error'], 180000);
  await H.sleep(600);
  await c.shot(out + '/4-done.png');
  console.log('states: ' + JSON.stringify(await c.ev('JSON.stringify([document.body.dataset.state, document.getElementById("doneword").textContent])')));
  c.close();
  console.log('shots written to ' + out);
})().catch((e) => { console.log('FAIL: ' + e.message); process.exit(1); });
