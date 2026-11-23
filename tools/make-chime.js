#!/usr/bin/env node
/* Generates assets/chime.wav — the download-finished tone.
 *
 * macOS ships system sounds and the app plays Glass there, but Windows and
 * Linux have no equivalent bundled asset, so those platforms fell back to
 * shell.beep(): a dull PC-speaker honk. This writes one small WAV so every
 * OS plays the same bright two-note bell.
 *
 * Synthesised rather than borrowed, so the repo ships no third-party audio
 * licence. Two strikes of an inharmonic partial cluster, exponential decay,
 * 4 ms attack to keep the onset click-free.
 *
 * Usage: node tools/make-chime.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RATE = 44100;
const SECS = 1.25;
const N = Math.round(RATE * SECS);

/* Partials as multiples of a base frequency, with amplitudes and decay times.
   Non-integer ratios are what makes it read as a bell rather than a flute. */
const PARTIALS = [
  { r: 1.0, a: 1.00, tau: 1.00 },
  { r: 2.0, a: 0.46, tau: 0.72 },
  { r: 2.98, a: 0.30, tau: 0.55 },
  { r: 4.21, a: 0.19, tau: 0.40 },
  { r: 5.43, a: 0.11, tau: 0.28 },
  { r: 6.79, a: 0.07, tau: 0.20 },
];

const STRIKES = [
  { at: 0.00, hz: 1568.0, amp: 1.00 },   /* G6 */
  { at: 0.13, hz: 2093.0, amp: 0.72 },   /* C7, a fifth above the first */
];

const ATTACK = 0.004;
const RELEASE = 0.06;

const buf = new Float64Array(N);

for (const s of STRIKES) {
  const start = Math.round(s.at * RATE);
  const len = N - start;
  for (const p of PARTIALS) {
    const w = 2 * Math.PI * s.hz * p.r;
    const tau = (0.28 * p.tau) * RATE;          /* decay in samples */
    for (let i = 0; i < len; i++) {
      const t = i;
      let env = Math.exp(-t / tau);
      if (t < ATTACK * RATE) env *= t / (ATTACK * RATE);
      buf[start + i] += s.amp * p.a * env * Math.sin(w * t / RATE);
    }
  }
}

/* Global fade-out so the tail never truncates with a click. */
const relSamples = Math.round(RELEASE * RATE);
for (let i = 0; i < relSamples; i++) {
  const idx = N - relSamples + i;
  buf[idx] *= 1 - i / relSamples;
}

let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(buf[i]));
const norm = peak > 0 ? 0.89 / peak : 1;

const pcm = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) {
  let v = Math.round(buf[i] * norm * 32767);
  if (v > 32767) v = 32767;
  if (v < -32768) v = -32768;
  pcm.writeInt16LE(v, i * 2);
}

const dataLen = pcm.length;
const hdr = Buffer.alloc(44);
hdr.write('RIFF', 0);
hdr.writeUInt32LE(36 + dataLen, 4);
hdr.write('WAVE', 8);
hdr.write('fmt ', 12);
hdr.writeUInt32LE(16, 16);                 /* PCM chunk size */
hdr.writeUInt16LE(1, 20);                  /* format: PCM */
hdr.writeUInt16LE(1, 22);                  /* channels: mono */
hdr.writeUInt32LE(RATE, 24);
hdr.writeUInt32LE(RATE * 2, 28);           /* byte rate: 16-bit mono */
hdr.writeUInt16LE(2, 32);                  /* block align */
hdr.writeUInt16LE(16, 34);                 /* bits per sample */
hdr.write('data', 36);
hdr.writeUInt32LE(dataLen, 40);

const out = path.join(__dirname, '..', 'assets', 'chime.wav');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([hdr, pcm]));

console.log('wrote ' + path.relative(process.cwd(), out) +
  '  ' + (SECS) + 's  ' + RATE + ' Hz mono 16-bit  ' +
  (44 + dataLen) + ' bytes (' + ((44 + dataLen) / 1024).toFixed(1) + ' KiB)');
