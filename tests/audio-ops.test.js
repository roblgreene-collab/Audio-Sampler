import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../js/audio-ops.js';
import { encodeWav } from '../js/encoders.js';

const SR = 44100;

function ramp(n, channels = 1) {
  return ops.createClip(SR, Array.from({ length: channels }, (_, c) =>
    Float32Array.from({ length: n }, (_, i) => (c ? -1 : 1) * (i / n))));
}

function sine(freq, seconds) {
  const n = Math.round(SR * seconds);
  return ops.createClip(SR, [Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * i) / SR))]);
}

// Estimate frequency by counting upward zero crossings in the middle of the clip.
function estimateFreq(clip) {
  const ch = clip.channels[0];
  const a = Math.floor(ch.length * 0.2);
  const b = Math.floor(ch.length * 0.8);
  let crossings = 0;
  for (let i = a + 1; i < b; i++) if (ch[i - 1] < 0 && ch[i] >= 0) crossings++;
  return crossings / ((b - a) / clip.sampleRate);
}

test('slice and concat round-trip', () => {
  const c = ramp(1000, 2);
  const joined = ops.concat([ops.slice(c, 0, 400), ops.slice(c, 400)]);
  assert.deepEqual(joined.channels, c.channels);
});

test('removeRange shortens by the range minus the crossfade', () => {
  const c = ramp(SR);
  const out = ops.removeRange(c, 10000, 20000);
  const fade = Math.round(SR * 0.004);
  assert.equal(ops.clipLength(out), SR - 10000 - fade);
  assert.equal(out.channels[0][0], c.channels[0][0]);
});

test('splice replaces a region', () => {
  const c = ramp(100);
  const rep = ops.createClip(SR, [new Float32Array(10).fill(5)]);
  const out = ops.splice(c, 20, 60, rep);
  assert.equal(ops.clipLength(out), 70);
  assert.equal(out.channels[0][20], 5);
  assert.equal(out.channels[0][30], c.channels[0][60]);
});

test('chop splits into equal pieces covering the whole clip', () => {
  const c = ramp(1003);
  const pieces = ops.chop(c, 4);
  assert.equal(pieces.length, 4);
  assert.equal(pieces.reduce((n, p) => n + ops.clipLength(p), 0), 1003);
});

test('reverse only touches the selected range and does not mutate input', () => {
  const c = ramp(10);
  const before = c.channels[0].slice();
  const out = ops.reverse(c, 2, 5);
  assert.deepEqual(c.channels[0], before);
  assert.deepEqual(Array.from(out.channels[0].slice(2, 5)), Array.from(before.slice(2, 5)).reverse());
  assert.equal(out.channels[0][0], before[0]);
  assert.equal(out.channels[0][9], before[9]);
});

test('reverse twice is identity', () => {
  const c = ramp(500, 2);
  assert.deepEqual(ops.reverse(ops.reverse(c)).channels, c.channels);
});

test('normalize hits the target peak', () => {
  const c = ops.gain(sine(440, 0.1), 0.25);
  assert.ok(Math.abs(ops.peak(ops.normalize(c)) - 0.989) < 1e-6);
});

test('fade in starts at silence and ends at full level', () => {
  const c = ops.createClip(SR, [new Float32Array(100).fill(1)]);
  const out = ops.fade(c, 'in');
  assert.equal(out.channels[0][0], 0);
  assert.equal(out.channels[0][99], 1);
});

test('tape pitch up an octave halves length and doubles frequency', () => {
  const c = sine(220, 1);
  const out = ops.pitchTape(c, 12);
  assert.ok(Math.abs(ops.clipLength(out) - SR / 2) <= 1);
  assert.ok(Math.abs(estimateFreq(out) - 440) < 5, `got ${estimateFreq(out)}`);
});

test('tape pitch down lengthens the clip', () => {
  const out = ops.pitchTape(sine(440, 0.5), -12);
  assert.ok(Math.abs(ops.clipLength(out) - SR) <= 2);
  assert.ok(Math.abs(estimateFreq(out) - 220) < 5);
});

test('timeStretch changes length but keeps pitch', () => {
  const c = sine(300, 1);
  for (const f of [0.5, 1.5, 2]) {
    const out = ops.timeStretch(c, f);
    assert.equal(ops.clipLength(out), Math.round(SR * f));
    assert.ok(Math.abs(estimateFreq(out) - 300) < 6, `factor ${f}: ${estimateFreq(out)}`);
  }
});

test('timeStretch keeps level steady (no window gaps)', () => {
  const c = ops.createClip(SR, [new Float32Array(SR).fill(0.5)]);
  const out = ops.timeStretch(c, 1.3).channels[0];
  for (let i = 0; i < out.length - 4096; i += 97) assert.ok(Math.abs(out[i] - 0.5) < 1e-3, `sample ${i}: ${out[i]}`);
});

test('pitchKeepLength keeps length and shifts frequency', () => {
  const c = sine(220, 1);
  for (const [semis, freq] of [[12, 440], [-12, 110], [7, 220 * 2 ** (7 / 12)]]) {
    const out = ops.pitchKeepLength(c, semis);
    assert.equal(ops.clipLength(out), SR);
    assert.ok(Math.abs(estimateFreq(out) - freq) < freq * 0.03, `${semis} st: ${estimateFreq(out)}`);
  }
});

test('limitChannels mixes down to stereo', () => {
  const c = ops.createClip(SR, [new Float32Array(4).fill(1), new Float32Array(4).fill(1), new Float32Array(4).fill(1)]);
  const out = ops.limitChannels(c, 2);
  assert.equal(out.channels.length, 2);
});

test('encodeWav writes a valid header', async () => {
  const c = ramp(100, 2);
  const blob = encodeWav(c);
  const v = new DataView(await blob.arrayBuffer());
  const tag = (o) => String.fromCharCode(...new Uint8Array(v.buffer, o, 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), SR);
  assert.equal(v.getUint32(40, true), 100 * 2 * 2);
  assert.equal(blob.size, 44 + 400);
});
