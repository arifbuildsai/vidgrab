/* Shared CDP driver for the live tests: WebSocket attach, Runtime.evaluate,
   console/exception collection, state polling, card reset. Every harness file
   speaks to the running app through this — no test touches source code. */
'use strict';
const fs = require('fs');
const os = require('os');

const DL = os.homedir() + '/Downloads';

function connect(wsUrl, problems) {
  const ws = new WebSocket(wsUrl);
  let seq = 0; const pend = new Map();
  ws.addEventListener('open', () => ['Runtime.enable', 'Page.enable'].forEach((m) => send(m)));
  ws.addEventListener('message', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); return; }
    if (!problems) return;
    if (d.method === 'Runtime.exceptionThrown') { const e = d.params.exceptionDetails; problems.push('EXC: ' + ((e.exception && e.exception.description) || e.text)); }
    if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) problems.push(d.params.type + ': ' + d.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
  });
  const send = (m, p) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
  return {
    ws,
    /* The open must be bounded: a WS pointed at a page that died during an app
       restart never fires open OR error here, and an unbounded await hung the
       whole suite for 25 minutes on a dead endpoint. */
    ready: new Promise((r, j) => {
      if (ws.readyState === 1) return r();
      const t = setTimeout(() => j(new Error('CDP websocket never opened (dead target?)')), 15000);
      ws.addEventListener('open', () => { clearTimeout(t); r(); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(t); j(new Error('CDP websocket error')); }, { once: true });
      ws.addEventListener('close', () => { clearTimeout(t); j(new Error('CDP websocket closed before open')); }, { once: true });
    }),
    send,
    ev: async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)); return r.result.value; },
    shot: async (file) => fs.writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64')),
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (c) => c.ev('document.body.dataset.state');
const dlFiles = (videoId) => fs.readdirSync(DL).filter((n) => videoId && n.indexOf(videoId) !== -1 && !n.startsWith('.vidgrab-'));
const tmpDirs = () => fs.readdirSync(DL).filter((n) => n.indexOf('.vidgrab-') === 0);
const rmVideo = (videoId) => { for (const f of dlFiles(videoId)) { try { fs.rmSync(DL + '/' + f, { force: true }); } catch (_) {} } };

/* Cold idle: clear the field (fires dropPlan), click away any done/error
   panel, wait for the button to be live. Every test starts with this so a
   previous stage's prefetch or plan cannot swallow its submit. */
async function resetCard(c) {
  await c.ev("(function(){var i=document.getElementById('sf_url');i.readOnly=false;i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await c.ev("(function(){['btn-again','btn-retry'].forEach(function(id){var b=document.getElementById(id);if(b&&!b.closest('[hidden]'))b.click();})})()");
  for (let i = 0; i < 60; i++) {
    if ((await state(c)) === 'idle' && !(await c.ev('document.getElementById("btn-go").disabled'))) return true;
    await sleep(250);
  }
  return false;
}

async function waitState(c, wanted, limit) {
  const t = Date.now();
  while (Date.now() - t < limit) {
    const s = await state(c);
    if (wanted.indexOf(s) !== -1) return s;
    await sleep(250);
  }
  return state(c);
}

/* Paste a link and reach ready (or error). Returns the chip list. */
async function paste(c, url) {
  await c.ev(`(function(){var i=document.getElementById('sf_url');i.readOnly=false;i.value=${JSON.stringify(url)};document.getElementById('dl-form').requestSubmit()})()`);
  const s = await waitState(c, ['ready', 'error'], 120000);
  if (s !== 'ready') return { ok: false, state: s };
  const chips = JSON.parse(await c.ev('JSON.stringify([...document.querySelectorAll(".qual")].map(function(b){return {id:b.dataset.id,label:b.querySelector("b").textContent}}))'));
  return { ok: true, chips };
}

/* Press Download and run until the card leaves 'working', sampling the caption
   every 250ms. Reports first-byte latency and every distinct caption line. */
async function pressRun(c, limitMs) {
  await c.ev('document.getElementById("dl-form").requestSubmit()');
  const t = Date.now();
  let firstByte = null; const rows = []; const captions = [];
  for (let i = 0; i < Math.ceil((limitMs || 240000) / 250); i++) {
    const row = JSON.parse(await c.ev('JSON.stringify([document.getElementById("pct").textContent,document.getElementById("pmeta").textContent,document.body.dataset.state,document.getElementById("bar").hidden])'));
    rows.push(row);
    if (row[2] === 'working' && firstByte === null && /KiB\/s|B\/s|MiB\/s/.test(row[1])) firstByte = Date.now() - t;
    if (captions[captions.length - 1] !== row[1]) captions.push(row[1]);
    if (row[2] !== 'working') return { secs: ((Date.now() - t) / 1000).toFixed(1), state: row[2], firstByte, captions, rows };
    await sleep(250);
  }
  return { secs: 'TIMEOUT', state: await state(c), firstByte, captions, rows };
}

module.exports = { connect, sleep, state, dlFiles, tmpDirs, rmVideo, resetCard, waitState, paste, pressRun, DL };
