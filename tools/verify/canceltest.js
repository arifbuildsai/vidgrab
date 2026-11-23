/* Prove the cancel fix for real: press Cancel mid-download, then check that
   (a) the card returns to ready, (b) NO .vidgrab-*-tmp folder survives — not
   now, not after a grace period, (c) no partial media file is left in the
   downloads folder, (d) the stale folder a killed run left behind (if any) is
   swept by the next job. Everything talks to the live app over CDP. */
const [,, wsUrl] = process.argv;
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const dl = os.homedir() + '/Downloads';
const VID = 'jNQXAC9IVRw';
const tmpDirs = () => fs.readdirSync(dl).filter((n) => n.indexOf('.vidgrab-') === 0);
const parts = () => fs.readdirSync(dl).filter((n) => n.indexOf(VID) !== -1);

const ws = new WebSocket(wsUrl);
let seq = 0; const pend = new Map(); const problems = [];
const send = (m, p) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
ws.addEventListener('open', () => ['Runtime.enable', 'Page.enable'].forEach((m) => send(m)));
ws.addEventListener('message', (ev) => {
  const d = JSON.parse(ev.data);
  if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); return; }
  if (d.method === 'Runtime.exceptionThrown') { const e = d.params.exceptionDetails; problems.push('EXC: ' + (e.exception && e.exception.description || e.text)); }
  if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) problems.push(d.params.type + ': ' + d.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result.value; };
const state = () => ev('document.body.dataset.state');

const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); console.log((cond ? '  ok   ' : '  FAIL ') + msg); };

(async () => {
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  await sleep(300);
  /* cold start: remove any finished file for this video so the press downloads */
  for (const f of parts()) { try { fs.unlinkSync(dl + '/' + f); } catch (_) {} }
  const staleBefore = tmpDirs();
  console.log('scratch folders present before the job: ' + JSON.stringify(staleBefore));

  /* reset the card, paste, wait ready */
  await ev("(function(){var i=document.getElementById('sf_url');i.readOnly=false;i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("(function(){['btn-again','btn-retry'].forEach(function(id){var b=document.getElementById(id);if(b&&!b.closest('[hidden]'))b.click();})})()");
  for (let i = 0; i < 40; i++) { if ((await state()) === 'idle' && !(await ev('document.getElementById("btn-go").disabled'))) break; await sleep(250); }
  await ev(`(function(){document.getElementById('sf_url').value='https://www.youtube.com/watch?v=${VID}';document.getElementById('dl-form').requestSubmit()})()`);
  for (let i = 0; i < 120; i++) { const s = await state(); if (s === 'ready' || s === 'error') break; await sleep(250); }
  check(await state() === 'ready', 'card reached ready (state=' + (await state()) + ')');

  /* press, wait until bytes are flowing */
  await ev('document.getElementById("dl-form").requestSubmit()');
  let pctAt = 0;
  for (let i = 0; i < 120; i++) {
    const row = JSON.parse(await ev('JSON.stringify([parseFloat(document.getElementById("pct").textContent)||0, document.body.dataset.state])'));
    if (row[0] >= 6) { pctAt = row[0]; break; }
    await sleep(200);
  }
  check(pctAt >= 6, 'download got under way (reached ' + pctAt + '%)');
  console.log('pressing Cancel at ' + pctAt.toFixed(1) + '%');
  const midTmp = tmpDirs();
  check(midTmp.length >= 1, 'scratch folder exists while downloading: ' + JSON.stringify(midTmp));

  /* cancel, then give the app 10s to clean up — the old bug never came */
  await ev("document.getElementById('btn-cancel').click()");
  const t0 = Date.now();
  let st = '';
  while (Date.now() - t0 < 30000) { st = await state(); if (st !== 'working') break; await sleep(200); }
  const settledAt = (Date.now() - t0) / 1000;
  console.log('state after cancel: ' + st + ' (' + settledAt.toFixed(1) + 's)');
  check(st === 'ready', 'card returned to ready, not stuck in working');
  check(settledAt < 8, 'the job ended promptly after cancel (' + settledAt.toFixed(1) + 's — a hang took minutes)');

  await sleep(4000); /* grace: delayed unlinks and the retrying rmTmp */
  const after = tmpDirs();
  const leftFiles = parts();
  console.log('scratch folders after cancel+4s: ' + JSON.stringify(after));
  console.log('video files after cancel: ' + JSON.stringify(leftFiles));
  check(after.length === 0, 'NO scratch folder survived the cancel');
  check(leftFiles.length === 0, 'no partial media file left in Downloads');

  /* next job must sweep the stale folder a killed run left (if one existed) */
  if (staleBefore.length) {
    await ev('document.getElementById("dl-form").requestSubmit()');
    for (let i = 0; i < 120; i++) { const r = JSON.parse(await ev('JSON.stringify([parseFloat(document.getElementById("pct").textContent)||0,document.body.dataset.state])')); if (r[0] >= 4 || r[1] === 'done') break; await sleep(250); }
    await sleep(1500);
    const swept = tmpDirs().filter((n) => staleBefore.indexOf(n) !== -1 && fs.existsSync(dl + '/' + n));
    check(swept.length === 0, 'the stale folder from the killed run was swept: ' + JSON.stringify(swept));
    await ev("document.getElementById('btn-cancel').click()");
    for (let i = 0; i < 60; i++) { if ((await state()) !== 'working') break; await sleep(250); }
  }

  console.log('console problems: ' + JSON.stringify(problems));
  check(problems.length === 0, 'no console errors or exceptions');
  ws.close();
  console.log('\n' + (fails.length ? 'FAILURES:\n  - ' + fails.join('\n  - ') : 'CANCEL TEST PASSED'));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.log('HARNESS FAIL: ' + e.message); process.exit(1); });
