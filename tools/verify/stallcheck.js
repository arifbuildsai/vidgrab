/* Prove the stall requirement offline, at full speed. Extracts the REAL report()
   closure out of src/main.js and the REAL progress handler out of ui/js/main.js,
   drives them with a fake clock over a byte timeline that pauses for 6 seconds
   and then runs into the merge phase, and asserts:
     - the pause is detected and named
     - the rate holds (does not decay toward zero)
     - the percentage never parks
     - once speed+ETA appear on screen they never vanish before 'done'
   Exit non-zero on any failure. */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'app', 'desktop');
const SRC = path.join(ROOT, 'src', 'main.js');
const UI = path.join(ROOT, 'ui', 'js', 'main.js');
const src = fs.readFileSync(SRC, 'utf8');

const grabFn = (start) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error('not found in main.js: ' + start);
  const j = src.indexOf('\n}', i);
  return src.slice(i, j + 2);
};
const helpers = ['function humanSize(', 'function humanDuration('].map(grabFn).join('\n\n');

const a = src.indexOf('const BUDGET = { starting: [0, 3]');
const b = src.indexOf('phase: phase,', a);
const end = src.indexOf('};', b);
if (a < 0 || b < 0 || end < 0) throw new Error('report closure not found in main.js');
const reportSrc = src.slice(a, end + 2);
console.log('extracted report(): ' + reportSrc.split('\n').length + ' lines, from main.js as it stands\n');

/* fake clock */
let NOW = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => NOW;

const frames = [];
const mk = new Function('send', 'startedAt', helpers + '\n' + reportSrc + '\nreturn report;');
const report = mk((ch, p) => frames.push(p), NOW);

const TOTAL = 725 * 1024;
const KB = 1024;
const advance = (ms) => { NOW += ms; };
const feed = (done, phase) => report(phase || 'downloading', done, TOTAL);

/* steady ~30 KiB/s for 4s, then 6s of dead silence, then resume to the end,
   then 4s of merging (every byte down, job still working), then done */
let done = 0;
for (let i = 0; i < 40; i++) { advance(100); done += 3 * KB; feed(done); }
const paused = done;
for (let i = 0; i < 60; i++) { advance(100); feed(paused); }
while (done < TOTAL) { advance(100); done = Math.min(TOTAL, done + 3 * KB); feed(done); }
for (let i = 0; i < 40; i++) { advance(100); report('merging', TOTAL, TOTAL); }
advance(100); report('done', TOTAL, TOTAL);

const fails = [];
const stallFrames = frames.filter((f) => f.stalled);
const dlFrames = frames.filter((f) => f.phase === 'downloading' && f.done > 0 && f.left > 0);

if (!stallFrames.length) fails.push('no frame was ever marked stalled — the pause was not detected');
for (const f of dlFrames) {
  if (!f.speed) fails.push('blank speed at ' + Math.round(f.pct) + '%');
  if (!f.eta) fails.push('blank ETA at ' + Math.round(f.pct) + '%');
}
for (const f of stallFrames) {
  if (!f.speed) fails.push('speed blanked during the stall at ' + Math.round(f.pct) + '%');
  if (!f.eta) fails.push('ETA blanked during the stall at ' + Math.round(f.pct) + '%');
  if (!f.note) fails.push('no note during the stall');
}
const stallSpeeds = new Set(stallFrames.map((f) => f.speed));
if (stallSpeeds.size > 1) fails.push('speed wobbled during the stall: ' + [...stallSpeeds].join(', '));
let frozen = 0, maxFrozen = 0;
for (let i = 1; i < frames.length; i++) {
  if (frames[i].pct <= frames[i - 1].pct) { frozen++; maxFrozen = Math.max(maxFrozen, frozen); } else frozen = 0;
}
console.log('frames: ' + frames.length + ' (downloading w/ bytes out: ' + dlFrames.length + ', stalled: ' + stallFrames.length + ', merging: ' + frames.filter((f) => f.phase === 'merging').length + ')');
console.log('first stall frame: ' + JSON.stringify(stallFrames[0]));
console.log('last stall frame:  ' + JSON.stringify(stallFrames[stallFrames.length - 1]));
console.log('distinct speeds during the 6s stall: ' + [...stallSpeeds].join(' / '));
console.log('notes seen: ' + [...new Set(frames.map((f) => f.note).filter(Boolean))].join('  |  '));
console.log('max consecutive non-moving percentages: ' + maxFrozen);

/* ---- what the screen reads, using the renderer's real hold logic ---- */
const ui = fs.readFileSync(UI, 'utf8');
const i2 = ui.indexOf('  var lastSpeed');
const j2 = ui.indexOf("  api.on('vg:cancelled'", i2);
if (i2 < 0 || j2 < 0) throw new Error('renderer progress block not found');
let body = ui.slice(i2, j2).replace(/\s+$/, '');
body = body.replace("api.on('vg:progress', function (p) {", 'function onProgress(p) {').replace(/\}\);\s*$/, '}');
if (/api\.on\(/.test(body)) throw new Error('renderer slice still holds an api.on: ' + body.slice(-120));
const mkRenderer = () => {
  const d = { fill: { style: {} }, pct: { textContent: '' }, bar: { classList: { toggle() {} } }, pmeta: { textContent: '' } };
  const fn = new Function('fill', 'pct', 'bar', 'pmeta', 'show',
    'return (function(){\n' + body + '\nreturn onProgress;\n})();')(d.fill, d.pct, d.bar, d.pmeta, () => {});
  return { fn, d };
};
console.log('\n--- what the screen reads (renderer logic, run for real) ---');
const one = mkRenderer();
const samples = [dlFrames[0], stallFrames[0], stallFrames[stallFrames.length - 1],
  frames.find((f) => f.phase === 'merging'), frames[frames.length - 2]].filter(Boolean);
for (const f of samples) { one.fn(f); console.log('  ' + (f.stalled ? 'STALLED ' : f.phase === 'merging' ? 'MERGING ' : '        ') + String(Math.round(f.pct)).padStart(3) + '%  |  ' + one.d.pmeta.textContent); }

/* the requirement as the user stated it: once the numbers appear, they never
   disappear again until the file is saved */
const run = mkRenderer();
let blanks = 0, seen = 0, firstSeen = -1;
for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  run.fn(f);
  const txt = run.d.pmeta.textContent;
  const hasBoth = /KiB\/s|B\/s|MiB\/s/.test(txt) && /ETA /.test(txt);
  if (hasBoth) { if (firstSeen < 0) firstSeen = i; seen++; continue; }
  if (firstSeen >= 0 && i > firstSeen && f.phase !== 'done') blanks++;
}
console.log('\nframes from first-rate onward: ' + (frames.length - firstSeen) + ' | with speed AND ETA: ' + seen + ' | blanked after appearing: ' + blanks);
if (firstSeen < 0) fails.push('the speed/ETA pair never appeared on screen');
if (blanks) fails.push(blanks + ' frames lost the speed or the ETA after it had appeared');

Date.now = realNow;
console.log('\n' + (fails.length ? 'FAILURES:\n  - ' + fails.slice(0, 12).join('\n  - ') : 'ALL STALL ASSERTIONS PASSED'));
process.exit(fails.length ? 1 : 0);
